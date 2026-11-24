import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  configPath,
  DEFAULT_LOCATION,
  DEFAULT_PROFILE,
  expandUser,
  FALLBACK_DEFAULT_LOCATION,
} from "../../core/config.ts";
import { renderCliData } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import {
  ConfigParserError,
  parseConfig,
  sectionItems,
} from "../../lib/configparser.ts";
import { outputOptions } from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";

const credentialFields = [
  "key_file",
  "security_token_file",
  "delegation_token_file",
] as const;

async function loadProfiles({ io, settings }: CustomCommandContext) {
  const path = configPath(settings.configFile, io.env, io.cwd);
  try {
    const file = Bun.file(resolve(io.cwd, path));
    return { path, config: parseConfig(await file.text(), path) };
  } catch (error) {
    const message =
      error instanceof ConfigParserError
        ? `Could not read config file ${path}: ${error.message}`
        : `Config file not found: ${path}`;
    io.err(`ClickException: ${message}\n`);
    throw new Exit(1);
  }
}

async function inspectProfile(
  ctx: CustomCommandContext,
  values: Map<string, string | null>,
) {
  const { io } = ctx;
  const files = await Promise.all(
    credentialFields.map(async (field) => {
      const value = values.get(field);
      const path = value ? expandUser(value, io.env) : null;
      const exists =
        path &&
        (await stat(resolve(io.cwd, path)).then(
          (entry) => entry.isFile(),
          () => false,
        ));
      return {
        field,
        path,
        status: !path ? "not_configured" : exists ? "present" : "missing",
      };
    }),
  );
  let authType = "unknown";
  if (values.get("security_token_file")) authType = "security_token";
  else if (values.get("delegation_token_file")) authType = "instance_obo_user";
  else if (
    ["key_file", "fingerprint", "user"].some((field) => values.get(field))
  )
    authType = "api_key";

  return {
    files,
    authType,
    region: values.get("region") ?? null,
    details: {
      tenancy: values.get("tenancy") ?? null,
      user: values.get("user") ?? null,
      fingerprint: values.get("fingerprint") ?? null,
      ...Object.fromEntries(
        files.map(({ field, status }) => [
          `${field.replaceAll("_", "-")}-status`,
          status,
        ]),
      ),
    },
  };
}

function render(ctx: CustomCommandContext, data: unknown) {
  renderCliData(ctx.io, { data }, null, outputOptions(ctx), {
    nestDataInDataAttribute: false,
  });
}

export async function runProfileList(ctx: CustomCommandContext) {
  const { config, path } = await loadProfiles(ctx);
  const names = [...config.sections.keys()];
  if (config.defaults.size) names.unshift(DEFAULT_PROFILE);
  const profiles = await Promise.all(
    names.map(async (name) => {
      const values = sectionItems(config, name)!;
      const { authType, region, details } = await inspectProfile(ctx, values);
      return {
        name,
        active: name === ctx.settings.profile,
        "config-file": path,
        "auth-type": authType,
        region,
        ...details,
      };
    }),
  );
  render(ctx, profiles);
}

const requiredFields: Record<string, string[]> = {
  api_key: ["user", "tenancy", "fingerprint", "key_file"],
  security_token: ["key_file", "security_token_file"],
  instance_obo_user: ["delegation_token_file"],
};

type Finding = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  field?: string;
  path?: string;
};

export async function runProfileDiagnose(ctx: CustomCommandContext) {
  const { io, rootValues, settings } = ctx;
  const { config, path } = await loadProfiles(ctx);
  const name = settings.profile;
  const label = `Profile '${name}'`;
  const values =
    name === DEFAULT_PROFILE && !config.defaults.size
      ? undefined
      : sectionItems(config, name);
  const profile = values && (await inspectProfile(ctx, values));
  const region = profile?.region ?? null;
  const authType = profile?.authType ?? "unknown";
  const envRegion = io.env.OCI_CLI_REGION;
  const envAuth = io.env.OCI_CLI_AUTH;
  const effectiveRegion = rootValues.region || envRegion || region;
  const effectiveAuth = settings.auth || "api_key";
  const findings: Finding[] = [];
  const localPath = (file: string) => resolve(io.cwd, expandUser(file, io.env));

  if (
    localPath(settings.configFile) === localPath(DEFAULT_LOCATION) &&
    localPath(path) === localPath(FALLBACK_DEFAULT_LOCATION)
  ) {
    findings.push({
      severity: "info",
      code: "config_path_fallback_used",
      path,
      message: `Using fallback config path ${path} because the default config path was not used.`,
    });
  }

  if (!profile || !values) {
    findings.push({
      severity: "error",
      code: "missing_profile",
      message: `${label} does not exist in config file ${path}.`,
    });
  } else {
    if (authType === "unknown") {
      findings.push({
        severity: "error",
        code: "unknown_auth_type",
        message: `${label} does not have enough local fields to infer auth type.`,
      });
    }
    for (const field of requiredFields[effectiveAuth] ?? []) {
      if (!values.get(field)) {
        findings.push({
          severity: "error",
          code: "missing_required_field",
          field,
          message: `${label} is missing required field '${field}' for auth type '${effectiveAuth}'.`,
        });
      }
    }
    if (!effectiveRegion) {
      findings.push({
        severity: "error",
        code: "region_missing",
        field: "region",
        message: `${label} has no region and OCI_CLI_REGION is not set.`,
      });
    }
    for (const file of profile.files) {
      if (file.status === "missing" && file.path) {
        findings.push({
          severity: "error",
          code: "missing_credential_file",
          field: file.field,
          path: file.path,
          message: `${label} references ${file.field} that does not exist: ${file.path}`,
        });
      }
    }
    const tokens = ["security_token_file", "delegation_token_file"].filter(
      (field) => values.get(field),
    );
    const apiKey = ["user", "fingerprint"].filter((field) => values.get(field));
    if (tokens.length > 1) {
      findings.push({
        severity: "warning",
        code: "ambiguous_auth_config",
        field: tokens.join(","),
        message: `${label} has multiple token auth fields configured: ${tokens.join(", ")}.`,
      });
    }
    if (tokens.length && apiKey.length) {
      const fields = [...tokens, ...apiKey];
      findings.push({
        severity: "warning",
        code: "ambiguous_auth_config",
        field: fields.join(","),
        message: `${label} mixes token auth fields with API-key-only fields: ${fields.join(", ")}.`,
      });
    }
    if (!rootValues.region && envRegion && region && envRegion !== region) {
      findings.push({
        severity: "info",
        code: "region_overridden_by_env",
        field: "region",
        message: `OCI_CLI_REGION overrides profile region '${region}' with '${envRegion}'.`,
      });
    }
    if (
      !rootValues.auth &&
      envAuth &&
      authType !== "unknown" &&
      envAuth !== authType
    ) {
      findings.push({
        severity: "warning",
        code: "auth_overridden_by_env",
        field: "auth",
        message: `OCI_CLI_AUTH overrides inferred profile auth type '${authType}' with '${envAuth}'.`,
      });
    }
  }

  let status = "ok";
  if (findings.some(({ severity }) => severity === "error")) status = "error";
  else if (findings.some(({ severity }) => severity === "warning"))
    status = "warning";
  render(ctx, {
    status,
    profile: name,
    active: Boolean(profile),
    "config-file": path,
    region,
    "effective-region": effectiveRegion,
    "auth-type": authType,
    "effective-auth-type": effectiveAuth,
    findings,
    ...profile?.details,
  });
}
