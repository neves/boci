// `bun run fuzz [--service a,b] [--command "<service> <path>"]… [--iterations N] [--seed N]
//               [--limit N] [--jobs N] [--boci-bin dist/boci] [--promote]`
// Differential fuzzing against the Reference CLI: for each Leaf command that sends a
// modelled request, build random spec-valid invocations (scripts/fuzz-lib.ts) with random
// replies from the response model, run both CLIs against the same fake endpoint, and
// compare stdout, stderr, exit status, requests and touched files after the usual masks.
// Offline (fake endpoint, sandbox HOME), but it runs the Reference CLI, so it's never part
// of `bun test`. Mismatches go to .fuzz/<seed>.json; --promote turns them into Parity
// cases (test/parity/cases/fuzz-found.json) with goldens from this run.
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { parseArgs } from "util";
import {
  type NormalizedRun,
  normalizeRun,
  signatureValid,
} from "../test/harness/compare.ts";
import {
  CASES_DIR,
  type Golden,
  type ParityCase,
  caseHash,
  goldenPath,
} from "../test/harness/cases.ts";
import {
  CLIS,
  type Launcher,
  type Run,
  runCli,
  runInProcess,
} from "../test/harness/runner.ts";
import {
  disposeSharedSandboxes,
  FAKE_KEY_PEM,
} from "../test/harness/sandbox.ts";
import {
  buildInvocation,
  describeDiff,
  fuzzable,
  type Invocation,
  invocationSeed,
  rng,
  type ServiceSpec,
} from "./fuzz-lib.ts";
import { zygoteLauncher } from "./oci-zygote.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    service: { type: "string" },
    command: { type: "string", multiple: true },
    iterations: { type: "string", default: "3" },
    seed: { type: "string" },
    limit: { type: "string" },
    jobs: { type: "string" },
    "boci-bin": { type: "string" },
    timeout: { type: "string", default: "60" },
    promote: { type: "boolean", default: false },
  },
});

const ROOT = join(import.meta.dir, "..");
const seed = values.seed
  ? Number(values.seed)
  : Math.floor(Math.random() * 2 ** 31);
const iterations = Number(values.iterations);
const timeoutMs = Number(values.timeout) * 1000;
const publicKey = createPublicKey(FAKE_KEY_PEM)
  .export({ type: "spki", format: "pem" })
  .toString();

// --- Pick the commands -----------------------------------------------------------------
const index = (await Bun.file(join(ROOT, "spec/index.json")).json()) as {
  services: Record<string, unknown>;
};
const wanted = values.command?.length
  ? values.command.map((k) => {
      const [service = "", ...path] = k.trim().split(/\s+/);
      return { service, path: path.join(" ") };
    })
  : undefined;
const services = wanted
  ? [...new Set(wanted.map((w) => w.service))]
  : values.service
    ? values.service.split(",").filter(Boolean)
    : Object.keys(index.services);

const specs = new Map<string, ServiceSpec>();
let targets: { service: string; path: string }[] = [];
for (const service of services) {
  const file = Bun.file(join(ROOT, `spec/${service}.json`));
  if (!(await file.exists())) {
    // The index also lists services with no commands of their own.
    if (values.service || wanted)
      throw new Error(`no spec for service ${service}`);
    continue;
  }
  const spec = (await file.json()) as ServiceSpec;
  specs.set(service, spec);
  for (const [path, command] of Object.entries(spec.commands)) {
    if (!fuzzable(command)) continue;
    if (wanted && !wanted.some((w) => w.service === service && w.path === path))
      continue;
    targets.push({ service, path });
  }
}
if (wanted && targets.length < wanted.length)
  throw new Error(
    "some --command keys don't exist or send no modelled request",
  );
if (values.limit) {
  // A seeded sample, so `--seed S --limit N` names the same commands again.
  const r = rng(seed);
  targets = targets
    .map((t) => ({ t, k: r.next() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, Number(values.limit))
    .map(({ t }) => t)
    .sort((a, b) => a.service.localeCompare(b.service));
}

const invocations: Invocation[] = [];
for (const { service, path } of targets)
  for (let i = 0; i < iterations; i++) {
    const inv = buildInvocation(
      service,
      path,
      specs.get(service)!,
      invocationSeed(seed, `${service} ${path}`, i),
    );
    if (inv) invocations.push(inv);
  }
specs.clear();

const referenceVersion = (await Bun.$`${CLIS.oci} --version`.text()).trim();
console.log(
  `fuzz seed ${seed}: ${invocations.length} invocations of ${targets.length} commands against oci ${referenceVersion}`,
);

// --- Run both CLIs ---------------------------------------------------------------------
type Mismatch = {
  key: string;
  id: string;
  argv: string[];
  stdin?: string;
  replies: unknown;
  differs: Record<string, { oci: string; boci: string }>;
  oci: NormalizedRun & { files?: Record<string, string> };
  boci: NormalizedRun & { files?: Record<string, string> };
};
type TimedOut = {
  key: string;
  id: string;
  argv: string[];
  error: string;
};
const mismatches: Mismatch[] = [];
const timedOut: TimedOut[] = [];
const goldens = new Map<string, NormalizedRun>();
let done = 0;
let matched = 0;
let timeouts = 0;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timeout after ${timeoutMs / 1000}s: ${label}`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const observe = (run: Run) => ({
  ...normalizeRun(run),
  ...(run.files ? { files: run.files } : {}),
});

async function runOne(inv: Invocation, launch: Launcher) {
  const opts = { ...inv, captureFiles: inv.captureFiles, timeoutMs };
  let oci: Run;
  let boci: Run;
  try {
    oci = await runCli(CLIS.oci, inv.argv, opts, launch);
  } catch (e) {
    timeouts++;
    const error = `oci: ${(e as Error).message}`;
    timedOut.push({ key: inv.key, id: inv.id, argv: inv.argv, error });
    console.log(`\n${inv.id}: ${error}`);
    return;
  }
  try {
    boci = values["boci-bin"]
      ? await runCli([join(ROOT, values["boci-bin"])], inv.argv, opts)
      : await withTimeout(runInProcess(inv.argv, opts), "boci");
  } catch (e) {
    timeouts++;
    const error = `boci: ${(e as Error).message}`;
    timedOut.push({ key: inv.key, id: inv.id, argv: inv.argv, error });
    console.log(`\n${inv.id}: ${error}`);
    return;
  }
  const expected = observe(oci);
  const actual = observe(boci);
  const differs = describeDiff(expected, actual);
  const badSignature = boci.requests.some(
    (req) =>
      req.headers.authorization?.startsWith("Signature ") &&
      !signatureValid(req, publicKey),
  );
  if (badSignature)
    differs.signature = { oci: "valid", boci: "invalid signature" };
  if (!Object.keys(differs).length) {
    matched++;
    return;
  }
  goldens.set(inv.id, normalizeRun(oci));
  mismatches.push({
    key: inv.key,
    id: inv.id,
    argv: inv.argv,
    ...(inv.stdin === undefined ? {} : { stdin: inv.stdin }),
    replies: inv.replies,
    differs,
    oci: expected,
    boci: actual,
  });
}

let next = 0;
async function worker() {
  const launch = await zygoteLauncher();
  try {
    while (next < invocations.length) {
      const inv = invocations[next++]!;
      await runOne(inv, launch);
      done++;
      if (process.stdout.isTTY)
        process.stdout.write(
          `\r${done}/${invocations.length} · ${mismatches.length} mismatches · ${inv.key}`
            .slice(0, 100)
            .padEnd(100),
        );
      else if (done % 1000 === 0)
        console.log(
          `${done}/${invocations.length} · ${mismatches.length} mismatches · ${timeouts} timeouts · ${inv.key}`,
        );
    }
  } finally {
    await launch.close();
  }
}
const jobs = Number(values.jobs ?? availableParallelism());
await Promise.all(Array.from({ length: jobs }, worker));
await disposeSharedSandboxes();
if (process.stdout.isTTY) process.stdout.write("\n");

// --- Report ----------------------------------------------------------------------------
const reportFile = join(ROOT, ".fuzz", `${seed}.json`);
await Bun.write(
  reportFile,
  `${JSON.stringify({ seed, referenceVersion, invocations: invocations.length, matched, timeouts, timedOut, mismatches }, null, 2)}\n`,
);

const byKey = new Map<string, Mismatch[]>();
for (const m of mismatches) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m]);
const byField = new Map<string, number>();
for (const m of mismatches)
  for (const f of Object.keys(m.differs))
    byField.set(f, (byField.get(f) ?? 0) + 1);

console.log(
  `${matched}/${invocations.length} invocations matched (${((100 * matched) / Math.max(1, invocations.length)).toFixed(1)}%), ${mismatches.length} mismatched in ${byKey.size} commands, ${timeouts} timed out`,
);
if (mismatches.length) {
  console.log(
    `differing fields: ${[...byField].map(([f, n]) => `${f} ${n}`).join(", ")}`,
  );
  for (const [key, ms] of [...byKey].slice(0, 20)) {
    const m = ms[0]!;
    const [field, d] = Object.entries(m.differs)[0]!;
    console.log(`\n${key}  (${ms.length}×)  ${m.id}`);
    console.log(`  argv: ${m.argv.join(" ")}`);
    console.log(`  ${field}: oci  ${d.oci.slice(0, 160)}`);
    console.log(`  ${field.replace(/./g, " ")}  boci ${d.boci.slice(0, 160)}`);
  }
  if (byKey.size > 20) console.log(`\n… ${byKey.size - 20} more commands`);
  console.log(`\nfull report: ${reportFile}`);
  console.log(
    `reproduce one: bun run fuzz --seed ${seed} --iterations ${iterations} --command "<key>"`,
  );
}

// --- Promote ---------------------------------------------------------------------------
if (values.promote && mismatches.length) {
  const file = join(CASES_DIR, "fuzz-found.json");
  const existing = (await Bun.file(file).exists())
    ? ((await Bun.file(file).json()) as ParityCase[])
    : [];
  const ids = new Set(existing.map((c) => c.id));
  const added: ParityCase[] = [];
  for (const inv of invocations) {
    if (!goldens.has(inv.id) || ids.has(inv.id)) continue;
    const { captureFiles: _, ...c } = inv;
    added.push(c);
    const golden: Golden = {
      caseHash: caseHash(c),
      referenceVersion,
      observed: goldens.get(inv.id)!,
    };
    await Bun.write(goldenPath(c.id), `${JSON.stringify(golden, null, 2)}\n`);
  }
  await Bun.write(
    file,
    `${JSON.stringify([...existing, ...added], null, 2)}\n`,
  );
  await Bun.$`${process.execPath} fmt ${file} ${added.map((c) => goldenPath(c.id))}`.quiet();
  console.log(
    `promoted ${added.length} Parity cases to test/parity/cases/fuzz-found.json (goldens written)`,
  );
}
process.exit(mismatches.length ? 1 : 0);
