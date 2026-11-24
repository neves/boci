# 05: Read Click file inputs once

**What to build:** Read a named Click input with one Bun-native read so the bytes consumed are the bytes that passed validation.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Opening a named input no longer requires a validation open followed by reopening the same path.
- [x] Named files and stdin supply the expected bytes to the command.
- [x] Missing and unreadable named inputs produce the Reference CLI diagnostic and exit status.
