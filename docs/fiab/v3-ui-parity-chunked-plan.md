# CSA Loom Fabric UI Parity — Chunked Execution Plan

Breaks the v3 UI parity ask into **10 independently-shippable chunks** so a single agent failure can't blow up the whole effort. Each chunk has explicit acceptance criteria, real-backend wiring, bicep sync items, and an E2E test.

**Hard rule:** every chunk follows `.claude/rules/no-vaporware.md`. Front-end + BFF + Azure backing or it doesn't ship.

---

## Chunk 0 — Foundation infrastructure (1-2 hr)

**Goal:** Cosmos containers + BFF routes + bicep wiring for everything downstream chunks depend on.

**New Cosmos containers** (add to `cosmos-client.ts` init + bicep cosmos.bicep auto-create):
- `apps-catalog` PK `/tenantId` — seeded with 10 CSA-curated apps
- `workloads-catalog` PK `/tenantId` — seeded with 10 workloads
- `user-prefs` PK `/userId` — dismissals, theme, sidebar collapse, recent items
- `tabs-state` PK `/userId` — open editor tabs across sessions
- `notifications` PK `/userId` — Loom notifications + Azure Activity Log events
- `audit-log` PK `/itemId` — item edit history (for editor History button)
- `comments` PK `/itemId` — editor comments
- `shares` PK `/itemId` — share links
- `folders` PK `/workspaceId` — workspace folders
- `downloads` PK `/userId` — recent downloads
- `search-history` PK `/userId` — recent search queries

**New BFF routes:**
- `/api/apps-catalog` GET/POST + `/[id]` GET/PUT/DELETE
- `/api/workloads-catalog` same shape
- `/api/user-prefs` GET ?key=, POST {key, value}, DELETE
- `/api/tabs` GET, POST {tabs:[]}, DELETE
- `/api/notifications` GET, POST (server-side), PATCH {read:true}
- `/api/items/[type]/[id]/audit` GET (audit log), `/comments` GET/POST, `/share` POST
- `/api/workspaces/[id]/folders` GET/POST/DELETE
- `/api/downloads` GET, POST
- `/api/search/items` POST {q} — Cosmos CONTAINS(); later upgrade to AI Search
- `/api/items/recent` GET — user's recent items across workspaces

**Bicep sync:**
- `modules/landing-zone/cosmos.bicep` — add the 11 containers idempotently
- No new Azure resources; just data plane

**Acceptance:**
- All 11 Cosmos containers exist (verified `az cosmosdb sql container list`)
- Every BFF route returns 401 (no cookie) and 200 with real data (with cookie)
- Cosmos seeding script `scripts/csa-loom/seed-catalogs.sh` populates apps-catalog and workloads-catalog with real CSA content
- E2E receipt: curl 11 endpoints with minted cookie, paste output

---

## Chunk 1 — Top header refactor (2-3 hr)

**Goal:** Fabric-pattern top header with every element functional.

**Files:** `lib/components/page-shell.tsx`, `lib/components/topbar/*.tsx` (new)

**Components (all functional):**
1. **App launcher** (top-left dot-grid waffle): dropdown with real links — Azure Portal (sub-scoped), Power BI service, Fabric portal, Loom docs, switch tenant. Renders user's actual tenant.
2. **Product name + workspace dropdown**: queries `/api/workspaces`, shows current workspace name, dropdown lists all user's workspaces with click-to-switch (router.push).
3. **Tab strip** (Zustand `useOpenTabs` store, persisted via `/api/tabs`): tabs auto-open on item navigation, × closes (with dirty-check confirm), drag-reorder, "Saved · Saving · Unsaved" status from form state, scroll horizontally when overflow.
4. **Center search**: input → POST `/api/search/items` → results dropdown with item icon + name + workspace + click-to-navigate. Recent searches from `search-history` container.
5. **Sidebar collapse**: persists to `user-prefs:sidebarCollapsed`.
6. **Notifications bell + badge**: queries `/api/notifications`, badge shows unread count, click opens panel with real Loom + Azure Activity events; mark-read PATCHes.
7. **Settings gear**: navigates to `/admin/tenant-settings`.
8. **Downloads icon**: queries `/api/downloads`, dropdown of recent downloads.
9. **Help (?)**: dropdown — Documentation / What's new / Submit issue / Keyboard shortcuts.
10. **Feedback button**: opens existing `/api/feedback` dialog (already wired to GitHub issues).
11. **Profile**: shows real `session.claims.name` + email tooltip; dropdown — View profile / Sign out (calls `/auth/sign-out`).

**Bicep sync:**
- Env vars: `LOOM_TENANT_ID`, `LOOM_AZURE_PORTAL_URL`, `LOOM_POWERBI_URL`, `LOOM_FABRIC_URL`, `LOOM_DOCS_URL` (all in admin-plane/main.bicep `apps[].env`)

**Acceptance:**
- Every interactive element does its labeled action against real data
- Open 3 items in 3 tabs, refresh browser → tabs restore
- Search "lakehouse" → returns real workspace items, click → navigates
- E2E receipt: 11 screenshots, one per top-header element doing its thing

---

## Chunk 2 — Left sidebar redesign (1 hr)

**Goal:** Fabric 13-entry rail with active state + pinned section.

**Files:** `lib/components/sidebar.tsx` (rewrite)

**Components:**
1. 13 nav items with icons (Fluent React Icons 20Regular) + labels. Each links to a real route (most exist; 4 new pages from Chunk 5).
2. Active state highlight with Loom brand accent
3. Collapsible (driven by `useUiStore.sidebarCollapsed`)
4. **Pinned workspaces** (bottom): queries `/api/workspaces?sort=recentlyAccessed&top=3`, click → navigate
5. **Pinned items** (below pinned workspaces): queries `/api/items/recent?top=3`, click → opens editor tab
6. Drag-reorder pinned items (persists to `user-prefs:pinnedItems`)

**Bicep sync:** none (UI-only)

**Acceptance:**
- All 13 nav entries route to existing or new pages with real content
- Pinned section reflects real user activity
- E2E: collapse sidebar → refresh → still collapsed (user-prefs persistence)

---

## Chunk 3 — Home page rebuild (2-3 hr)

**Goal:** Welcome hero + 11 functional task-flow templates + carousel + Quick access.

**Files:** `app/page.tsx`

**Components:**
1. Welcome hero
2. **11 task-flow cards** — each click POSTs `/api/workspaces` with `{name, taskFlow: '<template>'}`. Server creates the workspace AND pre-populates items per template:
   - `medallion` → creates bronze/silver/gold lakehouse items + ADF pipeline item
   - `event-analytics` → creates eventhouse + kql-database + eventstream + kql-dashboard
   - `basic-ml` → creates ai-foundry-project + ml-model + ml-experiment
   - `translytical` → creates geo-map + geo-dataset + geo-query + synapse-dedicated-sql-pool
   - etc. for all 11
3. Each card has icon, name, "What you get" hover (lists pre-populated items)
4. After creation: router.push to `/workspaces/[newId]` with first pre-populated item open
5. **Learn carousel** — 5 cards with real deep-links to `/learn/*` Loom docs
6. **Quick access tabs** — Recent workspaces / Recent items / Favorites, each backed by `/api/workspaces` and `/api/items/recent`

**Bicep sync:**
- `lib/templates/task-flows.ts` (new) — define the 11 templates with their items + initial state. Server-side; not bicep but tracked.

**Acceptance:**
- Click "Medallion" → creates workspace with 4 items in Cosmos → lands on new workspace page → 4 items visible
- E2E receipt for all 11 templates

---

## Chunk 4 — Workspace view + +New item modal (2-3 hr)

**Goal:** Functional workspace header, toolbar, and item table.

**Files:** `app/workspaces/[id]/page.tsx`, `lib/components/new-item-modal.tsx`

**Components:**
1. **Workspace header**: real badges (capacity tier read from Cosmos `workspace.capacity` + OneLake-enabled read from `workspace.onelakeEnabled`), real description (editable inline → PATCH)
2. **Action bar**:
   - Create deployment pipeline → navigate to `/deployment-pipelines/new?fromWorkspace=<id>` (real)
   - Create app → POST `/api/apps-catalog` to publish workspace as an app (real)
   - Manage access → drawer with `/api/workspaces/[id]/members` GET/POST/DELETE (Graph API for user lookup)
   - Workspace settings → drawer (Chunk 5)
3. **Toolbar**:
   - +New item → opens modal (below)
   - New folder → POST `/api/workspaces/[id]/folders` (real Cosmos)
   - Import → file upload → POST `/api/workspaces/[id]/import` (parses JSON / yaml / bicepparam, creates items)
   - Migrate → drawer to move items between workspaces (real Cosmos updates)
   - Filter by keyword → client-side filter on item table
   - Filter → drawer with type/owner/refreshed/sensitivity filters
4. **+New item modal**:
   - Left rail: category tabs from `fabric-item-types.ts` (all ~70 types grouped)
   - Recommended / All / Recently used tabs
   - Card grid: icon + name + 1-line description (from `learnContent.overview`)
   - "Show details" toggle expands cards with full description + Learn link
   - Filter search across all types
   - Click card → "Create [type]" CTA → POST `/api/workspaces/[id]/items` → navigate to new editor
5. **Item table** with extended columns:
   - Name (with icon + dirty marker if open in tab) — link to editor
   - Status (Cosmos `item.status` + Azure resource state probe)
   - Type
   - Task (from `taskFlow` template if applicable)
   - Owner (from `item.createdBy`)
   - Refreshed (from `item.updatedAt`)
   - Next refresh (from `item.state.schedule` if defined)
   - Endorsement (from `item.endorsement`)
   - Sensitivity (from `item.sensitivity`)
   - Included in app (from `apps-catalog.items[]` check)
   - Each column sortable + filterable

**Bicep sync:**
- New BFF routes registered in middleware route table
- Cosmos `workspace` document schema extended with `members[]`, `capacity`, `onelakeEnabled`, `taskFlow`

**Acceptance:**
- Open workspace, create a folder, drop an item in, see it in table, click → open editor in tab
- E2E receipt for full create-folder-add-item-open flow

---

## Chunk 5 — Workspace Settings drawer (3-4 hr)

**Goal:** 15 sections, each backed by a real Azure config call.

**Files:** `app/workspaces/[id]/settings/page.tsx` + `lib/components/settings/*-section.tsx`

**Sections (each real):**
1. **General**: image upload (POST `/api/workspaces/[id]/image` → store blob in ADLS Gen2 lake `loom-workspace-images` container), name + description (PATCH), domain dropdown (Cosmos `domains` container), tags multi-select, contacts (Graph user picker), notifications toggle
2. **Workspace type**: real capacity tier (from Cosmos+Azure), upgrade button → ARM call to change capacity
3. **Azure connections**: lists `workspace.azureConnections[]`, Add new → opens form, validates via ARM REST, saves to Cosmos
4. **System storage**: real ADLS Gen2 usage stats (existing adls-client + new `getStorageStats()` method)
5. **Git integration**: GitHub repo binding via `/api/workspaces/[id]/git` POST → calls GitHub API to create webhook
6. **Workspace identity**: shows the Console UAMI (read-only)
7. **Outbound networking**: real Container App VNet config from ARM
8. **Inbound networking**: real Container App ingress config from ARM
9. **Encryption**: real KV state, CMK toggle (if Premium)
10. **Monitoring**: real App Insights connection + diagnostic settings status
11. **Power BI**: collapsible — Power BI capacity binding form, real `/api/powerbi/workspaces` membership
12. **Delegated Settings**: per-workspace overrides
13. **OneLake**: real container list with sizes
14. **Data Engineering/Science**: Spark pool defaults, library settings
15. **Data Factory**: ADF binding + auto-pause config
16. **Data Warehouse**: Synapse Dedicated pool config + auto-pause

**Bicep sync:**
- New ADLS container `loom-workspace-images` (add to `landing-zone/storage.bicep`)
- New Cosmos container `domains`
- Env var `LOOM_GITHUB_APP_ID` for the GitHub App integration

**Acceptance:**
- Upload workspace image → renders in workspace header
- Change capacity → ARM call succeeds → reflected in header badge
- Bind Git repo → webhook visible on GitHub side
- E2E receipt per section

---

## Chunk 6 — 7 new top-level pages (4-5 hr)

**Goal:** Apps, Scorecards, Learn, Functions, Workloads, Real-Time hub, Deployment pipelines — all functional.

**Each page must be REAL:**

1. **/apps** — Apps gallery (Cosmos `apps-catalog` + workspace's installed apps). "Install" button materializes the app's items in user's selected workspace.
2. **/scorecards** — real Power BI scorecards via existing client + Loom-curated CSA scorecards (Cosmos `loom-scorecards`). Click → opens scorecard editor.
3. **/learn** — pulls What's new from GitHub releases API (live), training cards link to real Loom docs MDX, community link to GitHub Discussions.
4. **/functions** — Azure Functions list via `Microsoft.Web/sites` ARM + Loom's user-data-function items from Cosmos. "Create function" CTA → deploys via existing function-app bicep.
5. **/workloads** — Cosmos `workloads-catalog` gallery. "Install" toggles workload feature flag in user's workspace (modifies `workspace.workloads[]`). My workloads / Included with Loom / Org-added filter tabs.
6. **/realtime** — real EventHub list (existing kusto-client + EventStream client) + 4 hero cards + Get started with real data sources (lists tenant's existing Event Hubs).
7. **/deployment-pipelines** — Cosmos `deployment-pipelines` container. 4-stage Dev→Test→Prod visual. Promote button calls GHA workflow `csa-loom-promote.yml` (new) that promotes content via Fabric Deployment Pipelines REST.

**Bicep sync:**
- New Cosmos containers: `loom-scorecards`, `deployment-pipelines`
- New GHA workflow `csa-loom-promote.yml`
- Env vars: `LOOM_GITHUB_RELEASES_REPO`, `LOOM_LEARN_DOCS_BASE_URL`

**Acceptance:**
- Each page returns real data, no `return []` stubs
- Install an app from /apps → items appear in workspace
- Install a workload → workspace gains the workload's UI
- E2E receipt for each of 7 pages

---

## Chunk 7 — Editor chrome refactor (3-4 hr)

**Goal:** Multi-tab interface + functional ribbon + Comments/History/Share with real backing.

**Files:** `lib/editors/item-editor-chrome.tsx` (rewrite)

**Components:**
1. **Tab strip integration** with `useOpenTabs` store from Chunk 1
2. **Ribbon row** (Home/Edit/AI tools/Run/View tabs) — each editor opts in via `ribbon` prop
3. **Toolbar** below ribbon — per editor
4. **Right action cluster**:
   - **Comments** → drawer with real `/api/items/[type]/[id]/comments` GET/POST (Cosmos `comments` container) with @-mentions
   - **History** → drawer with real `/api/items/[type]/[id]/audit` audit log (Cosmos `audit-log` container, populated on every PATCH)
   - **Develop** dropdown — Open in VS Code (vscode:// URI scheme), Download as JSON, View raw spec
   - **Share** → real share link generator → POST `/api/items/[type]/[id]/share` → returns signed link with expiration
   - **Copilot** → floating button opens `/copilot?context=<itemId>` with item pre-loaded as orchestrator context
   - **Learn** → opens `LearnDialog` (from Learn Popups agent currently running)
5. **Status bar** at bottom: real connection state (ping via `/api/health`), AutoSave indicator (Zustand store), Copilot completions toggle (user-prefs), selection info

**Bicep sync:** none (data plane only)

**Acceptance:**
- Open editor → add comment → reload → comment persists
- Edit item → history shows the change with timestamp + user
- Click Share → get a URL that works for unauthenticated viewers (signed token)
- E2E receipt for all 6 right-cluster actions

---

## Chunk 8 — Global search via AI Search (2-3 hr)

**Goal:** Replace Cosmos CONTAINS with real AI Search index for ranked + highlighted results.

**Files:** `lib/azure/search-indexer.ts` (new), `app/api/search/items/route.ts` (rewrite), bicep

**Components:**
1. Create AI Search index `loom-items` in `dlz-aisearch-dev-eastus2` with fields: id (key), type (filterable), workspaceId (filterable), name (searchable+sortable), description (searchable), tags (filterable), createdBy (filterable), createdAt (sortable), endorsement (filterable), sensitivity (filterable)
2. **Indexer job** — Function App that listens to Cosmos change feed and pushes deltas to AI Search index. Real Function, not a stub.
3. `/api/search/items` POST `{q, filters}` → AI Search query → returns ranked hits with snippet highlights
4. Top header search dropdown uses the new endpoint

**Bicep sync:**
- New Function App `func-loom-indexer-eastus2` in admin-plane
- AI Search index schema as bicep `Microsoft.Search/searchServices/indexes`
- Role: UAMI gets Search Index Data Contributor

**Acceptance:**
- Create new item → within 30s appears in search results
- Search "FedRAMP" → returns ranked items across all workspaces
- E2E receipt: index doc count + sample query result

---

## Chunk 9 — Bicep sync + 1-button push-button verification (2-3 hr)

**Goal:** Every new Cosmos container, env var, role, and resource added in Chunks 0-8 is in bicep. Then run a full deploy in a side sub.

**Tasks:**
1. Audit every change since v2.5.1 against bicep modules. Add missing.
2. Update `commercial-full.bicepparam` with new param defaults
3. Update `gcc-high.bicepparam` and `il5.bicepparam` accordingly
4. Run `az deployment sub what-if` against the current sub → expect only the new resources, no destructive drift
5. Add to `scripts/csa-loom/seed-catalogs.sh` so apps + workloads + scorecards seed on every deploy
6. Update `.github/workflows/csa-loom-post-deploy-bootstrap.yml` with the new RBAC + tenant config

**Acceptance:**
- `what-if` clean
- Catalog Cosmos containers seeded on fresh deploy
- E2E receipt: bicep what-if output

---

## Chunk 10 — Validation + teardown test (4-6 hr)

**Goal:** Prove the 1-button deploy actually works from scratch.

**Tasks:**
1. **Vitest unit tests** for every BFF route (mock Cosmos, mock Azure clients)
2. **Playwright E2E** for every wired editor:
   - Sign in via minted cookie
   - Open editor
   - Run primary action
   - Verify real Azure side-effect (Cosmos doc count, ARM resource state)
3. **Teardown script** `scripts/csa-loom/teardown.sh`:
   - Deletes all RGs (rg-csa-loom-admin-eastus2, rg-csa-loom-dlz-single-eastus2)
   - Removes Power BI workspace SP assignments
   - Removes Databricks SCIM SP
   - Removes Synapse SQL login
   - Removes role assignments
   - Removes Foundry project
4. **Redeploy script** `scripts/csa-loom/redeploy-from-scratch.sh`:
   - `az deployment sub create -f main.bicep -p commercial-full.bicepparam`
   - `bash scripts/csa-loom/deploy-v2-synapse.sh` (Synapse Dedicated + auto-pause)
   - `bash scripts/csa-loom/grant-apim-rbac.sh`
   - GHA workflow `csa-loom-post-deploy-bootstrap.yml` for Synapse SCIM + Databricks SCIM + APIM RBAC + ADX RBAC + Foundry RBAC + Power BI tenant SP + AI Search RBAC + Content Safety RBAC + Function App provisioning + AI Search indexer
   - `bash scripts/csa-loom/seed-catalogs.sh`
   - Run the Vitest + Playwright suite
5. **Acceptance criteria**: after the redeploy, every editor either lights up with real data OR shows its documented MessageBar gate

**Acceptance:**
- Teardown clean
- Redeploy clean
- All tests green
- Final receipt: full Playwright trace + screenshots of every editor working

---

## Estimated total: 24-36 hr focused work

Realistic in 2-3 sessions if I delegate heavily to parallel agents. Each chunk is independently shippable + bicep-synced, so we never get to a "half-finished" state.

## Order

I'll execute in this order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. **Chunk N must pass acceptance before N+1 starts.** If an agent fails mid-chunk, salvage what landed + restart that chunk only.

## Already-running work

- Learn popups agent (`afcbea65...`) is finishing now — that satisfies the "Learn" part of Chunk 7's right-cluster.
- Power Platform / Copilot Studio / Cross-item Copilot / Gov+Unleashed / Security hardening all landed in earlier rounds.

## Approval gate

Before I start: confirm this breakdown is the right scope, the right order, and the rule above is what you want enforced. I won't spawn the Chunk 0 agent until you say go.
