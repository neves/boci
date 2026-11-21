// Run a CLI (oci, boci, or a stand-in) the same way for every Parity case:
// isolated sandbox HOME + fake config, a fresh fake endpoint, `{endpoint}` and
// `{config}` placeholders in argv substituted, everything observable captured.
import { join } from "node:path";
import {
  type CapturedRequest,
  type Reply,
  startFakeEndpoint,
} from "./fake-endpoint.ts";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";

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

export async function runCli(
  cli: readonly string[],
  argv: string[],
  opts: RunOptions = {},
): Promise<Run> {
  await using sb = await createSandbox(opts.config, opts.sandbox);
  using fake = startFakeEndpoint(opts.replies);
  const args = argv.map((a) =>
    a.replaceAll("{endpoint}", fake.url).replaceAll("{config}", sb.configFile),
  );
  const proc = Bun.spawn([...cli, ...args], {
    cwd: sb.home,
    env: { ...sb.env, ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    // Sandbox paths differ per run; normalise them so runs are comparable.
    stdout: stdout
      .replaceAll(sb.home, "{home}")
      .replaceAll(fake.url, "{endpoint}"),
    stderr: stderr
      .replaceAll(sb.home, "{home}")
      .replaceAll(fake.url, "{endpoint}"),
    exitCode,
    requests: fake.requests,
  };
}
