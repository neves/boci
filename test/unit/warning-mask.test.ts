import { expect, test } from "bun:test";
import { OUTPUT_MASKS } from "../harness/masks.ts";

test("only the duplicate --from-json warning is masked", () => {
  const prefix = "/tmp/click/core.py:42: UserWarning: ";
  const duplicate =
    prefix +
    "The parameter --from-json is used more than once. Remove its duplicate as parameters should be unique.\n  self.get_params(ctx)\n";
  const unrelated = prefix + "An unrelated warning\n  warn(message)\n";
  let output = duplicate + unrelated;
  for (const [pattern, replacement] of OUTPUT_MASKS)
    output = output.replace(pattern, replacement);
  expect(output).toBe(unrelated);
});
