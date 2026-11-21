<img src="assets/icon.svg" width="64" height="64" alt="">

# boci

**The OCI CLI, without the wait.**

boci is a drop-in replacement for Oracle's [`oci` CLI](https://github.com/oracle/oci-cli), built on [Bun](https://bun.sh). It has the same commands, the same flags and the same output, with a start-up measured **30× faster**. Swap `oci` for `boci` and your scripts keep working.

> [!WARNING]
> **Early development.** boci is being built in the open and can't run commands yet. See [Progress](#progress).

- One static binary
- No Python, no venv
- Parity-tested against the real `oci`

Homepage: [`site/index.html`](site/index.html)

## Benchmarks

Before `oci` sends a single request, Python has to start and import the whole CLI package. That costs over 400 ms on every call, and it adds up in scripts.

|                                            |                  boci |                  oci |              |
| ------------------------------------------ | --------------------: | -------------------: | ------------ |
| Start-up: launch the CLI and load its code |             **14 ms** |               419 ms | 30× faster   |
| Peak memory at start-up                    |             **44 MB** |                68 MB | 35% less     |
| Install size                               | **104 MB** (one file) | 339 MB (Python venv) | 3.3× smaller |

Where `oci`'s time goes today (median of 10 runs). Offline rows use a local fake endpoint, so they measure CLI overhead only:

| Command                                |     oci | of which start-up | boci   |
| -------------------------------------- | ------: | ----------------: | ------ |
| `oci --version`                        |  417 ms |              100% | coming |
| `oci --help`                           |  435 ms |               96% | coming |
| `oci os --help`                        |  456 ms |               92% | coming |
| `oci compute instance launch --help`   |  727 ms |               58% | coming |
| usage error (unknown flag)             |  455 ms |               92% | coming |
| `oci os ns get`                        |  494 ms |               85% | coming |
| `oci iam region list`                  |  476 ms |               88% | coming |
| `oci os bucket list --all` (20 pages)  |  593 ms |               71% | coming |
| `oci compute instance list` (5k items) | 1493 ms |               28% | coming |
| … `--query` (5k items)                 | 1286 ms |               33% | coming |
| … `--output table` (5k items)          | 1334 ms |               31% | coming |
| live: `oci os ns get`                  |  569 ms |               74% | coming |
| live: `oci iam region list`            |  669 ms |               63% | coming |

Measured on an Intel Core i3-7100 (4 threads), Linux, oci-cli 3.96.3 on Python 3.12, Bun 1.4.5. Peak memory is taken through a tiny C launcher so the parent process doesn't inflate it. Reproduce with `bun run bench`, or `bun run bench:live` to add real API calls. Results are written to [`bench/results/latest.md`](bench/results/latest.md). The boci column fills in as each command lands.

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

Snapshot: **0 of 9,372 commands verified.**

| Rung                                             | Done |
| ------------------------------------------------ | ---: |
| Foundations: extractor, status, test harness     | 8/13 |
| Offline: version, help, parser, config           |  0/7 |
| First signed request: `os ns get`                |  0/5 |
| Generated reads (GET)                            |  0/3 |
| Lists, pagination, `--query`, tables             |  0/4 |
| Request bodies and writes                        |  0/5 |
| Waiters: `--wait-for-state`                      |  0/2 |
| Other auth methods                               |  0/4 |
| Hand-written commands, interactive mode, Windows |  0/6 |

## Install

There's no release yet. Once commands work, boci will ship as a single binary for Linux and macOS (x64 and arm64). Until then, build it from source with [Bun](https://bun.sh) 1.4.5 or newer:

```console
$ git clone https://github.com/neves/boci
$ cd boci && bun install
$ bun run build          # → dist/boci
$ bun run status         # what works, what's missing
$ bun test               # offline parity suite
```

Once commands land, use it as `oci`:

```console
# boci reads your existing ~/.oci/config
$ boci os ns get --profile my-profile

# or make it the default, scripts unchanged
$ alias oci=boci

# planned: hand unimplemented commands to the real oci
$ export BOCI_FALLBACK=oci
```

## Development

| Command               | What it does                                                |
| --------------------- | ----------------------------------------------------------- |
| `bun run extract`     | Regenerate `spec/` from the pinned oci-cli (needs `uv`)     |
| `bun run status`      | Parity progress per service and ladder rung                 |
| `bun test`            | Offline test suite (never touches the network or `~/.oci`)  |
| `bun run parity:live` | Record or confirm parity against the profile in `.env.test` |
| `bun run bench`       | oci vs boci benchmark (`bench:live` adds real API calls)    |
| `bun run build`       | Compile `dist/boci`                                         |

The reference CLI is `oci-cli==3.96.3`. Install it with `uv tool install --python 3.12 oci-cli==3.96.3`.

## FAQ

**Is this an official Oracle project?**
No. boci is an independent open-source project and isn't affiliated with or endorsed by Oracle. It talks to the same public OCI APIs the official CLI uses.

**Will my scripts break?**
That's the point of the parity tests: the same invocation should produce the same stdout, stderr error object and exit code. Commands boci doesn't support yet fail with a clear message. With `BOCI_FALLBACK=oci` set, they're handed to the real `oci` instead.

**Why Bun?**
Bun compiles TypeScript into one self-contained executable that starts in milliseconds, with fast built-in crypto, HTTP and JSON. boci also skips the OCI SDK and signs requests itself, so there's very little to load.

**Why is the binary 104 MB?**
Most of it is the Bun runtime, which every compiled Bun app embeds. It's still one file, a third of the size of the Python install, with nothing else to set up.

**Which oci version does boci match?**
oci-cli 3.96.3. Moving to a newer oci release regenerates the command data and shows exactly what changed.
