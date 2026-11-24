# 05: Share non-directory config file reader and POSIX path normalization across `setup` and `session`

**What to build:** Use one shared helper for safely reading existing config files (ignoring missing, directory, or unreadable targets) and one shared helper for normalizing paths to forward slashes and stripping trailing separators across `setup`, `session`, and Object Storage commands.

**Blocked by:** None (can start immediately)

**Status:** complete

- [x] `setup` and `session` commands read existing config text through a single shared helper that ignores directories and permission/missing-file errors while rethrowing unexpected errors.
- [x] Forward-slash and trailing-slash path normalization in `setup`, `session`, and Object Storage uses a shared helper rather than scattered `.replaceAll("\\", "/")` calls, with all existing unit and parity tests passing.
