# 24: Connection errors match the Reference CLI

**What to build:** When a request can't connect (e.g. ECONNREFUSED, no `--endpoint` reachable), boci prints the same error and exit code as the Reference CLI (a `RequestException`-style message), instead of crashing with an uncaught `TypeError: ECONNREFUSED` and a stack trace.

**Blocked by:** none.

**Status:** ready-for-agent

## Context for the implementer

- Found while auditing `requestOnly`: the `complex-json-inline` and `complex-json-file` cases (`email-data-plane ... submit-raw-email`, `test/parity/cases/core.json`) have no `--endpoint`, so neither CLI sends a request; against `dist/boci` boci crashes, the Reference CLI prints a `RequestException`. They pass only because `requestOnly` ignores output.
- Fix: give those cases a reachable `--endpoint` so they actually test the request body, and add a separate case (offline, e.g. a closed localhost port, `--no-retry`) for the connection-error output. Record goldens with `bun run golden --filter`.
