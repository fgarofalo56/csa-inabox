# direct-lake — parity with Fabric Direct Lake (Power BI semantic-model storage mode)

> **This is the hardest single workload to parity.** Loom is honest about the
> gap. This per-surface doc records exactly which Direct Lake capabilities are
> built and which are honest-gated.

!!! success "Console wiring SHIPPED (verified against `main` 2026-07-12)"
    The T4–T6 Console wiring that this doc previously tracked as roadmap has
    landed and is verified in code: the
    `/api/items/semantic-model/[id]/direct-lake` route exists (GET/PUT
    per-table refresh policies + POST query with transparent
    warm-cache → Synapse Serverless fallback), and `semantic-model-editor.tsx`
    ships the **Direct Lake (shim)**, **Direct Lake query**, and
    **Incremental refresh** tabs plus the `/refresh-policy` route. Rows 3–5
    below are now ✅ with file evidence. The **Azure-native default** remains
    the push-dataset "Build a Power BI model" path (no Fabric, no XMLA)
    documented in `semantic-model.md`; the shim/warm-cache path is strictly
    opt-in per `no-fabric-dependency.md`.

**Source UI:**
- Direct Lake overview — https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview
- Develop / framing — https://learn.microsoft.com/fabric/fundamentals/direct-lake-develop
- Direct Lake on OneLake — https://learn.microsoft.com/fabric/fundamentals/direct-lake-onelake-storage-mode

**Loom design:** [Direct Lake parity workload](../workloads/direct-lake-parity.md) · ADR [fiab-0004](../adr/0004-direct-lake-parity.md)
**Shim backend (built):**
- `apps/fiab-direct-lake-shim/src/LoomDirectLakeShim/EventGrid/DeltaLogEventHandler.cs` — Delta `_delta_log` event ingestion
- `apps/fiab-direct-lake-shim/src/LoomDirectLakeShim/Tom/TomRefreshClient.cs` — `RefreshPartition()` / `RefreshTable()` via `Microsoft.AnalysisServices.Tabular`
- `apps/fiab-direct-lake-shim/src/LoomDirectLakeShim/Config/SemanticModelConfigStore.cs` — Cosmos `direct-lake-config.refresh-policies` (60 s cache)
- `apps/fiab-direct-lake-shim/src/LoomDirectLakeShim/Models/RefreshPolicy.cs` — `RefreshPolicyKind` (partition / full / directquery-fallback / composite)

**Console wiring (T4–T6 — SHIPPED, in `main`):**
- `apps/fiab-console/app/api/items/semantic-model/[id]/direct-lake/route.ts` — GET/PUT per-table refresh policies (Cosmos store) + POST DirectQuery-style query with transparent warm-AAS-cache → Synapse Serverless `OPENROWSET` fallback (`servingFrom: 'warm-cache' | 'serverless-fallback'`)
- `apps/fiab-console/app/api/items/semantic-model/[id]/refresh-policy/route.ts` — incremental-refresh policy read/apply (TMSL Alter + Refresh)
- `apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx` — **Direct Lake (shim)** tab (per-table `RefreshPolicyKind` picker), **Direct Lake query** tab (serving-from surface), **Incremental refresh** tab (RangeStart/RangeEnd, granularity, periods, detect-changes)

---

## Fabric feature inventory

| # | Capability (real Fabric UI) | Where in Fabric |
| --- | --- | --- |
| 1 | Create a Direct Lake semantic model from a Lakehouse/Warehouse (pick tables, storage mode = Direct Lake on OneLake) | Fabric workspace → New semantic model |
| 2 | Framing — advance the model to the latest Delta version without a full Import refresh | Automatic on Delta commit (or reframe API) |
| 3 | Per-table storage mode + refresh policy (partition / full / DirectQuery fallback / composite) | Model settings / Desktop live-edit |
| 4 | DirectQuery fallback when a query exceeds F-SKU guardrails (DL/SQL) | Automatic at query time |
| 5 | Hybrid tables — incremental refresh + DirectQuery current-period partition | Desktop incremental-refresh policy |
| 6 | V-Order — write-time Parquet sort/encoding for VertiPaq paging | Fabric Spark / Lakehouse write path |

---

## Loom coverage

Legend: ✅ built (full 1:1 + real backend) · ⚠️ honest-gate (full surface renders + Fluent MessageBar / disclosed limit) · ❌ MISSING (roadmap, disclosed)

| # | Capability | State | Notes |
| --- | --- | --- | --- |
| 1 | Create a semantic model over lakehouse/warehouse tables | ⚠️ honest-gate | The Azure-native default is the **push-dataset Build-model** path (`POST /api/items/semantic-model/build` → `createPushDataset`) — real Power BI REST, no XMLA, no Fabric. True Direct-Lake-on-OneLake creation needs a Fabric F-SKU; disclosed via MessageBar naming `LOOM_POWERBI_XMLA_ENDPOINT`. See `semantic-model.md` row 11. |
| 2 | Framing (sub-second advance to latest Delta) | ⚠️ honest-gate | The shim performs **TOM partition refresh** (5–30 s), not VertiPaq framing. The freshness gap is disclosed in `workloads/direct-lake-parity.md` (Honest gaps). Backend is real (`TomRefreshClient.RefreshPartition`). |
| 3 | Per-table storage-mode + refresh-policy picker in the editor | ✅ built (T4) | The **Direct Lake (shim)** tab in `semantic-model-editor.tsx` renders one row per model table with a `RefreshPolicyKind` picker (Partition / Full / DirectQuery-fallback / Composite) and persists via `PUT /api/items/semantic-model/[id]/direct-lake` to the Cosmos `direct-lake-config.refresh-policies` store the shim reads. Honest MessageBar discloses this is an AAS incremental-refresh shim, not a Fabric F-SKU. |
| 4 | DirectQuery fallback for stale/cache-miss | ✅ built (T5) | `POST /api/items/semantic-model/[id]/direct-lake` serves from the warm AAS cache when fresh (TTL `LOOM_DL_CACHE_TTL_SECONDS`, default 3600) and falls through transparently to Synapse Serverless `OPENROWSET` over the Gold Delta files — reply carries `servingFrom: 'warm-cache' | 'serverless-fallback'`, surfaced in the **Direct Lake query** tab. No Fabric / Power BI dependency on the default (Serverless) path. |
| 5 | Hybrid tables / incremental + enhanced refresh editor | ✅ built (T6) | The **Incremental refresh** tab (archive range, incremental range, granularity/periods, detect-changes column, real-time DirectQuery toggle) reads/applies policies via `GET`/`PUT /api/items/semantic-model/[id]/refresh-policy` (TMSL Alter to set the policy + TMSL Refresh to apply). |
| 6 | V-Order on Loom-written Delta | ⚠️ honest-gate | Loom-written Delta tables lack V-Order (no OSS V-Order encoder). Negligible for Import-mode models (VertiPaq reads spec-compliant Parquet); only matters if Fabric later reads them. Disclosed in `workloads/direct-lake-parity.md`. |

**Status: zero ❌ (2026-07-12).** Rows 3–5 are ✅ built (T4–T6 Console wiring verified in `main`); rows 1, 2, 6 are honest-gates with a real backend behind them and the gap disclosed in-product. Per `ui-parity.md` this doc now shows every inventory row built ✅ or honest-gate ⚠️.

---

## Backend per control

| Control / function | Backend |
| --- | --- |
| Direct Lake (shim) tab — per-table policy picker | `GET`/`PUT /api/items/semantic-model/[id]/direct-lake` → Cosmos `direct-lake-config.refresh-policies` (same store `SemanticModelConfigStore.cs` reads) |
| Direct Lake query tab — DirectQuery-style query | `POST /api/items/semantic-model/[id]/direct-lake` → warm AAS cache (Power BI Premium XMLA, opt-in) else Synapse Serverless `OPENROWSET` over Gold Delta (`lib/azure/synapse-sql-client` `buildDeltaOpenRowsetSql`) |
| Incremental refresh tab — policy read/apply | `GET`/`PUT /api/items/semantic-model/[id]/refresh-policy` → TMSL Alter (set policy) + TMSL Refresh (apply) via the AAS incremental-refresh path |
| Delta-commit ingestion | `DeltaLogEventHandler.cs` — Storage Event Grid `BlobCreated` on `_delta_log/*` → `DeltaLogPath` parse → `FindModelsContainingTable()` |
| Refresh-policy store | `SemanticModelConfigStore.cs` — Cosmos DB `direct-lake-config` / `refresh-policies` (partition key `/semanticModelId`), 60 s in-memory cache |
| TOM partition refresh | `TomRefreshClient.RefreshPartition()` — `Microsoft.AnalysisServices.Tabular` → `partition.RequestRefresh(RefreshType.Full)` + `Model.SaveChanges()` |
| TOM full-table refresh | `TomRefreshClient.RefreshTable()` — `table.RequestRefresh(RefreshType.Full)` |
| Policy kinds | `Models/RefreshPolicy.cs` — `RefreshPolicyKind` { partition, full, directquery-fallback, composite } |
| Shim UAMI | bicep `uami-loom-direct-lake-${location}` (`admin-plane/identity.bicep:53`) |
| Shim Container App | `loom-direct-lake-shim:${appImageTags.directLake}` (`admin-plane/main.bicep:1685`) |
| Storage Event Grid topic | `Microsoft.EventGrid/systemTopics@2025-02-15` on the ADLS account (`landing-zone/storage.bicep:210`) |
| Cosmos config database | `direct-lake-config` DB + `refresh-policies` container (`landing-zone/cosmos.bicep:82`) |

Tests: `apps/fiab-direct-lake-shim/tests/LoomDirectLakeShim.Tests/DeltaLogPathParsingTests.cs` (Delta-log path parsing). The shim backend is real, deployed, and unit-tested, and the Console wiring (T4–T6) is shipped in `main`.

---

## Per-cloud / per-boundary notes

Direct Lake (Fabric-native) requires a Fabric **F-SKU**. The Loom shim approach (Premium Import + TOM warm-cache refresh) needs XMLA, which is available on F/P-SKU capacities. Per `no-fabric-dependency.md`, the **Azure-native default** (push-dataset Build-model) requires neither and works everywhere.

| Cloud | Fabric Direct Lake (F-SKU) | Loom Direct-Lake-Shim (Import + TOM) | Azure-native push-dataset default |
| --- | --- | --- | --- |
| Commercial | ✅ | ✅ shim backend deployed + Console wiring shipped (T4–T6) | ✅ works today, no Fabric |
| GCC | ❌ **No F-SKU; no Fabric** | ❌ **Structural gap** — no XMLA warm-cache target matching DL semantics (P-SKU Import + scheduled refresh only); the Serverless-fallback query path still works | ✅ works today, no Fabric |
| GCC-High / IL4 | ✅ | ✅ shim backend deployed + Console wiring shipped (T4–T6) | ✅ works today |
| DoD / IL5 | ✅ | ✅ shim backend deployed + Console wiring shipped (T4–T6) | ✅ works today |

The GCC absence is **structural, not timing-fixable** (no F-SKU → no Fabric Direct Lake and no XMLA warm-cache). This matches `workloads/direct-lake-parity.md` and ADR fiab-0004.

---

## Related

- Workload design: [Direct Lake parity](../workloads/direct-lake-parity.md)
- ADR: [fiab-0004 Direct Lake parity](../adr/0004-direct-lake-parity.md)
- PRP tasks T4–T6 (shipped): `docs/fiab/prp/power-bi.md`
- Semantic-model editor parity: [semantic-model.md](./semantic-model.md)
