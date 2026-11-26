// Run a CLI (oci, boci, or a stand-in) the same way for every Parity case:
// isolated sandbox HOME + fake config, a fresh fake endpoint, `{endpoint}` and
// `{config}` placeholders in argv substituted, everything observable captured.
// runCli spawns a process; runInProcess calls boci's run() in this process with the same
// sandbox environment (no spawn, module load or spec parsing per case).
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import { getPosixMode } from "../../src/lib/posixMode.ts";
import {
  type CapturedRequest,
  type Reply,
  startFakeEndpoint,
} from "./fake-endpoint.ts";
import { startFakeHttpsProxy } from "./fake-https-proxy.ts";
import {
  type FakeMetadataService,
  type MetadataServiceOptions,
  startFakeMetadataService,
} from "./fake-metadata.ts";
import {
  FAKE_KEY_PEM,
  PROXY_ENV,
  createSandbox,
  type Sandbox,
  type SandboxOptions,
  sharedSandbox,
} from "./sandbox.ts";

const ROOT = join(import.meta.dir, "..", "..");

export const CLIS = {
  /** The Reference CLI. Only `bun run golden` runs it, never `bun test` (ADR 0004). */
  oci: [Bun.which("oci") ?? "oci"],
  /** From source by default; BOCI_BIN=dist/boci runs the suite against the compiled binary. */
  boci: process.env.BOCI_BIN
    ? [join(ROOT, process.env.BOCI_BIN)]
    : ["bun", join(ROOT, "src", "main.ts")],
} as const;

export type Run = {
  stdout: string;
  stderr: string;
  exitCode: number;
  requests: CapturedRequest[];
  /** Ephemeral public key captured by the fake federation endpoint, when instanceMetadata is enabled. */
  sessionPublicKey?: string;
  /** Contents of requested sandbox files after the invocation finishes. */
  files?: Record<string, string>;
  /** Unix mode bits (`mode & 0o777`) of requested sandbox files after the invocation finishes. */
  fileModes?: Record<string, number>;
};

export type RunOptions = {
  replies?: Reply | Reply[];
  stdin?: string;
  env?: Record<string, string>;
  /** Extra lines appended to the sandbox config file. */
  config?: string;
  sandbox?: SandboxOptions;
  instanceMetadata?: boolean | MetadataServiceOptions;
  httpsProxy?: boolean;
  /** Paths relative to the sandbox HOME to read back after the command finishes. */
  captureFiles?: string[];
  /** Paths relative to the sandbox HOME whose Unix mode bits to read back after the command finishes. */
  captureFileModes?: string[];
  /** Kill the spawned process and reject if it runs longer than this many milliseconds. */
  timeoutMs?: number;
};

/** Starts one CLI process and collects what it printed; Bun.spawn unless replaced. */
export type Launcher = (
  cmd: string[],
  io: {
    cwd: string;
    env: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const spawnLauncher: Launcher = async (
  cmd,
  { cwd, env, stdin, timeoutMs },
) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          try {
            proc.kill("SIGKILL");
          } catch {
            /* process may already have exited */
          }
        }, timeoutMs);
  const stdoutP = new Response(proc.stdout).text().catch(() => "");
  const stderrP = new Response(proc.stderr).text().catch(() => "");
  try {
    const exitCode = await proc.exited;
    if (timedOut) {
      proc.stdout.cancel().catch(() => {});
      proc.stderr.cancel().catch(() => {});
      throw new Error(`timeout after ${(timeoutMs ?? 0) / 1000}s`);
    }
    const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
    return { stdout, stderr, exitCode };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export async function runCli(
  cli: readonly string[],
  argv: string[],
  opts: RunOptions = {},
  launch: Launcher = spawnLauncher,
): Promise<Run> {
  await using sb = await createSandbox(opts.config, opts.sandbox);
  using fake = startFakeEndpoint(opts.replies);
  using httpsProxy = opts.httpsProxy
    ? await startFakeHttpsProxy(opts.replies)
    : undefined;
  using metadata = opts.instanceMetadata
    ? startFakeMetadataService(
        opts.instanceMetadata === true ? {} : opts.instanceMetadata,
      )
    : undefined;
  const proxyEnv = httpsProxy
    ? {
        HTTPS_PROXY: httpsProxy.proxyUrl,
        https_proxy: httpsProxy.proxyUrl,
        REQUESTS_CA_BUNDLE: httpsProxy.caCertPath,
      }
    : undefined;
  const { stdout, stderr, exitCode } = await launch(
    [...cli, ...substitute(argv, sb, fake.url, metadata)],
    {
      cwd: sb.home,
      env: {
        ...sb.env,
        ...proxyEnv,
        ...substituteEnv(opts.env, sb, fake.url, metadata),
      },
      stdin: opts.stdin,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    },
  );
  const files = await readCapturedFiles(sb.home, opts.captureFiles);
  const fileModes = await readCapturedFileModes(sb.home, opts.captureFileModes);
  const requests = httpsProxy
    ? [...fake.requests, ...httpsProxy.requests]
    : fake.requests;
  return captured(
    sb,
    fake.url,
    stdout,
    stderr,
    exitCode,
    requests,
    metadata,
    files,
    fileModes,
  );
}

/**
 * boci's run() in this process, observing what a spawned `boci` would: same argv, env, cwd
 * and stdin, stdout/stderr captured, no terminal. The sandbox is shared between runs with
 * the same config (unless captureFiles or captureFileModes is set, indicating the command
 * mutates the sandbox).
 * Network: fetch reads the proxy settings from this process, so the sandbox's dead-proxy
 * safety net is installed here once.
 */
export async function runInProcess(
  argv: string[],
  opts: RunOptions = {},
): Promise<Run> {
  installProxySafetyNet();
  const mayMutateHome =
    opts.env?.OCI_CLI_AUTO_PROMPT !== undefined ||
    argv.some(
      (a) =>
        a === "--cli-auto-prompt" ||
        a === "--file" ||
        a.startsWith("--file=") ||
        a === "--output-file" ||
        a.startsWith("--output-file=") ||
        (a.startsWith("-") && !a.startsWith("--") && a.includes("i")),
    );
  const isolated = Boolean(
    opts.captureFiles?.length ||
    opts.captureFileModes?.length ||
    opts.httpsProxy ||
    mayMutateHome,
  );
  const sb = isolated
    ? await createSandbox(opts.config, opts.sandbox)
    : await sharedSandbox(opts.config, opts.sandbox);
  try {
    using fake = startFakeEndpoint(opts.replies);
    using httpsProxy = opts.httpsProxy
      ? await startFakeHttpsProxy(opts.replies)
      : undefined;
    using metadata = opts.instanceMetadata
      ? startFakeMetadataService(
          opts.instanceMetadata === true ? {} : opts.instanceMetadata,
        )
      : undefined;
    const proxyEnv = httpsProxy
      ? {
          HTTPS_PROXY: httpsProxy.proxyUrl,
          https_proxy: httpsProxy.proxyUrl,
          REQUESTS_CA_BUNDLE: httpsProxy.caCertPath,
        }
      : undefined;
    let stdout = "";
    let stderr = "";
    let exitCode: number;
    try {
      exitCode = await run({
        argv: substitute(argv, sb, fake.url, metadata),
        env: {
          ...sb.env,
          ...proxyEnv,
          ...substituteEnv(opts.env, sb, fake.url, metadata),
        },
        cwd: sb.home,
        out: (text) => {
          stdout += text;
        },
        err: (text) => {
          stderr += text;
        },
        isTTY: () => false,
        columns: () => undefined,
        stdin: opts.stdin,
      });
    } catch (e) {
      // What Bun prints for an uncaught error before exiting 1 (close enough to fail a case).
      stderr += `${Bun.inspect(e)}\n`;
      exitCode = 1;
    }
    const files = await readCapturedFiles(sb.home, opts.captureFiles);
    const fileModes = await readCapturedFileModes(
      sb.home,
      opts.captureFileModes,
    );
    const requests = httpsProxy
      ? [...fake.requests, ...httpsProxy.requests]
      : fake.requests;
    return captured(
      sb,
      fake.url,
      stdout,
      stderr,
      exitCode,
      requests,
      metadata,
      files,
      fileModes,
    );
  } finally {
    if (isolated) await sb[Symbol.asyncDispose]();
  }
}

function replacePlaceholders(
  value: string,
  sb: Sandbox,
  url: string,
  metadata?: FakeMetadataService,
): string {
  let out = value
    .replaceAll("{endpoint}", url)
    .replaceAll("{config}", sb.configFile)
    .replaceAll("{home}", sb.home)
    .replaceAll("{fakeKeyPem}", FAKE_KEY_PEM);
  if (metadata) {
    out = out
      .replaceAll("{metadata}", metadata.baseUrl)
      .replaceAll("{federation}", metadata.federationEndpoint);
  }
  return out;
}

function substitute(
  argv: string[],
  sb: Sandbox,
  url: string,
  metadata?: FakeMetadataService,
): string[] {
  return argv.map((a) => replacePlaceholders(a, sb, url, metadata));
}

function substituteEnv(
  env: Record<string, string> | undefined,
  sb: Sandbox,
  url: string,
  metadata?: FakeMetadataService,
): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      replacePlaceholders(v, sb, url, metadata),
    ]),
  );
}

async function readCapturedFiles(
  home: string,
  paths?: string[],
): Promise<Record<string, string> | undefined> {
  if (!paths?.length) return undefined;
  const out: Record<string, string> = {};
  for (const rel of paths) {
    const file = Bun.file(join(home, rel));
    if (await file.exists()) out[rel] = await file.text();
  }
  return out;
}

async function readCapturedFileModes(
  home: string,
  paths?: string[],
): Promise<Record<string, number> | undefined> {
  if (!paths?.length) return undefined;
  const out: Record<string, number> = {};
  for (const rel of paths) {
    try {
      out[rel] = getPosixMode(join(home, rel));
    } catch {
      // Missing file: leave unset so assertions see undefined.
    }
  }
  return out;
}

function captured(
  sb: Sandbox,
  url: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  requests: CapturedRequest[],
  metadata?: FakeMetadataService,
  files?: Record<string, string>,
  fileModes?: Record<string, number>,
): Run {
  const winHome = sb.home.replaceAll("/", "\\");
  const winHomeEscaped = sb.home.replaceAll("/", "\\\\");
  const norm = (s: string) => {
    let out = s
      .replaceAll(`/private${sb.home}`, "{home}")
      .replaceAll(sb.home, "{home}")
      .replaceAll(winHomeEscaped, "{home}")
      .replaceAll(winHome, "{home}")
      .replaceAll(url, "{endpoint}");
    if (metadata) {
      out = out
        .replaceAll(metadata.baseUrl, "{metadata}")
        .replaceAll(metadata.federationEndpoint, "{federation}");
    }
    return out;
  };
  return {
    // Sandbox paths differ per run; normalise them so runs are comparable.
    stdout: norm(stdout),
    stderr: norm(stderr),
    exitCode,
    requests,
    ...(metadata?.sessionPublicKey
      ? { sessionPublicKey: metadata.sessionPublicKey }
      : {}),
    ...(files
      ? {
          files: Object.fromEntries(
            Object.entries(files).map(([k, v]) => [k, norm(v)]),
          ),
        }
      : {}),
    ...(fileModes ? { fileModes } : {}),
  };
}

let proxied = false;
function installProxySafetyNet() {
  if (proxied) return;
  proxied = true;
  for (const [k, v] of Object.entries(PROXY_ENV)) process.env[k] = v;
}
