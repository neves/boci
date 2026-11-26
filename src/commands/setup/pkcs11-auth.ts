import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expandUser } from "../../core/config.ts";
import { BadParameter } from "../../core/convert.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import {
  ConfigParserError,
  formatParsedConfig,
  parseConfig,
} from "../../lib/configparser.ts";
import { Exit } from "../../lib/io.ts";
import { readConfigFile } from "../../utils/configFile.ts";
import { normalizePosixPath } from "../../utils/posixPath.ts";
import { promptSessionForProfile } from "../session.ts";
import {
  applyUserOnlyAccessPermissions,
  confirmClick,
  createDirectory,
  createStdinReader,
  promptClick,
  promptForRegion,
  removeProfileFromConfig,
  setupRegion,
  validateOcid,
  validateProfileName,
  writeConfig,
} from "../setup.ts";

export async function runSetupPkcs11Auth(
  ctx: CustomCommandContext,
): Promise<void> {
  const { io, values, rc, settings } = ctx;
  const stdin = createStdinReader(io);
  const fail = (message: string): never => {
    io.err(`${message}\n`);
    throw new Exit(1);
  };
  const defaultConfig = expandUser("~/.oci/config", io.env);
  const explicitProfile =
    typeof values.profile_name === "string" && values.profile_name;
  const config = normalizePosixPath(
    resolve(
      io.cwd,
      explicitProfile ? expandUser(settings.configFile, io.env) : defaultConfig,
    ),
  );
  const rcFile = resolve(io.cwd, expandUser(rc.path, io.env));

  try {
    const profile =
      explicitProfile ||
      (await promptSessionForProfile(io, stdin, defaultConfig));
    validateProfileName(profile, (message) => fail(`UsageError: ${message}`));
    if (!existsSync(dirname(config))) createDirectory(dirname(config));
    const text = readConfigFile(config);
    if (text !== null && text !== undefined) {
      const parsed = parseConfig(text, config);
      if (
        (profile === "DEFAULT" || parsed.sections.has(profile)) &&
        !(await confirmClick(
          io,
          stdin,
          `Profile ${profile} already exists in config. Do you want to overwrite it?`,
          false,
          true,
        ))
      ) {
        io.out("Config creation canceled.\n");
        return;
      }
    }

    const readOcid = (value: unknown, label: string) =>
      typeof value === "string"
        ? validateOcid(value)
        : promptClick(io, stdin, `Enter a ${label} OCID`, {
            valueProc: validateOcid,
            wrapExceptions: true,
          });
    const userId = await readOcid(values.user_ocid, "user");
    const tenancy = await readOcid(values.tenancy_ocid, "tenancy");
    const region =
      setupRegion(ctx, "pkcs11-auth") ??
      (await promptForRegion(io, stdin, ctx.index.regions, true));

    const selector = async (label: string) =>
      (
        await promptClick(io, stdin, label, {
          default: "",
          showDefault: false,
          wrapExceptions: true,
        })
      ).trim();
    const defaults = new Map<string, string>([
      ["pkcs11_slot_label", ""],
      ["pkcs11_key_id", ""],
      ["pkcs11_token_label", ""],
      ["pkcs11_token_serial_number", ""],
      ["pkcs11_key_id_override", ""],
      ["pkcs11_module_path", ""],
    ]);
    if (!values.use_default_pkcs11_options) {
      const slot = await selector(
        "Enter the PKCS#11 slot label, or leave blank to use the SDK default",
      );
      defaults.set("pkcs11_slot_label", slot);
      if (!slot)
        defaults.set(
          "pkcs11_key_id",
          await selector(
            "Enter the PKCS#11 key id, or leave blank to use the SDK default",
          ),
        );
      const token = await selector(
        "Enter the PKCS#11 token label, or leave blank to use the default token",
      );
      defaults.set("pkcs11_token_label", token);
      if (!token)
        defaults.set(
          "pkcs11_token_serial_number",
          await selector(
            "Enter the PKCS#11 token serial number, or leave blank to use the default token",
          ),
        );
      defaults.set(
        "pkcs11_key_id_override",
        await selector(
          "Enter a PKCS#11 keyId override, or leave blank to use the SDK-derived keyId",
        ),
      );
      defaults.set(
        "pkcs11_module_path",
        await selector(
          "Enter a PKCS#11 module path, or leave blank to use automatic discovery",
        ),
      );
    }

    removeProfileFromConfig(config, config, profile);
    writeConfig(config, {
      userId,
      tenancy,
      region,
      profileName: profile,
      writeKeyFile: false,
    });

    if (!existsSync(dirname(rcFile))) createDirectory(dirname(rcFile));
    const parsed = parseConfig(
      readConfigFile(rcFile) ?? "",
      rcFile,
      "DEFAULT",
      (option) => option,
    );
    let section =
      profile === "DEFAULT" ? parsed.defaults : parsed.sections.get(profile);
    if (!section && [...defaults.values()].some(Boolean)) {
      section = new Map();
      parsed.sections.set(profile, section);
    }
    if (section) {
      for (const [key, value] of defaults) {
        if (
          !section.delete(key) &&
          profile !== "DEFAULT" &&
          parsed.defaults.has(key)
        ) {
          fail(`KeyError: '${key}'`);
        }
        if (value) section.set(key, value);
      }
      await Bun.write(rcFile, formatParsedConfig(parsed));
      applyUserOnlyAccessPermissions(rcFile);
    }

    io.out(
      `Config written to: ${config}\nPKCS#11 defaults written to: ${expandUser(rc.path, io.env)}\n\n    Try out your newly created PKCS#11 profile with the following example command:\n\n    oci os ns get --config-file ${config} --profile ${profile} --auth pkcs11\n\n`,
    );
  } catch (error) {
    if (error instanceof BadParameter || error instanceof ConfigParserError) {
      fail(
        `${error instanceof BadParameter ? "BadParameter" : error.type}: ${error.message}`,
      );
    }
    throw error;
  }
}
