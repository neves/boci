# Parity tests record live once and replay offline

Both CLIs honour `--endpoint`, so Parity tests route them through a local proxy. Read-only and mutating tests hit the live account only when recording; afterwards boci's output is compared against the Reference CLI's output for the same recorded response, offline and deterministically. Request-only tests point both CLIs at a fake endpoint and compare the requests themselves. This keeps the autonomous loop fast, free, and safe, and lets a fresh checkout run the suite without credentials. Recordings are scrubbed of tenancy/user OCIDs and namespace before commit.

The default `bun test` run is entirely local and must stay fast: it never touches the network. Live calls happen only on explicit opt-in during implementation of a feature, to record and to confirm parity against the real account; the resulting Recordings then become the permanent offline tests.
