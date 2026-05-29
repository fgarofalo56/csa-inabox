# Loom Spark Job Definition Editor — Fabric-parity build spec

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


> Reference: Microsoft Learn — *How to create an Apache Spark job definition in Fabric* (`/fabric/data-engineering/create-spark-job-definition`), *Schedule and run an Apache Spark job definition* (`/fabric/data-engineering/run-spark-job-definition`), *Spark Job Definition REST API v2* (`/rest/api/fabric/articles/item-management/definitions/spark-job-definition`). Documented 2026-05-26 by catalog agent (no live capture — F64 SJD seat not provisioned in `casino-fabric-poc`).

## Overview

A Fabric **Spark Job Definition (SJD)** is a non-interactive batch submit item in the **Data Engineering** workload. Where a notebook is REPL-style and lives on an interactive Spark session, an SJD packages a single binary (`.py` / `.jar` / `.R`) plus reference libs, a default lakehouse context, command-line arguments, and a retry policy — and submits one batch job per run against the workspace's Spark compute. SJDs are the canonical way to run **compiled Scala/Java jars** and **production-grade Python jobs** in Fabric, and they're the activity type a Data Factory pipeline calls when it needs to invoke Spark.

The SJD item is created from the workspace **New item → Spark Job Definition** entry. Once created, it opens in a code-item editor with a multi-tab body and a ribbon. Runs are tracked in a per-item **Runs** tab and surfaced in the workspace **Monitoring hub**.

## Fabric SJD UX inventory

### Page chrome
- Page title shows the SJD name (editable inline) · `Saved` status indicator
- Standard Fabric workspace breadcrumb, capacity badge, and global action bar (search, Notifications, Settings, Help, Account)

### Ribbon (Home tab)
| Group | Buttons |
|---|---|
| **File** | Save · Save as |
| **Run** | **Run** (submits a manual batch) · **Cancel active run** |
| **Settings** | **Settings** ▼ (opens side pane with: General, Schedule, Run history retention) |
| **View** | View snapshot (per-run frozen spec) |
| **Sharing** | Share · Comments |

### Main body — left pane (definition form)
| Field | Behavior |
|---|---|
| **Language** dropdown | `PySpark (Python)` · `Spark(Scala/Java)` · `SparkR (R)` — drives accepted file extensions for upload |
| **Main definition file** | One required file. Upload from local **or** paste a full `abfss://` URI. `.py` / `.jar` / `.R` per language. Mandatory. For Scala/Java: paired **Main class** text input (FQCN). |
| **Reference files** | Optional, multiple. Same upload-or-ABFSS pattern. `.py` modules for PySpark, additional `.jar` for Scala, `.R` for SparkR. |
| **Command line arguments** | Free-form text, space-separated. Passed to the job's `argv[]`. |
| **Lakehouse references** | At least one **default lakehouse** is required. Optional **additional lakehouses** array. Default is the working file-system mount; relative paths in code resolve to it. |
| **Environment** dropdown | Attach a Fabric Environment item (libraries + Spark conf + pool). Optional — falls back to workspace default. |

### Main body — right pane (tabs)
| Tab | Contents |
|---|---|
| **Spark Compute** | Read-only display of the inherited runtime version (e.g. `1.3 / Spark 3.5 / Delta 3.2 / Python 3.11`) and the resolved Spark conf. **Add** button to layer per-job conf overrides (key/value pairs). |
| **Optimization** | Toggle **Retry policy**. When on: `retryCount` (≥1 or −1 for unlimited) and `intervalBetweenRetriesInSeconds` (0–86400). Warning callout: "Make sure the job is idempotent." |
| **Runs** | Table of past runs. Columns: Application name · Status (Not started / In progress / Succeeded / Failed / Cancelled) · Run kind (Manual / Scheduled / Pipeline) · Submitted by · Submit time · Duration · Spark application ID. Row click opens monitor detail (Spark UI, driver log, executor log). |

### Settings side pane
- **General** — name, description, default lakehouse picker shortcut
- **Schedule** — recurrence (minute / hourly / daily / weekly / monthly), start/end window, time zone, on/off toggle
- **Run history retention** — days to keep run records

### Per-run snapshot
Every submitted run captures a frozen copy of: main file, reference files, command-line args, lakehouse references, environment ref, Spark conf. The Runs tab → **View snapshot** opens this frozen spec with three actions: **Restore**, **Open SJD**, **Save as new SJD**.

### Pipeline activity surface
The same item is callable from Data Factory pipelines via the **Spark Job Definition activity** — drag from Activities bar, pick the SJD item, optionally override `commandLineArguments`. Runs triggered this way show with `Run kind = Pipeline` in the Runs tab.

---

## What Loom has today

Loom's `SparkJobDefinitionEditor` (`apps/fiab-console/lib/editors/phase2-misc-editors.tsx` line 146) is **C-grade** — functional but a thin form, not a parity surface:

- Single form with: **Main file** (ABFSS URI text input, no upload), **Main class**, **Spark pool** (Synapse pool dropdown), **Arguments** (textarea, newline-separated), **Spark conf** (raw JSON textarea)
- Buttons: **Submit Spark batch**, **Save spec**, **Refresh runs**
- Runs table: ID · Name · State · Result · Submitted · App ID
- Backend wired: `POST /api/items/spark-job-definition/[id]/submit` calls `submitSparkBatchJob` against the Synapse dev endpoint (Livy `/livyApi/versions/2019-11-01-preview/sparkPools/{pool}/batches`). Cosmos persistence of spec is real.

## Gaps for parity

1. **Language picker** — no language dropdown; pool/file path implies it. Add `PySpark | Spark(Scala/Java) | SparkR` with extension-aware upload validation.
2. **File upload** — Loom only accepts an ABFSS URI. Must add **Upload from local** that pushes the file to the workspace ADLS (`abfss://files@<account>.dfs.core.windows.net/sjd/<itemId>/Main/<filename>`) and records the path.
3. **Reference files** — no concept in Loom today. Add multi-file upload + per-file delete + ABFSS path entry. Persist as `state.spec.referenceFiles[]`.
4. **Lakehouse references** — Loom has no default-lakehouse binding on an SJD. Add **Default lakehouse** picker + **Additional lakehouses** multi-select pulling from Loom workspace items where `itemType = lakehouse`. Persist `defaultLakehouseId` + `additionalLakehouseIds[]`.
5. **Environment attachment** — no Environment dropdown. Pick from Loom items where `itemType = environment`; merge its libraries + conf at submit time.
6. **Retry policy** — `submitSparkBatchJob` ignores retry. Add `retryPolicy: { retryCount, intervalBetweenRetriesInSeconds }` to state and translate at submit (Livy doesn't have native retry; Loom must implement the loop server-side or via the existing run-orchestration worker).
7. **Tabbed layout** — Loom is flat. Split into the four-tab layout: **Definition / Spark Compute / Optimization / Runs** matching Fabric's anatomy.
8. **Spark conf UX** — replace raw JSON textarea with a **key/value DataGrid** (Add row, Delete row, validate value type per known Spark property).
9. **Settings → Schedule** — Loom has no scheduler for SJDs. Reuse the existing `pipeline-schedule` mechanism (or wire to Azure Logic Apps / Synapse Schedule trigger) and expose recurrence editor.
10. **Run snapshot** — every submit must clone the spec into `runs/{runId}/snapshot` so users can View snapshot · Restore · Save as. Currently only the submit response is recorded.
11. **Cancel active run** — `submitSparkBatchJob` returns a Livy batch ID; need `DELETE /livyApi/versions/.../batches/{id}` wired through a new `POST /api/items/spark-job-definition/[id]/runs/[runId]/cancel` route.
12. **Run history retention** — no policy. Add per-item TTL on the runs Cosmos container.
13. **Pipeline activity callable** — the existing `data-pipeline-editor.tsx` has no `SparkJobDefinitionActivity` type. Add it so pipelines can chain SJDs.
14. **Status bar / breadcrumbs** — minor; align with `ItemEditorChrome` patterns used elsewhere.

## Backend mapping

| Fabric concept | Loom backend |
|---|---|
| Submit batch | ✅ Existing `POST /api/items/spark-job-definition/[id]/submit` → `submitSparkBatchJob` → Synapse Livy. Databricks alternative: `POST /api/2.1/jobs/runs/submit` via existing `databricks-editors` SDK client. |
| Cancel active run | **NEW** `POST .../[id]/runs/[runId]/cancel` → Livy `DELETE /batches/{id}` or Databricks `POST /api/2.1/jobs/runs/cancel`. |
| Get run state | ✅ Existing `/api/items/spark-job-definition/[id]/runs` calls `getLivyBatch`. Extend to fetch driver/executor log URIs. |
| Upload main / reference file | **NEW** `POST .../[id]/files` (multipart) → writes to ADLS Gen2 under workspace files container at `sjd/{itemId}/Main|Libs/...`. Returns full ABFSS URI. |
| Lakehouse reference resolution | **NEW** at submit time, look up referenced lakehouse Cosmos items, read their `state.adlsPath`, and pass into Livy conf as `spark.sql.defaultDatabase` + `spark.hadoop.fs.defaultFS`. |
| Environment merge | **NEW** at submit, fetch the attached Environment item's `state.{requirements, conf, jars}` and merge into the Livy batch's `conf` + `jars[]` + `pyFiles[]`. |
| Retry policy | **NEW** server-side loop in a worker (Azure Function timer or Loom's run-orchestrator) — on failed terminal state, re-submit up to `retryCount` times with `intervalBetweenRetriesInSeconds` delay. |
| Schedule | **NEW** Cosmos doc `schedules/{itemId}` + a timer-triggered Function that calls the existing submit endpoint with the persisted spec. |

## Required Azure resources

- ✅ Synapse Workspace with at least one Spark Pool (already in `platform/fiab/bicep/modules/synapse/*.bicep`)
- ✅ ADLS Gen2 storage account with `files` container (already in lakehouse bicep)
- ✅ Loom Cosmos container `items` (already)
- **Optional, alt path:** Databricks workspace (already in bicep) — submit through `jobs/runs/submit` instead of Livy
- **NEW** Azure Function App for retry + schedule worker (or extend the existing `loom-run-orchestrator` Function if present)
- **NEW** Cosmos container `schedules` (new) — or extend `items` with a `state.schedule` sub-doc

## Estimated effort

**3 focused sessions.**

- **Session 1 (~2.5h):** Backend — file upload route, lakehouse-reference resolution at submit, cancel-run route, environment merge, run snapshot persistence. Cosmos schema additions.
- **Session 2 (~2.5h):** Frontend — tabbed layout (Definition / Spark Compute / Optimization / Runs), language picker with extension-aware upload, reference files multi-uploader, lakehouse refs picker, environment dropdown, key/value conf grid, retry policy form.
- **Session 3 (~2h):** Schedule editor + retry worker + pipeline-activity wiring + view-snapshot drawer + UAT harness coverage.

Drops Loom SJD from **C** (functional-but-flat) to **A** (production-grade + parity-shaped).
