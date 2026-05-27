# tracing — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/tracing/new`
**Fabric reference**: ai.azure.com — Tracing (span tree + Gantt timeline + per-span input/output + token counts + cost)
**Loom screenshot**: `temp/parity/tracing-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/tracing?hours=24` | 200 | Returns 0 traces (App Insights queried but no recent flow runs to trace) |

Page shows Window (hrs) input, Operation filter input, Reload button, and an empty table with headers: Time · Operation · Name · Duration (ms) · Success · Result.

## Phase 3 — Fabric vs Loom

| Fabric element | Loom present? | Severity |
|---|---|---|
| **Span tree** (hierarchical, expand/collapse parent → child spans for a single trace) | **NO — Loom is a flat row-per-trace table** | **BLOCKER** |
| **Gantt timeline** (one bar per span, horizontal axis = wall clock) | **NO** | **BLOCKER** |
| Per-span detail pane (input / output / tokens / cost / model / latency) | NO | BLOCKER |
| Token & cost aggregation per trace + per project | NO | MAJOR |
| Filter by status / model / operation / user / tag | partial (only operation filter) | MINOR |
| Time-range presets (5m / 1h / 24h / 7d / custom) | partial — single hours integer input | MINOR |
| Trace search by content / regex | NO | MAJOR |
| Live tail / auto-refresh | NO | MAJOR |
| Export to JSON / share | NO | COSMETIC |

## Functional

- Reload button re-calls `/api/items/tracing` — works
- Empty state is fine (no flow runs in this hub) but the editor has no example/demo trace to show what it WOULD look like

## Grade — **D**

Backing route is real (App Insights query). UI is a flat KQL-result table — NONE of the span tree or Gantt visualization that defines a "tracing" surface. Per build-phase contract this is BLOCKER for spans-tree visualization. **Grade D.**

> Note: this matches the "Tracing: spans tree with Gantt timeline, or flat KQL output?" critical check in the validator prompt. Answer: **flat KQL output.**
