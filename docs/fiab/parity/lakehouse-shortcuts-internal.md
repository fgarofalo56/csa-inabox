# lakehouse-shortcuts-internal — parity with Microsoft Fabric OneLake internal shortcuts

Source UI: https://learn.microsoft.com/fabric/onelake/onelake-shortcuts
(Fabric Lakehouse Explorer → **New shortcut → OneLake (internal)** wizard, the
Shortcuts list with per-row status, and the shortcut context menu).

**Azure-native, NO Fabric dependency.** An "internal" shortcut is a zero-copy,
named pointer to another Loom lakehouse's data on the **primary ADLS Gen2
account** (`internal://<container>/<path>`). It resolves on the Console UAMI
(Storage Blob Data Reader on the medallion account) and works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET. Tables shortcuts additionally register a
real external table on the configured query engine (Synapse Serverless preferred,
else Databricks UC) — no Fabric capacity required.

## Azure/Fabric feature inventory

1. **New shortcut wizard** — pick a source (internal OneLake item), browse its
   Tables/Files, name the shortcut, place it under a section.
2. **Source picker** — choose the source lakehouse / item in the workspace.
3. **Tables / Files path browse** — navigate the source object's folder tree and
   select the target folder/table.
4. **Name + placement** — name the shortcut (≤ 128 chars), choose the sub-folder
   it appears under.
5. **Shortcuts list** — every shortcut with Name, Path, Source, Type, Status.
6. **Status indicator** — a shortcut whose target is missing / inaccessible shows
   a broken/error state.
7. **Test / re-validate** — confirm the target is still reachable.
8. **Edit (rename)** — rename a shortcut.
9. **Delete** — remove the shortcut (never deletes the source data).
10. **Zero-copy semantics** — reads pass through to the source; no bytes copied.

## Loom coverage

| # | Capability | State | Notes |
|---|------------|-------|-------|
| 1 | New shortcut wizard | ✅ | `lib/components/onelake/shortcut-wizard.tsx` — 3-step Fluent v9 `Dialog` (Source → Browse → Name+review). |
| 2 | Source picker | ✅ | Step 1 lists workspace lakehouses (`GET /api/items/lakehouse?workspaceId=`, self excluded) + the ADLS storage container (`GET /api/lakehouse/containers`) that defines the `internal://<container>` root. |
| 3 | Tables/Files path browse | ✅ | Step 2 Tables/Files tabs + breadcrumb folder navigator over `GET /api/lakehouse/paths?container=&prefix=` (real ADLS listing). Select a folder or "Use current folder". |
| 4 | Name + placement | ✅ | Step 3 `Input` (regex `^[A-Za-z0-9 _.-]{1,128}$`), placement `Input`, format `Dropdown` (Tables), review MessageBar with the resolved `internal://` target. |
| 5 | Shortcuts list | ✅ | `ShortcutListGrid` Fluent `Table`: Name, Path, Source, Kind, Status, Actions. Rows from `GET /api/items/[type]/[id]/shortcuts` — **real Cosmos query, no mock array**. |
| 6 | Status pill (OK/Broken/Pending) | ✅ | `Badge` color success/danger/warning from the registry status; `displayStatus()` maps `active→OK`, `error→Broken`, `pending→Pending`. Tooltip surfaces `statusDetail`. |
| 7 | Test / re-validate | ✅ | Per-row **Test** → `POST /api/items/[type]/[id]/shortcuts/[name]/test` → `testInternalShortcut()` runs a **live ADLS HEAD** (`getMetadata`); missing path (404) or 403 flips the row to **Broken**. Tables also `SELECT TOP 1` the engine object. |
| 8 | Edit (rename) | ✅ | Per-row **Edit** → rename `Dialog` → `PATCH /api/items/[type]/[id]/shortcuts/[name]`; re-creates at the new deterministic id (real ADLS probe + Tables engine re-registration) and drops the stale row/object. |
| 9 | Delete | ✅ | Per-row **Delete** → `DELETE /api/items/[type]/[id]/shortcuts/[name]` → drops the engine object (external table) + the Cosmos row. Never touches source bytes. |
| 10 | Zero-copy semantics | ✅ | Registry pointer + (Tables) external table over the source `abfss://` path. No copy step anywhere in the create path. |

Honest infra-gate (⚠️, full UI still renders): a **Tables** shortcut where no
query engine is configured persists `pending` and the route returns 503 naming
`LOOM_SYNAPSE_WORKSPACE` / `LOOM_DATABRICKS_HOSTNAME`. A **Files** shortcut needs
no engine. No Fabric workspace is ever required on any path.

External (S3 / GCS / Dataverse / Delta Sharing) and cross-account ADLS targets
are out of scope for this item-nested route — those carry Key Vault credential
machinery and are served by the flat `/api/lakehouse/shortcuts` route, to which
the POST honestly redirects (`code: non_internal_use_flat_route`).

## Backend per control

| Control | Backend |
|---------|---------|
| List | `GET /api/items/[type]/[id]/shortcuts` → `listShortcuts(id)` — Cosmos `lakehouse-shortcuts` (PK `/lakehouseId`) single-partition query |
| Create | `POST …/shortcuts` → `createInternalShortcut()` → `resolveAndTestAdls('internal', …)` real `listPaths` UAMI probe; Tables → `createTablesShortcut()` (Synapse Serverless `CREATE VIEW … OPENROWSET` / Databricks UC `CREATE TABLE … LOCATION`); `createShortcut()` upsert |
| Test | `POST …/shortcuts/[name]/test` → `testInternalShortcut()` → `getMetadata(container, path)` live ADLS HEAD (+ `testEngineObject` for Tables) → `updateShortcutStatus()` |
| Edit | `PATCH …/shortcuts/[name]` → re-create at new id + `dropShortcutObject` + `deleteShortcut` (old) |
| Delete | `DELETE …/shortcuts/[name]` → `dropShortcutObject()` + `deleteShortcut()` |
| Auth | `loadOwnedItem(id, type, oid)` — caller's tenant must own the item's workspace |

## Sovereign clouds

The ADLS DFS endpoint host is resolved from the configured `LOOM_*_URL` env var
by `adls-client.ts` `resolveAccountName()` → `dfsUrl()`, emitting
`dfs.core.windows.net` (Commercial/GCC) or `dfs.core.usgovcloudapi.net`
(GCC-High/IL5) automatically. The Cosmos `lakehouse-shortcuts` container is
created lazily by `cosmos-client.ts` and documented in
`platform/fiab/bicep/modules/landing-zone/cosmos.bicep`. No code change is needed
per cloud — internal shortcuts are 100% ADLS + Cosmos, present in all four clouds.
