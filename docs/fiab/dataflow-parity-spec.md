# dataflow — parity with the Fabric Dataflow Gen2 editor

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
> capture said "Loom has Cosmos persistence + 503 Refresh not yet wired." That
> is stale: `DataflowGen2Editor`
> (`apps/fiab-console/lib/editors/dataflow-gen2-editor.tsx`) is wired to live
> Fabric Items REST including a real **Refresh** job. This doc is the honest,
> feature-by-feature comparison — and it is candid that a full Power Query
> designer is **not** built (the editor is a Script + Diagram editor, not the
> Power Query ribbon experience).

Source UI: **Fabric Dataflow Gen2** (Power Query Online). Inventory grounded in
Microsoft Learn: <https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview>.

**Backend reality.** Dataflows are managed as **Fabric items + a base64
definition** (`mashup.pq` / `queryMetadata.json`); Refresh triggers a real
Refresh **job instance** on the item. This is the one item whose Gen2 authoring
surface is genuinely Fabric/Power-Query-Online; the Loom editor edits the M
definition and dispatches Refresh against the Fabric Items API. No mock data —
list/detail/save/refresh hit Fabric REST and surface 401/403 verbatim.

---

## Loom coverage — delivered editor surface

Legend: ✅ built (full 1:1 + real backend) · ⚠️ partial / honest-gate.

| Fabric capability | Loom | Backend (real REST) |
| --- | --- | --- |
| Workspace picker + dataflow tree (left rail) | ✅ `useWorkspaces` + `Tree` | `GET /api/loom/workspaces`, `GET /api/items/dataflow?workspaceId=` |
| Create dataflow (dialog) | ✅ `New` | `POST /api/items/dataflow` |
| Delete dataflow (confirm) | ✅ | `DELETE /api/items/dataflow/[id]` |
| **Script tab** — Power Query M (`mashup.pq`/`.m`) or definition JSON in Monaco | ✅ `MonacoTextarea` (M → plaintext, else JSON) | `GET/PUT /api/items/dataflow/[id]` |
| **Diagram tab** — visual projection of the M queries (steps + dependencies) | ✅ `DataflowDiagram` parses M into a visual graph; editable | parses `mashup.pq`; `PUT` on Save |
| **Refresh now** → Fabric Refresh job | ✅ ribbon + button | `POST /api/items/dataflow/[id]/refresh` (Fabric Items `jobs/instances`) |
| Save (PUT InlineBase64 definition) / Ctrl+S | ✅ ribbon + keyboard | `PUT /api/items/dataflow/[id]` |
| Refresh list | ✅ button | `GET /api/items/dataflow?workspaceId=` |
| Unsaved (dirty) badge + part-path label (`mashup.pq` / `queryMetadata.json`) | ✅ | from `definition.parts` |
| Save/Refresh status line (timestamps, queued) | ✅ info `MessageBar` | from responses |
| Errors surface verbatim (no fabricated success) | ✅ `MessageBar intent="error"` | n/a |
| Fabric / workspace not reachable | ⚠️ honest-gate — `MessageBar` "Fabric not reachable" with the 401/403 + hint; the editor still renders | n/a |
| Non-`.pq`/`.m` definition part on the Diagram tab | ⚠️ honest-gate — `MessageBar` "edit it on the Script tab" (the diagram only projects M) | n/a |
| No dataflow selected yet | ⚠️ honest-gate — info `MessageBar`: design now, pick/create to Save/Refresh | n/a |

Every row above is ✅ or an honest ⚠️ gate — zero stub banners, zero dead
controls. The 503 "Refresh not yet wired" from the old capture is gone; Refresh
dispatches a real Fabric job.

## Backend per control (real REST, no mocks)

- List / detail / create / save / delete: `app/api/items/dataflow[/[id]]/route.ts` → Fabric Items REST (`/workspaces/{ws}/items`, definition get/update).
- Refresh: `app/api/items/dataflow/[id]/refresh/route.ts` → Fabric Items `POST /workspaces/{ws}/items/{id}/jobs/instances`.
- Diagram projection: `lib/components/pipeline/dataflow-diagram.tsx` (parses M, no backend).
- Auth: Console UAMI SP authorized in the Fabric tenant + added to the target workspace; 401/403 surfaced verbatim.

## Beyond this editor — full Power Query Online capabilities not yet built (honest)

The Fabric Dataflow Gen2 editor is the full Power Query Online experience. Loom
ships a Script + best-effort Diagram editor over the same definition, **not** the
Power Query ribbon. These are genuinely absent (tracked, not claimed):

| Fabric capability | Status |
| --- | --- |
| Power Query ribbon (Home / Add Column / Transform / View / Help, 300+ transforms) | ❌ not built |
| 100+ connector "Get Data" gallery | ❌ not built |
| Queries pane (left) with right-click operations | ❌ not built |
| Applied Steps pane (right) | ❌ not built |
| Data Preview grid (typed columns, row count, filter/sort) | ❌ not built |
| Schema view / column profiling + data-quality metrics | ❌ not built |
| Refresh History pane | ❌ not built — Refresh queues but history is not surfaced |
| AI Prompt Column / Copilot NL assistance | ❌ not built |
| Scheduled refreshes UI | ❌ not built |
| Parameters / Variable library | ❌ not built |
| Data destinations config (Azure SQL / ADX / ADLS / Lakehouse / Warehouse) | ❌ not built |

> Honest grade: this is a **C-grade** authoring surface for Gen2 — a real M
> editor + diagram + live Refresh, short of the Power Query designer. It is
> listed here so no reader mistakes it for full Power Query Online parity.

## Bicep / env sync

- This editor uses the **Fabric Items API** (an opt-in Fabric path); it requires
  a workspace the Console UAMI can reach, named via `LOOM_DEFAULT_FABRIC_WORKSPACE`
  / the workspace picker. Per `no-fabric-dependency.md`, dataflow Gen2's Azure-
  native equivalent for ETL is the **data-pipeline** (ADF/Synapse) item, which is
  the default path for codeless transformation when no Fabric workspace exists.
- No new Azure resource or env var is introduced by the dataflow editor; it
  consumes the existing Fabric workspace wiring. Adding Bicep for the un-built
  Power Query surfaces above before the code exists would be dead config per
  `no-vaporware.md`.

## Verification

Per `no-vaporware.md`: list/detail/save/refresh hit real Fabric REST; Refresh
queues a real job; the unreachable / non-M-part / no-selection states are honest
gates. Live side-by-side against Power Query Online confirms the gap rows above.
