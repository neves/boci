# 06: Print only the final result of os object copy

**What to build:** Use the implicit namespace lookup internally and print the final copy result as a single JSON document.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The implicit-namespace success case compares the lookup and copy requests and the complete stdout against the golden.
- [x] A failed lookup reports the Reference CLI error and prevents the copy request.
