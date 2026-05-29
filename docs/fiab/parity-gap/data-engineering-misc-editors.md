# Parity Gap — Data Engineering misc editors (v2 validator, 2026-05-26)

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


> Editors: `mirrored-database` / `dataflow` / `copy-job` / `spark-job-definition` / `environment` / `dbt-job`
> Sources:
> - `apps/fiab-console/lib/editors/mirrored-database-editor.tsx` (321 lines)
> - `apps/fiab-console/lib/editors/dataflow-gen2-editor.tsx` (275 lines)
> - `apps/fiab-console/lib/editors/phase2-misc-editors.tsx` (925 lines)
> Validator state: source-grade audit. Phase 4 live click blocked by MFA expiration.

## Critical request checks

- **"Mirrored Database / Dataflow / Copy Job: do they have configuration wizards or just JSON forms?"**
  - **Mirrored Database**: Has a real **8-source-type card-picker wizard** (lines 35-44, 240-248). DialogTrigger opens a Dialog with displayName, source-type card grid (Azure SQL DB / SQL MI / PostgreSQL / Cosmos / Snowflake / SQL Server 2025 / MSSQL 2016-2022 / Open mirroring), server, database. Real Fabric REST POST builds the mirroring.json definition with InlineBase64 encoding. **B-grade wizard.**
  - **Dataflow Gen2**: Has a **minimal create wizard** — Dialog with just a `displayName` Input. The Power Query M editor is a `<textarea>` (no wizard for source/sink/transforms). C-grade.
  - **Copy Job**: Has a **2-form layout** — Source + Sink panels with Linked Service / Type dropdown / Query / Sink Table inputs + a Column Mappings `<textarea>` (JSON). Not a wizard but a real form. C-present.

## 1. `mirrored-database`

| Element | app.fabric.microsoft.com → Mirrored Database | Loom | Severity |
|---|---|---|---|
| Mirror list (tree on left) | Yes | `Tree` with mirrors per workspace | present |
| **Create wizard** (source type / server / database) | Modal with source-type tiles | **8-source-card grid ✓** in Dialog | **A-present** ✓ |
| Workspace picker | Top combo | Fluent Select wired | present |
| Status badge (Running/Stopped/etc.) | Pill | `statusColor` helper → success/warning/severe/informative | present |
| **Tables replication metrics** (Schema / Table / Status / Rows / Bytes / Last sync) | Grid | 6-col Table | **B-present** ✓ |
| Start / Stop / Refresh buttons | Toolbar | `Play20Regular` / `Pause20Regular` / `ArrowSync20Regular` Buttons, all wired (lines 147-159, 229) | **B-present** ✓ |
| Delete | Bin button | `Delete20Regular` Button wired (line 186) with confirm() | present |
| Mirroring landing zone (target lakehouse) | Selectable | Hardcoded `MountedRelationalDatabase + Delta` | MINOR |
| Per-table replication detail (CDC LSN, schema drift) | Per-table drill | absent | MAJOR |
| Source-credential wizard | Connection string + auth method picker | absent — relies on Fabric's data-source connection management | MAJOR |
| Mirror replay / Reseed | Action | absent | MINOR |

**Grade**: **B** — Best create-wizard in the editor catalog. Real Fabric REST POST, list+detail+metrics+start/stop/delete all wired. Missing per-table drill and source-credential wizard but the core works end-to-end.

## 2. `dataflow`

| Element | app.fabric.microsoft.com → Dataflow Gen2 | Loom | Severity |
|---|---|---|---|
| Dataflow list (left tree) | Yes | `Tree` | present |
| **Create dialog** | Multi-step wizard (Get data → Power Query → Destination) | **Single-input dialog (displayName only)** | **MAJOR** — not a real wizard |
| Workspace picker | Top | Fluent Select | present |
| **Power Query M editor** | Power Query Online (Monaco-equivalent in iframe) | **`<textarea>`** | **BLOCKER** ❌ |
| Source picker (200+ connectors) | Sidebar gallery | absent | **BLOCKER** for parity |
| Sink picker (Lakehouse / Warehouse / KQL / SQL DB) | Sidebar | absent | **BLOCKER** |
| Step/transform pane | Right side | absent | **BLOCKER** |
| Schema view | Bottom pane | absent | **BLOCKER** |
| Refresh button + status | Top | `Refresh20Regular` Button wired (line 155) | present |
| Save | Top | `Save20Regular` Button wired (line 141), dirty-state badge | present |
| Delete | Bin | wired | present |
| Refresh history | Pane | absent | MAJOR |
| Schedule | Pane | absent | MAJOR |

**Grade**: **D** — list + create-with-name + save + refresh + delete all wired against real Fabric REST, but the M-code editing surface is a `<textarea>` and there's no source/sink/transforms UI. The Power Query Online experience cannot be replicated as a textarea.

## 3. `copy-job`

| Element | ADF Studio → Copy data | Loom | Severity |
|---|---|---|---|
| Source linked service / type / query | Form with picker + Monaco SQL | 2 Inputs + 1 native Dropdown + `<Textarea>` (Fluent) | C-present |
| Sink linked service / type / table | Form | 2 Inputs + 1 native Dropdown + 1 Input | C-present |
| **Column mappings editor** | Visual schema mapper with drag-drop | **`<textarea>` for JSON array** | **BLOCKER** ❌ |
| Run now | Toolbar | `Run now` Button wired (line 583) | **B-present** ✓ |
| Save | Toolbar | `Save` Button wired (line 576) | present |
| Recent runs table | Grid | 6-col Table with `fmtTs` and Badge color by status | present |
| Run detail (per-activity output, error rows) | Drill in | absent | MAJOR |
| Linked Service picker (live ARM list) | Combo | plain text Input — user must type name exactly | **MAJOR** |
| Source type ↔ Sink type compatibility matrix | UI hides incompatibles | absent | MINOR |
| Mapping rule wizard (auto-map by name / by position) | Top toggles | absent | MAJOR |
| Schedule / Triggers | Linked pane | absent | MINOR |

**Grade**: **C** — Run + Save + runs table all wired. Forms exist for source/sink. JSON mappings editor is the BLOCKER for parity with ADF visual mapper. Linked-service inputs being free text is fragile.

## 4. `spark-job-definition`

| Element | app.fabric.microsoft.com → Spark Job Definition | Loom | Severity |
|---|---|---|---|
| Main file / class / args / Spark conf | Form | Input + Input + Textarea + raw `<textarea>` for conf JSON | C-present |
| Spark pool picker | Combo (live from workspace) | Fluent Dropdown wired with `usePoolList()` (live ARM) | **B-present** ✓ |
| Submit (Livy batch) | Top button | `Submit Spark batch` Button wired (line 206-220), calls `/api/items/spark-job-definition/[id]/submit` | **B-present** ✓ |
| Save spec | Toolbar | wired | present |
| Recent runs table | Grid with status + appId + duration | 6-col Table with state/result badges | present |
| Run logs (driver / executor stdout) | Drill | absent | **MAJOR** |
| Spark UI link | Per-run | absent | MAJOR |
| Resources tab (lib files, JARs, eggs) | Side rail | absent | MAJOR |
| Default Lakehouse setting | Top combo | absent | MINOR |
| Run history persistence (>20 runs) | Yes | top 20 only (`?size=20`) | MINOR |

**Grade**: **C** — Submit + Save + pool picker + runs table all wired. Spark conf is a JSON `<textarea>`. No logs drill, no Spark UI link.

## 5. `environment`

(Source: phase2-misc-editors.tsx line 347)

| Element | app.fabric.microsoft.com → Environment | Loom | Severity |
|---|---|---|---|
| Tab bar (Requirements / Resources / Settings) | TabList | TabList (3 tabs) | present |
| **requirements.txt editor** | Monaco with pip-package autocomplete | `<Textarea>` (Fluent) | **MAJOR** — no Monaco |
| Spark conf JSON | Form | `<textarea>` (raw, JSON) | MAJOR |
| Custom JARs / files list | Upload widget | `<Textarea>` (text list) | MAJOR — no upload |
| Apply to pool | Top button | wired | present |
| Save | wired | wired | present |
| Status (publishing / ready) | Pill | absent | MINOR |
| Versions | Side panel | absent | MAJOR |

**Grade**: **C** — wired to real Fabric ARM, but pure form (no Monaco, no upload), thin parity vs the Fabric Environment editor.

## 6. `dbt-job`

| Element | Fabric dbt jobs (preview) / dbt Cloud | Loom | Severity |
|---|---|---|---|
| Repo URL + Branch + Target | Form | 3 Inputs | present |
| Databricks cluster id | Input | `<Input>` (plain text, not a picker) | **MAJOR** — no live cluster picker |
| **Model selection (--select)** | Textbox or selection from manifest | `<Textarea>` newline-separated | C-present |
| **Override commands** | `<Textarea>` newline-separated | `<Textarea>` newline-separated | present |
| profiles.yml | YAML editor | `<Textarea>` (informational only) | C-present |
| **Run dbt** | Top button | `Run dbt` Button wired (line 795) — creates/updates Databricks job + runs it | **B-present** ✓ |
| Save | Toolbar | wired | present |
| Run history | Grid | 6-col Table with `JobRunDTO` | present |
| Logs per run | Drill | absent | MAJOR |
| Manifest.json browse / model graph | Pane | absent | **MAJOR** (defining dbt feature) |
| Schedule / Triggers | Pane | absent | MAJOR |
| Cluster picker (live from Databricks API) | Dropdown | text input | MAJOR |

**Grade**: **C** — Run dbt works end-to-end via Databricks. Forms + run history wired. No model graph, no logs drill, no cluster picker. Honest scaffold.

## Phase 4 (click-every-button)

Source-grade `onClick` count:

| Editor | Wired buttons | Dead ribbon labels |
|---|---|---|
| mirrored-database | 5 (Refresh / Create / Start / Stop / Delete) | ~5 ribbon labels |
| dataflow | 4 (Refresh / Create / Save / Refresh / Delete) | ~4 ribbon labels |
| copy-job | 3 (Run / Save / Refresh runs) | ~4 ribbon labels |
| spark-job-definition | 3 (Submit / Save / Refresh runs) | ~3 ribbon labels |
| environment | ~3 (Save / Apply to pool / per-tab) | ~3 ribbon labels |
| dbt-job | 3 (Run / Save / Refresh) | ~3 ribbon labels |

Pattern: every editor has ~3-5 wired primary buttons in the action toolbar, AND ~3-5 dead ribbon labels at the top. The ribbon labels look like real buttons (because they're rendered in the same chrome) — Phase 4 verification would mark all dead ribbon labels as BROKEN.

## Summary

| Editor | Grade | Reason |
|---|---|---|
| mirrored-database | **B** | Real 8-source create wizard + start/stop/delete + tables metrics; missing per-table drill |
| dataflow | **D** | `<textarea>` for Power Query M (BLOCKER), no source/sink/transforms UI |
| copy-job | **C** | Run + Save + runs table wired; JSON mappings textarea (BLOCKER for ADF parity) |
| spark-job-definition | **C** | Submit + pool picker + runs table wired; JSON-textarea Spark conf, no logs |
| environment | **C** | Wired to ARM; no Monaco, no upload widget, no versions |
| dbt-job | **C** | Run dbt via Databricks wired; no manifest browse, no logs drill, free-text cluster |
