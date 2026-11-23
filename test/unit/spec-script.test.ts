import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const spec = (...args: string[]) =>
  Bun.spawnSync(["bun", "scripts/spec.ts", ...args], {
    cwd: root,
  }).stdout.toString();

test("bun run spec prints a Tier B command's patterns and survey", () => {
  const out = spec("lb", "backend-set", "create");
  expect(out).toContain("tier: B");
  expect(out).toMatch(/^patterns: .*fold-body.*helper/m);
  expect(out).toContain("invokes: services.load_balancer");
  expect(out).toContain("fold: health_checker_port → health_checker.port");
});

test("bun run spec prints usage checks of a Tier B command", () => {
  const out = spec("ce", "cluster", "create");
  expect(out).toContain(
    "check: Cannot specify --endpoint-nsg-ids without --endpoint-subnet-id",
  );
});
