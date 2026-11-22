// Run a CLI (oci, boci, or a stand-in) the same way for every Parity case:
// isolated sandbox HOME + fake config, a fresh fake endpoint, `{endpoint}` and
// `{config}` placeholders in argv substituted, everything observable captured.
// runCli spawns a process; runInProcess calls boci's run() in this process with the same
// sandbox environment (no spawn, module load or spec parsing per case).
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import {
  type CapturedRequest,
  type Reply,
  startFakeEndpoint,
} from "./fake-endpoint.ts";
import {
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
};

export type RunOptions = {
  replies?: Reply | Reply[];
  stdin?: string;
  env?: Record<string, string>;
  /** Extra lines appended to the sandbox config file. */
  config?: string;
  sandbox?: SandboxOptions;
};

/** Starts one CLI process and collects what it printed; Bun.spawn unless replaced. */
export type Launcher = (
  cmd: string[],
  io: { cwd: string; env: Record<string, string>; stdin?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const spawnLauncher: Launcher = async (cmd, { cwd, env, stdin }) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

export async function runCli(
  cli: readonly string[],
  argv: string[],
  opts: RunOptions = {},
  launch: Launcher = spawnLauncher,
): Promise<Run> {
  await using sb = await createSandbox(opts.config, opts.sandbox);
  using fake = startFakeEndpoint(opts.replies);
  const { stdout, stderr, exitCode } = await launch(
    [...cli, ...substitute(argv, sb, fake.url)],
    { cwd: sb.home, env: { ...sb.env, ...opts.env }, stdin: opts.stdin },
  );
  return captured(sb, fake.url, stdout, stderr, exitCode, fake.requests);
}

/**
 * boci's run() in this process, observing what a spawned `boci` would: same argv, env, cwd
 * and stdin, stdout/stderr captured, no terminal. The sandbox is shared between runs with
 * the same config (boci never writes to it). Network: fetch reads the proxy settings from
 * this process, so the sandbox's dead-proxy safety net is installed here once.
 */
export async function runInProcess(
  argv: string[],
  opts: RunOptions = {},
): Promise<Run> {
  installProxySafetyNet();
  const sb = await sharedSandbox(opts.config, opts.sandbox);
  using fake = startFakeEndpoint(opts.replies);
  let stdout = "";
  let stderr = "";
  let exitCode: number;
  try {
    exitCode = await run({
      argv: substitute(argv, sb, fake.url),
      env: { ...sb.env, ...opts.env },
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
  return captured(sb, fake.url, stdout, stderr, exitCode, fake.requests);
}

function substitute(argv: string[], sb: Sandbox, url: string): string[] {
  return argv.map((a) =>
    a
      .replaceAll("{endpoint}", url)
      .replaceAll("{config}", sb.configFile)
      .replaceAll("{home}", sb.home),
  );
}

function captured(
  sb: Sandbox,
  url: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  requests: CapturedRequest[],
): Run {
  return {
    // Sandbox paths differ per run; normalise them so runs are comparable.
    stdout: stdout.replaceAll(sb.home, "{home}").replaceAll(url, "{endpoint}"),
    stderr: stderr.replaceAll(sb.home, "{home}").replaceAll(url, "{endpoint}"),
    exitCode,
    requests,
  };
}

let proxied = false;
function installProxySafetyNet() {
  if (proxied) return;
  proxied = true;
  for (const [k, v] of Object.entries(PROXY_ENV)) process.env[k] = v;
}
