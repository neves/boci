# 01: Handler registry with lazy dispatch

**What to build:** Every Custom command handler (os, session, setup, profile, update) registers in one map from Leaf command key (e.g. `"os object get"`) to a lazily imported handler. The CLI dispatches through that map instead of importing each handler module directly, so adding hundreds of handlers later costs nothing at startup. The Custom command entries in `IMPLEMENTED` are derived from the map instead of listed by hand (Engine feature keys such as `--query` stay hand-listed). No behaviour change.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Context for the implementer

- Read GLOSSARY.md entries: Leaf command, Custom command, Generated command, Engine feature.
- The registry module holds `IMPLEMENTED`/`EXCLUDED`/`engineSupports`; the CLI module currently imports `run*` functions from each command module directly. Find them with `rg -n "commands/" src/core/cli.ts`.
- Use Bun-native dynamic `import()`; the build bundles to one binary, so dynamic imports stay in the binary but are only evaluated on use.
- Keep the registry module free of heavy imports: tooling scripts (`bun run status`, `ladder`) call `isImplemented` and must stay fast.

## Acceptance criteria

- [ ] One map is the single source of truth for Custom command handlers; the CLI no longer imports individual command modules statically.
- [ ] Custom command keys in `IMPLEMENTED` come from that map; `bun run status` reports the same verified count as before (7458 at time of writing).
- [ ] `bun run bench` startup time for `--version` and a generated GET is not worse than `bench/results/latest.md`.
- [ ] A unit test asserts every key in the map is a real Leaf command in the spec.
- [ ] `bun run verify` green. Commit message: `refactor: lazy custom command registry`.
