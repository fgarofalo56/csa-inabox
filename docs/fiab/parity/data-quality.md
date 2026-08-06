# data-quality — parity with Microsoft Purview Data Quality (Unified Catalog)

**Source UI:** Microsoft Purview — Unified Catalog → Health Management → **Data quality**
<https://learn.microsoft.com/purview/unified-catalog-data-quality>
Supporting: <https://learn.microsoft.com/purview/unified-catalog-data-quality-fabric-lakehouse>

**Surface file:** `apps/fiab-console/lib/editors/data-quality-editor.tsx` (304 lines)
**Panels:** `components/dq-runner-checks-panel.tsx`, `components/dq-data-diff-panel.tsx`
**Rule management (separate surface):** `/governance/data-quality`
**Route:** `/items/data-quality/[id]` · W11.

## Scope split — read this before the totals

The `data-quality` **item type** is deliberately only the *run configuration +
scorecard* half of Purview's experience. **Rule authoring lives on a different
Loom surface** (`/governance/data-quality`), which the editor links to
explicitly (`:211`). Grading the item against all 22 Purview rows would blame
this surface for features that exist next door.

So rows below are marked **[here]** (must exist in this editor) or
**[governance]** (Loom's answer lives on the governance page; this doc records
where, and the governance page owns its own coverage). Only **[here]** rows count
toward this surface's totals; **[governance]** rows are listed for completeness
and totalled separately.

**Related docs (different scope, not duplicates):**
`docs/fiab/parity/data-quality-run-results.md` grades Loom's DQ **results**
against Databricks Lakehouse Monitoring + Delta constraints; this doc grades the
**item editor** against Purview. Both are needed; neither supersedes the other.

## Purview inventory and Loom coverage

| # | Purview capability | Where | Loom | Evidence / gap |
|---|---|---|---|---|
| 1 | Governance-domain selector scoping the DQ experience | [governance] | ⚠️ | Loom scopes by **workspace**, not governance domain. Different model, comparable effect. |
| 2 | Data-source connection setup (Managed Identity) | [here] | ✅ | Backend radio (ADX / Databricks SQL / Synapse SQL) + per-backend target fields; the console UAMI is the identity. |
| 3 | Data profiling — distribution, min/max, stddev, uniqueness, completeness, duplicates, with AI-recommended columns | [here] | ❌ | **Not built anywhere in Loom.** This is Purview's *entry point* — you profile first, then rules are suggested from what profiling found. Without it a user must already know what to assert. Largest single gap. |
| 4 | Asset **Overview** page: global score + actions tile + Run scan | [here] | ✅ | Scorecard card: composite score, `ProgressBar` colour-banded at 90/70, passing/failing badges, backend·target·timestamp. |
| 5 | **Schema** tab + **Import schema** (re-pull types on source drift) | [here] | ❌ | No schema view on this surface. Purview needs Import schema for Iceberg specifically; Loom has no equivalent. |
| 6 | **Rules** tab listing applied rules with a per-rule **Trend** column | [here] | ⚠️ | The breakdown grid shows Rule / Check / Scope / Measured / Detail / Status for the **last run only**. There is **no per-rule trend** — you cannot see that a rule has been degrading. History exists but only as whole-run rows. |
| 7 | Rules toggle ON/OFF; draft rules don't run or score | [governance] | — | Owned by `/governance/data-quality`. |
| 8 | Eight OOB rule types (freshness, unique, string-format, data-type, duplicate-rows, empty/blank, table-lookup, custom) | [governance] | ⚠️ | Loom's teaching banner names **five** (not-null / unique / range / regex / freshness). No table-lookup (cross-asset reference check), no duplicate-rows, no data-type match. |
| 9 | String-format sub-modes: enumeration / like-pattern / regex | [governance] | ⚠️ | Regex only, per the banner. |
| 10 | Custom rule — visual expression builder (row / filter / null expressions) | [governance] | ❌ | Not evidenced. |
| 11 | Custom (Spark SQL) rule | [governance] | ❌ | Not evidenced. |
| 12 | **Suggest rules** (AI-generated from profiling) | [governance] | ❌ | Consequence of row 3 — no profiling means no suggestions. |
| 13 | **Run quality scan** (ad hoc) | [here] | ✅ | `POST …/run` → real `runDqRules` against the selected backend. Auto-saves a dirty item first (`:115`) so the run matches what is persisted — a correct detail. |
| 14 | Incremental / time-filtered scan (preview) | [here] | ❌ | Whole-target only. |
| 15 | **Scheduled scans** wizard (recurrence, ≤30 assets, weekly default-on) | [here] | ❌ | **No scheduling.** DQ that only runs when a human clicks is not a control — this and row 3 are the two gaps that most change what the surface is *for*. |
| 16 | **Monitoring** page: Activities/Scans tabs, filters, **PU consumed** per job | [here] | ⚠️ | **History** tab gives Ran / Backend / Target / Score / Rules / Status, newest-first, 50 retained. No filters, no cost/consumption column. |
| 17 | Scoring formula + rollup asset → data product → domain | [here] | ⚠️ | Composite score is computed and rendered per run. **No rollup** to a product or domain level from this surface. |
| 18 | Rule **Details** / **History** tabs with passed/failed/ignored + 50-run trend | [here] | ⚠️ | Run-level history retains 50 runs (matching Purview's number), but there is **no per-rule** history or trend (row 6). |
| 19 | DQ **dimension** Power BI report (completeness / consistency / conformity / accuracy / freshness / uniqueness) | [here] | ❌ | No dimension model at all. Loom scores rules, not dimensions, so it cannot say "our completeness is 94%". |
| 20 | **Alerts** wizard (score < X% or dropped by > X%, recipients, notify-on-failed-scan) | [here] | ❌ | No alerting. Combined with row 15, a quality regression is invisible until someone opens the item. |
| 21 | **Action items** centre: Active/In-progress/Resolved/My-items, recommendation + generated SQL diagnostic, assignable, status | [here] | ⚠️ | The **Runner checks** and **Data diff** tabs (N7d, default-ON flag) are Loom's adjacent answer and are genuinely useful, but there is no assignable action-item workflow with status. |
| 22 | Managed VNet for private-endpoint sources | [here] | ✅ | The console runs in-VNet; ADX/Databricks/Synapse are reached over private endpoints by deployment construction. |
| 23 | Delete DQ data (profile + history + rules) | [here] | ⚠️ | Runs are capped at 50 and drop off; no explicit purge action. |
| 24 | 200-active-rules-per-asset ceiling; freshness unsupported on Snowflake/Databricks-UC/BigQuery/Synapse/Azure SQL | [here] | ✅ **exceeds** | Loom has no such ceiling, and its freshness check runs on the backends Purview excludes. A genuine advantage over the source product. |

**[here] totals: 5 ✅ (1 exceeding) · 7 ⚠️ · 7 ❌ (19 rows).**
**[governance] rows: 0 ✅ · 3 ⚠️ · 2 ❌ (5 rows) — owned by `/governance/data-quality`.**

## ux-baseline §7 spot-check

| Bar | Status |
|---|---|
| `ItemEditorChrome` + ribbon (Quality / Item groups) | ✅ |
| `TeachingBanner` + Learn link | ✅ |
| Tabs with live counts; N7d tabs flag-gated (kill-switch hides both) | ✅ |
| `NewItemCreateGate` — clean first-open | ✅ |
| Fluent v9 + Loom tokens; `flexWrap` on every badge row | ✅ |
| Honest gate when the backend is unconfigured | ⚠️ — probed on load and rendered as `MessageBar intent="warning"` naming the env var. Honest, but **not** the shared `HonestGate`: no inline **Fix it**, no gate-registry entry (**G2**). |
| Breakdown grid uses `PreviewTable` | ❌ — hand-built `<Table>`; no type badges, no timing bar. |
| G3 resizable panes | ❌ — `maxHeight: '46vh'` fixed. |

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Gate probe on load | `GET /api/items/data-quality/:id/run` | Env/config check for the selected backend |
| N7d flag probe | `GET …/checks` | Runtime-flag `n7d-data-quality-diff` (default-ON) |
| **Run quality checks** | `POST …/run` | `runDqRules` → **ADX** (KQL) / **Databricks SQL** / **Synapse SQL** (TDS) |
| Runner checks / Data diff tabs | `…/checks`, diff route | Same backends |
| Save | `PATCH` via `useItemState` | Cosmos DB |

Real backend on every control. No mocks. No Fabric host contacted — and per the
measured finding that **Fabric has no native DQ surface at all** (data quality
for OneLake is entirely a Purview surface), `no-fabric-dependency.md` is
satisfied by construction here.

## Verdict

**C/B — the run-and-score half is solid; the operate-and-govern half is missing.**
Three gaps change what the surface *is*, rather than merely how complete it is:

1. **Row 3 — no profiling.** Purview's flow is profile → suggest → assert.
   Loom's is assert → run. A user who does not already know their data cannot
   get started.
2. **Row 15 — no scheduling.** Manual-only DQ is a diagnostic, not a control.
3. **Row 20 — no alerting.** With 15, a regression is invisible until someone
   looks.

After those: **row 6/18** (per-rule trend — the data is already persisted per
run, so this is mostly a rendering change) and **row 19** (DQ dimensions).

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/data-quality/<id>
  ```
  The walk must run against all three backends (ADX / Databricks / Synapse) —
  the backend radio changes the target fields and each path is separately
  breakable.
- Coverage read from source; static evidence only (`no_scaffold_claims`).
