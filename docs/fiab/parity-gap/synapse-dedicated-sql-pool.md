# Parity gap — `synapse-dedicated-sql-pool`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure Synapse Studio → SQL pools → query editor.
> Loom route: `https://<your-console-hostname>/items/synapse-dedicated-sql-pool/new`.
> Editor source: `apps/fiab-console/lib/editors/synapse-sql-editors.tsx` (lines 290-479).

## Live-browser validation status

Attempted full 4-phase live capture. **Loom MSAL session was expired during this run** — every authenticated route redirected to `/auth/login`. Validator captured the redirect at `temp/parity/loom-auth-gate.png`. Per parity-validation-standard, when live capture is blocked, the validator falls back to source-of-truth code review against the parity contract. Findings below are based on direct read of the deployed source (matches commit `894ee602` on `access-patterns-vpn-agw-fd`, which is the branch the deployed `loom-console--0000075` image was built from).

## Phase 3 — gap matrix vs Synapse Studio

| # | Fabric / Synapse Studio element | Loom present? | Severity |
|---|---|---|---|
| 1 | T-SQL editor with Monaco + IntelliSense (`SELECT`/`FROM`/`JOIN`/CTE completion), error squiggles, schema-aware autocomplete from `INFORMATION_SCHEMA` | **MISSING** — uses a plain `<textarea>` (synapse-sql-editors.tsx:467-473). No Monaco import in the file, no `@monaco-editor/react` dep in `apps/fiab-console/package.json`. The `editor` CSS class is decorative (line 36-39: just `font-family: Consolas`). | **BLOCKER** |
| 2 | Schema tree (Schemas → Tables → Columns) with row-count + table preview on click | Present (lines 384-422) — real schema fetch via `/api/.../schema`, real row counts, click-to-template SELECT | OK |
| 3 | Result grid with sortable columns + filter + cell-formatting + export CSV | Partial — renders results in a Fluent `<Table>` (lines 96-126) but no column sort, no filter, no CSV export. Cells are plain `formatCell()` stringification. | MAJOR |
| 4 | Chart View toggle (line / bar / pivot) on result set | MISSING — no chart code anywhere in the file | MAJOR |
| 5 | Pool state badge (Online / Paused / Resuming) + Resume + Pause buttons | Present (lines 428-450) — real ARM REST, polls every 5s while resuming | OK |
| 6 | Honest MessageBar gate when pool is Paused / Resuming | Present (lines 451-466) | OK |
| 7 | Query "Estimate cost" / DWU consumed estimate | MISSING — ribbon claims "Estimate cost" action (line 261) but no handler is wired | MINOR (ribbon vapor) |
| 8 | "Workload management" panel (resource classes, classifiers) | MISSING — ribbon action present, no impl | MINOR (ribbon vapor) |
| 9 | "Geo backup" status + restore | MISSING — ribbon action present, no impl | MINOR (ribbon vapor) |
| 10 | Status bar at the bottom of editor (Connected as <upn> / DB / row count) | MISSING — no `<StatusBar>` component rendered | MINOR |
| 11 | Query history / saved queries pane | MISSING | MINOR |
| 12 | Multi-tab query editor (open multiple queries side-by-side) | MISSING | MINOR |

## Phase 4 — functional click probe (source-trace, not live)

| Control | Source impl | Live behavior |
|---|---|---|
| **Run** button | `run()` (line 352-373) — `POST /api/items/synapse-dedicated-sql-pool/{id}/query` with `{sql}`. Real TDS. Handles 409 → pool not Online. | Real — assuming backend env (`LOOM_SYNAPSE_WORKSPACE` + PE + MI role) is configured |
| **Resume** button | `resume()` (line 332-341) — `POST /api/items/.../resume` + polls every 5s | Real |
| **Pause** button | `pause()` (line 343-350) — `POST /api/items/.../state {action: 'pause'}` | Real |
| **Refresh** button | `refreshState() + refreshSchema()` (line 440) | Real |
| Schema tree leaf click | `setSqlText('SELECT TOP 100 * FROM [schema].[table]')` (line 411) | Real — local state update |
| Ribbon "New SQL query" / "Estimate cost" / "Workload mgmt" / "Geo backup" / "Permissions" | No `actions: [...].onClick` handler in `RibbonTab` shape. These render as decorative pills only. | **DEAD** — silently broken buttons |

## Grade

**C** — primary action (Run) is real-REST against TDS. Pool state lifecycle (Resume / Pause / poll / honest gate) is genuinely Fabric-parity quality. But the editor itself is a `<textarea>` not Monaco (BLOCKER per parity contract section 1), result grid has no chart toggle / sort / export (MAJOR), no status bar, no query history, and 4 ribbon buttons are silently dead (multiple BROKEN per Phase 4).

Build phase MUST replace the textarea with `@monaco-editor/react` + `sql` language mode + a `setModelMarkers`-based error squiggle pipeline before this can grade above C. Bonus work: schema-aware completion provider seeded from the same `/api/.../schema` call the tree already makes.

