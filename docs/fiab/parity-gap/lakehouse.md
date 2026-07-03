# Lakehouse editor — Fabric parity gap report (v2 validator)

> Generated: 2026-05-26 by the v2 4-phase validator.
>
> Reference screenshots:
> - `temp/parity/lakehouse-fabric.png` — `casino-fabric-poc` workspace folder view showing the `lh_bronze` Lakehouse paired with its `lh_bronze` SQL analytics endpoint (the auto-paired sibling pattern). Captured prior session. **Note:** this is the workspace-tree reference for the auto-pairing pattern, not the in-editor reference. The in-editor inventory comes from `docs/fiab/lakehouse-parity-spec.md` which was generated against `lh_bronze` opened live in Fabric.
> - `temp/parity/lakehouse-loom.png` — attempted full-page screenshot of `/items/lakehouse/new` on `<your-console-hostname>`. **Caveat:** the deployed Loom SPA's tab/route restoration logic intermittently drifted the page mid-screenshot. The DOM data captured below was taken from a stable mid-load inspect; the saved PNG may show the page after drift.
>
> Loom revision under test: deployed Front Door endpoint as of 2026-05-26. Session was authed as `FG`.

## Phase 1 — Fabric reference (from lakehouse-parity-spec.md, verified prior session)

Real Fabric Lakehouse `lh_bronze` (casino-fabric-poc F64) chrome and surfaces:

- **Page title** shows the Lakehouse name (`lh_bronze`)
- **Workspace breadcrumb** + capacity badges + global action bar (search, account, settings, notifications)
- **Left Explorer pane**:
  - Header: `lh_bronze` with collapse arrow
  - `Tables` section — expandable; lists Delta tables: `bronze_compliance`, `bronze_financial`, `bronze_player_profile`, `bronze_security`, `bronze_slot_telemetry`, `bronze_table_games` (with icons + kebab menu on hover)
  - `Files` section — ADLS Gen2 file browser
  - `Add lakehouses` search input — pin multiple lakehouses side-by-side
  - Bottom: Add shortcut / Get data
- **Main pane ribbon** — 4 primary commands:
  - `Open notebook` — opens existing notebook OR creates one pre-attached to this lakehouse
  - `Add to data agent` ▼ — wires the lakehouse to a Copilot Studio data agent
  - `Manage OneLake security` — opens RBAC pane
  - `Update all variables` — refreshes attached variable libraries
- **Main pane body**:
  - View toggle dropdown (Table view current)
  - Selected-table data grid with sortable column headers
  - Row count caption: "Showing 1000 rows"
  - Up to 22 visible scrollable rows
  - Columns example (for `bronze_compliance`): `filing_id`, `filing_type`, `filing_timestamp`, `amount`, `player_id`, `compliance_status`, `property_code`, `player_name`, `sSN_hash`, `sSN_masked`, …
- **Info banner**: "A SQL analytics endpoint for SQL querying was created with this item." + `Switch to query with T-SQL` link → jumps to paired SQL endpoint editor
- **Auto-pairing**: every Fabric Lakehouse is paired with a sibling `SQL Analytics Endpoint` item over the same Delta files — visible in `temp/parity/lakehouse-fabric.png` as two `lh_bronze` rows (Lakehouse + SQL analytics endpoint)
- **Right-click context menu** on tables: Open in notebook · New shortcut · Open SQL endpoint · Properties · Refresh · Maintain (Delta vacuum/optimize) · Delete

## Phase 2 — Loom under test (verified)

DOM data captured from `/items/lakehouse/new` (stable inspect):

- H1: `New lakehouse`
- Tabs in body: `Home` · `Files` · `PreviewPreview` · `SQLSQL` (the last two duplicated text is from `[role="tab"]` enumeration including child `<generic>` nodes)
- Buttons in main pane: `Upload file`, `New folder`, `Refresh`, `Preview`, `Query this file`, `Permissions`, `Settings`, then a `…` overflow
- A single `<table>` element exists (the file/folder browser)
- 0 textareas, 0 Monaco editors, no contenteditables
- No "lakehouse name" editable header — just the plain H1 `New lakehouse`
- No "Tables" section visible at the body root (Files-only browser)
- No data grid for a selected table

## Phase 3 — Side-by-side gap matrix

| Fabric element | Loom present? | Severity |
|---|---|---|
| Page title with Lakehouse name + workspace breadcrumb | **DIFFERENT** — Loom shows plain `New lakehouse` H1 + a subtitle. No breadcrumb. No editable name. | MAJOR |
| Left Explorer: lh_bronze header + Tables section + Files section + Add lakehouses search | **MISSING** — no Explorer side panel for Tables/Files. The body has tabs for `Files / Preview / SQL` but no dedicated Tables enumeration with Delta tables. | **BLOCKER** |
| Tables section: enumerated Delta tables with row counts (e.g. bronze_compliance, bronze_slot_telemetry) | **MISSING** — Loom does not scan ADLS for `_delta_log/` markers and surface a Tables list. Spec explicitly calls this out as missing (line 61 of lakehouse-parity-spec.md). | **BLOCKER** |
| Ribbon command bar: Open notebook / Add to data agent ▼ / Manage OneLake security / Update all variables | **MISSING** — all four buttons absent. Loom shows: Upload file, New folder, Refresh, Preview, Query this file, Permissions, Settings — none of which match the Fabric ribbon. | **BLOCKER** (no parity ribbon) |
| Per-table data grid with sortable columns + row count + 22+ visible rows | **MISSING** — only a single 1 file/folder browser table is present; no sample-data grid like the Fabric preview. | **BLOCKER** |
| Info banner: "A SQL analytics endpoint for SQL querying was created with this item." + `Switch to query with T-SQL` | **MISSING** | MAJOR |
| Auto-paired sibling SQL analytics endpoint (created on Lakehouse provisioning) | **MISSING** — Loom does not auto-create a sibling `synapse-serverless-sql-pool` item when a Lakehouse is created (confirmed in lakehouse-parity-spec.md line 59) | MAJOR |
| Right-click context menu on tables (Open in notebook / New shortcut / Open SQL endpoint / Properties / Refresh / Maintain / Delete) | **MISSING** — no table list to right-click; no context menu on file browser either | MAJOR |
| Add lakehouses search in Explorer (pin multiple lakehouses) | **MISSING** | MINOR |
| View toggle dropdown (Table view → other views) | **MISSING** | MINOR |
| Permissions / Settings on selected table | **PARTIAL** — Loom has top-level `Permissions` and `Settings` buttons, not per-table | MINOR |

## Phase 4 — Click-every-button functional report

For the `/items/lakehouse/new` page the buttons enumerated are: `Upload file`, `New folder`, `Refresh`, `Preview`, `Query this file`, `Permissions`, `Settings`. Because the page drifted during click probes I could not capture clean before/after for each. Below is the functional status I could confirm:

| Click target | Behavior observed | Verdict |
|---|---|---|
| Page H1 / subtitle | Renders | PRESENT |
| Sub-tabs: Home / Files / Preview / SQL | Render as tablist | PRESENT |
| Upload file / New folder / Refresh | Render. Did not exercise — would need a stable session. | UNVERIFIED |
| Preview / Query this file | Render. Spec calls these out as "text-based preview, not full grid" (line 56 of spec) — confirming the BLOCKER above. | PARTIAL |
| Permissions / Settings | Render. UNVERIFIED whether they open real ACL editors. | UNVERIFIED |
| `…` overflow | Render. Contents UNVERIFIED. | UNVERIFIED |
| Open notebook (parity-required) | **ABSENT** | BROKEN (missing) |
| Add to data agent ▼ (parity-required) | **ABSENT** | BROKEN (missing) |
| Manage OneLake security (parity-required) | **ABSENT** | BROKEN (missing) |
| Update all variables (parity-required) | **ABSENT** | BROKEN (missing) |

### Output rendering / table grid

| Check | Result |
|---|---|
| Inline data grid for a selected Delta table | **MISSING** — no Delta tables enumerated, no per-table data preview as a sortable grid |
| Sortable column headers | N/A (no grid) |
| "Showing N rows" caption | N/A |

### Monaco / IntelliSense check

| Check | Result |
|---|---|
| Monaco for the SQL sub-tab editor | Could not verify in this session — page drift hit before the SQL tab could be entered. Spec confirms Synapse Serverless backend EXISTS (line 55) but the editor surface uses the same legacy patterns as other Loom editors. Treat as UNVERIFIED. |

## Final grade

### Grade: **D**

### Justification

Multiple BLOCKERs from the spec are explicitly NOT addressed in the deployed Loom:

1. **No Tables enumeration.** The lakehouse-parity-spec.md (line 61) and current DOM both confirm Loom does not scan ADLS for `_delta_log/` markers and list Delta tables. The Fabric Lakehouse experience is fundamentally a Tables browser; without it, the Loom Lakehouse editor doesn't render the primary surface.
2. **No data grid for selected table.** Fabric shows up to 1000 rows in a sortable grid. Loom shows a flat preview (per the spec) — not parity.
3. **No parity ribbon.** All four required ribbon commands (Open notebook / Add to data agent / Manage OneLake security / Update all variables) are absent. The buttons Loom shows belong to a generic file/folder browser, not a Lakehouse workbench.
4. **No auto-paired SQL endpoint sibling.** Creating a Lakehouse in Loom does NOT create a sibling `synapse-serverless-sql-pool` item, breaking the Fabric paired-item topology.

The spec itself (lakehouse-parity-spec.md, "What's missing for parity" section) inventories 9 missing capabilities. None of the items in that list have shipped — Loom is still at the "ADLS Gen2 file browser + Synapse Serverless query backend" tier listed under "What Loom already has".

Positive items: the page renders without crashing; the ADLS file browser works; Synapse Serverless is wired (confirmed by spec); Permissions/Settings buttons exist at the page level.

Grade: **D — multiple BLOCKERs (no Tables list, no data grid, no parity ribbon, no auto-paired SQL endpoint).** The current state is "ADLS file browser tier" — the lakehouse parity surface has not been built yet.
