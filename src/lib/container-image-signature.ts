import { fromFile } from "../core/config.ts";
import type { CustomCommandContext } from "../core/registry.ts";
import { printResult } from "../core/output.ts";
import { callCommand, outputOptions } from "./custom-command.ts";
import { Exit } from "./io.ts";

const legacyKmsRegions = new Set([
  "us-ashburn-1",
  "us-phoenix-1",
  "us-seattle-1",
  "eu-frankfurt-1",
  "uk-london-1",
  "ap-melbourne-1",
  "ap-mumbai-1",
  "ap-osaka-1",
  "ap-seoul-1",
  "ap-sydney-1",
  "ap-tokyo-1",
  "eu-amsterdam-1",
  "eu-zurich-1",
  "ca-montreal-1",
  "ca-toronto-1",
  "me-jeddah-1",
  "sa-saopaulo-1",
  "us-luke-1",
  "us-langley-1",
  "us-gov-ashburn-1",
  "us-gov-chicago-1",
  "us-gov-phoenix-1",
  "uk-gov-london-1",
]);

export function signatureError(
  ctx: CustomCommandContext,
  message: string,
): never {
  ctx.io.err(message + "\n");
  throw new Exit(1);
}

export function signatureRegion(ctx: CustomCommandContext): string | undefined {
  const { io, settings, rootValues } = ctx;
  try {
    const config = fromFile(
      settings.configFile,
      settings.profile,
      io.env,
      io.cwd,
    );
    return (rootValues.region ||
      io.env.OCI_CLI_REGION ||
      config.region ||
      undefined) as string | undefined;
  } catch {
    return undefined;
  }
}

function domain(ctx: CustomCommandContext, region: string | undefined): string {
  const realm = region && ctx.index.regions.regionRealms[region];
  if (!realm) signatureError(ctx, "KeyError: None");
  return ctx.index.regions.realms[realm]!;
}

export function registryEndpoint(
  ctx: CustomCommandContext,
  region: string | undefined,
): string {
  return `https://artifacts.${region}.oci.${domain(ctx, region)}`;
}

export function vaultEndpoint(
  ctx: CustomCommandContext,
  keyId: string,
  region: string | undefined,
): string {
  const vault = /ocid1\.key\.[\w-]+\.[\w-]+\.([\w-]+)\.\w{60}/.exec(keyId)?.[1];
  if (!vault)
    signatureError(
      ctx,
      "ClickException: Failed to split key ocid. Please check the kms_key_id is correct.",
    );
  const infix = region && legacyKmsRegions.has(region) ? "" : ".oci";
  return `https://${vault}-crypto.kms.${region}${infix}.${domain(ctx, region)}`;
}

export async function signatureRequest(
  ctx: CustomCommandContext,
  service: string,
  name: string,
  values: Record<string, unknown>,
  endpoint: string,
) {
  const result = await callCommand(
    { ...ctx, rootValues: { ...ctx.rootValues, endpoint } },
    service,
    name,
    values,
  );
  if (!result.response.ok) printResult(ctx.io, result, outputOptions(ctx));
  return result;
}
