// Reference: services/container_engine/src/oci_cli_container_engine/containerengine_cli_extended.py:30 (61 lines)
import { createServiceClient } from "../../core/operation.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { signRequest } from "../../core/signer.ts";
import { pyStrip } from "../../lib/configparser.ts";
import { Exit } from "../../lib/io.ts";

const OBO_GENERIC_HEADERS = [
  "date",
  "(request-target)",
  "host",
  "opc-obo-token",
] as const;

/** Python 3.12 `urllib.parse.quote_plus` (leaves A-Za-z0-9_.-~ unescaped, spaces -> '+'). */
function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("%20", "+")
    .replace(
      /[!'()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/**
 * Match Python's `requests.Request("GET", url, params=header_params).prepare().url`
 * for `generate-token`.
 */
export function buildPresignedTokenUrl(
  baseUrl: string,
  params: readonly [string, string][],
): string {
  const preparedBase = new URL(baseUrl).href;
  const query = params
    .map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`)
    .join("&");
  const sep = preparedBase.includes("?") ? "&" : "?";
  return `${preparedBase}${sep}${query}`;
}

/** Python's `base64.urlsafe_b64encode(text.encode('utf-8')).decode('utf-8')` (keeps `=` padding). */
export function urlsafeBase64Encode(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

/** Python's `(datetime.utcnow() + timedelta(minutes=4)).isoformat('T') + "Z"`. */
export function formatExpirationTimestamp(nowMs = Date.now()): string {
  return new Date(nowMs + 4 * 60 * 1000)
    .toISOString()
    .replace(/\.(\d{3})Z$/, ".$1000Z");
}

export async function runCeClusterGenerateToken(
  ctx: CustomCommandContext,
): Promise<void> {
  const clusterId = ctx.values.cluster_id;
  if (typeof clusterId === "string" && pyStrip(clusterId) === "") {
    ctx.io.err(
      "UsageError: Parameter --cluster-id cannot be whitespace or empty string\n",
    );
    throw new Exit(1);
  }

  const clientSpec = (ctx.spec.clients["container_engine.container_engine"] ??
    {}) as Record<string, unknown>;
  const sc = await createServiceClient(ctx.io, {
    client: clientSpec,
    values: ctx.values,
    rootValues: ctx.rootValues,
    settings: ctx.settings,
    index: ctx.index,
  });

  if (sc.configRegion === undefined) {
    ctx.io.err("KeyError: 'region'\n");
    throw new Exit(1);
  }

  const rawUrl = `https://containerengine.${sc.configRegion}.oraclecloud.com/cluster_request/${String(clusterId)}`;
  const preparedUrl = new URL(rawUrl).href;
  const headers: Record<string, string> = {};
  if (sc.delegationToken !== undefined) {
    headers["opc-obo-token"] = sc.delegationToken;
  }

  const req = {
    method: "GET",
    url: preparedUrl,
    headers,
  };
  signRequest(
    req,
    { keyId: sc.keyId, privateKey: sc.privateKey },
    true,
    sc.delegationToken !== undefined ? OBO_GENERIC_HEADERS : undefined,
  );

  const headerParams: [string, string][] = [
    ["authorization", req.headers.authorization ?? ""],
    ["date", req.headers.date ?? ""],
  ];
  if (sc.delegationToken !== undefined) {
    headerParams.push(["opc-obo-token", sc.delegationToken]);
  }

  const tokenUrl = buildPresignedTokenUrl(preparedUrl, headerParams);
  const token = urlsafeBase64Encode(tokenUrl);
  const expirationTimestamp = formatExpirationTimestamp();

  const execCredential =
    `\n{\n` +
    `    "apiVersion": "client.authentication.k8s.io/v1beta1",\n` +
    `    "kind": "ExecCredential",\n` +
    `    "status": {\n` +
    `        "token": "${token}",\n` +
    `        "expirationTimestamp": "${expirationTimestamp}"\n` +
    `    }\n` +
    `}\n    \n`;
  ctx.io.out(execCredential);
}
