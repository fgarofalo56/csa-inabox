# Parity gap — `databricks-notebook`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Databricks Workspace → Workspace → Users → ... → Notebook editor (cell-based with PySpark / SQL / Scala / R magics).
> Loom route: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/databricks-notebook/new`.
> Editor source: `apps/fiab-console/lib/editors/databricks-editors.tsx` (lines 592-928).

## Phase 3 — gap matrix vs Databricks notebook UI

| # | Databricks element | Loom present? | Severity |
|---|---|---|---|
| 1 | **Cell-based notebook** (each cell = independent block with Run Cell / Move / Delete / Convert-to-markdown / language magic header) | **MISSING** — entire notebook is a SINGLE `<textarea>` (lines 860-868). Whole-file save, whole-notebook run. No cells. | **BLOCKER** |
| 2 | Monaco editor with PySpark / SQL / Scala / R syntax + completion (spark.* / df.* / pyspark.sql.functions.* / dbutils.* / %sql / %fs / %sh) | **MISSING** — `<textarea>` only | **BLOCKER** |
| 3 | Run Cell vs Run All (cell-level execution) | **MISSING** — only "Run on cluster" runs the whole notebook via `/runs/submit` (line 690-709) | **BLOCKER** |
| 4 | Inline cell output (table renderer, `display()` chart toggle, error trace inline) | MISSING — single bottom output area with raw text (lines 875-891) | **BLOCKER** |
| 5 | Workspace tree (folders / notebooks / repos) | Present (lines 745-775) — real `/api/.../list` listing | OK |
| 6 | Cluster selector + attach state + auto-attach last used | Present partial (lines 825-839) — dropdown selecting cluster, but no "Attach / Detach" toggle | MAJOR |
| 7 | Save + Reload | Present (lines 669-687) — real `PUT` against workspace API | OK |
| 8 | Run history (recent runs in workspace) | Present (lines 893-921) | OK |
| 9 | Schedule / Permissions / Revision history / Comments / Share | MISSING — ribbon claims "Schedule" / "Permissions" / "Revision history" (line 574) without handlers | MAJOR (ribbon vapor) |
| 10 | Status bar (kernel state / line N of M / autosave / language) | MISSING | MINOR |
| 11 | dbutils / widgets palette | MISSING | MAJOR |
| 12 | Variables explorer side pane | MISSING | MINOR |
| 13 | Git integration (Repos UI / commit / sync) | MISSING | MAJOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| Workspace tree expand | `toggle(path)` + lazy `loadDir` (line 642-649) | Real |
| Notebook tree leaf | `openNotebook(path, lang)` — real GET, populates textarea | Real |
| **Save** | `save()` (line 669-687) — real PUT | Real |
| **Run on cluster** | `runOn()` (line 690-709) — real `/runs/submit` + polling loop (line 712-736) | Real |
| Language dropdown | `setLanguage` local state | Real (but no syntax change — textarea ignores it) |
| Cluster dropdown | `setClusterId` local state | Real |
| Ribbon "Save" / "Reload" / "Run on cluster" / "View runs" / "Refresh tree" | No handlers — ribbon decorative | **DEAD** — 5 ribbon vapor |

## Grade

**D** — multiple BLOCKERs.

This is the canonical example of the "no-scaffold-claims" regression. A Databricks notebook is, definitionally, a sequence of cells. Loom's "databricks notebook editor" presents the entire notebook source as one undifferentiated `<textarea>` and runs the whole thing as one batch. That's not parity — it's a remote file editor that happens to call `/runs/submit` on submit. Save + Run-whole-notebook + workspace tree + run history are genuinely real-REST, which is why this isn't F.

Remediation requires re-architecting around cells (parse the magic-comment / `# COMMAND ----------` Databricks cell delimiter on load, render N `<CodeCell>` components, each with its own Monaco instance + Run button + output pane). Plus Monaco with `python|sql|scala|r` language modes and Databricks-aware completion seeded from a small static dictionary of `dbutils.*` / `spark.*` / `display()` / `%sql` / etc.

