import { expect, test } from "bun:test";
import { scrub, scrubOcid } from "../harness/record.ts";

const tenancy =
  "ocid1.tenancy.oc1..aaaaaaaarealtenancyuniquepart1234567890abcdefghijklmnopq";
const compartment =
  "ocid1.compartment.oc1..aaaaaaaarealcompartmentpart0987654321zyxwvutsrqponmlkj";
const instance = "ocid1.instance.oc1.sa-vinhedo-1.anrhkljrrealinstancepart";

test("OCIDs keep type, realm, region and length but lose the unique part", () => {
  const fake = scrubOcid(instance);
  expect(fake.startsWith("ocid1.instance.oc1.sa-vinhedo-1.")).toBe(true);
  expect(fake).toHaveLength(instance.length);
  expect(fake).not.toContain("realinstance");
});

test("scrubbing is deterministic so references stay consistent", () => {
  expect(scrubOcid(compartment)).toBe(scrubOcid(compartment));
  expect(scrubOcid(compartment)).not.toBe(scrubOcid(tenancy));
});

test("scrub replaces OCIDs, the namespace and the fingerprint everywhere", () => {
  const text = JSON.stringify({
    url: `https://objectstorage.sa-vinhedo-1.oraclecloud.com/n/myrealns/b?compartmentId=${compartment}`,
    auth: `keyId="${tenancy}/ocid1.user.oc1..aaaaaaaauser/12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0"`,
    data: { namespace: "myrealns", "compartment-id": compartment },
  });
  const out = scrub(text, {
    namespace: "myrealns",
    fingerprint: "12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0",
  });
  expect(out).not.toContain("myrealns");
  expect(out).not.toContain("realcompartment");
  expect(out).not.toContain("realtenancy");
  expect(out).not.toContain("12:34:56:78");
  expect(out).toContain("/n/bocifakens/b?");
});

test("namespace is only replaced as a whole token", () => {
  expect(scrub("ns abc abcdef", { namespace: "abc" })).toBe(
    "ns bocifakens abcdef",
  );
});

test("signature values are removed", () => {
  const json = JSON.stringify({
    a: 'Signature headers="date",signature="QUJDRA==",version="1"',
  });
  expect(scrub(json, {})).not.toContain("QUJDRA==");
});
