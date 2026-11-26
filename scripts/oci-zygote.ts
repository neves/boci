// A Launcher for the Reference CLI that forks pre-imported Python processes
// (scripts/oci-zygote.py, which documents what differs from a fresh process and how
// that's kept out of goldens) instead of starting `oci` from scratch for every case.
// Most of a case's 0.5-0.9 s is Python importing oci_cli and the service it names; a
// forked child takes ~0.1 s. Each launcher keeps one zygote, replaced when the service
// or env changes, so feed it cases sorted by service. Anything the zygote can't run
// faithfully falls back to a plain spawn.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launcher, spawnLauncher } from "../test/harness/runner.ts";

const SCRIPT = join(import.meta.dir, "oci-zygote.py");
/** Never a real directory: output mentioning it means HOME was read at import time. */
const ZYGOTE_HOME = "/nonexistent-boci-zygote-home";

async function python(oci: string): Promise<string> {
  const first = (await Bun.file(oci).text()).split("\n", 1)[0] ?? "";
  if (!first.startsWith("#!")) throw new Error(`${oci}: no shebang`);
  return first.slice(2).trim();
}

class Zygote {
  private readonly proc;
  private readonly lines;
  private buf = "";
  private dead = false;
  constructor(
    py: string,
    oci: string,
    args: string[],
    env: Record<string, string>,
  ) {
    this.proc = Bun.spawn([py, SCRIPT, JSON.stringify(args)], {
      env: { ...env, HOME: ZYGOTE_HOME, BOCI_OCI_ENTRY: oci },
      cwd: "/",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    this.lines = this.proc.stdout
      .pipeThrough(new TextDecoderStream())
      .getReader();
  }
  async request(
    req: object,
    timeoutMs?: number,
  ): Promise<{ exitCode?: number; fallback?: boolean; timedOut?: boolean }> {
    this.proc.stdin.write(`${JSON.stringify(req)}\n`);
    await this.proc.stdin.flush();
    const readReply = async () => {
      while (!this.buf.includes("\n")) {
        const { value, done } = await this.lines.read();
        if (done)
          throw new Error(`oci zygote exited (${await this.proc.exited})`);
        this.buf += value;
      }
      const i = this.buf.indexOf("\n");
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      return JSON.parse(line) as {
        exitCode?: number;
        fallback?: boolean;
        timedOut?: boolean;
      };
    };
    if (timeoutMs === undefined) return readReply();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        readReply(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `timeout after ${timeoutMs / 1000}s (zygote unresponsive)`,
              ),
            );
          }, timeoutMs + 2000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async kill() {
    if (this.dead) return;
    this.dead = true;
    try {
      this.proc.stdin.end();
    } catch {
      /* process may already have exited */
    }
    try {
      this.proc.kill("SIGKILL");
    } catch {
      /* process may already have exited */
    }
    this.lines.cancel().catch(() => {});
    await this.proc.exited;
  }
  async close() {
    if (this.dead) return;
    this.dead = true;
    try {
      this.proc.stdin.end();
    } catch {
      /* process may already have exited */
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      this.proc.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!exited) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* process may already have exited */
      }
      this.lines.cancel().catch(() => {});
      await this.proc.exited;
    }
  }
}

export type ZygoteLauncher = Launcher & {
  /** Cases that had to be spawned normally. */
  readonly fallbacks: number;
  close(): Promise<void>;
};

/** One per worker: calls must not overlap. */
export async function zygoteLauncher(): Promise<ZygoteLauncher> {
  const dir = await mkdtemp(join(tmpdir(), "boci-zygote-"));
  let zygote: Zygote | undefined;
  let key: string | undefined;
  let n = 0;
  let fallbacks = 0;
  const fallback: Launcher = (cmd, io) => {
    fallbacks++;
    return spawnLauncher(cmd, io);
  };
  const launch: Launcher = async (cmd, io) => {
    const [oci = "oci", ...args] = cmd;
    const { HOME: _, ...env } = io.env;
    const k = JSON.stringify([args[0], env]);
    if (!zygote || key !== k) {
      await zygote?.close();
      zygote = new Zygote(await python(oci), oci, args, io.env);
      key = k;
    }
    const id = n++;
    const paths = {
      stdin: io.stdin === undefined ? null : join(dir, `${id}.in`),
      stdout: join(dir, `${id}.out`),
      stderr: join(dir, `${id}.err`),
    };
    try {
      if (paths.stdin) await Bun.write(paths.stdin, io.stdin ?? "");
      let r: { exitCode?: number; fallback?: boolean; timedOut?: boolean };
      try {
        r = await zygote.request(
          {
            argv: args,
            env: io.env,
            cwd: io.cwd,
            ...paths,
            ...(io.timeoutMs === undefined ? {} : { timeoutMs: io.timeoutMs }),
          },
          io.timeoutMs,
        );
      } catch (e) {
        await zygote.kill();
        zygote = undefined;
        key = undefined;
        throw e;
      }
      if (r.timedOut)
        throw new Error(`timeout after ${(io.timeoutMs ?? 0) / 1000}s`);
      if (r.fallback) return fallback(cmd, io);
      const result = {
        stdout: await Bun.file(paths.stdout).text(),
        stderr: await Bun.file(paths.stderr).text(),
        exitCode: r.exitCode ?? 1,
      };
      if (`${result.stdout}${result.stderr}`.includes(ZYGOTE_HOME))
        return fallback(cmd, io);
      return result;
    } finally {
      await Promise.all(
        Object.values(paths).map((p) => p && rm(p, { force: true })),
      );
    }
  };
  return Object.assign(launch, {
    get fallbacks() {
      return fallbacks;
    },
    async close() {
      await zygote?.close();
      await rm(dir, { recursive: true, force: true });
    },
  });
}
