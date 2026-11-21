# /// script
# requires-python = "==3.12.*"
# dependencies = ["oci-cli==3.96.3"]
# ///
"""Golden data for boci's request signer: oci.signer.Signer on fixed-date requests,
signed with the committed throwaway test key (test/fixtures/fake_oci_api_key.pem)."""

import json
import os

from oci._vendor import requests
from oci.signer import Signer

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
KEY = os.path.join(ROOT, "test", "fixtures", "fake_oci_api_key.pem")
signer = Signer("ocid1.tenancy.oc1..t", "ocid1.user.oc1..u", "aa:bb:cc", KEY)

DATE = "Sat, 21 Nov 2026 07:00:09 GMT"
CASES = [
    ("GET", "https://objectstorage.us-ashburn-1.oraclecloud.com/n", None, True),
    ("GET", "https://identity.us-ashburn-1.oci.oraclecloud.com/20160918/regions", None, True),
    ("GET", "https://objectstorage.us-ashburn-1.oraclecloud.com/n/ns/b?compartmentId=ocid1.compartment.oc1..x&limit=5&fields=tags", None, True),
    ("GET", "http://127.0.0.1:43123/n/ns/b/bk/o/dir%2Ffile%20name.txt", None, True),
    ("DELETE", "https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances/ocid1.instance.oc1.phx.abc", None, True),
    ("HEAD", "https://objectstorage.us-ashburn-1.oraclecloud.com/n/ns/b/bk", None, True),
    ("POST", "https://objectstorage.us-ashburn-1.oraclecloud.com/n/ns/b", '{"name": "b", "compartmentId": "c"}', True),
    ("PUT", "https://iaas.us-ashburn-1.oraclecloud.com/20160918/vcns/ocid1.vcn.oc1..x", '{"displayName": "caf\\u00e9"}', True),
    ("PUT", "https://iaas.us-ashburn-1.oraclecloud.com/20160918/vcns/x", "", True),
    ("POST", "https://iaas.us-ashburn-1.oraclecloud.com/20160918/instances/x?action=STOP", None, True),
    ("PATCH", "https://example.us-ashburn-1.oci.oraclecloud.com/20200101/things/x", '[{"op": "add"}]', True),
    ("POST", "https://objectstorage.us-ashburn-1.oraclecloud.com/n/ns/b/bk/o", "raw object body", False),
    ("PUT", "https://objectstorage.us-ashburn-1.oraclecloud.com/n/ns/b/bk/o/x", "unicode éè body", True),
]

out = []
for method, url, body, enforce in CASES:
    req = requests.Request(method, url, data=body if body is not None else None, headers={"date": DATE, "accept": "application/json"})
    prepared = req.prepare()
    (signer if enforce else signer.without_content_headers)(prepared)
    headers = {k.lower(): v for k, v in prepared.headers.items()}
    out.append({
        "method": method, "url": url, "body": body, "enforceContentHeaders": enforce,
        "headers": {k: headers[k] for k in ("date", "host", "content-type", "content-length", "x-content-sha256", "authorization") if k in headers},
    })

with open(os.path.join(ROOT, "test", "fixtures", "signer.json"), "w") as f:
    json.dump(out, f, indent=1, ensure_ascii=False)
print(len(out))
