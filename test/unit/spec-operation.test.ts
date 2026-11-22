import { expect, test } from "bun:test";

type Operation = {
  client: string;
  method: string;
  http: string;
  path: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, { arg: string; collectionFormat?: string }>;
  headerParams: Record<string, { arg?: string; value?: string }>;
  body?: string;
  responseType?: string;
  paginated: boolean;
};
type Spec = {
  clients: Record<
    string,
    { basePath: string; endpointTemplate: string; endpointServiceName: string }
  >;
  commands: Record<string, { kind: string; operation?: Operation }>;
};

const root = `${import.meta.dir}/../../spec`;
const os = (await Bun.file(`${root}/os.json`).json()) as Spec;
const iam = (await Bun.file(`${root}/iam.json`).json()) as Spec;

test("os ns get maps to GET /n with an optional compartmentId query", () => {
  const op = os.commands["ns get"]?.operation;
  expect(op).toMatchObject({
    client: "object_storage.object_storage",
    method: "get_namespace",
    http: "GET",
    path: "/n",
    responseType: "str",
    paginated: false,
  });
  expect(op?.queryParams.compartmentId?.arg).toBe("compartment_id");
  expect(op?.headerParams.accept?.value).toBe("application/json");
});

test("list operations record path params, collection formats and pagination", () => {
  const op = os.commands["bucket list"]?.operation;
  expect(op?.path).toBe("/n/{namespaceName}/b");
  expect(op?.pathParams.namespaceName).toBe("namespace_name");
  expect(op?.queryParams.fields?.collectionFormat).toBe("csv");
  expect(op?.paginated).toBe(true);
});

test("body operations record the body argument", () => {
  const op = os.commands["bucket create"]?.operation;
  expect(op?.http).toBe("POST");
  expect(op?.body).toBe("create_bucket_details");
});

test("clients record endpoint template and base path", () => {
  const client = os.clients["object_storage.object_storage"];
  expect(client?.endpointTemplate).toContain("objectstorage.{region}");
  expect(client?.basePath).toBe("/");
  expect(iam.commands["region list"]?.operation?.path).toBe("/regions");
});

test("every generated GET path placeholder names an SDK path argument", async () => {
  const missing: string[] = [];
  for await (const file of new Bun.Glob("*.json").scan(root)) {
    if (file === "index.json") continue;
    const spec = (await Bun.file(`${root}/${file}`).json()) as Spec;
    for (const [name, cmd] of Object.entries(spec.commands)) {
      const op = cmd.operation;
      if (cmd.kind !== "generated" || op?.http !== "GET") continue;
      for (const [placeholder] of op.path.matchAll(/\{[^{}]+\}/g)) {
        if (!op.pathParams[placeholder.slice(1, -1)]) {
          missing.push(`${file} ${name}: ${placeholder}`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
});

test("every generated command has an operation", async () => {
  const missing: string[] = [];
  for await (const file of new Bun.Glob("*.json").scan(root)) {
    if (file === "index.json") continue;
    const spec = (await Bun.file(`${root}/${file}`).json()) as Spec;
    for (const [name, cmd] of Object.entries(spec.commands)) {
      if (cmd.kind === "generated" && !cmd.operation)
        missing.push(`${file} ${name}`);
    }
  }
  expect(missing).toEqual([]);
});
