import { expect, test } from "bun:test";
import {
  FLAG_NEEDS_VALUE,
  OptionParser,
  type ParamSpec,
  type ParseSettings,
  UNSET,
  UsageError,
} from "../../src/parser.ts";

type Case = {
  path: string[];
  argv: string[];
  opts?: Record<string, unknown>;
  args?: string[];
  order?: string[];
  error?: { type: string; message: string; option: string | null };
};
type Node = { params?: ParamSpec[]; helpDoc: { parse: ParseSettings } };

const root = `${import.meta.dir}/../..`;
const cases = (await Bun.file(
  `${root}/test/fixtures/parse.json`,
).json()) as Case[];
const index = await Bun.file(`${root}/spec/index.json`).json();
const services = new Map<
  string,
  { top: Node; groups: Record<string, Node>; commands: Record<string, Node> }
>();

async function node(
  path: string[],
): Promise<{ params: ParamSpec[]; parse: ParseSettings }> {
  if (path.length === 0)
    return { params: index.globalParams, parse: index.rootHelpDoc.parse };
  const [service, ...sub] = path as [string, ...string[]];
  if (!services.has(service))
    services.set(
      service,
      await Bun.file(`${root}/spec/${service}.json`).json(),
    );
  const spec = services.get(service);
  const key = sub.join(" ");
  const n = (
    sub.length ? (spec?.groups[key] ?? spec?.commands[key]) : spec?.top
  ) as Node;
  return { params: n.params ?? [], parse: n.helpDoc.parse };
}

const plain = (v: unknown): unknown =>
  v === UNSET
    ? { $: "UNSET" }
    : v === FLAG_NEEDS_VALUE
      ? { $: "FLAG_NEEDS_VALUE" }
      : Array.isArray(v)
        ? v.map(plain)
        : v;

// Generated from Click's real parser by tools/extract/parse_fixtures.py.
test("matches Click's option parser on generated argv for real oci commands", async () => {
  for (const c of cases) {
    const { params, parse } = await node(c.path);
    const parser = new OptionParser(params, parse);
    const label = `${c.path.join(" ") || "oci"} ${JSON.stringify(c.argv)}`;
    try {
      const r = parser.parse(c.argv);
      expect({
        label,
        opts: Object.fromEntries(
          Object.entries(r.opts).map(([k, v]) => [k, plain(v)]),
        ),
        args: r.args,
        order: r.order.map((p) => p.name),
      }).toEqual({
        label,
        opts: c.opts as never,
        args: c.args as never,
        order: c.order as never,
      });
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      expect({
        label,
        type: e.type,
        message: e.message,
        option: e.option ?? null,
      }).toEqual({ label, ...(c.error as never as object) } as never);
    }
  }
});
