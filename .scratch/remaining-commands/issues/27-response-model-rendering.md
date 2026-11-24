# 27: Responses render through their SDK model

**What to build:** boci prints a response body the way the Reference CLI does after the SDK deserializes it into the operation's `response_type` model: every model attribute appears (kebab-case, `null` when the service omitted it), keys the model doesn't declare are dropped, nested models recurse by `swagger_types`.

**Blocked by:** none.

**Status:** done

## Context for the implementer

- Found in ticket 24: `email-data-plane email-raw-submitted-response submit-raw-email --endpoint {endpoint}` with a reply body of `{}` prints `{"data": {"envelope-id": null, "message-id": null, "suppressed-recipients": null}}` in the Reference CLI; boci prints `{"data": {}}`. The `complex-json-*` cases sidestep it by replying with every field set.
- boci prints the raw JSON (`src/core/output.ts`); only `responseType?.startsWith("list[")` is consulted. Ticket 19 already put per-model attribute maps / `swagger_types` into the spec for camelization; reuse them.
- Check first how widespread it is: generated `get` cases reply with recorded or example bodies that usually carry every field, so few goldens may show it. Add hand-written cases with partial bodies (missing attribute, extra attribute, nested model, list of models, dict(str, …)).
- Ticket 26 also observed both response cases with a synthetic reply of `{}`: `generative-ai-sandbox sandbox-file write` renders three null fields (content-sha256, file-path, sandbox-id); `opsi awr-hub-objects put`, whose operation has no response type, ignores the reply body entirely. Ticket 26's transfer cases use a populated SandboxFile and an empty AWR reply.

The extracted surface contains 6,244 commands with a declared response type. Response models are now collected recursively for operations, wrapper variants and waiter getters. Offline parity covers partial and unknown attributes, nested lists and dictionary values, preserved dictionary keys, and responses without a declared type.
