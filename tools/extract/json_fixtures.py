# /// script
# requires-python = "==3.12.*"
# ///
"""Golden data for boci's Python-compatible JSON (src/pyjson.ts): json.loads then
json.dumps(indent=2, sort_keys=True, ensure_ascii=False), as oci's pretty_print_format."""

import json
import os

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
INPUTS = [
    '"fake-namespace"', '{"b": 1, "a": [1, 2.0, -0, -0.0, 1e16, 1.5e-7, 0.1, 100000000000000000000000, 1.7976931348623157e308]}',
    '[]', '{}', '[{}, []]', '{"x": {"y": {"z": null}}}', '"caf\\u00e9 \\u2603 \\ud83d\\ude00"', '"line\\nbreak\\ttab\\u0001\\u007f"',
    '{"Z": 1, "a": 2, "_": 3, "é": 4, "B": 5}', 'true', 'false', 'null', '123456789012345678901234567890',
    '[1e5, 1E5, 12.5e2, 3.0, 2.50, 1e-5, 0.0001, 0.00001, 123456789012345.6, 1234567890123456.7, 12345678901234567.8]',
    '{"quote": "\\"q\\" \\\\ /"}', '"\\u00e9\\u00e8"', '[-1, -1.5, -1e-10]', '{"k": [true, false, null, "s"]}',
]
cases = []
for text in INPUTS:
    value = json.loads(text)
    cases.append({"input": text, "out": json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)})
with open(os.path.join(ROOT, "test", "fixtures", "pyjson.json"), "w") as f:
    json.dump(cases, f, indent=1, ensure_ascii=False)
print(len(cases))
