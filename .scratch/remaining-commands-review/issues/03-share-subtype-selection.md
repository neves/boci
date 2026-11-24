# 03: Share SDK model subtype selection

**What to build:** Resolve inherited discriminators through one lookup for request camelization and response rendering.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Parity cases for input and output exercise an inherited discriminator and a field unique to the selected subtype.
- [x] When a discriminator is missing, each direction retains its Reference CLI behavior.
