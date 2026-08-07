# sql-lab — parity with Databricks SQL editor / Fabric SQL analytics endpoint / Trino UI

**Source UI:** there is no single first-party twin; this surface is graded against
the interactive lakehouse-SQL tier as a class:
- Azure Databricks SQL editor — <https://learn.microsoft.com/azure/databricks/sql/>
- Microsoft Fabric SQL analytics endpoint — <https://learn.microsoft.com/fabric/data-warehouse/sql-analytics-endpoint-performance>
- Azure Synapse **serverless SQL** (Loom's own no-DuckDB fallback) — <https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview>

**Surface file:** `apps/fiab-console/lib/editors/sql-lab-editor.tsx` (552 lines)
**Route:** `/items/sql-lab/[id]` · Items N2a (duckdb-wasm) + N2b (`loom-duckdb` serving tier).

**Companion doc (different scope, not a duplicate):**
`docs/fiab/parity/sql-lab-duckdb.md` is the **program/architecture** doc for the
N2a+N2b tier pair — engine, deployment, storage posture, Trino/Flight SQL
interop. This file is the per-slug `ui-parity.md` **surface** deliverable that
`docs/fiab/parity/<slug>.md` requires; the two are complementary and the
architecture doc does not satisfy the per-slug requirement on its own.

## Feature inventory and Loom coverage

### Query authoring and execution

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| Q1 | SQL editor with a run action | built | **Query** tab; ribbon Run action plus in-tab run. |
| Q2 | Read-only posture over the lake | built (deliberate) | The tier's identity holds **Storage Blob Data READER** — it "can query everything and change nothing" (stated in the surface's own `LearnPopover`). A genuine safety property, not a limitation to apologise for. |
| Q3 | Multiple query languages | built (exceeds) | SQL **and PRQL** (N8, Preview, default-ON) via a language `Dropdown`. Neither Databricks SQL nor the Fabric endpoint offers a second query language. |
| Q4 | Result grid with typed columns + timing | built | Renders through the shared **`PreviewTable`** — type badges and a timing status bar. One of only two surfaces in this batch that uses the shared primitive. |
| Q5 | Query history | **MISSING** | No history of previous queries in the session or across sessions. Databricks SQL and the Fabric endpoint both keep one; it is the most-missed editor affordance. |
| Q6 | Saved queries / query tabs | **MISSING** | One query at a time; nothing is saved. |
| Q7 | Schema browser / object explorer tree | **MISSING** | No catalog/schema/table tree beside the editor. A user must already know the table names — the same free-text problem as `analysis-board`, on a surface where an explorer tree is standard in every comparator. |
| Q8 | Autocomplete / IntelliSense | **MISSING** | Not evidenced. |
| Q9 | Cancel a running query | partial | A `running` state drives the ribbon label; no explicit cancel affordance evidenced. |
| Q10 | Explain / query plan | **MISSING** | Not built. |
| Q11 | Export results (CSV / clipboard) | partial | The **Local analysis** tab holds the Arrow result client-side and can slice it; a plain "download CSV" is not evidenced. |
| Q12 | Row-limit / max-rows control | partial | Not evidenced as a user control. |

### Tiering and interop *(largely Loom-only)*

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| T1 | Engine identity + version surfaced | built | Toolbar badge reads `DuckDB <version>` when the tier is configured, `Synapse Serverless` when it is not — the user always knows which engine answered. |
| T2 | Loaded extensions surfaced | built | Second badge listing `caps.capabilities.extensions`. |
| T3 | **Graceful engine fallback** | built (Loom-only) | With no DuckDB tier the same SQL runs on **Synapse Serverless** — "identical results, more latency". No comparator offers a fallback engine; `auto-bind-by-default.md` is satisfied because the surface works with nothing configured. |
| T4 | **Local analysis** tier (duckdb-wasm in the browser) | built (Loom-only) | Slices the already-fetched Arrow result in-browser at zero server cost. Neither Databricks nor Fabric has this. |
| T5 | **Connect** tab: ADBC / Flight SQL / JDBC snippets + short-lived access ticket | built (exceeds) | Databricks and Fabric document connection strings; Loom generates per-engine snippets *and* mints a ticket in-product. |
| T6 | Arrow result transport | built | `POST /api/duckdb/query?format=arrow`. |

### Surface behaviour and gating

| # | Capability | Loom | Evidence / gap |
|---|---|---|---|
| S1 | Runtime kill-switch with a guided off-state | built (exemplary) | Flag `n2b-sql-lab-duckdb` off renders a full `EmptyState` naming the flag and the exact remediation path (Admin → Runtime flags), and states plainly that every other surface keeps working. Best off-state in this batch. |
| S2 | Shared **`HonestGate`** with inline **Fix it** | built | `<HonestGate gateId={caps.gate.id} gate={caps.gate} … onResolved={refetch}>` — **G2 compliant**, and one of only two surfaces in this batch that is. |
| S3 | Honest "tier unreachable" state distinguished from "not configured" | built (exemplary) | `caps.unreachable` renders its own `MessageBar` with the reason. This is exactly the distinction `deploy-integrity.md` **R7** demands — "I could not reach it" is not reported as "it is not there". |
| S4 | `LearnPopover` explaining when to use this tier vs Spark | built | Concrete and quantified (sub-second vs 1-5 min Spark start-up), not marketing copy. |
| S5 | G3 resizable panes | built | `splitKeyPrefix="sql-lab"` on `ItemEditorChrome` — persisted `sizingKey`. |
| S6 | Ribbon with grouped actions (Run / Tiers) incl. tooltips | built | |
| S7 | `TeachingBanner` | **MISSING** | Has a `LearnPopover` (S4) but no dismissible teaching banner; siblings carry both. |

## Totals

**14 built (5 of them exceeding every comparator, 3 Loom-only) · 4 partial · 6 MISSING — 24 rows.**

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Capability probe (engine, version, extensions, gate) | `GET /api/duckdb/capabilities` | `loom-duckdb` serving tier (internal-ingress ACA) |
| **Run** (SQL or PRQL) | `POST /api/duckdb/query?format=arrow` | Embedded **DuckDB** reading Delta / Iceberg / Parquet **in place** on ADLS Gen2 |
| Fallback engine | Synapse serverless path | **Azure Synapse serverless SQL** |
| Trino federation | `/api/sql/trino` | Trino (opt-in) |
| Local analysis | duckdb-wasm, in-browser | none (by design) |
| Connect snippets + ticket | connect route | Short-lived access ticket |

Real backend on every control. No mocks. No Fabric/OneLake host contacted —
`no-fabric-dependency.md` satisfied.

## Assessment

**B/A− — the strongest surface in this batch on state-honesty**, and the one
other editors should be copied from. It is the only surface here that gets all
four of: shared `HonestGate` with Fix-it, a guided flag-off `EmptyState`,
`PreviewTable` for results, and persisted `SplitPane` sizing. S3 (distinguishing
"unreachable" from "unconfigured") is precisely the discipline `deploy-integrity.md`
R7 exists to enforce, implemented voluntarily.

The gaps are all in **editor ergonomics**, and they are the same four every
comparator ships:

1. **Q7 — no schema browser.** On a SQL surface this is the single biggest
   omission; you must know your table names before you arrive.
2. **Q5 — no query history.** Standard in Databricks SQL and the Fabric
   endpoint.
3. **Q6 — no saved queries / tabs.**
4. **Q8 — no autocomplete.** Compounds Q7.

None of these are backend work; they are all editor features, which makes this
the cheapest surface in the batch to move from B to A.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); GitHub Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/sql-lab/<id>
  ```
  The walk must exercise **both** engine paths — with the DuckDB tier configured
  and with it absent (the Synapse-serverless fallback) — plus the PRQL language
  toggle and the flag-off state.
- Coverage read from source; static evidence only (`no_scaffold_claims`).
