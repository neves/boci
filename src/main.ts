#!/usr/bin/env bun
// boci entry point: the production adapter for run(). Commands are added rung by rung; see PLAN.md.
import { run } from "./core/cli.ts";
import { processStdio } from "./lib/io.ts";

const stdio = processStdio();
try {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    ...stdio,
    inheritStdio: stdio,
  });
} finally {
  await stdio.flush();
}
