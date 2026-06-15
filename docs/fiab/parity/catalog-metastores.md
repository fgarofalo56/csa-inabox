# catalog-metastores — parity with Databricks Unity Catalog / Fabric OneLake / Microsoft Purview accounts

Source UI:
- Azure Databricks → Catalog → Metastores (account console + workspace catalog explorer)
- Microsoft Fabric → OneLake / workspaces
- Microsoft Purview → Data Map account overview
- Databricks **account console** → Catalog → Metastores + Workspaces → Assign (https://accounts.azuredatabricks.net)
- Microsoft Purview classic governance portal → Data Map → **Register** → *Azure Databricks Unity Catalog* (https://web.purview.azure.com) — Learn: https://learn.microsoft.com/purview/register-scan-azure-databricks-unity-catalog
- Learn: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/ ,
  https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/get-started

Surface: `apps/fiab-console/app/catalog/metastores/page.tsx`
Route: `apps/fiab-console/app/api/catalog/metastores/route.ts` (GET list + POST register/probe)

The Loom **Catalog → Metastores** surface (`/catalog/metastores`) federates over every
back-end the Unified Catalog spans and lets an operator **persistently register** a
Databricks workspace, **attach** it to a Unity Catalog metastore, and **catalog** it in
Microsoft Purview — all without a real Microsoft Fabric tenant.

## Azure/Databricks/Fabric/Purview feature inventory

| # | Capability (real UI) | Real backend |
|---|----------------------|--------------|
| 1 | List Unity Catalog metastores (id, region, attached workspace) | UC REST `GET /api/2.1/unity-catalog/metastores` (account/metastore admin) |
| 2 | Per-region metastore model — region column reflects the one-metastore-per-region rule | UC metastore `region` field |
| 3 | Honest account-admin gate (listing metastores needs account/metastore admin) | UC 403 → `ACCOUNT_ADMIN_GATE` with role/identity/where remediation |
| 4 | Register a workspace + list its catalogs (does NOT need account-admin) | UC REST `GET /api/2.1/unity-catalog/catalogs` via POST probe |
| 5 | Discover Databricks workspaces over ARM for the picker | ARM `workspaces` list (Console UAMI Reader) |
| 6 | Manual hostname entry fallback when ARM discovery is blocked | POST probe with manual `hostname` |
| 7 | Surface per-workspace (non-admin) reachability errors | `unityWorkspaceErrors[]` |
| 8 | Fabric / OneLake workspaces (opt-in, soft-fail) | OneLake list — opt-in, never blocks |
| 9 | Microsoft Purview account + endpoint | Purview short-name → endpoint derivation |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | `LoomDataTable<UnityMeta>` (metastore name + id, region, workspace) |
| 2 | built ✅ | `region` column, `filterType:'select'` |
| 3 | honest-gate ⚠️ | warning MessageBar with role/identity/where; page still renders all else |
| 4 | built ✅ | Register section → POST probe → `LoomDataTable<ProbeCatalog>` (name/type/owner) |
| 5 | built ✅ | discovered-workspaces `Dropdown` |
| 6 | built ✅ | manual-entry toggle + `Input` |
| 7 | built ✅ | per-workspace error MessageBar |
| 8 | honest-gate ⚠️ | Fabric/OneLake section soft-fails; opt-in copy, no Fabric hard dependency |
| 9 | built ✅ / honest-gate ⚠️ | account+endpoint shown when configured; warning MessageBar otherwise |

Zero ❌, zero stub banners. Summary `TileGrid` of three `ItemTile`s (Unity Catalog,
OneLake, Purview) anchors to each Section.

## Backend per control

- Unity table + register probe → `GET`/`POST /api/catalog/metastores` (UC REST data plane).
- Account-admin gate → real UC 403 mapped to `ACCOUNT_ADMIN_GATE`; remediation references
  `scripts/csa-loom/add-loom-uami-to-uc-metastore-admin.sh` and env `LOOM_DATABRICKS_HOSTNAMES`
  (wired in `platform/fiab/bicep/modules/admin-plane/main.bicep`).
- OneLake → opt-in list, soft-fails (no-fabric-dependency).
- Purview → endpoint derived from `LOOM_PURVIEW_ACCOUNT` (bicep `admin-plane/main.bicep`).

## Persistent registration + UC attach + Purview source/scan inventory (grounded in Learn)

| # | Capability (source UI) | Where |
|---|------------------------|-------|
| 1 | List the UC metastores in the account | Databricks account console → Catalog |
| 2 | See which metastore a workspace is attached to | account console → workspace → metastore |
| 3 | **Assign / re-assign** a workspace to a UC metastore | account console → metastore → Workspaces → Assign |
| 4 | List a workspace's UC catalogs | workspace → Catalog Explorer |
| 5 | Register an *Azure Databricks Unity Catalog* source (Name + Metastore ID + collection) | Purview Data Map → Register |
| 6 | Define a scan (auth: managed identity / Access Token / service principal + SQL Warehouse HTTP path + IR + scan ruleset) | Purview Data Map → source → New scan |
| 7 | Trigger / run the scan to catalog metadata | Purview scan → Save and run |
| 8 | See scan-run status / history | Purview source → scans → runs |

| # | Capability | Status | Backend per control |
|---|------------|--------|---------------------|
| 1 | List account metastores | ✅ | `unity-catalog-account-client.listAccountMetastores()` → `GET accounts.azuredatabricks.net/api/2.0/accounts/{id}/metastores` |
| 2 | Current workspace assignment | ✅ | `getWorkspaceMetastoreAssignment(wsId)` → `GET …/workspaces/{wsId}/metastore` (404 ⇒ unassigned) |
| 3 | Attach / re-attach metastore | ✅ | `assignMetastore(wsId, metastoreId, defaultCatalog)` → `PUT …/workspaces/{wsId}/metastore` (idempotent). `default_catalog_name` is deprecated by Databricks (use the Default Namespace API) but still sent for back-compat. |
| 4 | List workspace catalogs | ✅ | `unity-catalog-client.listCatalogs(host)` → workspace UC REST 2.1 |
| 5 | Register Databricks UC source | ✅ | `purview-client.registerDatabricksUnityCatalogSource()` → `PUT /scan/datasources/{ds}` kind `AzureDatabricksUnityCatalog`, props `{ metastoreId, collection }` |
| 6 | Define scan | ✅ (MI-first) / ⚠️ honest-gate (no HTTP path) | `defineDatabricksUnityCatalogScan()` → `PUT /scan/datasources/{ds}/scans/{scan}`. **MI-first DEFAULT** kind `AzureDatabricksUnityCatalogMsi` (no Key Vault — uses the Purview account's system-assigned MI); alternative kind `AzureDatabricksUnityCatalogAccessToken` when a Key-Vault PAT credential is supplied. Per current Learn, MI / PAT / service-principal are all supported auth methods (the prior "MI not supported" claim was outdated). Gates only when no SQL Warehouse HTTP path is provided. |
| 7 | Trigger scan run | ✅ (when HTTP path supplied) | `triggerScanRun(ds, scan)` → `PUT …/runs/{runId}` |
| 8 | Scan-run status | ✅ | `listScanRuns(ds, scan)` (existing) |
| — | **Persist the registration** (survives reload, no bicep flip) | ✅ | `cosmos-client.metastoreRegistrationsContainer()` — one doc per workspaceUrl, PK `/tenantId`. Unioned into federation by `resolveWorkspaceHostnames()`. |

Zero ❌. The default scan path (MI-first) needs **no Key Vault** — only a running SQL
Warehouse + its HTTP path, plus a one-time Databricks-admin step (register the Purview
MI as a Databricks service principal + grant UC SELECT/USE) automated/documented by
`scripts/csa-loom/setup-purview-databricks-scan.sh`. The only non-functional state is the
honest gate when no SQL Warehouse HTTP path is supplied. Table/column lineage additionally
requires the `system.access` schema enabled in Unity Catalog (per Learn prerequisites).

## Persistence — how it survives a reload

`POST /api/catalog/metastores` upserts a `MetastoreRegistration` doc to Cosmos
(`metastore-registrations`, PK `/tenantId`, id = workspaceUrl). The UC federation reader
(`resolveWorkspaceHostnames()`) **unions** `LOOM_DATABRICKS_HOSTNAMES` (env) with the
persisted `workspaceUrl`s, so a registered workspace is picked up on every subsequent
load with **no bicep flip and no redeploy** — the gap the previous probe-only POST left
open.

## Per-cloud

| Boundary | UC attach | Purview source/scan | Notes |
|----------|-----------|---------------------|-------|
| Commercial / GCC | ✅ (UC managed) | ✅ `.purview.azure.com` | Full path. |
| GCC-High | ⚠️ gated (UC not GA in usgovaz/va; `catalogPrimary='purview'`) | ✅ `.purview.azure.us` | Registration still persists; attach gates honestly. Account host overridable via `LOOM_DATABRICKS_ACCOUNT_HOST`. |
| IL5 | ⚠️ gated (`catalogPrimary='atlas-aks'`, `purviewEnabled=false`) | ⚠️ gated | Cosmos persistence + the Atlas-primary honest gate render. |

## Backend env / bicep

- `LOOM_DATABRICKS_ACCOUNT_ID` (+ optional `LOOM_DATABRICKS_ACCOUNT_HOST`) — wired into the
  Console Container App env in `platform/fiab/bicep/modules/admin-plane/main.bicep`. Empty
  leaves the attach action gated; registration + catalog listing still work.
- `LOOM_PURVIEW_ACCOUNT` — already wired (catalog.bicep). The UAMI needs Data Source
  Administrator + Data Reader on the root collection (classic Data Map metadata policy,
  granted by `scripts/csa-loom/grant-purview-datamap-role.sh`).
- **Databricks UC scan (MI-first, default)** — the Purview account's system-assigned MI
  (catalog.bicep gives the account `identity:{type:'SystemAssigned'}`) is used as the scan
  credential. One-time Databricks-admin setup (register that MI as a Databricks service
  principal + grant UC SELECT/USE; optionally enable `system.access` for lineage) is
  automated/documented by `scripts/csa-loom/setup-purview-databricks-scan.sh`. **No Key
  Vault required.**
- **Databricks UC scan (PAT alternative, opt-in)** — set
  `databricksScanKeyVaultEnabled=true` in `catalog.bicep` to provision a Key Vault for the
  Databricks PAT secret; the module grants the Purview account MI **Key Vault Secrets User**
  (`4633458b-…`) on it. `MODE=pat KEYVAULT=<name> scripts/csa-loom/setup-purview-databricks-scan.sh`
  registers the Purview Key Vault connection and prints the credential-creation steps.
- Cosmos `metastore-registrations` container is created lazily (createIfNotExists) — no
  extra ARM step beyond the account+database.

## Redesign note

Presentation: raw Fluent `<Table>` blocks → `LoomDataTable`; hand-rolled
`<div style={card}>` + `sectionHead` inline-style cards → `<Section>`; inline
styles folded into a single `makeStyles`; added a summary `TileGrid`/`ItemTile`
row. Remediation copy and the `LOOM_DATABRICKS_HOSTNAMES` / `LOOM_PURVIEW_ACCOUNT`
references are left verbatim so they stay in sync with the deployed environment.

## Verification

`POST /api/catalog/metastores {source:'unity-catalog', hostname:'adb-….azuredatabricks.net'}`
returns `{ ok:true, persisted:true, registration:{…}, catalogs:[…] }` with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET. Reloading the page (`GET`) returns the same row in
`registrations[]` — proving persistence across reloads. With `metastoreId` + the account
API configured, `steps.attach.ok===true` and the workspace shows **UC attached**; with
`registerPurview`, `steps.purview.ok===true` and the workspace shows **Purview source**.
