import { expect, test } from "bun:test";

type Node = {
  name: string;
  hidden: boolean;
  commands?: Record<string, Node>;
};

const index = (await Bun.file(
  `${import.meta.dir}/../../spec/index.json`,
).json()) as {
  referenceVersion: string;
  servicesWithoutCommands: string[];
  root: Node;
};

const leaves = (node: Node): number =>
  node.commands
    ? Object.values(node.commands).reduce((n, c) => n + leaves(c), 0)
    : 1;

test("spec index is extracted from the pinned Reference CLI", () => {
  expect(index.referenceVersion).toBe("3.96.3");
});

test("spec index contains os ns get as a leaf command", () => {
  const get = index.root.commands?.os?.commands?.ns?.commands?.get;
  expect(get).toBeDefined();
  expect(get?.commands).toBeUndefined();
});

test("spec index covers non-service top-level commands", () => {
  for (const name of ["setup", "session", "raw-request", "profile"]) {
    expect(index.root.commands?.[name]).toBeDefined();
  }
});

test("services listed without code are recorded, not dropped", () => {
  expect(index.servicesWithoutCommands).toContain("occ");
  expect(index.root.commands?.occ).toBeUndefined();
});

test("spec index has the full command surface", () => {
  expect(leaves(index.root)).toBeGreaterThan(9_000);
});
