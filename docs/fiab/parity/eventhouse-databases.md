# eventhouse-databases — parity with Fabric Eventhouse "Databases" browser

Source UI: Microsoft Fabric Real-Time Intelligence → Eventhouse item → System
overview / "Databases" list. Learn:
https://learn.microsoft.com/fabric/real-time-intelligence/eventhouse
Azure-native backend: Azure Data Explorer (ADX) cluster
`adx-csa-loom-shared` — no Fabric capacity or workspace required.

Loom surface: `EventhouseEditor` in
`apps/fiab-console/lib/editors/phase3-editors.tsx` (the eventhouse "Databases"
panel).

## Fabric/ADX feature inventory (every capability)

| # | Capability (Fabric Eventhouse / ADX) | Notes |
|---|--------------------------------------|-------|
| 1 | List every KQL database in the eventhouse | name + metadata |
| 2 | Per-database size shown on the card/row | TotalSize |
| 3 | Per-database retention shown | RetentionPolicy.SoftDeletePeriod |
| 4 | Per-database caching / hot-cache window | CachingPolicy.DataHotSpan |
| 5 | Per-database table count | NumberOfTables |
| 6 | Tile (card) view of databases | default |
| 7 | List (grid) view of databases | toggle |
| 8 | Toggle between tile and list view | view switcher |
| 9 | Open a database (query editor) — same tab | KQL queryset |
| 10 | Open a database in a NEW tab | per-object action |
| 11 | "Get data" into a database | ingestion wizard |
| 12 | Delete a database | with confirmation |
| 13 | + New (KQL) database | create |
| 14 | + Database shortcut (ReadOnlyFollowing) | Fabric-managed only |
| 15 | Refresh the list | re-read cluster |
| 16 | Mark / show the default database | NetDefaultDB context |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `GET /api/items/eventhouse/[id]` → `listDatabasesWithDetails()` (`.show databases details`) |
| 2 | built ✅ | tile + list show `fmtDbSize(totalSizeMb)` |
| 3 | built ✅ | `retentionDays` (parsed from `SoftDeletePeriod`) on tile + list |
| 4 | built ✅ | `hotCacheDays` (parsed from `DataHotSpan`) in list view |
| 5 | built ✅ | `tableCount` on tile + list |
| 6 | built ✅ | `dbView === 'tile'` card grid |
| 7 | built ✅ | `dbView === 'list'` Fluent `Table` |
| 8 | built ✅ | `Apps20`/`List20` toggle, `aria-pressed` |
| 9 | built ✅ | `openKqlEditor()` → `router.push('/items/kql-database/new?…')` |
| 10 | built ✅ | `openKqlEditorNewTab()` → `window.open(…,'_blank')` |
| 11 | built ✅ | Get data dialog → `POST …/ingest` (file / Event Hub / OneLake-ADLS) |
| 12 | built ✅ | Delete confirm dialog → `DELETE …/database?name=` → `deleteKustoDatabase()` (ARM) |
| 13 | built ✅ | New KQL database dialog → `POST …/database` → `createDatabase()` (ARM) |
| 14 | honest-gate ⚠️ | disabled button + title: ReadOnlyFollowing shortcut needs a Fabric-managed eventhouse; standalone ADX hosts ReadWrite databases only |
| 15 | built ✅ | Refresh button + ribbon → `load()` |
| 16 | built ✅ | `default` Badge keyed off `state.defaultDatabase` |

Zero ❌. The single ⚠️ is an honest backend-capability gate (ReadOnlyFollowing
"shortcut" databases are a Fabric-managed-eventhouse feature; the Azure-native
standalone ADX cluster only hosts ReadWrite databases), per `no-vaporware.md`
and `no-fabric-dependency.md` — every other row works on the Azure-native path
with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Backend per control

| Control | Backend call |
|---------|--------------|
| List + metadata | Kusto `/v1/rest/mgmt` `.show databases details` (`listDatabasesWithDetails`) |
| Query / Open in new tab | client-side route to KQL database editor (which queries `/v1/rest/query`) |
| Get data | `POST /api/items/eventhouse/[id]/ingest` (real Kusto ingest) |
| Create | ARM `PUT Microsoft.Kusto/clusters/{c}/databases/{n}` (`createDatabase`) |
| Delete | ARM `DELETE Microsoft.Kusto/clusters/{c}/databases/{n}` (`deleteKustoDatabase`) |

All ARM calls honor `LOOM_ARM_SCOPE` / `LOOM_ARM_HOST` for sovereign clouds
(Commercial default). No `api.fabric.microsoft.com` / `api.powerbi.com` /
`onelake.dfs.fabric` on any code path here.
