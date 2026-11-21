import { expect, test } from "bun:test";

type Param = {
  kind: "option" | "argument";
  name: string;
  opts: string[];
  secondaryOpts: string[];
  type: string;
  required: boolean;
  multiple: boolean;
  isFlag: boolean;
  hidden: boolean;
  choices?: string[];
  default?: unknown;
  help?: string;
};
type Command = { help?: string; hidden: boolean; params: Param[] };
type ServiceSpec = {
  service: string;
  groups: Record<string, { help?: string; hidden: boolean }>;
  commands: Record<string, Command>;
};

const root = `${import.meta.dir}/../../spec`;
const os = (await Bun.file(`${root}/os.json`).json()) as ServiceSpec;
const index = (await Bun.file(`${root}/index.json`).json()) as {
  globalParams: Param[];
};

const param = (cmd: Command | undefined, opt: string) =>
  cmd?.params.find((p) => p.opts.includes(opt));

test("service spec has commands keyed by path below the service", () => {
  expect(os.service).toBe("os");
  expect(os.commands["ns get"]).toBeDefined();
  expect(os.groups.ns).toBeDefined();
  expect(os.groups.bucket?.help).toBeString();
});

test("leaf commands carry help and options with their Click attributes", () => {
  const create = os.commands["bucket create"];
  expect(create?.help).toContain("bucket");
  const name = param(create, "--name");
  expect(name?.required).toBe(true);
  expect(name?.kind).toBe("option");
  expect(name?.help).toBeString();
  const compartment = param(os.commands["ns get"], "--compartment-id");
  expect(compartment?.required).toBe(false);
});

test("choices and flags are recorded", () => {
  const create = os.commands["bucket create"];
  expect(param(create, "--public-access-type")?.choices).toContain(
    "NoPublicAccess",
  );
  const all = param(os.commands["bucket list"], "--all");
  expect(all?.isFlag).toBe(true);
});

test("global options are recorded in the index", () => {
  const output = index.globalParams.find((p) => p.opts.includes("--output"));
  expect(output?.choices).toEqual(expect.arrayContaining(["json", "table"]));
  for (const opt of [
    "--profile",
    "--config-file",
    "--region",
    "--endpoint",
    "--query",
  ]) {
    expect(index.globalParams.some((p) => p.opts.includes(opt))).toBe(true);
  }
});
