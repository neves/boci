"""Loaded by the Reference CLI's Python when tools/record is on PYTHONPATH.

If BOCI_RECORD_FILE is set, every HTTP exchange made through `requests` is appended
to it as one JSON line, exactly as sent and received. TLS and request signing are
untouched, which a forwarding proxy could not achieve (the signed `host` would differ).
"""

import base64
import json
import os

_path = os.environ.get("BOCI_RECORD_FILE")

if _path:
    import importlib

    def _body(data):
        if data is None:
            return {"text": ""}
        if hasattr(data, "read"):
            return {"stream": True}
        if isinstance(data, str):
            data = data.encode()
        try:
            return {"text": data.decode("utf-8")}
        except UnicodeDecodeError:
            return {"base64": base64.b64encode(data).decode()}

    def _wrap(adapter_cls):
        original = adapter_cls.send

        def send(self, request, **kwargs):
            response = original(self, request, **kwargs)
            entry = {
                "request": {
                    "method": request.method,
                    "url": request.url,
                    "headers": dict(request.headers),
                    "body": _body(request.body),
                },
                "response": {
                    "status": response.status_code,
                    "headers": dict(response.headers),
                    "body": _body(response.content),
                },
            }
            with open(_path, "a") as f:
                f.write(json.dumps(entry) + "\n")
            return response

        adapter_cls.send = send

    # The OCI SDK vendors its own copy of requests; hook both copies.
    for _mod in ("oci._vendor.requests.adapters", "requests.adapters"):
        try:
            _wrap(importlib.import_module(_mod).HTTPAdapter)
        except ImportError:
            pass
