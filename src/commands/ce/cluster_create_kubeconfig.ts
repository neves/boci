// Reference: services/container_engine/src/oci_cli_container_engine/containerengine_cli_extended.py:607 (76 lines)
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { expandUser } from "../../core/config.ts";
import { printResult } from "../../core/output.ts";
import { expandVars } from "../../core/rc.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { pyStrip } from "../../lib/configparser.ts";
import {
  callCommand,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";
import { Exit, type Invocation } from "../../lib/io.ts";
import { dumpYaml } from "../../utils/dumpYaml.ts";

const DEFAULT_KUBECONFIG_LOCATION = "~/.kube/config";
const DEFAULT_TOKEN_VERSION = "2.0.0";
const KUBECONFIG_ROOT_KEYS = [
  "apiVersion",
  "kind",
  "preferences",
  "current-context",
] as const;

const createKubeconfigOperation: OperationSpec = {
  client: "container_engine.container_engine",
  method: "create_kubeconfig",
  http: "POST",
  path: "/clusters/{clusterId}/kubeconfig/content",
  pathParams: {
    clusterId: "cluster_id",
  },
  queryParams: {},
  headerParams: {
    accept: {
      value: "application/x-yaml",
    },
    "content-type": {
      value: "application/json",
    },
    "opc-request-id": {
      arg: "opc_request_id",
    },
  },
  body: "create_cluster_kubeconfig_content_details",
  responseType: "stream",
};

const createKubeconfigBindings: Record<string, unknown>[] = [
  {
    target: "kwarg",
    key: ["opc_request_id"],
    transform: "use_or_generate_request_id",
  },
  {
    target: "body",
    key: ["tokenVersion"],
    param: "token_version",
    when: "token_version is not None",
  },
  {
    target: "body",
    key: ["expiration"],
    param: "expiration",
    when: "expiration is not None",
  },
  {
    target: "body",
    key: ["endpoint"],
    param: "kube_endpoint",
    when: "kube_endpoint is not None",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Append `--auth` and `--profile` to `users[0].user.exec.args` when present,
 * matching Python's `KeyError`/`IndexError` bail-out (which skips re-dumping).
 */
function enrichWithAuthContext(
  kubeconfig: unknown,
  auth: string,
  profile: string,
): boolean {
  if (!isRecord(kubeconfig) || !("users" in kubeconfig)) return false;
  const users = kubeconfig.users;
  if (!Array.isArray(users) || users.length === 0) return false;
  const firstUser = users[0];
  if (!isRecord(firstUser) || !("user" in firstUser)) return false;
  const userObj = firstUser.user;
  if (!isRecord(userObj) || !("exec" in userObj)) return false;
  const execObj = userObj.exec;
  if (!isRecord(execObj) || !("args" in execObj)) return false;
  const args = execObj.args;
  if (!Array.isArray(args)) return false;
  if (auth) args.push("--auth", auth);
  if (profile) args.push("--profile", profile);
  return true;
}

function mergeKubeconfigSection(
  dst: Record<string, unknown>,
  src: Record<string, unknown>,
  key: string,
): void {
  const srcList = src[key];
  if (srcList === null || srcList === undefined) return;
  if (!Array.isArray(srcList)) return;
  if (dst[key] === null || dst[key] === undefined) dst[key] = [];
  if (!Array.isArray(dst[key])) return;
  const dstList = dst[key] as Record<string, unknown>[];
  const snapshot = [...dstList];
  for (const item of srcList as Record<string, unknown>[]) {
    let matched = false;
    for (let idx = 0; idx < snapshot.length; idx++) {
      if (item?.name === snapshot[idx]?.name) {
        matched = true;
        dstList[idx] = item;
      }
    }
    if (!matched) dstList.push(item);
  }
}

function mergeKubeconfig(
  io: Invocation,
  newKubeconfig: string,
  diskPath: string,
): void {
  if (statSync(diskPath).size === 0) {
    writeFileSync(diskPath, newKubeconfig, "utf8");
    return;
  }
  const existingText = readFileSync(diskPath, "utf8");
  let existingYaml: unknown;
  let newYaml: unknown;
  try {
    existingYaml = Bun.YAML.parse(existingText);
    newYaml = Bun.YAML.parse(newKubeconfig);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    io.out(`Error parsing configuration file ${message}\n`);
    return;
  }
  if (!isRecord(existingYaml) || !isRecord(newYaml)) {
    writeFileSync(diskPath, dumpYaml(existingYaml), "utf8");
    return;
  }
  for (const key of KUBECONFIG_ROOT_KEYS) {
    if (key in newYaml) existingYaml[key] = newYaml[key];
  }
  mergeKubeconfigSection(existingYaml, newYaml, "clusters");
  mergeKubeconfigSection(existingYaml, newYaml, "contexts");
  mergeKubeconfigSection(existingYaml, newYaml, "users");
  writeFileSync(diskPath, dumpYaml(existingYaml), "utf8");
}

export async function runCeClusterCreateKubeconfig(
  ctx: CustomCommandContext,
): Promise<void> {
  const clusterId = ctx.values.cluster_id;
  if (typeof clusterId === "string" && pyStrip(clusterId) === "") {
    ctx.io.err(
      "UsageError: Parameter --cluster-id cannot be whitespace or empty string\n",
    );
    throw new Exit(1);
  }

  const command = sdkCommand(
    ctx,
    "cluster create-kubeconfig",
    createKubeconfigOperation,
    createKubeconfigBindings,
  );
  const callValues = {
    ...ctx.values,
    token_version: ctx.values.token_version ?? DEFAULT_TOKEN_VERSION,
  };
  const result = await callCommand(
    ctx,
    "ce",
    "cluster create-kubeconfig",
    callValues,
    command,
  );
  if (!result.response.ok) {
    printResult(ctx.io, result, outputOptions(ctx));
    return;
  }

  let newKubeconfig = result.raw;
  const withAuthContext = ctx.values.with_auth_context === true;
  // cli_util.build_client populates ctx.obj['auth'] with 'api_key' when unset.
  const auth = ctx.settings.auth ?? "api_key";
  const profile = ctx.settings.profile ?? "";

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(newKubeconfig);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.io.out(`Error parsing configuration file ${message}\n`);
    return;
  }

  if (
    !withAuthContext ||
    (!auth && !profile) ||
    enrichWithAuthContext(parsed, auth, profile)
  ) {
    newKubeconfig = dumpYaml(parsed);
  }

  const rawFile =
    typeof ctx.values.file === "string"
      ? ctx.values.file
      : DEFAULT_KUBECONFIG_LOCATION;
  const file = expandVars(expandUser(rawFile, ctx.io.env), ctx.io.env);

  if (file === "-") {
    ctx.io.out(`${newKubeconfig}\n`);
    return;
  }

  const diskPath = resolve(ctx.io.cwd, file);
  if (ctx.values.overwrite === true || !isRegularFile(diskPath)) {
    const dir = dirname(diskPath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(diskPath, newKubeconfig, "utf8");
    ctx.io.out(`New config written to the Kubeconfig file ${file}\n`);
    return;
  }

  mergeKubeconfig(ctx.io, newKubeconfig, diskPath);
  ctx.io.out(
    `Existing Kubeconfig file found at ${file} and new config merged into it\n`,
  );
}
