# catalog-metastores — parity with Databricks Unity Catalog / Fabric OneLake / Microsoft Purview accounts

Source UI:
- Azure Databricks → Catalog → Metastores (account console + workspace catalog explorer)
- Microsoft Fabric → OneLake / workspaces
- Microsoft Purview → Data Map account overview
- Learn: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/ ,
  https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/get-started

Surface: `apps/fiab-console/app/catalog/metastores/page.tsx`
Route: `apps/fiab-console/app/api/catalog/metastores/route.ts` (GET list + POST register/probe)

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

## Redesign note (this PR)

Presentation-only: raw Fluent `<Table>` blocks → `LoomDataTable`; hand-rolled
`<div style={card}>` + `sectionHead` inline-style cards → `<Section>`; ~30 inline
styles folded into a single `makeStyles`; added a summary `TileGrid`/`ItemTile`
row. No backend, env var, role, or bicep change — remediation copy and the
`LOOM_DATABRICKS_HOSTNAMES` / `LOOM_PURVIEW_ACCOUNT` references are left verbatim
so they stay in sync with the deployed environment.
