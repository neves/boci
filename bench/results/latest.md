# boci vs oci benchmark

2026-11-26T14:41:00.819Z · oci 3.96.3 · 10 runs/scenario · 4 CPUs · Bun 1.4.5

Times in ms (median of runs after the first; "first" = first run). RSS = peak resident memory.

| scenario                         | oci first | oci median |       boci first | boci median | speed-up | oci RSS MB | boci RSS MB | what it exercises                                                    |
| -------------------------------- | --------: | ---------: | ---------------: | ----------: | -------: | ---------: | ----------: | -------------------------------------------------------------------- |
| floor: runtime floor             |       329 |         13 |                4 |           4 |     3.0× |         11 |          34 | empty program: python3.12 vs compiled Bun binary                     |
| floor: import floor              |       926 |        412 |               49 |          50 |     8.3× |         66 |          62 | load the CLI's code: `import oci_cli.cli` vs the boci binary's entry |
| --version                        |       416 |        413 |               41 |          41 |    10.1× |         66 |          57 | pure start-up: no config, no network                                 |
| --help                           |       432 |        430 | differs from oci |             |        — |         67 |           — | start-up + root help rendering                                       |
| os --help                        |       543 |        451 |               48 |          47 |     9.5× |         69 |          61 | loads one service's command tree                                     |
| compute instance launch --help   |      2201 |        716 |               58 |          59 |    12.2× |        104 |          69 | largest help pages (100+ options)                                    |
| usage error                      |       454 |        455 |               48 |          48 |     9.6× |         69 |          61 | unknown option: parse + error path                                   |
| os ns get                        |       494 |        492 |               53 |          53 |     9.3× |         71 |          63 | config + key load + sign + 1 request                                 |
| iam region list                  |       475 |        474 |               57 |          56 |     8.4× |         69 |          67 | 1 request, small list render                                         |
| os bucket list --all (20 pages)  |       600 |        594 |              123 |         113 |     5.3× |         77 |          86 | pagination: 20 sequential signed requests                            |
| compute instance list (5k items) |      1480 |       1482 |              405 |         307 |     4.8× |        201 |         144 | deserialize + render ~5 MB JSON                                      |
| … --query (5k items)             |      1308 |       1283 |              180 |         177 |     7.2× |        160 |         102 | JMESPath filter + projection over 5k items                           |
| … --output table (5k items)      |      1556 |       1320 |              202 |         189 |     7.0× |        159 |         103 | table rendering of 5k rows                                           |

Install footprint: oci 575 MB (Python venv) · boci 108 MB (single binary)
