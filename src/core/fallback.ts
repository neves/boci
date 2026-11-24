import { Exit, type Invocation } from "../lib/io.ts";

/** Exit code for "boci doesn't implement this yet" (oci itself uses 0, 1 and 2). */
export const NOT_IMPLEMENTED = 3;

/**
 * The command is valid but boci can't run it yet. With BOCI_FALLBACK set (e.g. to `oci`),
 * hand the untouched argv, stdin and stdio to the Reference CLI and return its exit code.
 */
export async function notImplemented(
  io: Invocation,
  argv: string[],
  commandPath: string,
): Promise<never> {
  const fallback = io.env.BOCI_FALLBACK;
  const depth = Number(io.env.BOCI_FALLBACK_DEPTH ?? "0");
  if (fallback && depth === 0) {
    const bin =
      Bun.which(fallback, { PATH: io.env.PATH ?? "", cwd: io.cwd }) ?? fallback;
    const cmd =
      process.platform === "win32" && /\.[mc]?[jt]s$/i.test(bin)
        ? [
            Bun.which("bun", {
              PATH: io.env.PATH ?? process.env.PATH ?? "",
            }) ?? process.execPath,
            bin,
            ...argv,
          ]
        : [bin, ...argv];
    const options = {
      cwd: io.cwd,
      env: { ...io.env, BOCI_FALLBACK_DEPTH: String(depth + 1) },
    };
    if (io.inheritStdio) {
      await io.inheritStdio.flush(); // boci's warnings come before the child's output
      const proc = Bun.spawn(cmd, {
        ...options,
        stdio: ["inherit", "inherit", "inherit"],
      });
      throw new Exit(await proc.exited);
    }
    const proc = Bun.spawn(cmd, {
      ...options,
      stdin: io.stdin === undefined ? "ignore" : new Blob([io.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    io.out(stdout);
    io.err(stderr);
    throw new Exit(code);
  }
  io.err(
    `boci: '${commandPath}' is not implemented yet (run \`bun run status\` in the boci repo for coverage).\n` +
      "Set BOCI_FALLBACK=oci to run unimplemented commands with the Reference CLI.\n",
  );
  throw new Exit(NOT_IMPLEMENTED);
}
