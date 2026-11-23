# 19: parse_json_parameter camelizes keys by the SDK model

**What to build:** JSON given to a complex param (by the user, or by a Tier B wrapper that folds options into snake_case keys) reaches the request with the same keys as the Reference CLI. `cli_util.parse_json_parameter` runs `make_dict_keys_camel_case(obj, parameter_name)`: keys of a dict whose declared type is an SDK model become camelCase (`total_size_in_gbs` → `totalSizeInGbs`), recursively by each attribute's `swagger_types`, honouring discriminator subtypes; `dict(str, …)` keys and unknown types stay as given. The Engine's `parseJsonParameter` only `JSON.parse`s.

**Blocked by:** 11: options into a JSON body.

**Status:** ready-for-agent

## Context for the implementer

- The type of each complex param comes from the command's `@json_skeleton_generation_handler(input_params_to_complex_types=...)` metadata (`{'module', 'class'}`); the model's `attribute_map` / `swagger_types` and subtypes (`get_possible_subtype_based_on_payload`) come from the SDK. Extract only what camelization needs (per model: snake → camel names, attribute types, discriminator → subtype) into the spec, shared per service like `jsonExamplePool`.
- Excluded until this lands (`EXCLUDED` in `src/core/registry.ts`; their `generated-wrapper-db` cases and goldens are already recorded): `db database update` (`managed_auto_failover`, `failover_targets`), `db exascale-db-storage-vault create|update` (`total_size_in_gbs`), `db system launch-from-database|launch-from-db-system` (`is_*_enabled` data collection options).
- It applies to every Generated and Tier A command too: add a hand-written case giving snake_case keys to a model-typed complex option (and one to a `dict(str, …)` option such as `--freeform-tags`, which must stay as given).
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 19`) for the rest.

## Acceptance criteria

- [ ] The five commands above are verified (removed from `EXCLUDED`), plus hand-written camelization cases.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.
