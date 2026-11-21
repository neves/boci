# boci vs oci benchmark

2026-11-21T08:07:11.788Z · oci 3.96.3 · 10 runs/scenario · 4 CPUs · Bun 1.4.5

Times in ms (median of runs after the first; "first" = first run). RSS = peak resident memory.

| scenario                         | oci first | oci median |      boci first | boci median | speed-up | oci RSS MB | boci RSS MB | what it exercises                                                    |
| -------------------------------- | --------: | ---------: | --------------: | ----------: | -------: | ---------: | ----------: | -------------------------------------------------------------------- |
| floor: runtime floor             |        14 |         12 |               5 |           5 |     2.3× |         13 |          20 | empty program: python3.12 vs compiled Bun binary                     |
| floor: import floor              |       417 |        416 |              22 |          21 |    19.8× |         68 |          56 | load the CLI's code: `import oci_cli.cli` vs the boci binary's entry |
| --version                        |       416 |        416 |              13 |          13 |    32.9× |         69 |          50 | pure start-up: no config, no network                                 |
| --help                           |       431 |        434 |              21 |          21 |    20.8× |         69 |          56 | start-up + root help rendering                                       |
| os --help                        |       457 |        454 |              18 |          18 |    25.1× |         71 |          55 | loads one service's command tree                                     |
| compute instance launch --help   |       739 |        723 |              26 |          26 |    27.6× |        106 |          61 | largest help pages (100+ options)                                    |
| usage error                      |       452 |        456 |              18 |          18 |    25.0× |         71 |          53 | unknown option: parse + error path                                   |
| os ns get                        |       505 |        493 | not implemented |             |        — |         74 |           — | config + key load + sign + 1 request                                 |
| iam region list                  |       477 |        477 | not implemented |             |        — |         71 |           — | 1 request, small list render                                         |
| os bucket list --all (20 pages)  |       596 |        592 | not implemented |             |        — |         80 |           — | pagination: 20 sequential signed requests                            |
| compute instance list (5k items) |      1470 |       1480 | not implemented |             |        — |        204 |           — | deserialize + render ~5 MB JSON                                      |
| … --query (5k items)             |      1283 |       1284 | not implemented |             |        — |        162 |           — | JMESPath filter + projection over 5k items                           |
| … --output table (5k items)      |      1331 |       1332 | not implemented |             |        — |        161 |           — | table rendering of 5k rows                                           |
| live: os ns get                  |       600 |        572 | not implemented |             |        — |         79 |           — | real API round trip                                                  |
| live: iam region list            |       716 |        631 | not implemented |             |        — |         77 |           — | real API round trip                                                  |

Install footprint: oci 465 MB (Python venv) · boci 106 MB (single binary)
