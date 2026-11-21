// `bun run bench [--runs N] [--live] [--only <substring>]`
//
// Compares the Reference CLI (`oci`) with `boci` on process start-up and CLI-side work.
// Offline scenarios run both CLIs in an isolated sandbox against a local fake endpoint,
// so network latency is excluded and only CLI overhead is measured. `--live` adds
// scenarios against the real account in `.env.test` (read-only commands only).
//
// "Cold start" here means a fresh process per run with a warm OS page cache (no root
// needed). The first run of each scenario is reported separately from the median.
import { parseArgs } from "util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox, type Sandbox } from "../test/harness/sandbox.ts";

const ROOT = join(import.meta.dir, "..");
const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runs: { type: "string", default: "10" },
    live: { type: "boolean", default: false },
    only: { type: "string" },
  },
});
const RUNS = Number(flags.runs);

// ---------------------------------------------------------------- fake endpoint

type Reply = (req: Request, url: URL) => Response;

const regions = Array.from({ length: 45 }, (_, i) => ({
  key: `R${i}`,
  name: `region-${i}-1`,
}));
const instance = (i: number) => ({
  "availability-domain": "Uocm:US-ASHBURN-AD-1",
  "compartment-id": "ocid1.compartment.oc1..aaaaaaaafake",
  "defined-tags": {
    Oracle: { CreatedBy: "bench", CreatedOn: "2026-11-21T00:00:00.000Z" },
  },
  "display-name": `instance-${i}`,
  "freeform-tags": { team: i % 2 ? "red" : "blue" },
  id: `ocid1.instance.oc1.iad.fake${String(i).padStart(8, "0")}`,
  "lifecycle-state": i % 7 ? "RUNNING" : "STOPPED",
  shape: "VM.Standard.E2.1.Micro",
  "shape-config": { ocpus: 1, "memory-in-gbs": 1 },
  "time-created": "2026-11-21T00:00:00.000Z",
});
// The SDK sends camelCase; the CLI renders kebab-case. Serve camelCase like the real API.
const camel = (o: unknown): unknown =>
  Array.isArray(o)
    ? o.map(camel)
    : o && typeof o === "object"
      ? Object.fromEntries(
          Object.entries(o).map(([k, v]) => [
            k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()),
            k.endsWith("-tags") ? v : camel(v),
          ]),
        )
      : o;
const bigInstanceList = JSON.stringify(
  camel(Array.from({ length: 5000 }, (_, i) => instance(i))),
);
const page = (n: number) =>
  JSON.stringify(
    camel(
      Array.from({ length: 100 }, (_, i) => ({
        name: `bucket-${n}-${i}`,
        namespace: "ns",
        "compartment-id": "c",
        etag: "e",
        "time-created": "2026-11-21T00:00:00.000Z",
      })),
    ),
  );

const routes: [RegExp, Reply][] = [
  [/^\/n\/?$/, () => Response.json("benchns")],
  [/^\/20160918\/regions$/, () => Response.json(regions)],
  [/^\/regions$/, () => Response.json(regions)],
  [
    /^\/n\/[^/]+\/b\/?$/,
    (_req, url) => {
      const n = Number(url.searchParams.get("page") ?? "1");
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (n < 20) headers["opc-next-page"] = String(n + 1);
      return new Response(page(n), { headers });
    },
  ],
  [
    /\/instances\/?$/,
    () =>
      new Response(bigInstanceList, {
        headers: { "content-type": "application/json" },
      }),
  ],
];

function startFakeEndpoint() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      for (const [re, reply] of routes)
        if (re.test(url.pathname)) return reply(req, url);
      return Response.json(
        { code: "NotAuthorizedOrNotFound", message: "bench: no route" },
        { status: 404 },
      );
    },
  });
}

// ---------------------------------------------------------------- scenarios

type Scenario = {
  name: string;
  why: string;
  argv: (endpoint: string) => string[];
  live?: boolean;
};

const scenarios: Scenario[] = [
  {
    name: "--version",
    why: "pure start-up: no config, no network",
    argv: () => ["--version"],
  },
  {
    name: "--help",
    why: "start-up + root help rendering",
    argv: () => ["--help"],
  },
  {
    name: "os --help",
    why: "loads one service's command tree",
    argv: () => ["os", "--help"],
  },
  {
    name: "compute instance launch --help",
    why: "largest help pages (100+ options)",
    argv: () => ["compute", "instance", "launch", "--help"],
  },
  {
    name: "usage error",
    why: "unknown option: parse + error path",
    argv: () => ["os", "ns", "get", "--no-such-flag"],
  },
  {
    name: "os ns get",
    why: "config + key load + sign + 1 request",
    argv: (e) => ["os", "ns", "get", "--endpoint", e],
  },
  {
    name: "iam region list",
    why: "1 request, small list render",
    argv: (e) => ["iam", "region", "list", "--endpoint", e],
  },
  {
    name: "os bucket list --all (20 pages)",
    why: "pagination: 20 sequential signed requests",
    argv: (e) => [
      "os",
      "bucket",
      "list",
      "--all",
      "--namespace-name",
      "ns",
      "--compartment-id",
      "ocid1.compartment.oc1..aaaaaaaafake",
      "--endpoint",
      e,
    ],
  },
  {
    name: "compute instance list (5k items)",
    why: "deserialize + render ~5 MB JSON",
    argv: (e) => [
      "compute",
      "instance",
      "list",
      "--compartment-id",
      "ocid1.compartment.oc1..aaaaaaaafake",
      "--endpoint",
      e,
    ],
  },
  {
    name: "… --query (5k items)",
    why: "JMESPath filter + projection over 5k items",
    argv: (e) => [
      "compute",
      "instance",
      "list",
      "--compartment-id",
      "ocid1.compartment.oc1..aaaaaaaafake",
      "--endpoint",
      e,
      "--query",
      'data[?"lifecycle-state"==\'RUNNING\'].{name:"display-name",id:id}',
    ],
  },
  {
    name: "… --output table (5k items)",
    why: "table rendering of 5k rows",
    argv: (e) => [
      "compute",
      "instance",
      "list",
      "--compartment-id",
      "ocid1.compartment.oc1..aaaaaaaafake",
      "--endpoint",
      e,
      "--query",
      'data[].{name:"display-name",state:"lifecycle-state"}',
      "--output",
      "table",
    ],
  },
  {
    name: "live: os ns get",
    why: "real API round trip",
    live: true,
    argv: () => ["os", "ns", "get"],
  },
  {
    name: "live: iam region list",
    why: "real API round trip",
    live: true,
    argv: () => ["iam", "region", "list"],
  },
];

// ---------------------------------------------------------------- runner

type Sample = {
  ms: number;
  rss: number;
  exit: number;
  out: string;
  err: string;
};

let rssLauncher: string | undefined; // set in main; see bench/rss.c

async function runOnce(
  cmd: string[],
  env: Record<string, string>,
): Promise<Sample> {
  const t0 = performance.now();
  const rssOut = `${rssLauncher}.out`;
  const proc = Bun.spawn(rssLauncher ? [rssLauncher, ...cmd] : cmd, {
    env: rssLauncher ? { ...env, RSS_OUT: rssOut } : env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  const ms = performance.now() - t0;
  const rss = rssLauncher
    ? Number((await Bun.file(rssOut).text()).trim()) * 1024
    : 0;
  return { ms, rss, exit, out, err };
}

type Result = {
  first: number;
  median: number;
  min: number;
  rssMB: number;
  exit: number;
  note?: string;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

async function measure(
  cmd: string[],
  env: Record<string, string>,
  runs = RUNS,
  allowStub = false,
): Promise<Result> {
  const first = await runOnce(cmd, env);
  if (!allowStub && /not implemented yet/.test(first.err)) {
    return {
      first: Number.NaN,
      median: Number.NaN,
      min: Number.NaN,
      rssMB: Number.NaN,
      exit: first.exit,
      note: "not implemented",
    };
  }
  const samples = [first];
  for (let i = 1; i < runs; i++) samples.push(await runOnce(cmd, env));
  const ms = samples.slice(1).map((s) => s.ms);
  return {
    first: first.ms,
    median: median(ms.length ? ms : [first.ms]),
    min: Math.min(...(ms.length ? ms : [first.ms])),
    rssMB: Math.max(...samples.map((s) => s.rss)) / 2 ** 20,
    exit: first.exit,
  };
}

// ---------------------------------------------------------------- main

const ociBin = Bun.which("oci");
if (!ociBin)
  throw new Error(
    "oci not found: uv tool install --python 3.12 oci-cli==3.96.3",
  );
const ociVenv = `${(await Bun.$`uv tool dir`.text()).trim()}/oci-cli`;
const ociPython = `${ociVenv}/bin/python`;
const bociBin = join(ROOT, "dist", "boci");
await Bun.$`bun build --compile --minify ${join(ROOT, "src/main.ts")} --outfile ${bociBin}`.quiet();

await using sb: Sandbox = await createSandbox();
if (Bun.which("cc")) {
  rssLauncher = join(sb.home, "rss");
  await Bun.$`cc -O2 -o ${rssLauncher} ${join(import.meta.dir, "rss.c")}`.quiet();
} else {
  process.stderr.write("warning: no C compiler; RSS column will be empty\n");
}
using server = startFakeEndpoint();
const endpoint = `http://127.0.0.1:${server.port}`;

let liveEnv: Record<string, string> | undefined;
if (flags.live) {
  const profile = Bun.env.BOCI_TEST_PROFILE;
  if (!profile)
    throw new Error(
      "--live needs BOCI_TEST_PROFILE (run via `bun --env-file=.env.test`)",
    );
  liveEnv = {
    ...process.env,
    OCI_CLI_PROFILE: profile,
    OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "True",
  } as Record<string, string>;
}

type Row = {
  group: string;
  name: string;
  why: string;
  oci: Result;
  boci: Result;
};
const rows: Row[] = [];
const log = (s: string) => process.stderr.write(s);

// Runtime floors: the unavoidable cost of starting each runtime, before any CLI code.
{
  const floorDir = join(sb.home, "floor");
  await mkdir(floorDir);
  await Bun.write(join(floorDir, "hello.ts"), "console.log('hi')\n");
  await Bun.$`bun build --compile --minify ${join(floorDir, "hello.ts")} --outfile ${join(floorDir, "hello")}`.quiet();
  const floors: [string, string, string[], string[]][] = [
    [
      "runtime floor",
      "empty program: python3.12 vs compiled Bun binary",
      [ociPython, "-c", "pass"],
      [join(floorDir, "hello")],
    ],
    [
      "import floor",
      "load the CLI's code: `import oci_cli.cli` vs the boci binary's entry",
      [ociPython, "-c", "import oci_cli.cli"],
      [bociBin],
    ],
  ];
  for (const [name, why, py, bun] of floors) {
    if (flags.only && !name.includes(flags.only)) continue;
    log(`· ${name}\n`);
    rows.push({
      group: "floor",
      name,
      why,
      oci: await measure(py, sb.env),
      boci: await measure(bun, sb.env, RUNS, true),
    });
  }
}

for (const s of scenarios) {
  if (s.live && !liveEnv) continue;
  if (flags.only && !s.name.includes(flags.only)) continue;
  log(`· ${s.name}\n`);
  const env = s.live ? (liveEnv as Record<string, string>) : sb.env;
  const argv = s.argv(endpoint);
  const runs = s.live ? Math.min(RUNS, 5) : RUNS;
  rows.push({
    group: s.live ? "live" : "offline",
    name: s.name,
    why: s.why,
    oci: await measure([ociBin, ...argv], env, runs),
    boci: await measure([bociBin, ...argv], env, runs),
  });
}

// ---------------------------------------------------------------- report

const size = async (p: string) =>
  Number((await Bun.$`du -sb ${p}`.text()).split("\t")[0]);
const footprint = {
  ociMB: (await size(ociVenv)) / 2 ** 20,
  bociMB: (await size(bociBin)) / 2 ** 20,
};

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "—");
const speedup = (o: Result, b: Result) =>
  Number.isFinite(b.median) && b.median > 0
    ? `${(o.median / b.median).toFixed(1)}×`
    : "—";
const lines = [
  `# boci vs oci benchmark`,
  ``,
  `${new Date().toISOString()} · oci ${(await Bun.$`${ociBin} --version`.text()).trim()} · ${RUNS} runs/scenario · ${navigator.hardwareConcurrency} CPUs · Bun ${Bun.version}`,
  ``,
  `Times in ms (median of runs after the first; "first" = first run). RSS = peak resident memory.`,
  ``,
  `| scenario | oci first | oci median | boci first | boci median | speed-up | oci RSS MB | boci RSS MB | what it exercises |`,
  `|---|---:|---:|---:|---:|---:|---:|---:|---|`,
  ...rows.map(
    (r) =>
      `| ${r.group === "floor" ? "floor: " : ""}${r.name} | ${f(r.oci.first)} | ${f(r.oci.median)} | ${r.boci.note ?? f(r.boci.first)} | ${r.boci.note ? "" : f(r.boci.median)} | ${speedup(r.oci, r.boci)} | ${f(r.oci.rssMB)} | ${f(r.boci.rssMB)} | ${r.why} |`,
  ),
  ``,
  `Install footprint: oci ${footprint.ociMB.toFixed(0)} MB (Python venv) · boci ${footprint.bociMB.toFixed(0)} MB (single binary)`,
];
const report = lines.join("\n");
console.log(report);

const outDir = join(ROOT, "bench", "results");
await mkdir(outDir, { recursive: true });
await Bun.write(join(outDir, "latest.md"), `${report}\n`);
await Bun.write(
  join(outDir, "latest.json"),
  `${JSON.stringify({ at: new Date().toISOString(), runs: RUNS, footprint, rows }, null, 2)}\n`,
);
