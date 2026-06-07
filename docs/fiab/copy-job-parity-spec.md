# copy-job — parity with the Fabric Copy Job editor

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.

> **rev.2 (2026-06-06) — rewritten against current code.** The 2026-05-26
> capture said "Loom has Cosmos persistence + /run POST to ADF copy activity"
> and listed the whole editor as a gap. That is stale: `CopyJobEditor`
> (`apps/fiab-console/lib/editors/phase2-misc-editors.tsx`) is a real
> linked-service–driven source→sink editor wired to ADF + Synapse. This doc is
> the honest, feature-by-feature comparison.

Source UI: **Fabric Copy Job** (wizard-based data movement). Inventory grounded
in Microsoft Learn: <https://learn.microsoft.com/fabric/data-factory/what-is-copy-job>.

**Azure-native default (no real Fabric required, per `no-fabric-dependency.md`).**
The copy runs as a **Synapse pipeline** (`loom-copy-<id>`) materialised + triggered
on Run; the source/sink linked services come from the env-pinned **ADF factory**.
No Fabric workspace is required. No mock data — the source/sink dropdowns are
populated from a live `GET /api/adf/linked-services`, and Run executes a real
pipeline; errors surface verbatim (no fake success).

---

## Loom coverage — delivered editor surface

Legend: ✅ built (full 1:1 + real backend) · ⚠️ partial / honest-gate.

| Fabric capability | Loom | Backend (real REST) |
| --- | --- | --- |
| Create gate for a new item | ✅ `NewItemCreateGate` intro + Create | `POST /api/items/copy-job` |
| **Source — linked-service picker** (from the factory) | ✅ `Dropdown` listing real LS w/ type | `GET /api/adf/linked-services` (`listLinkedServices`) |
| Source type selector (AzureSql / AzureBlob / DelimitedText / Parquet / Json / AzureTable source) | ✅ `Dropdown` | stored in `state.source.type` |
| Source SQL query (for SQL sources) | ✅ `Textarea` | `state.source.query` |
| **Sink — linked-service picker** | ✅ same LS API | `GET /api/adf/linked-services` |
| Sink type selector (6 sink types matching sources) | ✅ `Dropdown` | `state.sink.type` |
| Sink table / path | ✅ `Input` | `state.sink.table` |
| **Column mappings** (source col → sink col, add/remove rows) | ✅ `KeyValueGrid` (array mode `{source,sink}`) | `state.mappings[]` |
| Save state (Ctrl+S + ribbon + button) | ✅ keyboard + ribbon `Edit` group | `PUT /api/items/copy-job/[id]` (Cosmos `saveItem`) |
| **Run now** (materialise + trigger the Synapse copy pipeline) | ✅ ribbon `Run` group + button (saves first) | `POST /api/items/copy-job/[id]/run` (`upsertPipeline` + `runPipeline`) |
| **Run history** (runId / status / start / end / duration / message) | ✅ `Table`, colour-coded status badges, Refresh runs | `GET /api/items/copy-job/[id]/runs` (`queryPipelineRuns`) |
| Last-run confirmation (runId) | ✅ success `MessageBar` | from Run response |
| Errors surface verbatim (no fabricated success) | ✅ `ErrBar` + per-action `MessageBar` | n/a |
| No ADF linked services available | ⚠️ honest-gate — `MessageBar intent="warning"` "No ADF Linked Services found" naming the Manage → Linked services remediation | `ls.linkedServices.length === 0` |
| ADF factory not provisioned / unreachable | ⚠️ honest-gate — `MessageBar intent="warning"` "ADF Linked Services unavailable" with the underlying error + hint (names `LOOM_ADF_NAME`) | `listLinkedServices` 503 / 401/403 |

Every row above is ✅ or an honest ⚠️ gate — zero stub banners, zero dead
controls. The Run button is disabled (not fake) until both source and sink
linked services are chosen.

## Backend per control (real REST, no mocks)

- Linked-service pickers: `useLinkedServices()` → `GET /api/adf/linked-services` → `lib/azure/adf-client.ts#listLinkedServices`.
- Save: `saveItem('copy-job', id, state)` → `PUT /api/items/copy-job/[id]` (Cosmos owned-item).
- Run: `POST /api/items/copy-job/[id]/run` → Synapse `upsertPipeline('loom-copy-<id>')` + `runPipeline`.
- Runs: `GET /api/items/copy-job/[id]/runs` → `queryPipelineRuns`.
- Auth: Console UAMI against `management.azure.com` (ADF + Synapse REST).

## Beyond this editor — full Fabric Copy Job capabilities not yet built (honest)

The Fabric Copy Job is an 11-panel guided wizard. Loom's editor is a flat,
real-backend source→sink form. These wizard capabilities are genuinely absent
(tracked, not claimed):

| Fabric capability | Status |
| --- | --- |
| Wizard-style guided flow (Source → Destination → Mapping → Mode → Settings → Review) | ❌ not built — flat form |
| 100+ connector gallery (searchable, categorized) | ❌ not built — 6 source / 6 sink types |
| Schema browser + data preview (sample rows, column types, row counts) | ❌ not built |
| Copy mode selector (Full / Incremental / CDC) + incremental watermark column | ❌ not built — always full copy |
| Write-behavior selector (Append / Overwrite / Merge / SCD Type 2) | ❌ not built |
| Per-table multi-select + per-table overrides | ❌ not built — single source/sink |
| Auto-partitioning, audit columns, performance tuning | ❌ not built |
| Run-history drill-down (per-table stats, source-vs-sink row counts) | ❌ not built — flat run list |

## Bicep / env sync

- Consumed env vars: `LOOM_ADF_NAME` (+ `LOOM_ADF_RG`, `LOOM_SUBSCRIPTION_ID`,
  `LOOM_DLZ_RG`, `LOOM_SYNAPSE_WORKSPACE`). The "ADF Linked Services
  unavailable" gate names them.
- Resource: the env-pinned ADF factory (`adf.bicep`) + Synapse workspace
  (already deployed). **No new Azure resource** — the copy runs as a Synapse
  pipeline created on demand. The 2026-06-06 `adfPrivateDnsZoneId` threading fix
  (see `data-pipeline-parity-spec.md`) is what makes the factory deploy in a
  clean sub so the linked-service pickers populate. No `LOOM_COPYJOB_*` env var
  is consumed by the current editor (incremental watermark/control-table is in
  the "not yet built" list above, so no Bicep for it is introduced — adding it
  before the code reads it would be dead config per `no-vaporware.md`).
- No new Cosmos container (copy-job persists in the shared owned-items container).

## Verification

Per `no-vaporware.md`: Save → Cosmos, Run → real Synapse pipeline, runs →
`queryPipelineRuns`; the no-LS / unreachable states are honest gates. Live
side-by-side against the Fabric Copy Job wizard confirms the gap rows above.
