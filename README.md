# boci

**The OCI CLI, without the wait.**

boci is a drop-in replacement for Oracle's [`oci` CLI](https://github.com/oracle/oci-cli), built on [Bun](https://bun.sh). It has the same commands, the same flags and the same output, and it starts **10× faster** (41 ms vs 413 ms for `--version`, 53 ms vs 492 ms for `os ns get`). Swap `oci` for `boci` and your scripts keep working.

> [!NOTE]
> **100% parity verified.** All **9,372 of 9,372** leaf commands across 175 OCI services are implemented and parity-tested against `oci-cli==3.96.3` on Linux, macOS, and Windows (17 documented accepted divergences in [`DIVERGENCES.md`](DIVERGENCES.md), 0 unresolved). See [Progress](#progress).

- One static binary
- No Python, no venv
- Parity-tested against the real `oci`

Homepage: [boci.pages.dev](https://boci.pages.dev) · [neves.github.io/boci](https://neves.github.io/boci/) ([`site/index.html`](site/index.html))

## Benchmarks

Before `oci` sends a single request, Python has to start and import the whole CLI package. That costs over 400 ms on every call, and it adds up in scripts.

|                           |                  boci |                  oci |              |
| ------------------------- | --------------------: | -------------------: | ------------ |
| Start-up (`--version`)    |             **41 ms** |               413 ms | 10.1× faster |
| Peak memory (`--version`) |             **57 MB** |                66 MB | 14% less     |
| Install size              | **108 MB** (one file) | 575 MB (Python venv) | 5.3× smaller |

Where `oci`'s time goes today (median of 10 runs). Offline rows use a local fake endpoint, so they measure CLI overhead only:

| Command                                |     oci | of which start-up | boci              |
| -------------------------------------- | ------: | ----------------: | ----------------- |
| `oci --version`                        |  413 ms |              100% | **41 ms** (10.1×) |
| `oci os --help`                        |  451 ms |               91% | **47 ms** (9.5×)  |
| `oci compute instance launch --help`   |  716 ms |               58% | **59 ms** (12.2×) |
| usage error (unknown flag)             |  455 ms |               91% | **48 ms** (9.6×)  |
| `oci os ns get`                        |  492 ms |               84% | **53 ms** (9.3×)  |
| `oci iam region list`                  |  474 ms |               87% | **56 ms** (8.4×)  |
| `oci os bucket list --all` (20 pages)  |  594 ms |               69% | **113 ms** (5.3×) |
| `oci compute instance list` (5k items) | 1482 ms |               28% | **307 ms** (4.8×) |
| … `--query` (5k items)                 | 1283 ms |               32% | **177 ms** (7.2×) |
| … `--output table` (5k items)          | 1320 ms |               31% | **189 ms** (7.0×) |

Start-up share = oci's import floor (412 ms) divided by the command's total. Measured on an Intel Core i3-7100 (4 threads), Linux, oci-cli 3.96.3 on Python 3.12, Bun 1.4.5. Peak memory is taken through a tiny C launcher so the parent process doesn't inflate it. Reproduce with `bun run bench`, or `bun run bench:live` to add real API calls. Results are written to [`bench/results/latest.md`](bench/results/latest.md).

## Drop-in

boci aims for 1:1 parity with the `oci` CLI:

- every service, command and flag;
- the same JSON on stdout;
- the same error shape on stderr;
- the same exit codes;
- the same `~/.oci/config`, `oci_cli_rc` and `OCI_CLI_*` behaviour.

Anything that can't match yet is listed as a known divergence in `DIVERGENCES.md` instead of failing silently.

```console
$ alias oci=boci   # that's the whole migration
$ oci os ns get
```

## How it works

Most of the `oci` CLI is generated from the OCI SDK. boci doesn't rewrite 9,000 commands by hand. It reads them out of the real CLI and runs them all with one small engine.

1. **Extract.** An extractor loads the pinned `oci` CLI and records every service, command, flag, default and HTTP operation as data. That's 9,372 commands across 175 services.
2. **Execute.** One generic engine handles config, request signing, pagination, `--query` and output for every generated command. Hand-written code covers the rest, like multipart uploads. That's 8,184 generated commands and 1,188 hand-written ones.
3. **Verify.** Parity tests compare boci with the real `oci`: the request it sends, stdout, stderr and exit code. Responses are recorded once, so the suite runs offline in seconds.

Decisions are recorded in [`docs/adr/`](docs/adr/), and the vocabulary is in [`GLOSSARY.md`](GLOSSARY.md).

## Progress

The work follows a ladder, easiest first: tooling, then offline behaviour, then the first signed request. After that come reads, lists, writes, waiters and other auth methods. The hand-written commands come last. The full ladder is in [`PLAN.md`](PLAN.md).

```console
$ bun run status            # live numbers: verified / implemented / missing per service
$ bun run status --service os
```

Snapshot: **9,372 of 9,372 commands verified (100.0%).** (8,184 generated, 1,188 custom · 17 accepted divergences, 0 unresolved.)

| Rung                                            |    Done |
| ----------------------------------------------- | ------: |
| Rung -1 — Foundations (measure before building) |   13/13 |
| Rung 0 — Offline behavior                       |   15/15 |
| Rung 1 — First signed request                   |   18/18 |
| Rung 2 — Generated GETs                         |     9/9 |
| Rung 3 — Lists and output                       |     5/5 |
| Rung 4 — Request bodies                         |   10/10 |
| Rung 5 — Waiters                                |     3/3 |
| Rung 6 — Other auth methods                     |     4/4 |
| Rung 7 — Custom commands (hardest last)         |   18/18 |
| Rung 8 — Remaining commands and Engine features | 211/211 |
| Rung 9 — Differential fuzzing                   |   34/34 |

## Install

With [mise](https://mise.jdx.dev) (binary from GitHub Releases or npm):

```console
$ mise use -g github:neves/boci
# or
$ mise use -g npm:boci-cli
```

With **Homebrew** (macOS & Linux):

```console
$ brew install neves/tap/boci
```

With **Scoop** (Windows):

```console
$ scoop bucket add neves https://github.com/neves/scoop-bucket
$ scoop install boci
```

With **Nix**:

```console
$ nix run github:neves/boci
```

With **curl / PowerShell**:

```console
$ curl -fsSL https://raw.githubusercontent.com/neves/boci/main/site/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/neves/boci/main/site/install.ps1 | iex
```

Or build from source with [Bun](https://bun.sh) 1.4.5 or newer:

```console
$ git clone https://github.com/neves/boci
$ cd boci && bun install
$ bun run build          # → dist/boci
$ bun run status         # what works, what's missing
$ bun test               # offline parity suite
```

Use it as `oci`:

```console
# boci reads your existing ~/.oci/config
$ boci os ns get --profile my-profile

# or make it the default, scripts unchanged
$ alias oci=boci

# optional: fall back to the real oci on any unsupported edge case (otherwise: exit code 3)
$ export BOCI_FALLBACK=oci
```

## Development

| Command                 | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `bun run extract`       | Regenerate `spec/` from the pinned oci-cli (needs `uv`)     |
| `bun run status`        | Parity progress per service and ladder rung                 |
| `bun test`              | Offline test suite (never touches the network or `~/.oci`)  |
| `bun run verify`        | Format, typecheck, build, and full parity suite             |
| `mise exec -- bun lint` | Lint the codebase with Bun canary (`mise.toml`)             |
| `bun run fuzz`          | Differential fuzzing against the reference `oci` CLI        |
| `bun run parity:live`   | Record or confirm parity against the profile in `.env.test` |
| `bun run bench`         | oci vs boci benchmark (`bench:live` adds real API calls)    |
| `bun run build`         | Compile `dist/boci`                                         |

The reference CLI is `oci-cli==3.96.3`. Install it with `uv tool install --python 3.12 oci-cli==3.96.3`.

## FAQ

**Is this an official Oracle project?**
No. boci is an independent open-source project and isn't affiliated with or endorsed by Oracle. It talks to the same public OCI APIs the official CLI uses.

**Will my scripts break?**
That's the point of the parity tests: all 9,372 commands are verified against the reference CLI for stdout, stderr error shape, requests, and exit codes. The 17 known accepted divergences are documented in [`DIVERGENCES.md`](DIVERGENCES.md). With `BOCI_FALLBACK=oci` set, any unsupported edge case is handed to the real `oci`.

**Why Bun?**
Bun compiles TypeScript into one self-contained executable that starts in milliseconds, with fast built-in crypto, HTTP and JSON. boci also skips the OCI SDK and signs requests itself, so there's very little to load.

**Why is the binary 108 MB?**
Most of it is the Bun runtime, which every compiled Bun app embeds. The command data for all 9,372 commands adds only 2.3 MB compressed. It's still one file, under a fifth of the size of the Python install, with nothing else to set up.

**Which oci version does boci match?**
oci-cli 3.96.3. Moving to a newer oci release regenerates the command data and shows exactly what changed.
