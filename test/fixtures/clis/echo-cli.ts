// Minimal stand-in CLI for runner tests: `echo-cli <endpoint> [args...]`.
// GETs <endpoint>/echo?args=..., prints the body, echoes HOME on stderr, exits 3.
const [endpoint, ...args] = Bun.argv.slice(2);
const res = await fetch(
  `${endpoint}/echo?args=${encodeURIComponent(args.join(" "))}`,
);
process.stdout.write(await res.text());
process.stderr.write(`home=${process.env.HOME}\n`);
const stdin = process.stdin.isTTY ? "" : await Bun.stdin.text();
if (stdin) process.stdout.write(`\nstdin=${stdin}`);
process.exit(3);
