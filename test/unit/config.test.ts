import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, fromFile } from "../../src/config.ts";

type Case = {
  name: string;
  text: string | null;
  profile: string;
  config?: Record<string, unknown>;
  error?: { type: string; message: string };
};
const cases = (await Bun.file(
  `${import.meta.dir}/../fixtures/config.json`,
).json()) as Case[];
const KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\nOCI_API_KEY\n";

// Generated from oci.config.from_file by tools/extract/config_fixtures.py.
test("fromFile matches oci.config.from_file", async () => {
  for (const c of cases) {
    const dir = await mkdtemp(join(tmpdir(), "boci-config-"));
    try {
      await Bun.write(join(dir, "key.pem"), KEY);
      if (c.text !== null) {
        await Bun.write(join(dir, "config"), c.text.replaceAll("{dir}", dir));
        await chmod(join(dir, "config"), 0o600);
      }
      const env = { HOME: dir };
      let got: { config?: unknown; error?: unknown };
      try {
        const cfg = fromFile(join(dir, "config"), c.profile, env, dir);
        got = {
          config: Object.fromEntries(
            Object.entries(cfg).map(([k, v]) => [
              k,
              typeof v === "string" ? v.replaceAll(dir, "{dir}") : v,
            ]),
          ),
        };
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        got = {
          error: { type: e.type, message: e.message.replaceAll(dir, "{dir}") },
        };
      }
      expect({
        name: c.name,
        text: c.text,
        profile: c.profile,
        ...got,
      }).toEqual(c as never);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
