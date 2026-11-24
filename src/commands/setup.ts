import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandUser } from "../core/config.ts";
import { setPosixMode } from "../utils/posixMode.ts";
import {
  ConfigParserError,
  formatParsedConfig,
  parseConfig,
} from "../lib/configparser.ts";
import { BadParameter, pyRepr } from "../core/convert.ts";
import {
  loadExternalRegionMetadata,
  type RegionsSpec,
} from "../core/endpoint.ts";
import { Exit, type Invocation } from "../lib/io.ts";
import { validateClickFileForRead } from "../core/click-file.ts";
import { loadPrivateKey, MissingPrivateKeyPassphrase } from "../core/signer.ts";

export const DEFAULT_KEY_NAME = "oci_api_key";
export const DEFAULT_DIRECTORY = "~/.oci";
export const DEFAULT_PROFILE_NAME = "DEFAULT";
export const PUBLIC_KEY_FILENAME_SUFFIX = "_public.pem";
export const PRIVATE_KEY_FILENAME_SUFFIX = ".pem";
export const NO_PASSPHRASE = "N/A";
export const PRIVATE_KEY_LABEL = "OCI_API_KEY";

const CONFIG_GENERATION_CANCELED_MESSAGE = "Config creation canceled.";
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._\-@]+$/;
const OCID_PATTERN =
  /^([0-9a-zA-Z_-]+[.:])([0-9a-zA-Z_-]*[.:]){3,}([0-9a-zA-Z_-]+)$/;
const HIDDEN_INPUT_MASK = "***";

const GENERATE_OCI_CONFIG_INSTRUCTIONS =
  "    This command provides a walkthrough of creating a valid CLI config file.\n\n" +
  "    The following links explain where to find the information required by this\n" +
  "    script:\n\n" +
  "    User API Signing Key, OCID and Tenancy OCID:\n\n" +
  "        https://docs.cloud.oracle.com/Content/API/Concepts/apisigningkey.htm#Other\n\n" +
  "    Region:\n\n" +
  "        https://docs.cloud.oracle.com/Content/General/Concepts/regions.htm\n\n" +
  "    General config documentation:\n\n" +
  "        https://docs.cloud.oracle.com/Content/API/Concepts/sdkconfig.htm\n\n\n";

const UPLOAD_PUBLIC_KEY_INSTRUCTIONS =
  "\n\n" +
  "    If you haven't already uploaded your API Signing public key through the\n" +
  "    console, follow the instructions on the page linked below in the section\n" +
  "    'How to upload the public key':\n\n" +
  "        https://docs.cloud.oracle.com/Content/API/Concepts/apisigningkey.htm#How2\n\n\n";

import {
  type StdinReader,
  createStdinReader,
  promptHiddenConfirmed,
  readHiddenLine,
} from "../core/stdin.ts";

export { type StdinReader, createStdinReader };

/**
 * cli_util.apply_user_only_access_permissions (Unix): 0o600 for files, 0o700 for directories.
 */
import { applyUserOnlyPermissions as applyUserOnlyAccessPermissions } from "../utils/applyUserOnlyPermissions.ts";
import { ensureDirectory as createDirectory } from "../utils/ensureDirectory.ts";
import { escapeRegExp } from "../utils/escapeRegExp.ts";
import { generateRsaKeyPair as generateKey } from "../utils/generateRsaKeyPair.ts";
import { publicKeyToMd5Fingerprint as publicKeyToFingerprint } from "../utils/publicKeyToMd5Fingerprint.ts";

export {
  applyUserOnlyAccessPermissions,
  createDirectory,
  generateKey,
  publicKeyToFingerprint,
};

/** cli_util.serialize_key for a public key (SubjectPublicKeyInfo PEM). */
export function serializePublicKey(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

/** cli_util.serialize_key for a private key (PKCS#8 PEM, encrypted when passphrase is given). */
export function serializePrivateKey(
  privateKey: KeyObject,
  passphrase?: string | null,
): string {
  if (passphrase) {
    return privateKey
      .export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase,
      })
      .toString();
  }
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Python os.path.join(dir, name) for POSIX paths without collapsing leading `./`. */
function pyPathJoin(dir: string, name: string): string {
  if (name.startsWith("/")) return name;
  if (dir === "") return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Python file.readline() in universal-newline text mode. */
function readFirstLine(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const nl = normalized.indexOf("\n");
  return nl === -1 ? normalized : normalized.slice(0, nl + 1);
}

/** Click `click.confirm(text, default=defaultValue, err=False)`. */
export async function confirmClick(
  io: Invocation,
  stdin: StdinReader,
  text: string,
  defaultValue = false,
  wrapExceptions = false,
): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]: " : "[y/N]: ";
  const prompt = `${text} ${suffix}`;
  while (true) {
    io.out(prompt);
    const line = await stdin.readLine();
    if (line === null) {
      io.err(wrapExceptions ? "Abort: \n" : "Aborted!\n");
      throw new Exit(1);
    }
    const normalized = line.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
    if (normalized === "") return defaultValue;
    io.out("Error: invalid input\n");
  }
}

/** Click `click.termui._mask_hidden_input`. */
function maskHiddenInput(message: string, value: string): string {
  let out = message.replaceAll(pyRepr(value), HIDDEN_INPUT_MASK);
  if (value) {
    out = out.replace(
      new RegExp(`(?<!\\w)${escapeRegExp(value)}(?!\\w)`, "g"),
      HIDDEN_INPUT_MASK,
    );
  }
  return out;
}

/** Click `click.prompt` subset used by `cli_setup`. */
async function promptClick<T = string>(
  io: Invocation,
  stdin: StdinReader,
  text: string,
  opts: {
    default?: string;
    hideInput?: boolean;
    wrapExceptions?: boolean;
    valueProc?: (value: string) => T | Promise<T>;
  } = {},
): Promise<T> {
  const prompt =
    opts.default !== undefined ? `${text} [${opts.default}]: ` : `${text}: `;
  const hideInput = opts.hideInput === true;
  const wrapExceptions = opts.wrapExceptions === true;

  while (true) {
    let value = "";
    while (true) {
      if (hideInput) {
        value = await readHiddenLine(io, stdin, prompt, wrapExceptions);
      } else {
        io.out(prompt);
        const line = await stdin.readLine();
        if (line === null) {
          io.err(wrapExceptions ? "Abort: \n" : "Aborted!\n");
          throw new Exit(1);
        }
        value = line;
      }
      if (value) break;
      if (opts.default !== undefined) {
        value = opts.default;
        break;
      }
    }
    if (!opts.valueProc) return value as unknown as T;
    try {
      return await opts.valueProc(value);
    } catch (e) {
      if (e instanceof BadParameter) {
        const message = hideInput
          ? maskHiddenInput(e.message, value)
          : e.message;
        io.out(`Error: ${message}\n`);
        continue;
      }
      throw e;
    }
  }
}

/** cli_setup.prompt_for_passphrase: hidden prompt with confirmation. */
export async function promptForPassphrase(
  io: Invocation,
  stdin: StdinReader,
  wrapExceptions = false,
): Promise<string | null> {
  const promptText = `Enter a passphrase for your private key ("${NO_PASSPHRASE}" for no passphrase): `;
  const value = await promptHiddenConfirmed(
    io,
    stdin,
    promptText,
    wrapExceptions,
  );
  return value === NO_PASSPHRASE ? null : value;
}

async function writePublicKeyToFile(
  io: Invocation,
  stdin: StdinReader,
  displayPath: string,
  diskPath: string,
  publicKey: KeyObject,
  overwrite: boolean,
): Promise<boolean> {
  if (
    !overwrite &&
    isFileSync(diskPath) &&
    !(await confirmClick(
      io,
      stdin,
      `File ${displayPath} already exists, do you want to overwrite?`,
    ))
  ) {
    return false;
  }
  writeFileSync(diskPath, serializePublicKey(publicKey));
  applyUserOnlyAccessPermissions(diskPath);
  io.out(`Public key written to: ${displayPath}\n`);
  return true;
}

async function writePrivateKeyToFile(
  io: Invocation,
  stdin: StdinReader,
  displayPath: string,
  diskPath: string,
  privateKey: KeyObject,
  passphrase: string | null,
  overwrite: boolean,
): Promise<boolean> {
  if (
    !overwrite &&
    isFileSync(diskPath) &&
    !(await confirmClick(
      io,
      stdin,
      `File ${displayPath} already exists, do you want to overwrite?`,
    ))
  ) {
    return false;
  }
  writeFileSync(
    diskPath,
    `${serializePrivateKey(privateKey, passphrase)}${PRIVATE_KEY_LABEL}`,
  );
  applyUserOnlyAccessPermissions(diskPath);
  io.out(`Private key written to: ${displayPath}\n`);
  return true;
}

/**
 * `oci setup repair-file-permissions --file <path>` (cli_setup.repair_file_permissions).
 */
export function runSetupRepairFilePermissions(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    usageError: (message: string) => never;
  },
): void {
  const rawFile = String(opts.values.file ?? "");
  const expanded = expandUser(rawFile, io.env);
  const resolved = resolve(io.cwd, expanded);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(resolved);
  } catch {
    opts.usageError(`Could not find file: ${expanded}`);
  }
  if (!st.isFile()) {
    opts.usageError("This command is only supported for files.");
  }
  applyUserOnlyAccessPermissions(resolved);
}

/**
 * `oci setup keys` (cli_setup.generate_key_pair).
 */
export async function runSetupKeys(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    usageError: (message: string) => never;
  },
): Promise<void> {
  const keyName =
    typeof opts.values.key_name === "string"
      ? opts.values.key_name
      : DEFAULT_KEY_NAME;
  const rawOutputDir =
    typeof opts.values.output_dir === "string"
      ? opts.values.output_dir
      : DEFAULT_DIRECTORY;
  let passphrase: string | null =
    typeof opts.values.passphrase === "string" ? opts.values.passphrase : null;
  const passphraseFile =
    typeof opts.values.passphrase_file === "string"
      ? opts.values.passphrase_file
      : undefined;
  const overwrite = opts.values.overwrite === true;

  if (passphraseFile !== undefined) {
    try {
      validateClickFileForRead(io, passphraseFile);
    } catch (e) {
      if (e instanceof BadParameter) {
        opts.usageError(`Invalid value for '--passphrase-file': ${e.message}`);
      }
      throw e;
    }
  }

  if (passphrase && passphraseFile) {
    opts.usageError(
      "Cannot specify both passphrase and passphrase-file options",
    );
  }

  const stdin = createStdinReader(io);

  if (passphraseFile) {
    const raw =
      passphraseFile === "-"
        ? await stdin.consumeAll()
        : readFileSync(resolve(io.cwd, passphraseFile), "utf8");
    const line = readFirstLine(raw);
    if (!line || /^\s*$/.test(line)) {
      opts.usageError(
        "passphrase-file must specify a password in the first line of the file",
      );
    }
    passphrase = line;
  }

  if (!passphrase) {
    passphrase = await promptForPassphrase(io, stdin);
  }

  const outputDir = expandUser(rawOutputDir, io.env);
  const resolvedDir = resolve(io.cwd, outputDir);
  if (!existsSync(resolvedDir)) {
    createDirectory(resolvedDir);
  }

  const { privateKey, publicKey } = generateKey();
  const publicDisplayPath = pyPathJoin(
    outputDir,
    `${keyName}${PUBLIC_KEY_FILENAME_SUFFIX}`,
  );
  const privateDisplayPath = pyPathJoin(
    outputDir,
    `${keyName}${PRIVATE_KEY_FILENAME_SUFFIX}`,
  );

  await writePublicKeyToFile(
    io,
    stdin,
    publicDisplayPath,
    resolve(io.cwd, publicDisplayPath),
    publicKey,
    overwrite,
  );
  await writePrivateKeyToFile(
    io,
    stdin,
    privateDisplayPath,
    resolve(io.cwd, privateDisplayPath),
    privateKey,
    passphrase,
    overwrite,
  );

  const fingerprint = publicKeyToFingerprint(publicKey);
  io.out(`Public key fingerprint: ${fingerprint}\n`);
  io.out(UPLOAD_PUBLIC_KEY_INSTRUCTIONS);
}

function validateProfileName(
  profileName: string,
  usageError: (message: string) => never,
): void {
  if (!profileName) {
    usageError("Profile name must be a non-empty string.");
  }
  if (!PROFILE_NAME_PATTERN.test(profileName)) {
    usageError(
      `Invalid profile name '${profileName}'. Profile names may only contain letters, numbers, '.', '_', '-', or '@'.`,
    );
  }
  if (profileName === "." || profileName === "..") {
    usageError(
      `Invalid profile name '${profileName}': Profile name cannot be '.' or '..'.`,
    );
  }
}

function validateOcid(ocid: string): string {
  if (!OCID_PATTERN.test(ocid)) {
    throw new BadParameter(
      "Invalid OCID format. Instructions to find OCIDs: https://docs.cloud.oracle.com/Content/API/Concepts/apisigningkey.htm#Other",
    );
  }
  return ocid;
}

function validatePrivateKeyFile(
  io: Invocation,
  filename: string,
): { filename: string; hasPassphrase: boolean; privateKey: KeyObject | null } {
  const expanded = expandUser(filename, io.env);
  const diskPath = resolve(io.cwd, expanded);
  if (!isFileSync(diskPath)) {
    throw new BadParameter(`No file found at: ${expanded}`);
  }
  const pem = readFileSync(diskPath, "utf8");
  try {
    const privateKey = loadPrivateKey(pem, null);
    return { filename: expanded, hasPassphrase: false, privateKey };
  } catch (e) {
    if (e instanceof MissingPrivateKeyPassphrase) {
      return { filename: expanded, hasPassphrase: true, privateKey: null };
    }
    throw new BadParameter(
      `Could not load file as private key. File: ${expanded}`,
    );
  }
}

function validatePrivateKeyPassphrase(
  filename: string,
  passphrase: string,
): { passphrase: string; privateKey: KeyObject } {
  // Python cryptography encodes passphrase as ASCII; non-ASCII raises UnicodeEncodeError (ValueError).
  if (/[^\x00-\x7f]/.test(passphrase)) {
    throw new BadParameter(
      "Incorrect passphrase, could not decrypt private key",
    );
  }
  const pem = readFileSync(filename, "utf8");
  try {
    const privateKey = loadPrivateKey(pem, passphrase);
    return { passphrase, privateKey };
  } catch {
    throw new BadParameter(
      "Incorrect passphrase, could not decrypt private key",
    );
  }
}

async function promptForConfigLocation(
  io: Invocation,
  stdin: StdinReader,
  defaultDir: string,
  usageError: (message: string) => never,
): Promise<{ configLocation: string | null; profileName: string | null }> {
  const defaultConfigPath = pyPathJoin(defaultDir, "config");
  const rawLocation = await promptClick(
    io,
    stdin,
    "Enter a location for your config",
    {
      default: defaultConfigPath,
      valueProc: (filename) => {
        const expanded = expandUser(filename, io.env);
        if (isDirSync(resolve(io.cwd, expanded))) {
          throw new BadParameter(
            "Config location must be a filename not a directory",
          );
        }
        return expanded;
      },
    },
  );
  const configLocation = resolve(io.cwd, rawLocation).replaceAll("\\", "/");

  if (existsSync(configLocation)) {
    try {
      const parsed = parseConfig(
        readFileSync(configLocation, "utf8"),
        configLocation,
      );
      if (
        await confirmClick(
          io,
          stdin,
          `Config file: ${configLocation} already exists. Do you want add a profile here? (If no, you will be prompted to overwrite the file)`,
          true,
        )
      ) {
        while (true) {
          const enteredName = await promptClick(
            io,
            stdin,
            "Enter the name of the profile you would like to create",
          );
          validateProfileName(enteredName, usageError);
          const sections = [...parsed.sections.keys()].map((s) =>
            s.toUpperCase(),
          );
          if (parsed.defaults.size > 0) sections.push(DEFAULT_PROFILE_NAME);
          const enteredUpper = enteredName.toUpperCase();
          if (sections.includes(enteredUpper)) {
            io.out(
              `Profile ${enteredUpper} already exists in config. Cannot specify a profile that conflicts with any existing profile(s): ${sections.join(", ")}\n`,
            );
            continue;
          }
          return { configLocation, profileName: enteredName };
        }
      }
    } catch (e) {
      if (!(e instanceof ConfigParserError)) throw e;
    }

    if (
      !(await confirmClick(
        io,
        stdin,
        `File: ${configLocation} already exists. Do you want to overwrite (Removes existing profiles!!!)?`,
        false,
      ))
    ) {
      return { configLocation: null, profileName: null };
    }
    unlinkSync(configLocation);
  } else {
    const dir = dirname(configLocation);
    if (dir && !existsSync(dir)) {
      createDirectory(dir);
    }
  }

  return { configLocation, profileName: DEFAULT_PROFILE_NAME };
}

export async function promptForRegion(
  io: Invocation,
  stdin: StdinReader,
  regions: RegionsSpec,
  wrapExceptions = false,
): Promise<string> {
  const sortedRegions = [...regions.regions].sort();
  const numeric = sortedRegions.map((r, i) => `${i + 1}: ${r}`);
  const lines: string[] = [];
  for (let i = 0; i < numeric.length; i += 5) {
    lines.push(numeric.slice(i, i + 5).join(", "));
  }
  const regionList = lines.join(",\n");
  const isValidIndex = (val: string) =>
    /^[0-9]+$/.test(val) &&
    Number(val) >= 1 &&
    Number(val) <= regions.regions.length;
  const isRecognizedRegion = async (val: string) => {
    const lower = val.toLowerCase();
    if (lower in regions.shortNames) return false;
    if (regions.regions.includes(lower)) return true;
    return (
      (await loadExternalRegionMetadata(lower, regions, io.env)) !== undefined
    );
  };

  let region: string | null = null;
  while (!region) {
    region = await promptClick<string | null>(
      io,
      stdin,
      `Enter a region by index or name(e.g.\n${regionList})`,
      {
        wrapExceptions,
        valueProc: async (val) => {
          if (!((await isRecognizedRegion(val)) || isValidIndex(val))) {
            io.out(
              `Unrecognized region: ${val}. Please enter a number between 1 to ${regions.regions.length}, or valid regions can be found here: https://docs.cloud.oracle.com/Content/General/Concepts/regions.htm\n`,
            );
            if (
              !(await confirmClick(
                io,
                stdin,
                "Continue with unrecognized region? (Enter 'n' to re-enter region)",
                false,
                wrapExceptions,
              ))
            ) {
              return null;
            }
          }
          return val;
        },
      },
    );
  }
  return isValidIndex(region)
    ? (sortedRegions[Number(region) - 1] as string)
    : region;
}

export function writeConfig(
  filename: string,
  opts: {
    userId?: string | null;
    fingerprint?: string | null;
    keyFile?: string | null;
    tenancy?: string | null;
    region?: string | null;
    passPhrase?: string | null;
    profileName?: string;
    securityTokenFile?: string | null;
    writeKeyFile?: boolean;
  },
): void {
  const existingFile = existsSync(filename);
  const profileName = opts.profileName ?? DEFAULT_PROFILE_NAME;
  const writeKeyFile = opts.writeKeyFile ?? true;
  let content = existingFile ? "\n\n" : "";
  content += `[${profileName}]\n`;
  if (opts.userId) content += `user=${opts.userId}\n`;
  if (opts.fingerprint) content += `fingerprint=${opts.fingerprint}\n`;
  if (writeKeyFile && opts.keyFile) content += `key_file=${opts.keyFile}\n`;
  content += `tenancy=${opts.tenancy ?? "None"}\n`;
  content += `region=${opts.region ?? "None"}\n`;
  if (opts.passPhrase) content += `pass_phrase=${opts.passPhrase}\n`;
  if (opts.securityTokenFile) {
    content += `security_token_file=${opts.securityTokenFile}\n`;
  }
  appendFileSync(filename, content);
  applyUserOnlyAccessPermissions(filename);
}

const DEFAULT_PROFILE_KEYS_TO_REMOVE = [
  "user",
  "fingerprint",
  "key_file",
  "tenancy",
  "region",
  "pass_phrase",
  "security_token_file",
];

/** Port of `cli_setup.remove_profile_from_config`. */
export function removeProfileFromConfig(
  diskConfigPath: string,
  displayConfigPath: string,
  profileNameToTerminate: string,
): void {
  let text: string | undefined;
  try {
    if (!isDirSync(diskConfigPath)) {
      text = readFileSync(diskConfigPath, "utf8");
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (
      code !== "ENOENT" &&
      code !== "ENOTDIR" &&
      code !== "EISDIR" &&
      code !== "EACCES"
    ) {
      throw e;
    }
  }
  if (profileNameToTerminate === DEFAULT_PROFILE_NAME) {
    const parsed =
      text !== undefined
        ? parseConfig(text, displayConfigPath)
        : { defaults: new Map(), sections: new Map() };
    for (const key of DEFAULT_PROFILE_KEYS_TO_REMOVE) {
      parsed.defaults.delete(key);
    }
    writeFileSync(diskConfigPath, formatParsedConfig(parsed), "utf8");
    return;
  }
  const parsed =
    text !== undefined
      ? parseConfig(text, displayConfigPath, "")
      : { defaults: new Map(), sections: new Map() };
  parsed.sections.delete(profileNameToTerminate);
  writeFileSync(diskConfigPath, formatParsedConfig(parsed, ""), "utf8");
}

/**
 * `oci setup config` (cli_setup.generate_oci_config).
 */
export async function runSetupConfig(
  io: Invocation,
  opts: {
    regions: RegionsSpec;
    usageError: (message: string) => never;
  },
): Promise<void> {
  const stdin = createStdinReader(io);
  io.out(GENERATE_OCI_CONFIG_INSTRUCTIONS);

  const defaultDir = expandUser(DEFAULT_DIRECTORY, io.env);
  const { configLocation, profileName } = await promptForConfigLocation(
    io,
    stdin,
    defaultDir,
    opts.usageError,
  );
  if (!configLocation || !profileName) {
    io.out(`${CONFIG_GENERATION_CANCELED_MESSAGE}\n`);
    return;
  }

  const userId = await promptClick(io, stdin, "Enter a user OCID", {
    valueProc: validateOcid,
  });
  const tenantId = await promptClick(io, stdin, "Enter a tenancy OCID", {
    valueProc: validateOcid,
  });
  const region = await promptForRegion(io, stdin, opts.regions);

  let keyPassphrase: string | null = null;
  let privateKeyFile: string;
  let fingerprint: string;

  if (
    await confirmClick(
      io,
      stdin,
      "Do you want to generate a new API Signing RSA key pair? (If you decline you will be asked to supply the path to an existing key.)",
      true,
    )
  ) {
    const rawKeyDir = await promptClick(
      io,
      stdin,
      "Enter a directory for your keys to be created",
      { default: defaultDir },
    );
    const keyLocation = resolve(
      io.cwd,
      expandUser(rawKeyDir, io.env),
    ).replaceAll("\\", "/");
    if (!existsSync(keyLocation)) {
      createDirectory(keyLocation);
    }

    const { privateKey, publicKey } = generateKey();
    const keyName = await promptClick(io, stdin, "Enter a name for your key", {
      default: DEFAULT_KEY_NAME,
    });
    const publicPath = pyPathJoin(
      keyLocation,
      `${keyName}${PUBLIC_KEY_FILENAME_SUFFIX}`,
    );
    if (
      !(await writePublicKeyToFile(
        io,
        stdin,
        publicPath,
        publicPath,
        publicKey,
        false,
      ))
    ) {
      io.out(`${CONFIG_GENERATION_CANCELED_MESSAGE}\n`);
      return;
    }

    keyPassphrase = await promptForPassphrase(io, stdin);
    privateKeyFile = pyPathJoin(
      keyLocation,
      `${keyName}${PRIVATE_KEY_FILENAME_SUFFIX}`,
    );
    if (
      !(await writePrivateKeyToFile(
        io,
        stdin,
        privateKeyFile,
        privateKeyFile,
        privateKey,
        keyPassphrase,
        false,
      ))
    ) {
      io.out(`${CONFIG_GENERATION_CANCELED_MESSAGE}\n`);
      return;
    }

    fingerprint = publicKeyToFingerprint(publicKey);
    io.out(`Fingerprint: ${fingerprint}\n`);
  } else {
    const validated = await promptClick(
      io,
      stdin,
      "Enter the location of your API Signing private key file",
      {
        valueProc: (filename) => validatePrivateKeyFile(io, filename),
      },
    );
    privateKeyFile = resolve(io.cwd, validated.filename).replaceAll("\\", "/");

    if (!readFileSync(privateKeyFile, "utf8").endsWith(PRIVATE_KEY_LABEL)) {
      const warning =
        `Warning: To increase security of your API key located at ${privateKeyFile}, ` +
        "append an extra line with 'OCI_API_KEY' at the end. For more information, " +
        "refer to https://docs.oracle.com/iaas/Content/API/Concepts/apisigningkey.htm";
      io.out(io.isTTY(1) ? `\x1b[33m${warning}\x1b[0m\n` : `${warning}\n`);
    }

    let privateKey = validated.privateKey;
    if (validated.hasPassphrase) {
      const decrypted = await promptClick(
        io,
        stdin,
        "Enter the passphrase for your private key",
        {
          hideInput: true,
          valueProc: (passphrase) =>
            validatePrivateKeyPassphrase(privateKeyFile, passphrase),
        },
      );
      keyPassphrase = decrypted.passphrase;
      privateKey = decrypted.privateKey;
    }

    fingerprint = publicKeyToFingerprint(
      createPublicKey(privateKey as KeyObject),
    );
    io.out(`Fingerprint: ${fingerprint}\n`);
  }

  if (
    keyPassphrase &&
    !(await confirmClick(
      io,
      stdin,
      "Do you want to write your passphrase to the config file? (If not, you will need to enter it when prompted each time you run an oci command)",
      false,
    ))
  ) {
    keyPassphrase = null;
  }

  writeConfig(configLocation, {
    userId,
    fingerprint,
    keyFile: privateKeyFile,
    tenancy: tenantId,
    region,
    passPhrase: keyPassphrase,
    profileName,
  });

  io.out(`Config written to ${configLocation}\n`);
  io.out(UPLOAD_PUBLIC_KEY_INSTRUCTIONS);
}

export const OCI_AUTOCOMPLETE_SCRIPT =
  "# coding: utf-8\n" +
  "# Copyright (c) 2016, 2026, Oracle and/or its affiliates. All rights reserved.\n" +
  "# This software is dual-licensed to you under the Universal Permissive License (UPL) 1.0 as shown at https://oss.oracle.com/licenses/upl or Apache License 2.0 as shown at http://www.apache.org/licenses/LICENSE-2.0. You may choose either license.\n\n" +
  "_oci_completion() {\n" +
  '    COMPREPLY=( $( env COMP_WORDS="${COMP_WORDS[*]}" \\\n' +
  "                   COMP_CWORD=$COMP_CWORD \\\n" +
  "                   _OCI_COMPLETE=complete $1 ) )\n" +
  "    return 0\n" +
  "}\n\n" +
  "complete -F _oci_completion -o default oci;";

/** Python os.path.realpath: resolves existing ancestor symlinks even when the leaf does not exist. */
function pyRealpath(rawPath: string, cwd: string): string {
  let current = resolve(cwd, rawPath);
  const tail: string[] = [];
  while (true) {
    try {
      const real = realpathSync(current);
      const out = tail.length ? join(real, ...tail.reverse()) : real;
      return out.replaceAll("\\", "/");
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        const out = tail.length ? join(current, ...tail.reverse()) : current;
        return out.replaceAll("\\", "/");
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}

async function promptInput(
  io: Invocation,
  stdin: StdinReader,
  msg: string,
): Promise<string> {
  io.out(`\n===> ${msg}`);
  const line = await stdin.readLine();
  if (line === null) {
    io.err("EOFError: EOF when reading a line\n");
    throw new Exit(1);
  }
  return line;
}

async function promptYN(
  io: Invocation,
  stdin: StdinReader,
  msg: string,
  defaultValue: "y" | "n" | null = null,
): Promise<boolean> {
  const y = defaultValue === "y" ? "Y" : "y";
  const n = defaultValue === "n" ? "N" : "n";
  while (true) {
    const ans = await promptInput(io, stdin, `${msg} (${y}/${n}): `);
    if (ans.toLowerCase() === "n") return false;
    if (ans.toLowerCase() === "y") return true;
    if (defaultValue && !ans) return defaultValue === "y";
  }
}

async function promptInputWithDefault(
  io: Invocation,
  stdin: StdinReader,
  msg: string,
  defaultValue: string | null,
): Promise<string> {
  if (defaultValue) {
    return (
      (await promptInput(
        io,
        stdin,
        `${msg} (leave blank to use '${defaultValue}'): `,
      )) || defaultValue
    );
  }
  return promptInput(io, stdin, `${msg}: `);
}

/**
 * `oci setup autocomplete` (cli_setup.setup_autocomplete / setup_autocomplete_non_windows).
 */
export async function runSetupAutocomplete(io: Invocation): Promise<void> {
  const stdin = createStdinReader(io);
  const isDarwin =
    (io.env.BOCI_SETUP_PLATFORM ?? process.platform) === "darwin";
  const userBashRc = expandUser("~/.bashrc", io.env);
  const userBashProfile = expandUser("~/.bash_profile", io.env);

  io.out(
    "To set up autocomplete, we would update few lines in rc/bash_profile file.\n",
  );

  const bashrcExists = isFileSync(userBashRc);
  const bashProfileExists = isFileSync(userBashProfile);
  let defaultRcFile: string | null;
  if (!bashrcExists && bashProfileExists) {
    defaultRcFile = userBashProfile;
  } else if (bashrcExists && bashProfileExists && isDarwin) {
    defaultRcFile = userBashProfile;
  } else {
    defaultRcFile = bashrcExists ? userBashRc : null;
  }

  let rcFile: string | null = null;
  if (!defaultRcFile) {
    const candidate = isDarwin ? userBashProfile : userBashRc;
    const createNow = await promptYN(
      io,
      stdin,
      `Could not automatically find a suitable file to use. Create ${candidate} now?`,
      "y",
    );
    if (createNow) {
      appendFileSync(candidate, "");
      rcFile = candidate;
    }
  }

  if (!rcFile) {
    rcFile = await promptInputWithDefault(
      io,
      stdin,
      "Enter a path to an rc file to update (file will be created if it does not exist)",
      defaultRcFile,
    );
  }

  let rcFilePath: string | null = null;
  if (rcFile) {
    rcFilePath = pyRealpath(expandUser(rcFile, io.env), io.cwd);
    if (!isFileSync(rcFilePath)) {
      io.out(`-- Automatically created rc file at '${rcFilePath}'\n`);
    }
  }

  if (!rcFilePath) {
    io.err("CLIInstallError: No suitable profile file found.\n");
    throw new Exit(1);
  }

  const completionScriptFile = pyPathJoin(
    expandUser("~/.oci", io.env),
    "bin/oci_autocomplete.sh",
  );
  io.out(`Using tab completion script at: ${completionScriptFile}\n`);

  const softLink = expandUser("~/lib/oci_autocomplete.sh", io.env);
  const bashProfileLine = `[[ -e "${softLink}" ]] && source "${softLink}"`;
  const confirmPrompt = `We need to add a few lines to your ${rcFilePath} file. Please confirm this is ok.`;

  if (await confirmClick(io, stdin, confirmPrompt, true)) {
    if (existsSync(softLink)) {
      setPosixMode(softLink, 0o644);
      unlinkSync(softLink);
    }
    try {
      const scriptDir = dirname(completionScriptFile);
      if (!isDirSync(scriptDir)) mkdirSync(scriptDir, { recursive: true });
      writeFileSync(completionScriptFile, OCI_AUTOCOMPLETE_SCRIPT, {
        mode: 0o644,
      });
      setPosixMode(completionScriptFile, 0o644);
      const linkDir = dirname(softLink);
      if (!isDirSync(linkDir)) mkdirSync(linkDir, { recursive: true });
      symlinkSync(completionScriptFile, softLink);
    } catch {
      io.out(
        `Unable to symlink ~/lib/oci_autocomplete.sh to ${bashProfileLine}. \nAdd '${bashProfileLine}' to your rc file and restart your terminal for the changes to take effect.\n`,
      );
      return;
    }

    const existingContent = existsSync(rcFilePath)
      ? readFileSync(rcFilePath, "utf8")
      : "";
    if (!existingContent.includes("lib/oci_autocomplete.sh")) {
      appendFileSync(rcFilePath, `\n${bashProfileLine}\n`);
    } else {
      io.out(
        `It looks like tab completion for oci is already configured in ${rcFilePath}. If you want to re-run the setup command please remove the line containing 'oci_autocomplete.sh' from ${rcFilePath} and run oci setup authenticate again.\n\n`,
      );
    }

    io.out(
      `Success! \n Restart your terminal or Run '${bashProfileLine}' for the changes to take effect.\n`,
    );
  } else {
    io.out("Exiting script. Tab completion not set up.\n");
  }
}
