import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, fromFile } from "../../src/core/config.ts";

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
    const dir = (await mkdtemp(join(tmpdir(), "boci-config-"))).replaceAll(
      "\\",
      "/",
    );
    try {
      await Bun.write(`${dir}/key.pem`, KEY);
      if (c.text !== null) {
        await Bun.write(`${dir}/config`, c.text.replaceAll("{dir}", dir));
        await chmod(`${dir}/config`, 0o600);
      }
      const env = { HOME: dir };
      let got: { config?: unknown; error?: unknown };
      const winDir = dir.replaceAll("/", "\\");
      const normDir = (s: string) =>
        s.replaceAll(dir, "{dir}").replaceAll(winDir, "{dir}");
      try {
        const cfg = fromFile(`${dir}/config`, c.profile, env, dir);
        got = {
          config: Object.fromEntries(
            Object.entries(cfg).map(([k, v]) => [
              k,
              typeof v === "string" ? normDir(v) : v,
            ]),
          ),
        };
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        got = {
          error: {
            type: e.type,
            message: normDir(e.message),
          },
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
