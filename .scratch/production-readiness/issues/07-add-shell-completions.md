# 07: Add shell completions for bash, zsh, and fish

**What to build:** Users can generate and load tab-completions for services, commands, and flags in `bash`, `zsh`, and `fish`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A completion command (or flag) outputs valid completion scripts for `bash`, `zsh`, and `fish` derived from the extracted command spec.
- [ ] Completions cover top-level services, nested command groups, leaf commands, and their flags.
- [ ] Unit/integration tests verify generated completion output for all three shells and confirm no conflict with existing `oci` CLI commands.
