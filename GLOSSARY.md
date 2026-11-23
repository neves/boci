# boci

boci is a drop-in replacement for Oracle's `oci` CLI: any invocation of `oci ...` should behave identically as `boci ...`. This glossary names the concepts used to measure and drive that parity.

## The two CLIs

**Reference CLI**:
The pinned release of Oracle's `oci` CLI that boci is measured against. Its behavior is the definition of correct.
_Avoid_: oci-cli, upstream, original

**Drop-in**:
The property that replacing `oci` with `boci` in any script yields the same stdout, stderr error shape, exit code, and config/env behavior.
_Avoid_: compatible, clone

## Command surface

**Command surface**:
The complete tree of services, command groups, leaf commands, and their flags exposed by the Reference CLI.
_Avoid_: API surface, spec

**Service**:
A top-level command group corresponding to one OCI service (e.g. `os`, `iam`, `compute`).
_Avoid_: module, product

**Command group**:
Any non-leaf node in the Command surface; it only groups other commands.
_Avoid_: namespace, resource

**Leaf command**:
An executable node in the Command surface (e.g. `os bucket list`); the unit of parity tracking.
_Avoid_: operation, endpoint, subcommand

**Generated command**:
A Leaf command whose behavior in the Reference CLI is a direct mapping of flags onto a single API operation.
_Avoid_: simple command, standard command

**Custom command**:
A Leaf command whose behavior in the Reference CLI is hand-written logic beyond a single API operation mapping (e.g. multipart upload, bulk download, setup wizard).
_Avoid_: extended command, special command

**Engine feature**:
A cross-cutting capability shared by many Leaf commands (an auth method, pagination, `--query`, waiting for state, output formats).
_Avoid_: core feature, global option

**Extension command**:
A boci-only command (such as `boci update`) that does not exist in the Reference CLI, listed in a separate trailing section of root `--help`.
_Avoid_: custom command, extra command, boci-native command

## Parity tracking

**Parity test**:
A check that runs the same invocation through the Reference CLI and boci and asserts identical observable behavior.
_Avoid_: comparison test, e2e test

**Verification state**:
Where a Leaf command stands: **missing** (boci rejects it), **implemented** (boci accepts and executes it), or **verified** (a Parity test passes).
_Avoid_: status, progress

**Divergence**:
A known, recorded difference between boci and the Reference CLI for a specific invocation, with the reason it is hard to match.
_Avoid_: bug, known issue, edge case

**Ladder**:
The ordered sequence of rungs, from easiest to hardest, in which Engine features and Custom commands are built.
_Avoid_: roadmap, phases, milestones

**Recording**:
A captured request and response from the live account, scrubbed of identifying values, that Parity tests replay offline.
_Avoid_: fixture, cassette, snapshot

**Test-owned resource**:
A live OCI resource created by a Parity test and carrying the test marker; the only kind of resource a Parity test may modify or delete.
_Avoid_: test resource, temp resource

**Fallback**:
Opt-in delegation of a missing Leaf command from boci to an installed Reference CLI.
_Avoid_: passthrough, proxy mode

**Test tier**:
The safety class of a Parity test: **read-only** (runs live freely), **mutating** (runs live only against Always-Free resources it creates itself, marked as test-owned, and deletes them afterwards), or **request-only** (compared by the requests each CLI would send, never executed live).
_Avoid_: test level, test type
