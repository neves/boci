#!/usr/bin/env bun
// boci entry point. Commands are added rung by rung; see PLAN.md.
import { commandHelp } from "./help/render.ts";
import { loadIndex, loadService, resolvePath } from "./spec.ts";
import { REFERENCE_VERSION } from "./version.ts";

/** Click's prog name. boci answers as `oci` so usage text matches scripts' expectations. */
const PROG = "oci";
const HELP_FLAGS = new Set(["--help", "-h", "-?"]);

const argv = process.argv.slice(2);

// --version / -v are eager root flags in Click: they win over everything after them.
// TODO(rung 0, parser): honour them after other root options too.
if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write(`${REFERENCE_VERSION}\n`);
  process.exit(0);
}

const index = await loadIndex();
const { path, node } = resolvePath(index.root, argv);
const rest = argv.slice(path.length);

// Leaf command help: -?/-h/--help is eager on leaf commands, so it wins anywhere after the path.
if (path.length > 0 && !node.commands && rest.some((a) => HELP_FLAGS.has(a))) {
  const [service, ...sub] = path as [string, ...string[]];
  const spec = await loadService(service);
  const cmd = spec.commands[sub.join(" ")];
  if (cmd) {
    process.stdout.write(
      `${commandHelp([PROG, ...path].join(" "), cmd.helpDoc)}\n`,
    );
    process.exit(0);
  }
}

process.stderr.write("boci: not implemented yet\n");
process.exit(1);
