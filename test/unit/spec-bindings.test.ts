import { expect, test } from "bun:test";

type Binding = {
  param?: string;
  target: "kwarg" | "body" | "output";
  key: string[];
  transform?: string;
  value?: unknown;
  when?: string;
  expr?: string;
};
type Command = {
  kind: string;
  params: { name: string; kind: string }[];
  operation?: { body?: string };
  bindings?: Binding[];
};
type Spec = { commands: Record<string, Command> };

const root = `${import.meta.dir}/../../spec`;
const os = (await Bun.file(`${root}/os.json`).json()) as Spec;

const binding = (cmd: Command | undefined, param: string) =>
  cmd?.bindings?.filter((b) => b.param === param);

test("simple params become SDK kwargs", () => {
  const list = os.commands["bucket list"];
  expect(binding(list, "namespace_name")?.[0]).toMatchObject({
    target: "kwarg",
    key: ["namespace_name"],
  });
  expect(binding(list, "limit")?.[0]).toMatchObject({
    target: "kwarg",
    key: ["limit"],
  });
});

test("body params become body fields with their JSON key and transform", () => {
  const create = os.commands["bucket create"];
  expect(binding(create, "name")?.[0]).toMatchObject({
    target: "body",
    key: ["name"],
  });
  expect(binding(create, "compartment_id")?.[0]).toMatchObject({
    target: "body",
    key: ["compartmentId"],
  });
  expect(binding(create, "metadata")?.[0]).toMatchObject({
    target: "body",
    key: ["metadata"],
    transform: "parse_json_parameter",
  });
});

test("the request id becomes a generated kwarg", () => {
  const get = os.commands["ns get"];
  const rid = get?.bindings?.find(
    (b) => b.transform === "use_or_generate_request_id",
  );
  expect(rid?.key).toEqual(["opc_client_request_id"]);
});

// CLI options that only steer the CLI itself and never reach the request.
const META = new Set([
  "help",
  "from_json",
  "all_pages",
  "page_size",
  "wait_for_state",
  "max_wait_seconds",
  "wait_interval_seconds",
  "force",
]);

test("every request-bound param of every generated command has a binding", async () => {
  const unbound: string[] = [];
  for await (const file of new Bun.Glob("*.json").scan(root)) {
    if (file === "index.json") continue;
    const spec = (await Bun.file(`${root}/${file}`).json()) as Spec;
    for (const [name, cmd] of Object.entries(spec.commands)) {
      if (cmd.kind !== "generated") continue;
      const bound = new Set(cmd.bindings?.map((b) => b.param));
      for (const p of cmd.params) {
        if (!META.has(p.name) && !bound.has(p.name))
          unbound.push(`${file} ${name} ${p.name}`);
      }
    }
  }
  expect(unbound.slice(0, 20)).toEqual([]);
});
