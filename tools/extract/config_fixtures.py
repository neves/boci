# /// script
# requires-python = "==3.12.*"
# dependencies = ["oci-cli==3.96.3"]
# ///
"""Golden data for boci's configparser + oci.config.from_file ports.

Writes each sample config to a temp dir, runs oci.config.from_file on it for several
profiles and records the dict or the exception. Paths are made relative to {dir}.
"""

import json
import os
import tempfile

import oci

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
KEY = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\nOCI_API_KEY\n"

SAMPLES = {
    "basic": "[DEFAULT]\nuser=u\nfingerprint=f\ntenancy=t\nregion=us-ashburn-1\nkey_file={dir}/key.pem\n",
    "inherit": "[DEFAULT]\nregion=us-phoenix-1\nkey_file={dir}/key.pem\n\n[other]\nUser = OtherUser\nregion: eu-frankfurt-1\n",
    "comments": "# top comment\n; semicolon\n[DEFAULT]\n  # indented comment\nuser = a b c  \ntenancy=t # not a comment\n\n[p]\nfoo=bar\n",
    "multiline": "[DEFAULT]\nkey=line1\n  line2\n\n  line3\nother = x\n",
    "empty-value": "[DEFAULT]\nadditional_user_agent =\nlog_requests = yes\n",
    "bad-bool": "[DEFAULT]\nlog_requests = maybe\n",
    "no-section": "user=u\n[DEFAULT]\n",
    "dup-section": "[a]\nx=1\n[a]\ny=2\n",
    "dup-option": "[a]\nX=1\nx=2\n",
    "parse-error": "[a]\nnovalue\n  \nalso bad line\n",
    "key-content": "[DEFAULT]\nkey_content = abc\n",
    "missing-key": "[DEFAULT]\nuser=u\n\n[p]\nkey_file = ~/nope.pem\n",
    "crlf": "[DEFAULT]\r\nuser=u\r\n[p]\r\nregion=r\r\n",
    "header-trailing": "[p] trailing\nx=1\n",
    "colon-and-equals": "[p]\na:b=c\nd = e:f\n",
}
PROFILES = ["DEFAULT", "other", "p", "a", "missing"]

cases = []
for name, text in SAMPLES.items():
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "key.pem"), "w") as f:
            f.write(KEY)
        os.environ["HOME"] = d  # ~ expands inside the temp dir, not the real home
        path = os.path.join(d, "config")
        with open(path, "w", newline="") as f:
            f.write(text.replace("{dir}", d))
        for profile in PROFILES:
            case = {"name": name, "text": text, "profile": profile}
            try:
                cfg = oci.config.from_file(path, profile)
                case["config"] = {k: (v.replace(d, "{dir}") if isinstance(v, str) else v) for k, v in cfg.items()}
            except Exception as e:
                case["error"] = {"type": type(e).__name__, "message": str(e).replace(d, "{dir}")}
            cases.append(case)
    # missing file
cases.append({"name": "no-file", "text": None, "profile": "DEFAULT", "error": {"type": "ConfigFileNotFound", "message": "Could not find config file at {dir}/config, please follow the instructions in the link to setup the config file https://docs.oracle.com/en-us/iaas/Content/API/Concepts/sdkconfig.htm"}})
with open(os.path.join(ROOT, "test", "fixtures", "config.json"), "w") as f:
    json.dump(cases, f, indent=1)
print(len(cases))
