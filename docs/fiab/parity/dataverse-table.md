# dataverse-table — parity with the Dataverse table designer

Source UI: Power Apps maker — table designer (`make.powerapps.com → Tables → <table>`).
Learn: <https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-create-entity>,
<https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query-metadata-web-api>

## Azure/Fabric feature inventory (grounded in Learn)

The table designer exposes these facets for a table:

1. **Columns** — logical/display name, data type, required level, custom flag, primary key / primary name.
2. **Keys** — alternate keys (EntityKeyMetadata): display name, key columns, index status.
3. **Relationships** — 1:N, N:1, N:N; referencing/referenced entity + attribute, intersect entity for N:N.
4. **Views** — system views (savedquery) + personal views (userquery); name, scope, default flag.
5. **Business rules** — processes (workflow category 2) targeting the table; name, activation state.
6. **Data** — the row grid (live business data for the table's entity set).
7. New custom table creation (publisher prefix, ownership) — portal-only wizard.

## Loom coverage

| Inventory row | Status | Notes |
| --- | --- | --- |
| Columns | built ✅ | Columns tab — full attribute list with PK/Name badges |
| Keys | built ✅ | Keys tab — `EntityDefinitions(...)/Keys` |
| Relationships | built ✅ | Relationships tab — 1:N + N:1 + N:N merged |
| Views | built ✅ | Views tab — savedqueries + userqueries |
| Business rules | built ✅ | Business rules tab — workflows category 2 |
| Data grid | built ✅ | Data tab — top-25 rows with formatted values |
| New custom table | honest-gate ⚠️ | `id=new` MessageBar + "Open in Maker" deep-link (portal-only wizard) |

Zero ❌. Zero stub banners (the only warning is the honest portal-only new-table gate).

## Backend per control

- List tables → `GET /api/items/dataverse-table` → `listTables` → `EntityDefinitions`
- Columns → `GET /api/items/dataverse-table/[id]` → `getTableSchema` → `EntityDefinitions(...)/Attributes`
- Keys → `GET .../[id]/keys` → `getTableKeys` → `EntityDefinitions(...)/Keys`
- Relationships → `GET .../[id]/relationships` → `getTableRelationships` → `OneToMany/ManyToOne/ManyToMany` nav props
- Views → `GET .../[id]/views` → `getTableViews` → `savedqueries` + `userqueries`
- Business rules → `GET .../[id]/business-rules` → `getTableBusinessRules` → `workflows`
- Data → `GET .../[id]/data` → `getTableData` → `<entityset>?$top=25` with formatted-value annotations

All Dataverse Web API v9.2 via the LOOM_DATAVERSE_CLIENT_ID SP. Honest infra-gate when the SP isn't an Application User on the env.
