# Parity gap — `synapse-serverless-sql-pool`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure Synapse Studio → SQL serverless → OPENROWSET query editor.
> Loom route: `https://<your-console-hostname>/items/synapse-serverless-sql-pool/new`.
> Editor source: `apps/fiab-console/lib/editors/synapse-sql-editors.tsx` (lines 148-253).

## Live-browser validation status

Same auth gate as `synapse-dedicated-sql-pool`. See that doc for context. Source-traced findings below.

## Phase 3 — gap matrix vs Synapse Studio serverless

| # | Fabric element | Loom present? | Severity |
|---|---|---|---|
| 1 | T-SQL editor with Monaco + IntelliSense for `OPENROWSET` / `BULK` / `FORMAT='PARQUET'` / external tables, error squiggles | **MISSING** — plain `<textarea>` (line 241-247) | **BLOCKER** |
| 2 | Database tree (master + user dbs) | Present (lines 192-205) — real `/api/.../schema` call, click selects DB | OK |
| 3 | Lake browser (OPENROWSET path tree → ADLS containers → folders → files) | Partial — shows lake folders from schema response (lines 206-215) but not interactive (no drilldown, no preview, no click-to-insert OPENROWSET) | MAJOR |
| 4 | Sample queries pane (with click-to-insert) | Present (lines 216-225) — real, populated from backend | OK |
| 5 | Result grid with chart toggle | Partial — Fluent `<Table>` only (lines 96-126); no chart, no sort, no export | MAJOR |
| 6 | Cost meter (bytes scanned + estimated $ per query) | MISSING — ribbon claims "Bytes processed" + "Cost cap" but no handler, no impl | MINOR (ribbon vapor) |
| 7 | External table creation wizard | MISSING — ribbon claims "External tables" action, no impl | MINOR (ribbon vapor) |
| 8 | Status bar (Connected as <upn> / database / scanned bytes) | MISSING | MINOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| **Run** button | `run()` (line 167-183) — `POST /api/items/synapse-serverless-sql-pool/{id}/query` with `{sql, database}`. Real TDS against ondemand endpoint. | Real |
| Database tree click | `setDatabase(name)` — local state | Real |
| Sample-query tree click | `setSqlText(sm.sql)` — local state | Real |
| Lake tree leaf | No `onClick` — leaf is dead | **DEAD** |
| Ribbon "New SQL query" / "External tables" / "Bytes processed" / "Cost cap" | No handlers in RibbonTab shape | **DEAD** — 4 dead ribbon buttons |

## Grade

**C** — Run button is genuinely real (no provisioning needed because serverless requires no resume). Database + sample-query trees are real. But the editor is a `<textarea>` (BLOCKER per contract), lake tree is read-only display (MAJOR), 4 ribbon buttons silently dead.

Same Monaco-replacement remediation as dedicated.

