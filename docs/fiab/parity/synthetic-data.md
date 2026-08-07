# synthetic-data — parity with the Microsoft Foundry Data Generation wizard (partial analog)

**Source UI (closest first-party analog):** Microsoft Foundry portal —
**Data Generation** / **Synthetic Data Generation** (both Preview)
<https://learn.microsoft.com/azure/foundry/observability/how-to/evaluation-dataset-synthetic>
· <https://learn.microsoft.com/azure/foundry/fine-tuning/data-generation>

**Surface file:** `apps/fiab-console/lib/editors/synthetic-data-editor.tsx` (434 lines)
**Generator:** `apps/fiab-console/lib/azure/synthetic-data-gen.ts`
**Route:** `/items/synthetic-data/[id]`

## Scoping note — the analog is real but only half-overlapping (measured)

An earlier reading of this surface assumed it was Loom-native with no Microsoft
analog. **That is wrong**, and the correction matters: Microsoft ships **two**
first-party synthetic-data wizards, both in the Foundry portal (not the Azure
portal). But they generate a **different artifact**:

| | Foundry Data Generation | Loom `synthetic-data` |
|---|---|---|
| Output | **JSONL** — `query`/`ground_truth` Q&A pairs, or tool-call conversations | **Delta table rows** — typed, relational |
| Purpose | Evaluation datasets / fine-tuning datasets for models | Test + demo data for a lakehouse |
| Source | A document, a prompt, an agent's instructions, or an OpenAPI spec | A **data contract's schema**, or hand-defined columns |
| Method | An LLM generates the samples | Deterministic per-column strategies (faker/distribution/categorical), seeded |
| Written to | A Foundry dataset | A real **Unity Catalog Delta table** via a UC volume |

So the two surfaces share a *shape* (pick a source, pick a generator, set a
sample count, preview, run, track jobs) and almost nothing of their *substance*.

Separately measured and worth recording: **there is no first-party Azure portal
synthetic/test-data generator for a relational database** — not for Azure SQL,
not for Synapse, not for PostgreSQL. Learn offers only fixed sample databases
(AdventureWorks), Data Sync (replication), and dynamic data masking (obfuscating
real data, not synthesising new). **Loom's tabular generation therefore has no
Azure analog at all** and is graded against `ux-standards.md` §7 for those rows.

This document grades both: **Block 1** against the Foundry wizard's shared shape;
**Block 2** against the ux-baseline for the Loom-native tabular capability.

## Block 1 — shared shape vs the Foundry Data Generation wizard

| # | Foundry capability | Loom | Evidence / gap |
|---|---|---|---|
| 1.1 | Job-list surface with status | ✅ | **Runs** tab: Started / Target / Rows written-of-requested / Status badge. |
| 1.2 | Generation wizard / dialog | ⚠️ | Loom uses a single **Design** tab with three cards (Source schema → Columns → Write target) rather than a stepped wizard. Equivalent information, flatter flow; a first-time user gets no ordering cue. |
| 1.3 | Source-input picker (agent / prompt / reference file) | ⚠️ | Loom's sources are **data contract** or **manual columns** — appropriate to its output type, but a document/prompt source is impossible by construction. |
| 1.4 | Generator-model picker | n/a | Loom's generation is deterministic and seeded, not model-based. No model to pick. Arguably a **strength**: reproducible, zero inference cost, no token spend. |
| 1.5 | Maximum sample count (Foundry 15-1000 / 50-1000) | ✅ **exceeds** | 1-200,000 rows, clamped in the control. |
| 1.6 | Output name | ✅ | Table-name field, sanitized to `[A-Za-z0-9_]`. |
| 1.7 | Preview panel of generated samples | ✅ | **Preview sample** → `POST …/preview` renders up to 10 real generated rows in a grid, `∅` for nulls. |
| 1.8 | Cost metrics on the completed job | ❌ | No cost/PU/DBU reporting. Deterministic generation has no token cost, but the **Databricks SQL warehouse time** is a real cost and is not surfaced. |
| 1.9 | Train/validation split toggle (80/20) | ❌ | Not offered. For ML test data this is a natural and cheap addition. |
| 1.10 | "Use this dataset" → hand off downstream | ⚠️ | The table lands in UC and is usable by any Loom item, but there is no in-product hand-off button (e.g. "open in SQL Lab", "attach to this notebook"). |
| 1.11 | Cancel / delete a generation job | ❌ | No cancel. A 200,000-row generation cannot be stopped once started. |
| 1.12 | Reproducibility | ✅ **exceeds** | A **seed** field with the documented promise "same seed reproduces the same rows". LLM-based generation cannot offer this. |
| 1.13 | Region/network limits disclosed | ❌ | Foundry's wizards are region-restricted and say so. Loom's surface makes no statement about where generation runs. |

**Block 1: 5 ✅ (2 exceeding) · 4 ⚠️ · 4 ❌ · 1 n/a (14 rows).**

## Block 2 — Loom-native tabular capability (graded against ux-standards §7)

| # | Bar / capability | Status | Evidence / gap |
|---|---|---|---|
| 2.1 | Per-column typed strategies | ✅ | `GEN_STRATEGIES` with a `needs` contract driving which option inputs render (range / precision / distribution / values / dateRange / constant / startAt). Typed controls only — `loom_no_freeform_config` satisfied. |
| 2.2 | Column types | ✅ | 8 types (string, integer, bigint, double, decimal, boolean, date, timestamp). |
| 2.3 | Per-column null rate | ✅ | Percent input mapped to a 0-1 `nullRate`. |
| 2.4 | Seed from a data contract, inferring strategies | ✅ | `POST …/sources` lists real contracts; `inferStrategy()` maps each column. |
| 2.5 | **PII-classified columns forced to synthetic** | ✅ **strong** | Contract columns classified PII map to synthetic name/email/mask strategies, badged `PII→synthetic` in the grid, with an explicit footer guarantee that no source row is copied. This is the surface's best feature and has no Foundry equivalent. |
| 2.6 | Write-target cascade (warehouse → catalog → schema → volume → table) | ✅ | Four real dependent `GET …/catalog?level=` calls against Unity Catalog. |
| 2.7 | Honest gate when Databricks unwired | ⚠️ | `MessageBar intent="warning"` naming the env var — honest, and it correctly states "Preview still works with no backend". But it is **not** the shared `HonestGate`, so no inline **Fix it** and no gate-registry entry (**G2** defect). |
| 2.8 | `ItemEditorChrome` + ribbon + command registration | ✅ | Ribbon groups Generate (Preview / Generate) and Item (Save). |
| 2.9 | `TeachingBanner` + Learn link | ✅ | `surfaceKey="synthetic-data-editor"`. |
| 2.10 | `NewItemCreateGate` — clean first-open | ✅ | No red banner on a fresh item. |
| 2.11 | Fluent v9 + Loom tokens; badge rows wrap | ✅ | Tokens throughout; `flexWrap` on every row style. |
| 2.12 | Preview grid uses shared `PreviewTable` (type badges + timing bar) | ❌ | Hand-built `<Table>`. No type badges, no timing bar — and this surface *knows* every column's type, so the badges are free. |
| 2.13 | G3 resizable panes (`SplitPane` + `sizingKey`) | ❌ | `maxHeight: '46vh'` fixed on both grids. |
| 2.14 | Column-spec reorder / duplicate | ❌ | Add and remove only. A 40-column contract cannot be reordered. |
| 2.15 | Correlated / dependent columns | ❌ | Every column is generated independently. Referential integrity across two generated tables, or `city` consistent with `country`, is not expressible — the practical ceiling on realism. |
| 2.16 | Append vs overwrite semantics on re-generate | ❌ | Not surfaced. Re-running against the same table name has undocumented behaviour from the UI's point of view. |
| 2.17 | Progress during a long generation | ⚠️ | Indeterminate `ProgressBar` only. 200,000 rows gives no percentage and no row counter. |
| 2.18 | Failure honesty | ✅ | `POST …/generate` failures set an error MessageBar **and** still persist the failed run into history (`:184`) — the run record is not lost on failure. Good behaviour, explicitly coded. |

**Block 2: 11 ✅ · 2 ⚠️ · 5 ❌ (18 rows).**

**Combined totals: 16 ✅ · 6 ⚠️ · 9 ❌ · 1 n/a (32 rows).**

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Contract source list | `GET /api/items/synthetic-data/:id/sources` | Cosmos (real `data-contract` items with schemas) |
| Warehouse / catalog / schema / volume cascade | `GET …/catalog?level=catalogs\|schemas\|volumes` | **Databricks Unity Catalog** REST |
| **Preview sample** | `POST …/preview` | In-process deterministic generator (seeded) — no backend needed, by design |
| **Generate table** | `POST …/generate` | **Databricks SQL** → stage to a UC **volume** → `createUcTableFromFile` → real **Delta table** |
| Save | `PATCH` via `useItemState` | Cosmos DB |

Real backend on every control that needs one. No mocks. No Fabric host contacted
— `no-fabric-dependency.md` satisfied (Databricks SQL over Delta is the
Azure-native path).

## Verdict

**B-grade — the strongest of the fourteen surfaces in this batch.** The PII→
synthetic mapping (2.5), the seeded reproducibility (1.12), the contract-driven
schema seeding (2.4), and the fact that failed runs are still recorded (2.18)
are all deliberate, correct choices. Real Delta output, real UC cascade.

The gaps are refinement rather than absence:

1. **2.15 (no correlated columns)** caps how realistic the output can be — the
   only *capability* gap that limits the surface's usefulness.
2. **1.11 + 2.17 (no cancel, no real progress)** on a job that can legitimately
   run for minutes.
3. **2.12** (`PreviewTable`) is a one-import swap that this surface benefits
   from more than most, since it already knows every column type.
4. **2.7** is a `ux-baseline.md` **G2** defect (bare gate, no Fix-it, unregistered).

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/synthetic-data/<id>
  ```
  The walk must prove: the same seed produces identical preview rows twice, a
  PII-classified contract column really lands as a synthetic value, and the
  generated Delta table is queryable afterwards.
- Coverage read from source; static evidence only (`no_scaffold_claims`).
