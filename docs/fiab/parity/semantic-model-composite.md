# semantic-model-composite — parity with Power BI / AAS composite (mixed-storage-mode) models

Source UI:
- Power BI Desktop / Service — per-table **Storage mode** (Import / DirectQuery / Dual) on a composite model
  (https://learn.microsoft.com/power-bi/transform-model/desktop-composite-models)
- TMSL Partitions object `mode` (import / directQuery / dual / default)
  (https://learn.microsoft.com/analysis-services/tmsl/partitions-object-tmsl)
- Fabric semantic-model definition (model.bim) updateDefinition
  (https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition)

## Azure / Fabric feature inventory

| # | Capability (real UI) | Where |
|---|----------------------|-------|
| 1 | Set a per-table storage mode: Import / DirectQuery / Dual | Power BI Desktop Model view → table → Properties → Storage mode |
| 2 | Mix modes in one model (composite) so a dimension can be Dual while a fact is DirectQuery and another table is Import | Composite model |
| 3 | A DirectQuery / Dual table reads from a SQL data source via a partition query | Partition source.type = "query" + dataSource |
| 4 | Cross-mode relationships resolve (Import ⇄ DQ ⇄ Dual) and a visual returns rows | Report canvas |
| 5 | Apply the model definition (push the per-partition mode into the live model) | XMLA / TMSL createOrReplace, or Fabric updateDefinition |
| 6 | Dual gated to Premium / Fabric capacity (standalone AAS = Import + DirectQuery only) | Engine capability |

## Loom coverage

| # | Capability | Status | Notes |
|---|-----------|--------|-------|
| 1 | Per-table Import / DirectQuery / Dual picker | ✅ built | `SemanticModelEditor` Tables tab — a Fluent `Select` per row (`tableModes` state) |
| 2 | Mix modes in one model | ✅ built | `applyModes()` sends every table with its own mode to the datasource route; `buildCompositeTmsl()` emits one `model.bim` with mixed `partitions[].mode` |
| 3 | DQ / Dual source query per table | ✅ built | Inline `Input` per DQ/Dual row (`tableSourceQ`); default `SELECT * FROM [Table]`; a model-level `dataSources` entry is auto-emitted |
| 4 | Cross-mode relationship + visual returns rows | ✅ built | Relationships carried into TMSL; DAX probe `EVALUATE TOPN(1, '<table>')` runs against the live model and returns the first 300 chars (`probe`) |
| 5 | Apply the per-partition mode | ✅ built / ⚠️ honest-gate | Fabric `updateDefinition` REST when an opt-in Fabric/Premium backend is configured (applied=true); otherwise the composite TMSL is returned as an `Invoke-ASCmd` receipt (applied=false) — standalone AAS cannot take TMSL over plain HTTP (XMLA TCP only) |
| 6 | Dual gated to Premium/Fabric | ✅ built | BFF rejects `dual` on US-Gov boundaries (GCC-High / IL5) with a precise 400; `buildCompositeTmsl({targetEngine:'aas-standalone'})` throws on Dual |

Zero ❌. Item #5's receipt-only state is the honest infra-gate permitted by `no-vaporware.md` (no fake "applied" — `applied:false` plus the exact remediation).

## Backend per control

| Control | Backend |
|---------|---------|
| Storage-mode picker → Apply | `POST /api/items/semantic-model/[id]/datasource` |
| TMSL build | `buildCompositeTmsl()` in `lib/azure/aas-client.ts` (pure; per-partition `mode` + auto `dataSources`) |
| Live apply | `applyTmslViaFabric()` → Fabric `POST /v1/workspaces/{ws}/semanticModels/{id}/updateDefinition` (opt-in) |
| Query probe | `executeDatasetQueries()` → Power BI `POST /datasets/{id}/executeQueries` (DAX) |
| AAS host (opt-in) | `platform/fiab/bicep/modules/admin-plane/analysis-services.bicep` (aasEnabled=false default) |
| Cloud suffix/scope | `aasSuffix()` / `aasScope()` / `aasRestBase()` in `lib/azure/cloud-endpoints.ts` |

## no-fabric-dependency posture

The semantic-model item's **default** Azure-native backend is the Loom-native tabular layer
(`provisionLoomNative`) — unchanged, works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. The composite
storage-mode apply lives on the editor's **opt-in** Power BI / Fabric surface (gated by `powerBiConfigured`),
and the Fabric `updateDefinition` call only fires when `LOOM_SEMANTIC_BACKEND=fabric` or a Fabric workspace is
bound. With no Fabric capacity, the picker still builds the composite TMSL and returns it as an offline
`Invoke-ASCmd` receipt — no Fabric requirement to use the feature.

## Per-cloud matrix

| Boundary | AAS suffix | Dual mode | Apply path |
|----------|-----------|-----------|------------|
| Commercial / GCC | `asazure.windows.net` | via Premium/Fabric (opt-in) | Fabric updateDefinition or Invoke-ASCmd receipt |
| GCC-High / IL5 / DoD | `asazure.usgovcloudapi.net` | **rejected (400)** — standalone AAS Import+DirectQuery only | Invoke-ASCmd receipt (Import/DQ) |

## Verification

- `lib/azure/__tests__/aas-composite-tmsl.test.ts` — 13 cases: per-partition import/DQ/dual, shared dataSource,
  auto dataSource, missing sourceQuery, Dual aas-standalone rejection, invalid mode, empty list, and the
  AAS cloud-matrix suffix/scope rows. All green.
- `npx tsc --noEmit` — touched files clean.
- Receipt (BFF datasource route): `{ ok, tmsl, applied, probe, steps }` — `tmsl` is the composite model.bim,
  `probe` is the first 300 chars of the live DAX `EVALUATE TOPN(1, …)` result.
