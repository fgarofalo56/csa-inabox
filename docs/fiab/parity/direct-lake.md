# direct-lake — parity with Fabric Direct Lake (Power BI semantic-model storage mode)

> **This is the hardest single workload to parity.** Loom is honest about the
> gap. This per-surface doc records exactly which Direct Lake capabilities are
> built, which are honest-gated, and which are roadmap.

!!! warning "Console wiring is roadmap (as of 2026-06-09)"
    The **Direct-Lake-Shim backend service** (`apps/fiab-direct-lake-shim`) is
    real, tested, and bicep-deployed — event ingestion, TOM partition/full
    refresh, and the Cosmos refresh-policy store all exist. **What is NOT yet in
    `main` is the Console UI that drives it**: there is no "Direct Lake (shim)"
    storage-mode option in `SemanticModelEditor`, no
    `/api/items/semantic-model/[id]/direct-lake` route, no refresh-policy picker,
    no DirectQuery-fallback badge, and no incremental-refresh editor. Those are
    tasks **T4–T6** (see `docs/fiab/prp/power-bi.md`). Rows 3–6 below are marked
    ❌ honestly until that wiring lands and this banner is removed. The supported
    **Azure-native default today** is the push-dataset "Build a Power BI model"
    path (no Fabric, no XMLA) documented in `semantic-model.md`.

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

**Console editor (T4–T6 — not yet in `main`):** `SemanticModelEditor` storage-mode option + `app/api/items/semantic-model/[id]/direct-lake/route.ts` + refresh-policy/incremental editors.

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
| 3 | Per-table storage-mode + refresh-policy picker in the editor | ❌ MISSING (T4) | The shim's `RefreshPolicyKind` (partition/full/directquery-fallback/composite) is persisted in Cosmos `direct-lake-config.refresh-policies`, but **no Console control reads/writes it** and there is no `/api/items/semantic-model/[id]/direct-lake` route. Roadmap. |
| 4 | DirectQuery fallback for stale/cache-miss | ❌ MISSING (T5) | No query-path proxy to Synapse Serverless `OPENROWSET` over the Delta path; no "Serving from: warm cache | fallback" badge. Roadmap. |
| 5 | Hybrid tables / incremental + enhanced refresh editor | ❌ MISSING (T6) | No incremental-refresh policy editor (RangeStart/RangeEnd, rolling window, detect-changes, DQ current-period) and no `/api/items/semantic-model/[id]/refresh-policy` route. Roadmap. |
| 6 | V-Order on Loom-written Delta | ⚠️ honest-gate | Loom-written Delta tables lack V-Order (no OSS V-Order encoder). Negligible for Import-mode models (VertiPaq reads spec-compliant Parquet); only matters if Fabric later reads them. Disclosed in `workloads/direct-lake-parity.md`. |

**Status: not yet A-grade.** Rows 3–5 are honest ❌ (Console wiring T4–T6 is not in `main`); rows 1, 2, 6 are honest-gates with a real backend behind them. This doc reaches zero ❌ only when T4–T6 land — at which point the roadmap banner above is removed and rows 3–5 flip to ✅.

---

## Backend per control (the shim that IS built)

| Control / function | Backend |
| --- | --- |
| Delta-commit ingestion | `DeltaLogEventHandler.cs` — Storage Event Grid `BlobCreated` on `_delta_log/*` → `DeltaLogPath` parse → `FindModelsContainingTable()` |
| Refresh-policy store | `SemanticModelConfigStore.cs` — Cosmos DB `direct-lake-config` / `refresh-policies` (partition key `/semanticModelId`), 60 s in-memory cache |
| TOM partition refresh | `TomRefreshClient.RefreshPartition()` — `Microsoft.AnalysisServices.Tabular` → `partition.RequestRefresh(RefreshType.Full)` + `Model.SaveChanges()` |
| TOM full-table refresh | `TomRefreshClient.RefreshTable()` — `table.RequestRefresh(RefreshType.Full)` |
| Policy kinds | `Models/RefreshPolicy.cs` — `RefreshPolicyKind` { partition, full, directquery-fallback, composite } |
| Shim UAMI | bicep `uami-loom-direct-lake-${location}` (`admin-plane/identity.bicep:53`) |
| Shim Container App | `loom-direct-lake-shim:${appImageTags.directLake}` (`admin-plane/main.bicep:1685`) |
| Storage Event Grid topic | `Microsoft.EventGrid/systemTopics@2025-02-15` on the ADLS account (`landing-zone/storage.bicep:210`) |
| Cosmos config database | `direct-lake-config` DB + `refresh-policies` container (`landing-zone/cosmos.bicep:82`) |

Tests: `apps/fiab-direct-lake-shim/tests/LoomDirectLakeShim.Tests/DeltaLogPathParsingTests.cs` (Delta-log path parsing). The shim backend is real, deployed, and unit-tested; the gap is exclusively the Console wiring (T4–T6).

---

## Per-cloud / per-boundary notes

Direct Lake (Fabric-native) requires a Fabric **F-SKU**. The Loom shim approach (Premium Import + TOM warm-cache refresh) needs XMLA, which is available on F/P-SKU capacities. Per `no-fabric-dependency.md`, the **Azure-native default** (push-dataset Build-model) requires neither and works everywhere.

| Cloud | Fabric Direct Lake (F-SKU) | Loom Direct-Lake-Shim (Import + TOM) | Azure-native push-dataset default |
| --- | --- | --- | --- |
| Commercial | ✅ | ✅ shim backend deployed (Console wiring = T4–T6 roadmap) | ✅ works today, no Fabric |
| GCC | ❌ **No F-SKU; no Fabric** | ❌ **Structural gap** — no XMLA warm-cache target matching DL semantics (P-SKU Import + scheduled refresh only) | ✅ works today, no Fabric |
| GCC-High / IL4 | ✅ | ✅ shim backend deployed (Console wiring = T4–T6 roadmap) | ✅ works today |
| DoD / IL5 | ✅ | ✅ shim backend deployed (Console wiring = T4–T6 roadmap) | ✅ works today |

The GCC absence is **structural, not timing-fixable** (no F-SKU → no Fabric Direct Lake and no XMLA warm-cache). This matches `workloads/direct-lake-parity.md` and ADR fiab-0004.

---

## Related

- Workload design: [Direct Lake parity](../workloads/direct-lake-parity.md)
- ADR: [fiab-0004 Direct Lake parity](../adr/0004-direct-lake-parity.md)
- PRP tasks T4–T6: `docs/fiab/prp/power-bi.md`
- Semantic-model editor parity: [semantic-model.md](./semantic-model.md)
