# Fork server for `bun run golden` (driven by scripts/oci-zygote.ts). Imports the
# Reference CLI once, exactly as a real `oci <argv>` invocation would (oci_cli loads the
# service named in sys.argv at import), then forks one child per Parity case. Each child
# sets up argv, env, cwd and stdio like a fresh process and runs the same
# `sys.exit(cli())` as the `oci` entry script, then exits as the interpreter would
# (threads, atexit, flush) but skips module teardown, which in a forked child copies the
# whole shared heap and costs most of the time saved.
#
# What a fresh process would do differently, and how it is kept out of goldens:
# - env read at import time: a request whose env (HOME aside) differs from the zygote's
#   gets {"fallback": true}, and so does one naming another service;
# - env written at import time (OCI_PYTHON_SDK_NO_SERVICE_IMPORTS): re-applied in the child;
# - HOME read at import time (cli_setup defaults etc.): the zygote's HOME is a path that
#   doesn't exist, and the caller re-runs any case whose output mentions it.
#
# Protocol: one JSON request per line on fd 0 ({argv, env, cwd, stdin, stdout, stderr}:
# stdin/stdout/stderr are file paths, stdin null = /dev/null); one JSON reply per line on
# fd 1: {"exitCode": n} or {"fallback": true}.
import atexit
import gc
import json
import os
import sys
import threading

ENTRY = os.environ.pop("BOCI_OCI_ENTRY", "oci")


def without_home(env):
    return {k: v for k, v in env.items() if k != "HOME"}


START_ENV = without_home(os.environ)
first = json.loads(sys.argv[1])
sys.argv = [ENTRY, *first]
from oci_cli.cli import cli  # noqa: E402
from oci_cli import dynamic_loader as dl  # noqa: E402

IMPORT_ENV = {k: v for k, v in without_home(os.environ).items() if START_ENV.get(k) != v}


def service_of(argv):
    return next((a for a in argv if a in dl.service_mapping), None)


LOADED = service_of(first)
gc.freeze()  # imported objects stay out of GC passes, so children don't copy their pages


def read_line():
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = os.read(0, 65536)
        if not chunk:
            return None
        buf += chunk
    return buf


def reply(obj):
    os.write(1, (json.dumps(obj) + "\n").encode())


def serve():
    """Returns in a forked child, ready to run the CLI; exits the zygote at EOF."""
    while True:
        line = read_line()
        if line is None:
            os._exit(0)
        req = json.loads(line)
        if (
            without_home(req["env"]) != START_ENV
            or "COMP_WORDS" in req["env"]
            or service_of(req["argv"]) != LOADED
            or (req["argv"] and req["argv"][0] == "setup")
        ):
            reply({"fallback": True})
            continue
        pid = os.fork()
        if pid == 0:
            setup(req)
            return
        _, status = os.waitpid(pid, 0)
        reply({"exitCode": os.waitstatus_to_exitcode(status)})


def setup(req):
    import random

    os.chdir(req["cwd"])
    os.environ.clear()
    os.environ.update(req["env"])
    os.environ.update(IMPORT_ENV)
    random.seed()
    stdin = os.open(req["stdin"] or os.devnull, os.O_RDONLY)
    out = os.open(req["stdout"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    err = os.open(req["stderr"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    for fd, target in ((stdin, 0), (out, 1), (err, 2)):
        os.dup2(fd, target)
        os.close(fd)
    sys.argv = [ENTRY, *req["argv"]]


def exit_code(e):
    if e.code is None:
        return 0
    if isinstance(e.code, int):
        return e.code
    print(e.code, file=sys.stderr)
    return 1


def finish(code):
    threading._shutdown()
    atexit._run_exitfuncs()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            code = 120
    os._exit(code)


serve()
try:
    sys.exit(cli())
except SystemExit as e:
    finish(exit_code(e))
except BaseException:
    sys.excepthook(*sys.exc_info())
    finish(1)
