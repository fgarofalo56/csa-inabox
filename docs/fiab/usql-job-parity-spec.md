# Loom U-SQL Job Editor — Fabric-parity build spec (deprecation track)

> Reference: Microsoft Learn — *Azure Data Lake Analytics task* (`/sql/integration-services/control-flow/azure-data-lake-analytics-task`), *Azure Data Lake Analytics overview* (`/azure/data-lake-analytics/data-lake-analytics-overview` — archived), *`az dla job submit` reference* (`/cli/azure/dla/job`), retirement announcement (`https://azure.microsoft.com/updates/migrate-to-azure-synapse-analytics/`). Documented 2026-05-26 by catalog agent.

## Overview — and a hard truth

**Azure Data Lake Analytics (ADLA), and the U-SQL job model that runs on it, was officially retired on 29 February 2024.** Microsoft's published guidance is to migrate U-SQL workloads to Azure Synapse Analytics (Spark or dedicated SQL) or to Microsoft Fabric (Spark, Warehouse, or Pipelines). The `az dla` CLI commands are marked `Deprecated`. New ADLA accounts cannot be provisioned in any cloud (Commercial, Gov, China) — the resource provider `Microsoft.DataLakeAnalytics/accounts` is in a `Disabled` registration state for new tenants and `Migration` for any account still alive.

A U-SQL job is a script combining SQL-like declarative syntax (`EXTRACT`, `SELECT`, `OUTPUT`) with embedded C# (user-defined functions / extractors / outputters / processors / reducers / appliers / combiners). The script compiles to a **vertex execution graph**, with each vertex a distributed unit of work. Execution scales by **Analytics Units (AUs)** — a soft-allocated slice of CPU + memory. Jobs run via the ADLA `submit` REST verb against the legacy resource provider; data lives in either ADLS Gen1 (also EOL'd) or ADLS Gen2 with an ABFS shim.

**This spec exists to document parity goals for completeness and to define Loom's graceful deprecation path — not to encourage building a full ADLA editor.** Any team starting fresh should treat the U-SQL editor in Loom as a migration off-ramp, not a destination.

## U-SQL Job UX inventory (what a complete editor *would* expose)

### Page chrome
- Page title with job name · **Legacy** badge · **Migration recommended** banner with link to Synapse / Fabric migration doc
- Top action bar: **Submit job**, **Estimate AUs**, **View execution graph**, **Cancel job**, **Catalog explorer**, **Register assembly**

### Tab — Script
- Monaco editor with U-SQL syntax highlighting. Supports inline C# blocks (`DECLARE @x string = "value"`, `CREATE FUNCTION`, `USING System.Text.RegularExpressions;`)
- Language modes: `U-SQL` (default), `C# code-behind` (separate `.usql.cs` panel for partial-class extensions)
- Toolbar — file open / save / sample-snippet menu (extract CSV, joined OUTPUT, register assembly)

### Tab — Job configuration
| Control | Source |
|---|---|
| **AnalyticsUnits (AUs)** | number input, 1–250 (account-quota-bounded) |
| **Priority** | number input, 1–1000 (lower = higher) |
| **RuntimeVersion** | dropdown — `default`, `release/20180819`, custom |
| **CompileMode** | dropdown — `Full` (compile + run), `Semantic` (semantic check only), `SingleBox` (compile on local box) |
| **CompileOnly** | toggle — build vertex graph without executing |
| **Synchronous** | toggle — wait for terminal state vs return after submission |
| **Timeout** | number (seconds) |
| **JobName** | text |
| **Pipeline / Recurrence linking** | optional inputs — `pipelineId`, `pipelineName`, `pipelineUri`, `recurrenceId`, `recurrenceName`, `runId` (used to group runs from a parent orchestrator) |

### Tab — Catalog
A tree of databases → schemas → tables / views / functions / assemblies / procedures / TVFs / credentials registered in the ADLA catalog. Per-item: definition viewer, drop button, dependency lookup.

### Tab — Execution graph (post-submit)
Stage-by-stage DAG of vertices. Per stage: vertex count, data read, data written, AU·sec consumed, fail/retry counts. Click a vertex → detail pane with stdout/stderr from the C# code-behind, performance counters, runtime memory.

### Tab — Job history / runs
DataGrid of recent submissions: jobId · name · state (`New`/`Queueing`/`Preparing`/`Compiling`/`Queued`/`Running`/`Finalizing`/`Ended-Succeeded`/`Ended-Failed`/`Ended-Cancelled`) · start time · duration · AU·sec consumed · cost estimate · resubmit button.

### Right rail — Catalog + Files
- **Files** picker over the linked ADLS Gen1/Gen2 store (browse paths used in `EXTRACT FROM "..."` and `OUTPUT TO "..."`)
- **Variables** panel — `DECLARE` substitutions surfaced for parameterized runs

### AU Estimator dialog
- Runs the script with `compileOnly=true` against a small AU allocation, extracts vertex graph statistics, and recommends an AU number that minimizes cost per second. Open via **Estimate AUs**.

### Deprecation surfaces (mandatory)
- Persistent yellow `MessageBar` on every tab: *"Azure Data Lake Analytics was retired 29 February 2024. New accounts can't be provisioned. Migrate to Azure Synapse Analytics (Spark) or Microsoft Fabric."* with a "Convert this script" button.
- **Convert this script** action — heuristic translator that emits a Synapse Spark notebook (PySpark) or a Fabric Lakehouse notebook draft. Rough translation only; user must validate.

---

## What Loom has today

Loom's `UsqlJobEditor` (`apps/fiab-console/lib/editors/azure-services-editors.tsx` line 1371) is **D-grade**:

- Renders the FabricItem chrome with a small ribbon (`Submit job`, `Estimate AUs`, `Register assembly`, `Catalog` — all label-only, **no click handlers**)
- A static `<textarea>` with a hard-coded sample U-SQL snippet (`@orders = EXTRACT … OUTPUT @agg TO "/curated/customer_revenue.csv"`)
- Three decorative badges: `ADLA · East US`, `AUs: 10`, `Legacy (warning)`
- A caption: *"Submit to ADLA account · estimated 8 AU·s · ~$0.04"*
- **Zero backend wiring** — no `/api/items/usql-job` POST, no REST call, no catalog enumeration

This is a textbook vaporware violation per `.claude/rules/no-vaporware.md`: pre-configured UI values that look like real data but aren't, buttons with no click handler, editor that reads from a hard-coded string instead of a backend. The only redeeming label is the `Legacy` badge, which honestly signals the underlying service state.

## Gaps for parity

Recommended path: **do not pursue full parity. Pursue graceful deprecation.** The full parity gap list (for completeness):

1. **Backend wiring** — there is none. Would need a Loom `/api/items/usql-job/[id]` POST that calls the ADLA `Job_Build` / `Job_Create` REST verbs against `https://{account}.azuredatalakeanalytics.net/Jobs/{jobId}?api-version=2017-09-01-preview`. This is build-time blocked because new ADLA accounts cannot be provisioned in any sub.
2. Monaco editor with U-SQL grammar (no published TextMate grammar from Microsoft — community grammars exist but are unmaintained).
3. Job configuration form (AUs, priority, runtime, compile mode, etc.) — straightforward UI work.
4. Catalog browser — `GET https://{account}.azuredatalakeanalytics.net/catalog/usql/databases` + nested REST. Service still responds for legacy accounts.
5. Execution graph viewer — would need `Job_GetStatistics` and a custom DAG renderer; very expensive to build.
6. Job history grid — `Job_List` REST.
7. ADLS file picker — already covered by the broader Loom storage editors; just wire as a shared component.
8. **Convert-to-Spark** translator — the only gap that genuinely matters. Should ship even in the deprecation path.

## Recommended path: Graceful deprecation (preferred)

Rebuild `UsqlJobEditor` as a **migration assistant**, not a job submitter:

1. **Drop the fake submit/estimate buttons.** Replace with `Convert to Synapse Spark notebook` and `Convert to Fabric Lakehouse notebook`.
2. **Keep the Monaco textarea**, populated from a real Cosmos-stored item body (the user's existing U-SQL script, pasted in for migration), not a hard-coded string.
3. **Banner first.** Mount a Fluent UI `MessageBar` with `intent="warning"` at the top: full retirement notice + link to the Microsoft migration guide + tracked Loom ticket.
4. **Translator action** — emit a best-effort Python/PySpark equivalent: `EXTRACT … FROM "/path/*.csv" USING Extractors.Csv(skipFirstNRows: 1)` → `spark.read.option("header","true").csv("abfss://…/path/*.csv")`; `OUTPUT … TO "/path/out.csv" USING Outputters.Csv` → `df.write.option("header","true").csv("abfss://…/out.csv")`. C# UDFs are flagged as "manual review required".
5. **No live ADLA submission path.** Even if a legacy account survives in some tenant, Loom won't carry the maintenance burden.
6. **Remove `usql-job` from the default catalog after one release cycle**, behind a `LOOM_INCLUDE_LEGACY_ITEMS` feature flag. The migration assistant lives on as a one-shot tool, not a catalog item.

## Backend mapping

| ADLA concept | Loom backend (deprecation path) |
|---|---|
| Persist user's U-SQL script for migration | **NEW** `PUT /api/items/usql-job/[id]` — body stored in Cosmos as `{ script: string, notes: string }`. No live ADLA call. |
| Convert to Spark | **NEW** `POST .../[id]/convert` `{ target: 'synapse-spark' \| 'fabric-lakehouse' }` → returns a draft notebook JSON the user can save as a new Loom Notebook item |
| Live submit / estimate / catalog | **EXPLICITLY NOT IMPLEMENTED.** Stub returns 410 Gone with body `{ ok: false, error: "Azure Data Lake Analytics was retired 2024-02-29. Use the Convert to Spark action." }`. |

If the project decides to pursue full parity anyway (not recommended), wiring would target the legacy ADLA REST endpoints under `https://{account}.azuredatalakeanalytics.net/...` — Microsoft still serves these for existing accounts but documents no SLA, no new features, and no Gov-cloud availability for new accounts.

## Required Azure resources

- **None for the deprecation path.** Cosmos for script storage is already in bicep.
- **For (unsupported) full parity**: a surviving legacy ADLA account — cannot be deployed from bicep because `Microsoft.DataLakeAnalytics/accounts` is no longer accepting new resources. This alone makes the no-vaporware rule's "bicep must deploy it from scratch" gate impossible to satisfy. A+ grade is unreachable.

## Estimated effort

**1 session (~2h) for graceful deprecation.** Strongly recommended.

- Rip out fake ribbon actions.
- Add `MessageBar` retirement banner.
- Wire `PUT /api/items/usql-job/[id]` with script persistence.
- Implement the `convert` heuristic translator (Python output, ~150 LOC of regex + tokenizer rules).
- Add a UAT case that submits a representative U-SQL snippet and checks the Spark output is syntactically valid Python.
- Move `usql-job` behind the `LOOM_INCLUDE_LEGACY_ITEMS` flag in the catalog manifest.

**Full parity effort (not recommended):** 8–12 sessions, blocked at deployment-validation step. Grade ceiling: **D** (because bicep can't provision the backing service). Drops to **F (vaporware)** the moment any contributor wires a fake submit handler.

The honest grade path here: Loom U-SQL today is **D / vaporware-adjacent**. Deprecation rebuild lands it at **B (functional migration tool, no backing legacy service required)**. There is no realistic A path because the underlying Azure service no longer accepts new deployments.
