# boci vs oci benchmark

2026-11-21T07:59:01.297Z · oci 3.96.3 · 10 runs/scenario · 4 CPUs · Bun 1.4.5

Times in ms (median of runs after the first; "first" = first run). RSS = peak resident memory.

| scenario                         | oci first | oci median |      boci first | boci median | speed-up | oci RSS MB | boci RSS MB | what it exercises                                                    |
| -------------------------------- | --------: | ---------: | --------------: | ----------: | -------: | ---------: | ----------: | -------------------------------------------------------------------- |
| floor: runtime floor             |        12 |         12 |               5 |           5 |     2.3× |         13 |          20 | empty program: python3.12 vs compiled Bun binary                     |
| floor: import floor              |       418 |        418 |              35 |          35 |    11.9× |         68 |          63 | load the CLI's code: `import oci_cli.cli` vs the boci binary's entry |
| --version                        |       417 |        416 |              27 |          27 |    15.6× |         69 |          57 | pure start-up: no config, no network                                 |
| --help                           |       433 |        434 |              36 |          35 |    12.2× |         69 |          63 | start-up + root help rendering                                       |
| os --help                        |       455 |        455 |              34 |          34 |    13.3× |         71 |          63 | loads one service's command tree                                     |
| compute instance launch --help   |       723 |        725 |              43 |          42 |    17.4× |        106 |          69 | largest help pages (100+ options)                                    |
| usage error                      |       454 |        455 |              34 |          34 |    13.2× |         71 |          61 | unknown option: parse + error path                                   |
| os ns get                        |       492 |        493 | not implemented |             |        — |         74 |           — | config + key load + sign + 1 request                                 |
| iam region list                  |       477 |        476 | not implemented |             |        — |         71 |           — | 1 request, small list render                                         |
| os bucket list --all (20 pages)  |       599 |        592 | not implemented |             |        — |         80 |           — | pagination: 20 sequential signed requests                            |
| compute instance list (5k items) |      1485 |       1481 | not implemented |             |        — |        204 |           — | deserialize + render ~5 MB JSON                                      |
| … --query (5k items)             |      1290 |       1283 | not implemented |             |        — |        162 |           — | JMESPath filter + projection over 5k items                           |
| … --output table (5k items)      |      1353 |       1330 | not implemented |             |        — |        161 |           — | table rendering of 5k rows                                           |
| live: os ns get                  |       600 |        574 | not implemented |             |        — |         79 |           — | real API round trip                                                  |
| live: iam region list            |       730 |        713 | not implemented |             |        — |         77 |           — | real API round trip                                                  |

Install footprint: oci 465 MB (Python venv) · boci 107 MB (single binary)
