#!/usr/bin/env bun
// boci entry point. Commands are added rung by rung; see PLAN.md.

import { REFERENCE_VERSION } from "./version.ts";

const argv = process.argv.slice(2);

// --version / -v are eager root flags in Click: they win over everything after them.
// TODO(rung 0, parser): honour them after other root options too.
if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write(`${REFERENCE_VERSION}\n`);
  process.exit(0);
}

process.stderr.write("boci: not implemented yet\n");
process.exit(1);
