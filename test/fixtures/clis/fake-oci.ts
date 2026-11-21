#!/usr/bin/env bun
// Stand-in Reference CLI for fallback tests: echoes argv and stdin, exits 7.
const stdin = process.stdin.isTTY ? "" : await Bun.stdin.text();
process.stdout.write(
  JSON.stringify({
    argv: Bun.argv.slice(2),
    stdin,
    depth: process.env.BOCI_FALLBACK_DEPTH,
  }),
);
process.exit(7);
