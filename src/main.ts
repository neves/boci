#!/usr/bin/env bun
// boci entry point. Commands are added rung by rung; see PLAN.md.
import { Exit, run } from "./cli.ts";

try {
  await run(process.argv.slice(2));
} catch (e) {
  if (e instanceof Exit) process.exitCode = e.code;
  else throw e;
}
