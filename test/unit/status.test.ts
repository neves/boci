import { expect, test } from "bun:test";
import {
  buildStatus,
  parseLadder,
  renderStatus,
} from "../../scripts/status-lib.ts";

const index = {
  referenceVersion: "3.96.3",
  root: {
    name: "oci",
    hidden: false,
    commands: {
      os: {
        name: "os",
        hidden: false,
        commands: {
          ns: {
            name: "ns",
            hidden: false,
            commands: {
              get: { name: "get", hidden: false },
              "get-metadata": { name: "get-metadata", hidden: false },
            },
          },
        },
      },
      iam: {
        name: "iam",
        hidden: false,
        commands: {
          region: {
            name: "region",
            hidden: false,
            commands: { list: { name: "list", hidden: false } },
          },
        },
      },
    },
  },
};

const ladder = `# plan
## Rung -1 — Foundations
- [x] Skeleton
- [ ] Status
## Rung 0 — Offline
- [~] Hard thing
- [ ] Version
`;

test("parses ladder items by rung with their state", () => {
  const rungs = parseLadder(ladder);
  expect(rungs.map((r) => r.title)).toEqual([
    "Rung -1 — Foundations",
    "Rung 0 — Offline",
  ]);
  expect(rungs[0]?.items).toEqual([
    { text: "Skeleton", state: "done" },
    { text: "Status", state: "todo" },
  ]);
  expect(rungs[1]?.items[0]?.state).toBe("stuck");
});

test("counts leaf commands per service by verification state", () => {
  const status = buildStatus({
    index,
    ladder,
    implemented: (path) =>
      path === "os ns get" || path === "os ns get-metadata",
    results: { "os ns get": { pass: true } },
    divergences: 1,
  });
  expect(status.totals).toEqual({
    missing: 1,
    implemented: 1,
    verified: 1,
    total: 3,
  });
  expect(status.services.os).toEqual({
    missing: 0,
    implemented: 1,
    verified: 1,
    total: 2,
  });
  expect(status.next).toBe("Status");
  expect(status.divergences).toBe(1);
});

test("a failing parity result does not count as verified", () => {
  const status = buildStatus({
    index,
    ladder,
    implemented: (path) => path === "os ns get",
    results: { "os ns get": { pass: false } },
    divergences: 0,
  });
  expect(status.services.os?.verified).toBe(0);
  expect(status.services.os?.implemented).toBe(1);
});

test("renders totals, the next ladder item and missing leaves for one service", () => {
  const status = buildStatus({
    index,
    ladder,
    implemented: () => false,
    results: {},
    divergences: 0,
  });
  const text = renderStatus(status, { service: "os" });
  expect(text).toContain("3.96.3");
  expect(text).toContain("Next: Status");
  expect(text).toContain("missing  os ns get");
});
