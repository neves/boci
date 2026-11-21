# boci vs oci benchmark

2026-11-21T06:49:52.337Z · oci 3.96.3 · 10 runs/scenario · 4 CPUs · Bun 1.4.5

Times in ms (median of runs after the first; "first" = first run). RSS = peak resident memory.

| scenario                         | oci first | oci median |      boci first | boci median | speed-up | oci RSS MB | boci RSS MB | what it exercises                                                    |
| -------------------------------- | --------: | ---------: | --------------: | ----------: | -------: | ---------: | ----------: | -------------------------------------------------------------------- |
| floor: runtime floor             |        35 |         12 |               5 |           5 |     2.4× |         13 |          20 | empty program: python3.12 vs compiled Bun binary                     |
| floor: import floor              |       415 |        419 |              14 |          14 |    30.7× |         68 |          44 | load the CLI's code: `import oci_cli.cli` vs the boci binary's entry |
| --version                        |       418 |        417 | not implemented |             |        — |         69 |           — | pure start-up: no config, no network                                 |
| --help                           |       433 |        435 | not implemented |             |        — |         69 |           — | start-up + root help rendering                                       |
| os --help                        |       455 |        456 | not implemented |             |        — |         71 |           — | loads one service's command tree                                     |
| compute instance launch --help   |       726 |        727 | not implemented |             |        — |        106 |           — | largest help pages (100+ options)                                    |
| usage error                      |       459 |        455 | not implemented |             |        — |         71 |           — | unknown option: parse + error path                                   |
| os ns get                        |       495 |        494 | not implemented |             |        — |         74 |           — | config + key load + sign + 1 request                                 |
| iam region list                  |       477 |        476 | not implemented |             |        — |         71 |           — | 1 request, small list render                                         |
| os bucket list --all (20 pages)  |       595 |        593 | not implemented |             |        — |         80 |           — | pagination: 20 sequential signed requests                            |
| compute instance list (5k items) |      1482 |       1493 | not implemented |             |        — |        203 |           — | deserialize + render ~5 MB JSON                                      |
| … --query (5k items)             |      1283 |       1286 | not implemented |             |        — |        162 |           — | JMESPath filter + projection over 5k items                           |
| … --output table (5k items)      |      1344 |       1334 | not implemented |             |        — |        161 |           — | table rendering of 5k rows                                           |
| live: os ns get                  |       578 |        569 | not implemented |             |        — |         79 |           — | real API round trip                                                  |
| live: iam region list            |       630 |        669 | not implemented |             |        — |         77 |           — | real API round trip                                                  |

Install footprint: oci 339 MB (Python venv) · boci 104 MB (single binary)
