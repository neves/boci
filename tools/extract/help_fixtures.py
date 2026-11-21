# /// script
# requires-python = "==3.12.*"
# dependencies = ["oci-cli==3.96.3"]
# ///
"""Golden data for boci's port of Click's help formatting (src/help/).

Feeds a deterministic sample of real help texts from spec/ through Click's own
wrap_text / make_default_short_help and oci's OciHelpFormatter at many widths.
Writes test/fixtures/help-format.json.
"""

import glob
import json
import os
import random

from click.formatting import wrap_text
from click.utils import make_default_short_help
from oci_cli.click_help_formatter import OciHelpFormatter

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
random.seed(1234)

texts, records = [], []
for path in sorted(glob.glob(os.path.join(ROOT, "spec", "*.json"))):
    if path.endswith("index.json"):
        continue
    spec = json.load(open(path))
    for node in list(spec["commands"].values()) + list(spec["groups"].values()):
        doc = node.get("helpDoc")
        if not doc:
            continue
        if doc["text"]:
            texts.append(doc["text"])
        records.extend(doc["records"])

texts = random.sample(texts, 600)
rec_sets = [random.sample(records, random.randint(1, 8)) for _ in range(300)]
widths = [10, 23, 40, 50, 58, 64, 78]

cases = {"wrap": [], "shortHelp": [], "writeText": [], "writeDl": []}
for i, t in enumerate(texts):
    w = widths[i % len(widths)]
    cases["wrap"].append({"text": t, "width": w, "out": wrap_text(t, w, "  ", "    ", preserve_paragraphs=True)})
    limit = [20, 45, 50, 63][i % 4]
    cases["shortHelp"].append({"text": t, "limit": limit, "out": make_default_short_help(t, limit)})
    f = OciHelpFormatter(width=[50, 58, 78][i % 3])
    f.indent()
    f.write_text(t)
    cases["writeText"].append({"text": t, "width": f.width, "out": f.getvalue()})
for i, rows in enumerate(rec_sets):
    f = OciHelpFormatter(width=[50, 58, 78][i % 3])
    f.indent()
    f.write_dl([tuple(r) for r in rows])
    cases["writeDl"].append({"rows": rows, "width": f.width, "out": f.getvalue()})

out = os.path.join(ROOT, "test", "fixtures", "help-format.json")
with open(out, "w") as fh:
    json.dump(cases, fh, ensure_ascii=False)
print(f"wrote {sum(len(v) for v in cases.values())} cases")
