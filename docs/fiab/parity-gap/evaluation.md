# evaluation — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/evaluation/new`
**Fabric reference**: ai.azure.com — Evaluations (Quality / RAG / Safety / Custom metric grid)
**Loom screenshot**: `temp/parity/evaluation-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/evaluation?project=loom-project-default` | **403** | Same Foundry data-plane permission gap as prompt-flow |
| `POST /api/items/evaluation` | wired but list 403 prevents reading any history | — |

Renders Project picker · New evaluation form with Display name / Dataset ID / Model deployment / Evaluators (comma-separated string).

## Phase 3 — Fabric vs Loom

| Fabric element | Loom present? | Severity |
|---|---|---|
| **Evaluator picker categorized as Quality · RAG · Safety · Custom** with toggleable per-category metrics | NO — single comma-separated text field | BLOCKER |
| Run a new evaluation with parameter overrides | partial (single form) | MAJOR |
| **Metric grid with category groupings** (Groundedness · Relevance · Fluency under Quality; Coherence under Quality; Hate/Violence/Sexual/SelfHarm under Safety; etc.) | NO — Loom renders flat key/value table when an evaluation is opened | BLOCKER |
| **Side-by-side run compare** | NO | MAJOR |
| Per-row sample drilldown (input → prediction → expected → individual eval scores) | NO | BLOCKER |
| Aggregate score sparkline | NO | MAJOR |
| Dataset preview button | NO | MAJOR |
| Re-run / Cancel run | NO | MAJOR |

## Functional

- Project picker wires to BFF (BFF returns project list OK; subsequent eval list 403)
- New evaluation form posts to BFF but cannot list to verify
- Detail render only shows a flat metric table

## Grade — **F**

Same diagnosis as prompt-flow: 403 on data-plane + flat-table UI vs Fabric's categorized metric grid + sample drilldown. The editor is functionally a "Submit eval job" form. Without honest MessageBar gating, this is vaporware. **Grade F.**
