import { notImplemented } from "../../../src/core/fallback.ts";
import { Exit, processStdio } from "../../../src/lib/io.ts";

const argv = Bun.argv.slice(2);
const stdio = processStdio();
try {
  await notImplemented(
    { argv, env: Bun.env, cwd: process.cwd(), ...stdio, inheritStdio: stdio },
    argv,
    `oci ${argv.join(" ")}`,
  );
} catch (error) {
  if (!(error instanceof Exit)) throw error;
  process.exitCode = error.code;
} finally {
  await stdio.flush();
}
