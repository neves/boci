import { expect, test } from "bun:test";
import { getPosixMode } from "../../src/utils/posixMode.ts";
import { FAKE, createSandbox, fingerprint } from "../harness/sandbox.ts";

test("sandbox writes a config with the fake identity and an isolated HOME", async () => {
  await using sb = await createSandbox();
  const config = await Bun.file(sb.configFile).text();
  expect(config).toContain(`tenancy=${FAKE.tenancy}`);
  expect(config).toContain(`user=${FAKE.user}`);
  expect(config).toContain(`key_file=${sb.keyFile}`);
  expect(config).toContain(`fingerprint=${await fingerprint(sb.keyFile)}`);
  expect(sb.env.HOME).toBe(sb.home);
  expect(sb.configFile.startsWith(sb.home)).toBe(true);
});

test("sandbox files are private so neither CLI warns about permissions", async () => {
  await using sb = await createSandbox();
  for (const file of [sb.configFile, sb.keyFile]) {
    expect(getPosixMode(file)).toBe(0o600);
  }
});

test("fingerprint is the colon-separated MD5 of the DER public key", async () => {
  await using sb = await createSandbox();
  expect(await fingerprint(sb.keyFile)).toMatch(
    /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/,
  );
});

test("sandbox is removed on dispose", async () => {
  let home = "";
  {
    await using sb = await createSandbox();
    home = sb.home;
  }
  expect(await Bun.file(`${home}/.oci/config`).exists()).toBe(false);
});
