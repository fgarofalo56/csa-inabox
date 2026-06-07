# lakehouse-schemas — parity with Microsoft Fabric schema-enabled lakehouse (F9)

Source UI: https://learn.microsoft.com/fabric/data-engineering/lakehouse-schemas
(Fabric Lakehouse Explorer — Tables tree, "New schema" dialog, drag-table-to-schema,
schema shortcut). Azure-native, NO Fabric dependency — schema DDL runs on a Synapse
Spark pool via Livy; namespace format `workspace.lakehouse.schema.table` is Spark 3.x
standard SQL (Fabric runs the same engine).

## Azure/Fabric feature inventory

1. Enable schemas on a lakehouse (`enableSchemas` / portal checkbox).
2. `dbo` default schema — immutable, present on every schema-enabled lakehouse,
   cannot be renamed or deleted.
3. Create schema (name = letters/digits/underscores, `^[A-Za-z0-9_]+$`).
4. Tables grouped by schema in the Explorer Tables tree.
5. Drag a table from one schema to another (executes `ALTER TABLE … RENAME TO`).
6. 4-part namespace queries: `workspace.lakehouse.schema.table`.
7. Schema shortcut — place a Tables shortcut inside a named schema.
8. Drop schema (`DROP SCHEMA … CASCADE`).
9. `SHOW SCHEMAS` / `SHOW TABLES IN <schema>` introspection.

## Loom coverage

| # | Capability | State | Notes |
|---|------------|-------|-------|
| 1 | Enable schemas | ✅ | Settings dialog `Schemas enabled` switch → `PUT /api/lakehouse/settings` (`schemasEnabled`). Bundle `LakehouseContent.schemasEnabled` is the install-time default. |
| 2 | `dbo` immutable default | ✅ | Synthetic row from `listSchemas` (never stored); POST/DELETE refuse `dbo` (400 `reserved_schema`); no Delete button rendered. |
| 3 | Create schema | ✅ | New schema dialog (`Input` with `^[A-Za-z0-9_]+$` validation) → `POST /api/lakehouse/schemas` → `CREATE SCHEMA IF NOT EXISTS` via Livy. |
| 4 | Tables grouped by schema | ✅ | Tables tab renders schema groups (`Tables/<schema>/`), each lazily lists its tables. |
| 5 | Move table between schemas | ✅ | "Move to schema…" → Move-table dialog (`Dropdown` of schemas) → `PATCH /api/lakehouse/schemas` → `ALTER TABLE <from>.<t> RENAME TO <to>.<t>`. Fluent v9 has no native tree DnD; the explicit menu action is the functional equivalent. |
| 6 | 4-part namespace query | ✅ | Tables tab shows the `lakehouse.schema.table` name + Query button emits the 4-part serverless-view comment + OPENROWSET over `Tables/<schema>/<table>`. |
| 7 | Schema shortcut | ✅ | Shortcut wizard step 3 "Target schema" `Dropdown` (Tables + schemasEnabled) → registers under `Tables/<schema>/`. |
| 8 | Drop schema | ✅ | Delete button → `DELETE /api/lakehouse/schemas` → `DROP SCHEMA … CASCADE` then drops the catalog row. |
| 9 | Introspection | ⚠️ | `SHOW SCHEMAS`/`SHOW TABLES` available via the SQL tab / Livy; the schema list is sourced from the Cosmos registry (single-partition, fast). |

Honest infra-gate (⚠️, full UI still renders): when `LOOM_SYNAPSE_WORKSPACE` is
unset the catalog row still persists and the route returns 503 naming the env var
+ the Synapse Administrator grant required to run the Spark DDL. No Fabric workspace
is ever required.

## Backend per control

| Control | Backend |
|---------|---------|
| Enable schemas | Cosmos `tenant-settings` (`schemasEnabled`) via `PUT /api/lakehouse/settings` |
| List schemas | Cosmos `lakehouse-schemas` (PK `/lakehouseId`) via `GET /api/lakehouse/schemas` (always prepends synthetic `dbo`) |
| Create schema | `CREATE SCHEMA IF NOT EXISTS \`<name>\`` — Synapse Spark pool via Livy (`runSparkSqlAndWait`) |
| Move table | `ALTER TABLE \`<from>\`.\`<t>\` RENAME TO \`<to>\`.\`<t>\`` — Synapse Spark pool via Livy |
| Delete schema | `DROP SCHEMA IF EXISTS \`<name>\` CASCADE` — Synapse Spark pool via Livy + Cosmos row delete |
| Provisioner | ADLS `Tables/<schema>/<table>/` dirs + Synapse serverless `<schema>.<view>` OPENROWSET views (`lib/install/provisioners/lakehouse.ts`) |

## Sovereign clouds

`synapse-dev-client.ts` `devBase()` reads `LOOM_SYNAPSE_DEV_SUFFIX`
(default `azuresynapse.net`; GCC-High/DoD = `azuresynapse.us`). Wired via
`admin-plane/main.bicep` (`loomSynapseDevSuffix`, `loomDefaultSparkPool`).
