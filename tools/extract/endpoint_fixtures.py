# /// script
# requires-python = "==3.12.*"
# dependencies = ["oci-cli==3.96.3"]
# ///
"""Golden data for boci's endpoint resolution: real SDK clients built the way the CLI's
cli_util.build_client builds them (explicit realm-specific / dual-stack booleans)."""

import glob
import importlib
import json
import os
import random

from oci.signer import Signer

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
KEY = os.path.join(ROOT, "test", "fixtures", "fake_oci_api_key.pem")
signer = Signer("ocid1.tenancy.oc1..t", "ocid1.user.oc1..u", "aa:bb", KEY)
random.seed(7)

clients = {}
for path in sorted(glob.glob(os.path.join(ROOT, "spec", "*.json"))):
    if path.endswith("index.json"):
        continue
    for key, info in json.load(open(path)).get("clients", {}).items():
        clients[key] = info["class"]

REGIONS = ["us-ashburn-1", "sa-vinhedo-1", "iad", "GRU", "us-langley-1", "uk-gov-london-1", "eu-frankfurt-2", "xx-unknown-1", "example.com"]
ENDPOINTS = [None, "http://127.0.0.1:9", "https://x.example.com/20160918/"]

def build(cls, region, endpoint, realm, dual):
    config = {"user": "ocid1.user.oc1..aaaaaaaabocifakeuser", "tenancy": "ocid1.tenancy.oc1..aaaaaaaabocifaketenancy", "fingerprint": "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99", "key_file": KEY, "region": region}
    kwargs = {"signer": signer, "client_level_realm_specific_endpoint_template_enabled": realm, "client_level_dualstack_endpoints_enabled": dual}
    if endpoint:
        kwargs["service_endpoint"] = endpoint
    client = cls(config, **kwargs)
    if endpoint:
        client.base_client.endpoint = endpoint  # build_client does this too
    return client.base_client

out = []
keys = sorted(clients)
sample = set(random.sample(keys, 40))
for key in keys:
    module, _, name = clients[key].rpartition(".")
    cls = getattr(importlib.import_module(module), name)
    combos = [("us-ashburn-1", None, False, False)]
    if key in sample:
        combos = [(r, e, realm, dual) for r in REGIONS for e in ENDPOINTS[:1] for realm in (False, True) for dual in (False, True)]
        combos += [("us-ashburn-1", e, False, False) for e in ENDPOINTS[1:]]
    for region, endpoint, realm, dual in combos:
        case = {"client": key, "region": region, "endpoint": endpoint, "realmSpecific": realm, "dualStack": dual}
        try:
            bc = build(cls, region, endpoint, realm, dual)
            case["stored"] = bc.endpoint
            case["resolved"] = bc.update_endpoint_template_for_options()
        except Exception as e:
            case["error"] = {"type": type(e).__name__, "message": str(e)}
        out.append(case)

with open(os.path.join(ROOT, "test", "fixtures", "endpoints.json"), "w") as f:
    json.dump(out, f)
print(len(out), sum("error" in c for c in out))
