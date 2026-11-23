# 16: Tier A accepts `del kwargs[...]` and custom blank checks

**What to build:** The 61 Tier B commands whose only patterns are `kwargs-del` and/or `blank-check` (ticket 10 survey) become Tier A: the extractor treats `del kwargs['x']` like `kwargs.pop('x')`, and a wrapper's `Parameter --x cannot be whitespace or empty string` check is recorded so the Engine raises it with the custom option name. They then run through the generic Engine like other Tier A wrappers.

**Blocked by:** 09: Tier A writes, 10: Tier B survey.

**Status:** done. Tiers now A 853, B 133, C 202. All 61 commands (plus the two `data-science ... download-package` wrappers, mis-tagged `file-read` because they write a download to `--file`) are Tier A, run through the Engine, and pass their Parity cases; 63 Ladder items ticked. The extractor's new `.read()`/`parse_json_parameter` rule moved `support incident put-attachment` to Tier B (ticket 12). The Engine also gained the generated commands' path-param blank check.

## Context for the implementer

- Command list: section "16" of `.scratch/remaining-commands/tier-b-report.md` (34 `kwargs-del` only, 25 both, 2 `blank-check` only): mostly `data-science ml-app*`, `db autonomous-database create|update|create-from-clone`, `db pluggable-database create|*-clone`, `instance-agent command *`, `resource-manager job create-*-job`, `nosql`, `rover node change-compartment|get-encryption-key`.
- Extractor: `sdk.custom_delegate` rejects `ast.Delete`; accept `del kwargs['x']` (also inside `if 'x' in kwargs:`) exactly where it accepts `kwargs.pop('x')`, and accept the blank-check `if isinstance(kwargs['x'], six.string_types) and len(kwargs['x'].strip()) == 0: raise click.UsageError(...)` as a recorded check (e.g. `delegate.blankChecks: ["x"]`, message from the source). The survey already records them under `survey.checks`.
- Check whether the Engine already raises the generated commands' own blank-check for path params; the custom message must name the custom option (`--ml-app-id`, not `--ml-application-id`), and the custom check runs before the generated one.
- `kwargs-del` also appears in 61 other Tier B commands (tickets 11–14); doing it here first lets those tickets ignore it.
- Write cases first: hand-written Parity cases for 2–3 examples (one blank-check error case, offline), record goldens with `bun run golden --filter <id-prefix>`, then widen through the case generator for every command that becomes Tier A.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 16`) for the rest.

## Acceptance criteria

- [x] Regenerated spec: the 61 commands are Tier A (report the new A/B/C counts in the commit body); no previously verified case changes.
- [x] Every one of them is verified, excluded with a reason, or covered by a follow-up ticket.
- [x] One commit per cause; `bun run ladder sync` run.
- [x] `bun run verify` green.
