# 04: Consolidate Python UTF-8 decoding and preserve the BOM

**What to build:** Read text files and decode wrapper byte values using the same strict UTF-8 semantics as Python.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A leading UTF-8 BOM survives both text-file reading and explicit byte decoding, as shown in the resulting request or output.
- [x] Malformed UTF-8 still raises the corresponding error on both paths.
- [x] Text-mode newline handling remains specific to file reads.
