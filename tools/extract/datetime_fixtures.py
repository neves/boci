# /// script
# requires-python = "==3.12.*"
# dependencies = ["oci-cli==3.96.3"]
# ///
"""Golden data for boci's CliDatetime port: oci's own convert() on many inputs."""

import json
import os

import click
from oci_cli.custom_types.cli_datetime import CLI_DATETIME, CLI_DATETIME_ROUNDED_MINUTE

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
inputs = [
    "2017-09-15T20:30:00.123456Z", "2017-09-15T20:30:00.1234Z", "2017-09-15T20:30:00.123Z", "2017-09-15T20:30:00.1Z",
    "2017-09-15T20:30:00Z", "2017-09-15T20:30Z", "2017-09-15t20:30:45z",
    "2017-09-15T12:30:00.456789-08:00", "2017-09-15T12:30:00.456-08:00", "2017-09-15T12:30:00-08:00", "2017-09-15T12:35-08:00",
    "2017-09-15T12:30:00.456789-0800", "2017-09-15T12:30:00.456+0530", "2017-09-15T23:30:00+0100", "2017-09-15T12:35-0800",
    "2017-09-15 17:25", "2017-09-15", " 2017-09-15 ", "2017-09-15T17:25", "1412195400", "0", "2000-02-29T23:59:59.999999Z",
    "2017-12-31T23:59:31Z", "2017-12-31T23:59:29.999Z", "1999-12-31T23:30:30-01:00",
    "yesterday", "2017-13-01", "2017-09-15T25:00Z", "2017/09/15", "",
]
cases = []
for value in inputs:
    for name, t in (("none", CLI_DATETIME), ("minute", CLI_DATETIME_ROUNDED_MINUTE)):
        case = {"value": value, "rounding": None if name == "none" else "minute"}
        try:
            case["out"] = t.convert(value, None, None)
        except click.BadParameter as e:
            case["error"] = e.message
        cases.append(case)
with open(os.path.join(ROOT, "test", "fixtures", "datetime.json"), "w") as f:
    json.dump(cases, f, indent=1)
print(len(cases))
