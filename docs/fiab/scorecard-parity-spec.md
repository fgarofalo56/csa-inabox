# Loom Scorecard Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `fabric-parity-loop`. Source: Microsoft Learn — Power BI metrics & scorecards (`/power-bi/create-reports/service-goals-introduction`, `service-goals-create`, `service-goals-create-connected`, `service-goals-subgoals`, `service-goals-check-in`, `service-goals-status-rules`, `service-goals-custom-status`, `service-goals-set-permissions`, `service-goals-get-started-hierarchies`).

A **Scorecard** (officially **Power BI Metrics**) is a Power BI service artifact that hosts one or more **goals** (also called metrics) — each goal tracks a current value vs a final target over time, with a status and an owner. Goals can be **manual** (values typed in by an owner via check-ins) or **connected** (values pulled automatically from a Power BI report visual on a daily refresh cadence). Scorecards live in a workspace and are backed by an auto-generated semantic model that stores all metric data.

## UI components

### Scorecards hub
- Left-nav entry **Scorecards** (formerly **Goals**)
- **New scorecard** button
- Sections: **Recommended** · **Recent** · **Favorites** · **Shared with me** · **All scorecards**
- Per-scorecard row: name, last visited timestamp, favorite (star) toggle
- View toggle: **List view** / **Compact view** (compact view supports resizable columns)

### Scorecard top action bar
- **Edit** pencil toggle (enters edit mode)
- **+ New goal** button (only in edit mode)
- **Refresh** (forces re-pull for connected goals — once-per-day max)
- **Share** — direct user / link share, with options for "Allow recipients to share" and "Allow access to underlying semantic model"
- **File** menu — Save a copy · Move scorecard (between workspaces) · Settings · Delete
- **Subscribe** — schedule email digests of goal progress
- **Follow** — push updates to Teams / email
- **View as Compact / List** toggle
- **Settings** cog (in edit mode) — opens Scorecard Settings pane

### Scorecard grid (main canvas)
- Hierarchical list of goals + subgoals (indented tree)
- Columns (configurable via Scorecard Settings):
  - **Name** (goal name + owner avatar)
  - **Current value** (with format string)
  - **Target / Final target**
  - **Status** (badge — preset: Not Started / On Track / At Risk / Behind / Unmet / Met, or custom statuses)
  - **Progress** (computed % of target)
  - **Last check-in** (date)
  - **Start date** / **Due date**
  - **Notes** count
- Per-row hover reveals **More options (…)** menu:
  - See details (opens Details pane)
  - New check-in
  - Edit
  - Add subgoal
  - Link to existing goal (for shared/linked goals across scorecards)
  - Delete

### New goal / Edit goal form
- **Goal name** (required)
- **Owners** — multi-select of users or distribution groups
- **Current value** — manual numeric OR **Connect to data** → choose a Power BI semantic model + visual + measure
- **Final target** — manual numeric OR connected
- **Status** — preset OR **Or set up rules** to define automated rules
- **Start date** / **Due date**
- **Format value** — number / currency / percent / scientific / custom (with prefix, suffix, decimals, scale K/M/B)
- **Save**

### Goal Details pane (right side)
- Header: name, owners, status badge
- **New check-in** button
- **Activity** feed: every check-in shown with date, value delta, status, note, author avatar
- Tabs:
  - **Properties** — full edit form
  - **Connections** — semantic model + visual + measure binding (for connected goals); Edit / Clear
  - **Time period** — tracking cycle (Daily / Weekly / Monthly / Quarterly / Yearly); start/due dates
  - **Status rules** — rule list with conditions
  - **Notes** — free-form notes log
  - **Permissions** — per-goal view / update permission roles (when goal-level permissions are enabled)
- **Trend chart** — sparkline of current value over time vs target line

### Check-in dialog
- **Date** picker (defaults to today)
- **Value** input (manual only; for connected goals, the value auto-populates from the selected date's snapshot and cannot be overridden)
- **Status** dropdown
- **Note** textarea (optional)
- **Save**

### Status rules editor
- Per-status row: Status (badge) + Condition builder
- Condition types:
  - **Value-based** — `current value` / `target value` operator (>, ≥, =, ≤, <) literal-or-percent
  - **Percentage of target** — % thresholds
  - **Date-based** — relative-to-due-date thresholds (e.g., "due in < 7 days AND value < 90% → At Risk")
  - **Combinations** of the above
- Custom status definitions — Add custom status with color + icon (replaces the preset 6-status set)

### Connected goal connection picker
- Pick semantic model from workspace
- Pick report (within that model's reports)
- Pick visual on a report page
- Pick the specific measure / data point in the visual
- Optional: filter context to pin (e.g., a specific category)

### Subgoals
- Indented under parent in the grid
- Inherit parent metadata (name format, statuses, tracking cycle, data connections)
- Can be manual or connected independently
- Aggregate up to parent (sum / average / weighted — configurable)

### Hierarchies (Preview)
- Auto-derive subgoals from a hierarchy in the connected semantic model (e.g., one goal per Region from a Region column)
- **Map owners** — bind owner column from the model to dynamically assign owner per child
- **Related metrics** pane — shows which metrics in the scorecard are connected and to which semantic model

### Scorecard Settings pane
- General — name, description, theme
- **Columns** — which columns to show / hide
- **Permissions** — goal-level role definitions (View permissions, Update permissions: Note / Status / Current; **Set for all** subgoals checkbox)
- **Tracking cycle defaults**
- **Custom statuses** — list of status names, colors, icons

### Sharing dialog
- Direct user / group share
- Link share with permission level
- **Allow recipients to share** toggle
- **Build permission on underlying semantic model** toggle

### Pin to dashboard
- Pin individual goal as a dashboard tile (tile shows current value, target, status, sparkline)

### Mobile experience
- iOS / Android Power BI app supports scorecards, check-ins, goal-level permissions, customized check-in attributes

## What Loom has
- `ScorecardEditor` (apps/fiab-console/lib/editors/phase3-editors.tsx:1738)
- Workspace picker, left tree of scorecards, refresh button
- Goals table with columns: Goal name · Current · Target · Add value action
- **Add goal value** dialog with value (numeric), target (optional), note (optional) — wired to `POST /api/items/scorecard/{id}` with `{goalId, value, targetValue, noteText}`
- BFF routes: `GET /api/items/scorecard?workspaceId=...` (list), `GET /api/items/scorecard/{id}?workspaceId=...` (goals), `POST .../{id}` (submit check-in)
- Empty-state message: "No goals on this scorecard (or the Fabric scorecard preview API is not enabled in this tenant)"
- C-grade verdict — list + read goals + submit one check-in field works; **no status, no rules, no connections, no hierarchy, no details pane, no permissions, no create-scorecard, no create-goal**

## Gaps for parity
1. **No create-scorecard** flow (`+ New scorecard`)
2. **No edit mode toggle** with the `+ New goal` button
3. **No new-goal / edit-goal form** (name, owners, status, start/due dates, format)
4. **No status column** — Loom shows only current and target
5. **No status rules editor** (value / percent / date / combinations)
6. **No custom statuses**
7. **No connected goals** — Loom only writes manual check-ins; cannot bind a goal to a semantic-model visual
8. **No subgoals / nested hierarchy**
9. **No Hierarchies (Preview)** — auto-derive subgoals from a hierarchy column
10. **No Goal Details pane** (Activity feed, Properties tabs, Connections, Time period, Notes, Permissions, trend sparkline)
11. **No check-in date picker** (Loom auto-sends today's date)
12. **No tracking cycle** config (Daily / Weekly / Monthly / Quarterly / Yearly)
13. **No goal-level permissions** (per-goal view / update / note / status / current)
14. **No Share / Subscribe / Follow / Move scorecard**
15. **No pin-to-dashboard** for a goal
16. **No Compact view** toggle

## Backend mapping
- The **Goals / Metrics / Scorecards REST API** is exposed under `/v1.0/myorg/scorecards` (and `/groups/{groupId}/scorecards`) — it is documented as **preview** and is enabled per-tenant
- **List scorecards**: `GET /v1.0/myorg/groups/{groupId}/scorecards` (Loom's `/api/items/scorecard` route)
- **Get scorecard + goals**: `GET /v1.0/myorg/groups/{groupId}/scorecards/{scorecardId}?$expand=goals`
- **Create scorecard**: `POST /v1.0/myorg/groups/{groupId}/scorecards` with `{name, description}`
- **Create goal**: `POST /v1.0/myorg/groups/{groupId}/scorecards/{scorecardId}/goals` with goal definition (name, owner, currentValue, targetValue, startDate, dueDate, status, format)
- **Update goal**: `PATCH .../goals/{goalId}`
- **Submit check-in (goal value)**: `POST .../goals/{goalId}/values` with `{value, targetValue?, status?, noteText?, dateTime}` — Loom already calls a thin wrapper here
- **Connected goal binding**: configured via the `valueConnection` / `targetConnection` properties on the goal, referencing a semantic-model `datasetId` + visual context — there is also a richer set of operations under `connections/`
- **Status rules**: `PATCH .../goals/{goalId}` with `statusRules` array
- **Permissions**: `POST .../scorecards/{scorecardId}/permissions` (preview)
- **Delete goal / scorecard**: `DELETE` on the corresponding resource
- **Underlying semantic model**: every scorecard auto-creates a hidden semantic model in the same workspace; the standard datasets API surfaces it (refresh, queries)
- **REST surface is preview** — some operations (custom statuses, hierarchies) are UI-only today and have no public REST. Where REST is missing Loom should iframe the Power BI service scorecard URL or show a MessageBar pointing to the official UI

## Required Azure resources / tenant settings
- Power BI Pro license to author + share scorecards in standard workspaces (free works for **My workspace** only)
- Workspace role: **Admin**, **Member**, or **Contributor**
- **Build permission** on each semantic model that a connected goal points at
- Tenant setting **Metrics** = enabled (this gates the Scorecards left-nav entry and the REST API; it is on by default for most tenants but admin-controllable)
- Tenant setting **Service principals can use Power BI APIs** = enabled (for Loom's SP to call the scorecards API)
- For goal-level permissions (Preview): tenant must have the preview opted in
- For Hierarchies (Preview): tenant must have the preview opted in
- For Teams integration (subscribe / follow): Microsoft Teams admin must allow the Power BI Teams app

## Estimated effort
**4-5 sessions.**

- **Phase 1 (1 session)** — Surface the full goal list with all real columns (name, owner avatars, current, target, **status**, last check-in, due date) by expanding the goal-detail GET; show the **status badge** with preset 6 statuses.
- **Phase 2 (1 session)** — Build the **Goal Details pane** (right-side drawer) with Activity feed (all prior check-ins) + Properties tab + trend sparkline.
- **Phase 3 (1 session)** — Wire **+ New goal** and **+ New scorecard** create flows. Add date-picker to the check-in dialog and a status dropdown.
- **Phase 4 (1 session)** — **Connected goals** — picker for semantic model + report visual binding; wire the `valueConnection` property.
- **Phase 5 (1 session, optional)** — Status rules editor, custom statuses, subgoals, goal-level permissions. Several of these are still preview in the REST API so partial coverage with MessageBar gates is acceptable.

## Notes
- The Loom v3.x backend already calls the scorecards REST API (list + get + submit value) so the BFF wiring is the lowest-risk piece — most of the gap is UI surface
- Hierarchies (Preview) and goal-level permissions are still tenant-gated previews; document them with MessageBar gates rather than blocking parity work
- Several scorecard features (custom statuses, hierarchies map-owner, Teams follow) have **no documented public REST surface** and are UI-only — for those, Loom should deep-link into `app.powerbi.com/scorecards/{id}` rather than promise parity
- The underlying auto-created semantic model is read-only from a metrics standpoint but is reachable via XMLA for advanced reporting on goal history
