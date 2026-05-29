# variable-library — parity with Fabric Variable Library

Source UI: Fabric Variable Library (https://learn.microsoft.com/fabric/cicd/variable-library/variable-library-overview),
value-sets (https://learn.microsoft.com/fabric/cicd/variable-library/value-sets),
REST (https://learn.microsoft.com/fabric/cicd/variable-library/automate-variable-library).

## Fabric feature inventory

| # | Capability | Fabric surface |
|---|------------|----------------|
| 1 | Variables list (name, type, default, note) | grid |
| 2 | 9 variable types (String/Integer/Number/Boolean/DateTime/Guid/ItemReference/ConnectionReference + Loom SecretReference) | type dropdown |
| 3 | Value sets (default + named alternates, e.g. dev/test/prod) | value-set tabs |
| 4 | Add / rename / delete variables and value sets | + Add value set |
| 5 | Active value set selection | active-set picker |
| 6 | Per-type value validation | inline validation |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | grid (name/type/value/description/delete) |
| 2 | built ✅ | all 9 types via `VAR_TYPE_LABELS` |
| 3 | built ✅ | value-set tabs (default/dev/test/prod) |
| 4 | built ✅ | Add value set dialog (create named value set), add/delete variable; **active value set** picker added |
| 5 | built ✅ | "Active value set" dropdown persists to `state.activeValueSet` (the runtime executor reads it) |
| 6 | built ✅ | `validateVarValue` per type |

## Backend per control

- All state → Cosmos `state` via PATCH `/api/items/variable-library/[id]` (vitest-covered logic in `_family-utils`).
- Matches the Fabric variable library JSON definition (variables.json + valueSets/ + settings.json `activeValueSet`).
