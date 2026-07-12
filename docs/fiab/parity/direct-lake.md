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

!!! info "There are THREE Azure-native Direct Lake mechanisms, not one (validated 2026-07-12)"
    Earlier revisions of this doc credited only the **shim + Synapse Serverless**
    path and understated framing. The full Azure-native Direct Lake surface is:

    1. **`loom-directlake` (Rust/axum + Apache DataFusion + delta-rs)** — the
       truest 1:1 with Fabric Direct Lake. It **reads Delta live off ADLS Gen2
       and columnar-scans it WITHOUT any Import** (delta-rs opens the `_delta_log`,
       DataFusion projects + scans, the result is transcoded to an Arrow IPC
       stream). It also performs **real metadata-only framing** (a Delta-log
       version pin, no data copy). BFF: `POST /api/directlake/scan` (columns) and
       `POST /api/directlake/frame` (version pin + schema). Managed-Identity read
       of the customer's own lake; NO Fabric/OneLake/Power BI host is contacted.
       Code: `apps/loom-directlake/src/scan.rs` (`open_delta` → `deltalake::open_table_with_storage_options` → `ctx.register_table` → DataFusion scan; `execute_frame` = version-pin only).
    2. **Synapse Serverless `OPENROWSET(FORMAT='DELTA')`** — the DirectQuery-style
       fallback the semantic-model **Direct Lake query** tab uses when the warm
       AAS cache is stale/unbuilt. Also a **live** read of the same Gold Delta
       files (Serverless' Delta reader auto-discovers the latest committed version
       from `_delta_log`), so it, too, is import-free.
    3. **Direct-Lake-shim (C# + TOM warm AAS cache)** — keeps a Power-BI-Premium
       VertiPaq cache fresh (5–30 s) via TOM partition refresh driven by
       `_delta_log` Event Grid events. This one DOES materialize a cache (opt-in,
       needs XMLA), and is the "warm" half of the query tab's fallback pair.

    Mechanisms (1) and (2) satisfy "reads Delta directly without import"; (3) is
    the opt-in warm accelerator. The **default** query path never requires Fabric,
    Power BI, or a warm cache — Serverless (and, when deployed, `loom-directlake`)
    serve every query live.

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
| 2 | Framing (advance the model to the latest Delta version without an Import) | ✅ built | `loom-directlake` performs **real metadata-only framing** — `execute_frame()` opens the Delta table via delta-rs and pins the current `_delta_log` version + schema with **no data copy** (`apps/loom-directlake/src/scan.rs:345`), exposed via `POST /api/directlake/frame`. This is the same operation Fabric's framing performs (pin the latest committed Delta version). The **shim** additionally offers a TOM partition/warm-cache refresh (5–30 s) for the opt-in Premium-XMLA path (`TomRefreshClient.RefreshPartition`). The residual sub-second-vs-5-30-s gap applies only to the XMLA warm-cache path and is disclosed in `workloads/direct-lake-parity.md`. |
| 3 | Per-table storage-mode + refresh-policy picker in the editor | ✅ built (T4) | The **Direct Lake (shim)** tab in `semantic-model-editor.tsx` renders one row per model table with a `RefreshPolicyKind` picker (Partition / Full / DirectQuery-fallback / Composite) and persists via `PUT /api/items/semantic-model/[id]/direct-lake` to the Cosmos `direct-lake-config.refresh-policies` store the shim reads. Honest MessageBar discloses this is an AAS incremental-refresh shim, not a Fabric F-SKU. |
| 4 | DirectQuery fallback for stale/cache-miss | ✅ built (T5) | `POST /api/items/semantic-model/[id]/direct-lake` serves from the warm AAS cache when fresh (TTL `LOOM_DL_CACHE_TTL_SECONDS`, default 3600) and falls through transparently to Synapse Serverless `OPENROWSET` over the Gold Delta files — reply carries `servingFrom: 'warm-cache' | 'serverless-fallback'`, surfaced in the **Direct Lake query** tab. No Fabric / Power BI dependency on the default (Serverless) path. The `loom-directlake` DataFusion engine (`POST /api/directlake/scan`) is a second live-Delta reader for the same purpose. |
| 5 | Hybrid tables / incremental + enhanced refresh editor | ✅ built (T6) | The **Incremental refresh** tab (archive range, incremental range, granularity/periods, detect-changes column, real-time DirectQuery toggle) reads/applies policies via `GET`/`PUT /api/items/semantic-model/[id]/refresh-policy` (TMSL Alter to set the policy + TMSL Refresh to apply). |
| 6 | V-Order on Loom-written Delta | ⚠️ honest-gate | Loom-written Delta tables lack V-Order (no OSS V-Order encoder). Negligible for Import-mode models (VertiPaq reads spec-compliant Parquet); only matters if Fabric later reads them. Disclosed in `workloads/direct-lake-parity.md`. |

**Status: zero ❌ (updated 2026-07-12).** Rows 2–5 are ✅ built; rows 1, 6 are
honest-gates with a real backend behind them and the gap disclosed in-product.
Row 2 (framing) was promoted from ⚠️ to ✅ after validating that
`loom-directlake` performs real metadata-only Delta-log framing (`execute_frame`)
— it was previously mis-scored because the doc tracked only the shim's TOM
refresh and omitted the DataFusion engine. Per `ui-parity.md` this doc shows
every inventory row built ✅ or honest-gate ⚠️.

---

## Backend per control

| Control / function | Backend |
| --- | --- |
| Live Delta columnar scan (import-free) | `POST /api/directlake/scan` → `loom-directlake` Rust service → delta-rs `open_table_with_storage_options` + DataFusion projection/limit scan → Arrow IPC (`apps/loom-directlake/src/scan.rs` `execute_scan`/`open_delta`). Honest gate: `LOOM_DIRECTLAKE_URL` (503 names `platform/fiab/bicep/modules/compute/loom-directlake-app.bicep`). |
| Framing (metadata-only version pin, no data copy) | `POST /api/directlake/frame` → `loom-directlake` `execute_frame` → delta-rs version pin + Arrow schema (`apps/loom-directlake/src/scan.rs:345`; service route `apps/loom-directlake/src/main.rs` `/frame`). BFF: `apps/fiab-console/app/api/directlake/frame/route.ts`. Same `LOOM_DIRECTLAKE_URL` honest gate. |
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
