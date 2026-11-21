# Hand-written Click-compatible argument parser instead of util.parseArgs

The Reference CLI parses arguments with Python Click, and Drop-in requires matching it on invalid input too: usage-error wording, exit code 2, `--flag/--no-flag` pairs, repeated options, short aliases, `--opt=value`, and `file://` value loading. `util.parseArgs` (the Bun-native default) and the npm parsers all differ from Click on these edges, so boci carries its own small parser whose behavior is pinned by Parity tests on malformed invocations.
