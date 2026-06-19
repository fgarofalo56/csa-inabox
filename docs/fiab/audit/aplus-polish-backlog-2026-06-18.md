# CSA Loom — A+ Polish Backlog (2026-06-18)

Synthesized from five per-area UI audits (Admin portal; Monitor + Governance + Security;
Unified/OneLake/Lineage catalog; Warp/Deploy-planner/Org-Visuals/item-editors; Learning Hub/
Copilot/RTI/Marketplace/Connections/Activator/Browse/Workspaces).

This is a **polish** backlog — every surface already renders and calls a real backend
(per `no-vaporware.md` / `no-fabric-dependency.md`). The gap to **A+** is consistency of the
shared primitives, accessibility labels, design-token discipline, contextual help, and tests.

The single biggest lever is that the two cross-cutting primitives **already exist** and are
**already correct enough** — they just are not used everywhere:

- `lib/components/ui/loom-data-table.tsx` — `LoomDataTable` already does sort + per-column
  filter (text/select/date) + resize + sticky header + loading/empty states. Many tables
  either bypass it (legacy Fluent `<Table>`) or use it without enabling `sortable`/`filterable`.
- `lib/components/empty-state.tsx` — `EmptyState` exists (icon + title + body + CTAs) but is
  bypassed by bare `Caption1`/`Spinner` empties in many panes, and itself hardcodes px.
- `lib/components/ui/admin-tab-styles.ts` — shared `makeStyles` atoms exist (`dialogGrid`, etc.)
  but panes still inline raw px instead of importing them.

Fix the primitives once, adopt them everywhere → most surfaces jump a full grade.

---

## 1. Top cross-cutting wins (ordered by impact × reach)

### W1 — `aria-label` sweep on every icon-only button (a11y) — REACH: ~130+ buttons, all areas
Icon-only `<Button icon={…} />` (Open, Refresh, Add, Delete, Edit, Copy, Export, Dismiss) across
admin, monitor, governance, security, catalog, panes, and canvases lack `aria-label`/`title`.
This is a WCAG 2.1 AA failure with one-line fixes, and the single highest-reach item.
- Adopt the existing good pattern (`app/catalog/catalog/*` uses `aria-label="Request access"` on
  the `Key16Regular` button) repo-wide.
- Use templated labels: `aria-label={\`Delete ${item.name}\`}`, `aria-label="Open in Azure portal"`.
- Targets: admin (capacity/scaling/audit-logs/users/permissions/domains toolbars + cells),
  `lib/components/admin-security/{audit-panel,purview-panel,mip-panel}.tsx`, monitor toolbars,
  `lib/components/warp/warp-transform-canvas.tsx` Handles (`aria-label="input"/"output"`),
  deploy-planner status chips (`Circle12Regular` → `aria-label="Using defaults"`).
- Add a Vitest "no unlabeled icon button" lint test (render + assert every `button` with no
  text node has an `aria-label`) to prevent regression.

### W2 — `LoomDataTable` adoption + fix the sticky z-index bug (table) — REACH: ~25 tables
Two parts, both high-reach:
1. **Fix the shared bug once:** in `lib/components/ui/loom-data-table.tsx` the `filterRow` is
   `position:sticky; top:0; zIndex:1` while `headerRow` is `zIndex:2` — the filter row slides
   under the header on scroll. Resolve their stacking (they don't overlap vertically; give the
   filter row its own sticky offset or raise it) and add a `aria-live="polite"` caption
   "Showing N of M items" when any filter is active. **Every table benefits from one edit.**
2. **Migrate the stragglers + turn on the features:** replace the legacy Fluent `<Table>` in
   `lib/components/admin-security/audit-panel.tsx` and the hand-rolled audit log in
   `lib/components/catalog/permission-matrix.tsx` with `LoomDataTable`; set `sortable:true` +
   `filterable:true` on list-view columns that currently omit them (`/learn` guides,
   `/copilot` sessions, `/realtime-hub` streams, `/api-marketplace` operations, monitor tables);
   set explicit `width` on federated-search columns.

### W3 — Shared loading **skeleton** for tables + trees (empty-loading) — REACH: ~15 surfaces
Tables/trees flip from a bare `<Spinner>` straight to full data (jarring, layout shift). Add a
`skeleton?: boolean` (or `LoomDataTableSkeleton`) to `LoomDataTable` that renders placeholder
rows matching the column schema, and a `TreeSkeleton` for the OneLake/lakehouse table trees.
- Targets: all admin tables, monitor tables, `app/onelake/page.tsx` TablesTab tree,
  `lib/panes/lakehouse.tsx` table explorer, `lib/components/catalog/lineage-canvas.tsx` graph,
  `/data-agent` agent rail.

### W4 — Route every empty state through `EmptyState` (+ tokenize it) (empty-loading) — REACH: ~20 surfaces
`EmptyState` exists but is bypassed by bare `Caption1` empties, and it hardcodes px
(`padding:'48px 24px'`, `gap:'16px'`, illustration `88px`, `borderRadius:'8px'`). Two steps:
1. Tokenize `lib/components/empty-state.tsx` (→ `tokens.spacingVerticalXXL`/`spacingHorizontalL`,
   `tokens.borderRadiusLarge`) so the shared atom is itself A-grade.
2. Replace bare empties with `EmptyState` (icon + title + body + CTA): catalog tree-browser
   `(empty)` text (`lib/components/catalog/tree-browser.tsx:272`), federated-search zero-results,
   lineage "No lineage edges", security DLP/audit/restrict-access empties,
   `/data-agent`, `/business-events` event-types, warp/warehouse "no rows returned".

### W5 — Shared `LearnPopover` / `HelpButton` pattern on every major surface (learn-help) — REACH: ~25 surfaces
The A+ rubric requires a Learn popup per surface; almost none exist. Build one reusable
`LearnPopover` (header `Info16Regular`/`Learning16Regular` button → `Popover`/`Drawer` with a
title, 2-3 bullet tips, and Learn links) fed from a per-surface `LEARNING_RESOURCES` array
(mirror the existing `lib/components/warp/warp-hub-content.tsx` resource shape).
- Targets: admin (capacity, batch-labeling, scaling…), `/governance` nav cards, monitor tables,
  all item panes (warehouse→T-SQL, lakehouse→Delta, notebook→Spark, semantic-model→XMLA,
  warp→visual-query, deploy-planner→architecture), catalog lineage/permissions/domains/details,
  `/learn` `/copilot` `/data-agent` tabs. Ground links via `microsoft_docs_search` per `ui-parity.md`.

### W6 — Spacing-token cleanup pass (raw px → Fluent tokens) (spacing-tokens) — REACH: ~250 literals
The most-repeated finding across every area: inline `style={{ marginTop:'4px', padding:'12px',
gap:'14px', fontSize:'12px' }}`, raw grid `minmax(180px…)`, and hardcoded colors (`#888`, `#fff`,
the warp `STEP_COLOR` map). Convert to `makeStyles` + `tokens.spacing*/fontSize*/borderRadius*`
and `shorthands`. Standardize the two recurring grids as shared atoms in `admin-tab-styles.ts`:
`statGrid` (`repeat(auto-fill, minmax(200px,1fr))`, `gap: spacingHorizontalL`) and a `cardSection`
(token border-top + `paddingTop: spacingVerticalM`).
- Highest-density files: `lib/components/admin/apim-*-pane.tsx` (~25 literals across 6 panes),
  `lib/components/warp/warp-transform-canvas.tsx` + `deploy-planner/deploy-plan-nodes.tsx`
  (~100 literals), `admin-security/*`, `monitor/monitor-pane.tsx`, `app/workspaces/page.tsx`
  chip/bulk-bar, `app/api-marketplace` drawer/code-block sizing.

### W7 — Sort-affordance + tile/list `ViewToggle` consistency (table/icons) — REACH: ~15 surfaces
Add a visible sort chevron + `cursor:pointer`/hover on sortable headers in `LoomDataTable`
(users can't tell columns are sortable today), and standardize one `ViewToggle` (tile ↔ list)
used by `/learn`, `/workload-hub`, `/browse`, OneLake — extend to monitor lists and admin
tables where space allows. Also: in OneLake list view render a single `LoomDataTable` with a
`Workspace` column instead of one table per workspace (enables cross-workspace sort/filter).

### W8 — Test coverage for the high-interaction surfaces (tests) — REACH: complex zero-coverage areas
The most complex interactive surfaces have zero/near-zero tests. Add Vitest + Playwright for:
- Warp canvas (`warp-transform-canvas.tsx`, 1099 lines): node add/delete, edge create,
  `compileGraph` SQL output, run/preview API, save to Cosmos.
- Deploy-planner UI (`deploy-planner-view.tsx`, ~1200 lines): palette drag-drop, node select,
  config update, cost calc, bicep export (utils already covered).
- Notebook pane: cell add/delete, language change, exec routing.
- Admin flows: capacity filter→DetailPane, scaling SKU change→cost preview→Apply, users role
  popover, audit-logs CSV export, permissions add-grant POST.
- Page E2E: `/learn` install dialog, `/connections` create/delete, `/workspaces` pin/bulk-delete,
  `/copilot` session open. Target ~60-70% on interactive workflows.

---

## 2. By category (high-impact items + file refs)

### Table
- **[bug] Fix `LoomDataTable` filter-row vs header z-index** so the filter row stays visible on
  scroll; add `aria-live` "Showing N of M" caption — `lib/components/ui/loom-data-table.tsx:135-167`.
- Replace legacy Fluent `<Table>` with `LoomDataTable` — `lib/components/admin-security/audit-panel.tsx:147-168`.
- Replace hand-rolled audit log with `LoomDataTable` — `lib/components/catalog/permission-matrix.tsx:30-100`.
- Enable `sortable`/`filterable` on list-view columns: `/learn` guides (`app/learn/page.tsx:501-550`),
  `/copilot` sessions (`app/copilot/page.tsx:447-454`), `/realtime-hub` streams,
  `/api-marketplace` operations.
- Add `Actions` column (Open + overflow) to `/copilot` sessions table (list view has no row action).
- Pre-set column widths + zero-result empty in federated search — `lib/components/catalog/federated-search.tsx`.
- Consistent `resizable` + ViewToggle on monitor tables — `lib/components/monitor/monitor-pane.tsx:411-418,979-987,1052-1060`.
- Warehouse/warp result grids → `LoomDataTable` (or DataGrid with sort + copy-cell + truncation
  tooltips) — `lib/panes/warehouse.tsx:339-375`, `lib/components/warp/warp-transform-canvas.tsx:567-580`.
- OneLake list view: single table w/ `Workspace` column instead of per-workspace tables —
  `app/onelake/page.tsx:1143,1287-1314`.

### Icons
- `aria-label` on all icon-only buttons (see **W1**) — security `purview-panel.tsx:411-412`,
  `mip-panel.tsx:330-335`; warp Handles `warp-transform-canvas.tsx:238-248`; deploy status chips.
- Use icon chips (color-tinted, from `itemVisual()`) instead of bare text buttons/cards:
  `/realtime-hub` SourceGallery, `/connections` tile header, `/activator` ItemsByTypePane
  (`:39`), `/browse` pinned-group headers.
- Move warp `STEP_COLOR` map (`:180-187`) and badge `#fff` off hardcoded hex onto
  `tokens.colorBrand/Warning/Success/DangerForeground*`.
- Consistent icon sizing (match button size) + de-duplicate redundant icon+label —
  `lib/components/admin/apim-developer-portal-pane.tsx`.

### Spacing-tokens
- APIM panes: ~25 inline margin/padding literals → tokens —
  `lib/components/admin/apim-{service,apis,backends,named-values,products,subscriptions,developer-portal}-pane.tsx`.
- Warp + deploy-planner: ~100 raw px (gap/padding/font/radius/handle sizes) → tokens/shorthands —
  `lib/components/warp/warp-transform-canvas.tsx` (`:129,154,162,164,165,230,863,1027`),
  `lib/components/deploy-planner/deploy-plan-nodes.tsx:47-156`, palette `:171-205`.
- Security: stat cards `style={{fontSize:24,…}}` → `tokens.fontSizeHero700`/`colorBrandForeground1`,
  panel padding/gap → tokens — `app/admin/security/page.tsx:57-67`,
  `admin-security/{audit-panel:24-30,dlp-panel:34-41,purview-panel:42-65,mip-panel:56-63}`.
- Monitor stat/toolbar gaps (`14px/24px/12px`) → tokens — `lib/components/monitor/monitor-pane.tsx:92,102-104,118`.
- `/workspaces` chips/bulk-bar (`3px 8px`,`12px`,`4px`) and `/api-marketplace` drawer/code-block
  px → tokens — `app/workspaces/page.tsx:140-183`, `app/api-marketplace/page.tsx:80,84,1063`.
- Semantic-model grids/tiles → tokens + `shorthands.padding()` — `lib/panes/semantic-model.tsx:70-73,111-120`.
- env-config/health `CSSProperties` objects (card/codeBox/head) → `makeStyles` + tokens.
- **New shared atoms** in `lib/components/ui/admin-tab-styles.ts`: `statGrid`, `cardSection`;
  reuse `dialogGrid` for all admin dialogs/drawers (capacity DetailPane, scaling Apply, env-config edits).
- Tokenize `lib/components/empty-state.tsx` itself (see **W4**).

### Learn-help (see W5 for the shared pattern)
- Lineage asset-ID field: `LearnPopover` with per-source example formats —
  `app/catalog/lineage/page.tsx:26-55`, `lib/components/catalog/lineage-graph.tsx:55-64`.
- OneLake Details footnote → `Learn about governance` popover; `aria-label` on close button —
  `app/onelake/page.tsx:671,854-862`.
- Permissions/domains form `Field` hints + Learn links — `permission-matrix.tsx:30-100`,
  `app/catalog/domains/page.tsx`.
- Governance nav-card icons get Tooltip/"Learn more" (Purview docs) — `app/governance/page.tsx:478-509`.
- Per-pane Help icon (warehouse/lakehouse/notebook/semantic-model/warp/deploy-planner).
- `/learn` `/copilot` `/data-agent` tab-level `HelpButton + HelpDrawer` (+ hotkeys).

### Empty-loading (see W3/W4)
- Tree skeletons: `app/onelake/page.tsx:479-537` TablesTab; `lib/panes/lakehouse.tsx:137-155`.
- Lineage skeleton graph + empty box — `lib/components/catalog/lineage-canvas.tsx`, `lineage-graph.tsx:55-64`.
- Catalog tree-browser empty box + account-admin gate MessageBar (match
  `app/catalog/metastores/page.tsx:366-378`) — `tree-browser.tsx:272,279-288`.
- Security DLP/audit/restrict empties → icon + `SkeletonItem` rows —
  `audit-panel.tsx:144`, `dlp-panel.tsx:267,323,588-591`.
- Notebook cell output: skeleton while running + distinct red error state; JSON via read-only
  Monaco — `lib/panes/notebook.tsx:132-176`.
- `/data-agent` rail skeleton + EmptyState CTA; `/business-events` event-types EmptyState.
- Tooltips on enum/metadata columns (audit `Kind`, users ws-roles, account status) — admin tables.

### A11y
- See **W1** (icon labels) — highest priority.
- Workspaces empty-state icons are `aria-hidden` with no text alternative; make the message
  keyboard-reachable — `app/workspaces/page.tsx:1235,1257`.
- OneLake workspace filter buttons need counts in `aria-label` ("Workspace: X, N items") and
  disabled styling at count 0 — `app/onelake/page.tsx:1145-1216`.
- Domain name-cell icon needs label / `aria-hidden`; verify menu-item focus order —
  `app/catalog/domains/page.tsx:231-282`.
- Semantic-model deploy controls in a `fieldset`/`legend`; `aria-describedby` on deploy button —
  `lib/panes/semantic-model.tsx:279-327`.
- Add `aria-label="Time range"` to monitor time-span dropdowns — `monitor-pane.tsx:535-559`.

### Tests (see W8)
- Warp canvas, deploy-planner-view, notebook pane: **zero** component tests today.
- Admin: only `mcp-servers-panel.test.tsx` exists across the whole admin surface.
- Add the "no unlabeled icon button" render-lint test alongside the **W1** sweep.

---

## 3. Already A-grade (leave as-is / use as the reference)

- **`LoomDataTable`** (`lib/components/ui/loom-data-table.tsx`) — sort + per-column text/select/date
  filter + resize + sticky header + generous token-based cell padding + loading/empty states are
  all built and correct. Only the filter-row z-index bug (W2) and an opt-in skeleton (W3) remain;
  it is the model every other table should adopt.
- **`EmptyState`** (`lib/components/empty-state.tsx`) — structure (icon + title + body + dual CTA,
  `role="status"`) is right; needs only px→token tidy (W4) and broader adoption.
- **`admin-tab-styles.ts` `dialogGrid`** — correct token-based dialog layout atom; just under-used.
- **Catalog `metastores` honest-gate MessageBar** (`app/catalog/metastores/page.tsx:366-378`) — the
  reference pattern for surfacing account-admin/403 remediation; replicate in tree-browser.
- **Catalog access button** (`app/catalog/catalog`, `aria-label="Request access"`) — the reference
  for the W1 icon-label pattern.
- **`warp-hub-content.tsx` `LEARNING_RESOURCES`** — the reference shape for the W5 LearnPopover data.
- **Deploy-planner utils** — `bicepparam`, `cost-estimate`, `plan-validation`, `planToBicep` already
  have tests; only the UI component lacks coverage.

---

### Suggested wave order
1. **W1 + W2-bug** (a11y labels + the one-line z-index fix) — biggest reach, lowest risk.
2. **W6 + W4-tokenize** (token cleanup incl. `EmptyState`/new `statGrid`/`cardSection` atoms).
3. **W3 + W4-adopt** (skeletons + EmptyState adoption).
4. **W5** (shared LearnPopover + per-surface resources, grounded in Learn).
5. **W2-migrate + W7** (table migrations, sort affordance, ViewToggle).
6. **W8** (tests + the icon-label lint guard).

---

## 4. Status — shipped 2026-06-18 (epic #1470)

| Win | Status | PR |
|-----|--------|----|
| W1 — aria-label sweep (icon-only buttons) | ✅ shipped | #1494 |
| W2-bug — `LoomDataTable` filter-row/header z-index + aria-live caption | ✅ shipped | #1493 |
| W2-migrate — legacy `<Table>` → `LoomDataTable`, enable sort/filter | ✅ shipped (audit-panel, permission-matrix, copilot/marketplace/realtime-hub) | #1493 |
| W3 — table/tree skeletons | ✅ shipped (`skeleton` prop + onelake/lakehouse/notebook/data-agent) | #1493, #1498 |
| W4 — tokenize `EmptyState` + route bare empties through it | ✅ shipped (tree-browser, federated-search, lineage, dlp-panel, data-agent, business-events) | #1493, #1498 |
| W5 — shared `LearnPopover`/`SectionExplainer` | ✅ shipped (7 surfaces) | #1495 |
| W6 — raw px/color → Fluent tokens (~165 literals) + `statGrid`/`cardSection` atoms | ✅ substantially complete (long-tail no-clean-token values left) | #1496, #1499 |
| W7 — sort affordance (chevron + `cursor:pointer` + `aria-sort`); ViewToggle | ✅ shipped (ViewToggle already existed) | #1497 |
| W8 — component/E2E tests (warp-canvas, deploy-planner, notebook, admin flows) | ⛔ **BLOCKED** — repo-wide vitest harness broken (jsdom env + missing `@csstools/css-calc` in shared worktree `node_modules`; `pnpm install` disallowed in worktrees). Fix the harness first, then W8. | — |

**Live:** console rolled to revision 0000023 with #1493–#1496; #1497–#1499 in the next consolidated roll. Self-audit 39 passing / 0 warnings / 0 failing.
