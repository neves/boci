# 10: Match response values and tighten timestamp parity checks

**What to build:** Compare successful response timestamps exactly and render SDK datetime and enum values as the Reference CLI does.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The harness detects different timestamps in successful stdout, including timezone-free timestamp fields.
- [x] Only the volatile top-level timestamp of a recognized transport exception on stderr is masked by the transport-exception timestamp rule.
- [x] A full-output load-balancer get case renders a UTC datetime ending in Z with the reference +00:00 suffix and an unfamiliar lifecycle state as UNKNOWN_ENUM_VALUE.
