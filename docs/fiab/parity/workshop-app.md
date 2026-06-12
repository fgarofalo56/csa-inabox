# workshop-app (Atelier) — parity with Palantir Foundry Workshop / Fabric Apps

Source UI:
- Palantir Foundry **Workshop** — ontology-bound operational app builder
  (object views + actions that write back to the ontology).
- Microsoft **Fabric Apps** (formerly internal "Rayfin") — real CRUD is
  **GraphQL** (`/api/graphql`, `RayfinClient` create/read/update/delete) backed
  by **SQL database in Fabric**; the portal SQL DB is read-only (schema from
  code). Ref: `/fabric/apps/read-write-data-graphql`.

> **Two distinct parity tracks — do not conflate.**
> - **Atelier = `workshop-app` item type** (this doc): the Palantir-Workshop
>   equivalent. An ontology-bound low-code app that does **real CRUD** over the
>   ontology's bound warehouse, hosted inside Loom.
> - **Rayfin = `rayfin-app` item type** (`docs/fiab/rayfin.md`): the
>   Fabric-Apps / code-first `--template dataapp` equivalent — a standalone
>   visual builder whose write-back forms run in the *deployed* app. `rayfin.md`'s
>   line "the Azure-native build has no separate Atelier item type" is scoped to
>   the **Rayfin** track only; the `workshop-app` Atelier item type does exist
>   and is the Workshop-parity surface.

## Azure-native backend (default, no Fabric)

Atelier's real CRUD runs directly over the **Synapse dedicated SQL pool** via
`lib/azure/synapse-sql-client.ts` (live TDS, Entra-token auth) — the
Azure-native equivalent of Fabric Apps' "SQL database in Fabric". No Fabric
capacity or workspace is required (`no-fabric-dependency.md`). Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

Env (already wired on the Console container, no new vars for writes):
`LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL`. SQL write rights: the
Console UAMI is promoted to `db_owner` per user database by
`platform/fiab/bootstrap/sql-security-bootstrap.sql`, which covers
INSERT/UPDATE/DELETE — no grant change needed.

## Feature inventory → Loom coverage

| Capability                                  | Loom coverage | Backend / route |
|---------------------------------------------|---------------|-----------------|
| Bind an ontology (Weave)                    | ✅ built       | `bind-ontology` → `_lib/ontology-binding` |
| Object views (entity types → app pages)     | ✅ built       | editor state + `run-action` list |
| **Read** rows for an entity (list)          | ✅ built       | `run-action` `op:list` → `SELECT TOP` |
| **Read** single row by key (get)            | ✅ built (new) | `run-action` `op:get` → `SELECT … WHERE [key]=@k` |
| **Create** a row                            | ✅ built (new) | `run-action` `op:create` → parameterised `INSERT` |
| **Update** a row by key                     | ✅ built (new) | `run-action` `op:update` → parameterised `UPDATE … WHERE` |
| **Delete** a row by key                     | ✅ built (new) | `run-action` `op:delete` → parameterised `DELETE … WHERE` |
| Action runner UI (form derived from columns)| ✅ built (new) | Dialog in `WorkshopAppEditor`; fields from live columns |
| Lineage (Thread edge on write-back)         | ✅ built (new) | `recordThreadEdge` `atelier-<op>` |
| Writes constrained to ontology shape        | ✅ built (new) | `OntologyEntityBinding.writableColumns` / `keyColumns` |

## Safety / no-vaporware

- Every value is bound as a TDS named parameter (`SynapseQueryParam`), never
  concatenated into SQL.
- Every identifier (table, column, key column) is validated by `safeSqlIdent`
  and bracket-quoted; unknown / unsafe columns are rejected with `400`.
- `create`/`update` are rejected (`400 column_not_allowed`) for columns not in
  the binding's `writableColumns` when declared — writes stay bound to the
  ontology-declared shape (no freeform SQL textbox).
- Honest gates: `409 no_ontology`, `409 no_binding`, `503
  synapse_not_configured`, `400 no_key` / `no_key_column` / `no_values`.

## Tests

- `app/api/items/workshop-app/[id]/run-action/__tests__/route.test.ts` —
  every op (list/get/create/update/delete) + every gate.
- `lib/editors/__tests__/family-utils.test.ts` — `safeSqlIdent`,
  `buildInsertSql`, `buildUpdateSql`, `buildDeleteSql`.
