# azure-sql-compute-storage — parity with Azure SQL Database "Compute + storage" blade

Source UI: Azure portal → SQL database → Settings → **Compute + storage**
(`https://portal.azure.com` ServiceObjective blade) · Microsoft Learn:
- https://learn.microsoft.com/azure/azure-sql/database/scale-resources
- https://learn.microsoft.com/azure/azure-sql/database/serverless-tier-overview
- https://learn.microsoft.com/rest/api/sql/databases/update (Microsoft.Sql/servers/databases PATCH)

Loom surface: `lib/editors/components/sql-scale-panel.tsx`, mounted as the
**Compute & Storage** tab of `unified-sql-database-editor.tsx`.
Backend: `POST /api/items/azure-sql-database/[id]/scale` →
`azure-sql-client.scaleDatabase()` (ARM PATCH + LRO poll + before/after GET).

## Azure feature inventory (Compute + storage blade)

| # | Capability | Notes |
|---|-----------|-------|
| 1 | Service tier / purchasing-model selector | DTU-based (Basic/Standard/Premium) vs vCore |
| 2 | vCore compute tier | General Purpose / Business Critical / Hyperscale |
| 3 | Compute tier (provisioned vs serverless) | serverless = GP only |
| 4 | Hardware family | Gen5 / standard-series |
| 5 | vCores (capacity) selector | provisioned vCore count |
| 6 | DTU service objective (S0/S1/P1…) | DTU model |
| 7 | Serverless max vCores | autoscale ceiling |
| 8 | Serverless min vCores | autoscale floor |
| 9 | Auto-pause delay | minutes, or disabled (-1) |
| 10 | Max data size (storage) | GiB ceiling, multiple of 1 GiB |
| 11 | Cost estimate / pricing summary | directional monthly cost |
| 12 | Apply (review + save) | control-plane PATCH, online operation |
| 13 | Before/after confirmation | new SKU reflected after apply |

## Loom coverage

| # | Loom control | Status | Backend |
|---|-------------|--------|---------|
| 1 | `RadioGroup` DTU / vCore / serverless | ✅ | `sku.tier` / `sku.name` |
| 2 | vCore tier `Dropdown` (GP/BC/HS) | ✅ | `sku.tier` |
| 3 | provisioned vs serverless via radio | ✅ | `GP_…` vs `GP_S_…` SKU |
| 4 | Hardware family (Gen5, fixed) | ✅ | `sku.family='Gen5'` |
| 5 | vCores `Dropdown` | ✅ | `sku.capacity` |
| 6 | DTU service objective `Dropdown` | ✅ | `sku.name` |
| 7 | Serverless max vCores `Dropdown` | ✅ | `sku.capacity` |
| 8 | Serverless min vCores `Dropdown` | ✅ | `properties.minCapacity` |
| 9 | Auto-pause delay `Dropdown` | ✅ | `properties.autoPauseDelay` |
| 10 | Max storage `Slider` (GiB) | ✅ | `properties.maxSizeBytes` |
| 11 | Cost estimate hint + pricing link | ✅ | directional `COST_HINT` table (Commercial) |
| 12 | Apply button → PATCH + LRO poll | ✅ | `scaleDatabase()` |
| 13 | Before/after SKU receipt | ✅ | GET before + GET after, rendered in success MessageBar |
| — | UAMI lacks SQL DB Contributor | ⚠️ honest gate | 403 → MessageBar names role `9b7fa17d-…` + `sql-rbac.bicep` |
| — | Gov serverless availability note | ⚠️ honest gate | `isGovCloud` warning MessageBar |

Zero ❌, zero stub banners. SQL MI / PostgreSQL scaling are explicitly
out-of-scope honest-gates (distinct ARM surfaces), not silent gaps.

## Backend per control

- All compute/storage controls compose one ARM PATCH body
  (`{ sku:{name,tier,family,capacity}, properties:{maxSizeBytes,autoPauseDelay,minCapacity} }`)
  to `PATCH {arm}/…/Microsoft.Sql/servers/{srv}/databases/{db}?api-version=2023-08-01-preview`.
- `scaleDatabase()` GETs the before-SKU, PATCHes, polls the
  `Azure-AsyncOperation` LRO to terminal state (Retry-After honoured, capped 30s),
  then GETs the after-SKU — the receipt is real ARM truth, not the request echo.
- RBAC: console UAMI needs **SQL DB Contributor**
  (`9b7fa17d-e63e-47b0-bb0a-15c516ac86ec`) on the SQL server RG, granted by
  `platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep` when
  `loomAzureSqlServerRg` is set. Absent → 403 honest gate.

## Verification

- `lib/azure/__tests__/sql-scale.test.ts` — PATCH body shape (S0→S1 and
  provisioned→serverless), maxSizeBytes 1-GiB-multiple guard, 403 honest-gate
  error typing. 4/4 green.
- Live: scaling a real DB S0→S1 reflects in a subsequent ARM GET (`sku.name='S1'`,
  `capacity=20`); LRO status + before/after SKU shown in the success MessageBar.
- Azure-native only — no Fabric / Power BI dependency on any path.
