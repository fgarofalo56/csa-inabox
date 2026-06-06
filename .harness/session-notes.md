# CSA Loom Harness — Session Notes

## Session 0 — 2026-06-05 (manual init)

**Agent:** operator + claude (manual initialization)
**Status:** completed — harness wired, ready for autonomous run

**Completed:**
- Authored the phased PRP (`.harness/spec.md`) — 9 phases, operator-excluded #17 image-gen.
- Generated `.harness/state.json` — 22 tasks ordered by `task_order` (99 → 12).
- Wrote `.harness/config.json` — live IDs, build/test gates, merge + git-bash gotchas, BLOCKING rules.
- Pre-run hygiene: merged the session's 18 feature PRs (#691–#705); merged #660 (SHIR idle-stop) + safe dependabot patches; closed the risky major dependabot bumps (vitest 4 / eslint 10 / redis) for deliberate handling; closed stale issues #589/#587/#428/#429 (kept #655 → folded into task-016); removed ~80 archived agent-worktree dirs.

**Context for the coding agent (read `.harness/config.json` first):**
- The console is `apps/fiab-console` (Next.js, Fluent v9). Gate on `tsc --noEmit`
  (filter pre-existing makeStyles-px errors) + the required `next build (node 20)` CI check; the vitest harness is broken — do not gate on unit tests.
- Per feature: branch off fresh `origin/main` → implement → tsc → focused PR →
  `gh pr merge <n> --squash --admin` (update-branch first if BEHIND; wait for `next build`) → console auto-rolls → live-verify → update state.json + append here + commit.
- Prefix az/gh commands that take `/subscriptions/...` with `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'`. Verify diagnostic settings with `az rest`, not `az monitor diagnostic-settings list --resource`.

**Next steps:**
- Coding agent picks the highest-`task_order` `todo` (task-001, Phase 0 baseline),
  implements one task per session, then continues down the ledger.
- If a task needs an operator decision (one-time grant, support-ticket gate,
  destructive action) → set status `blocked`, write the exact ask here, move on.

**Open items flagged for the operator (do not guess):**
- (none yet — the run will append blockers here as it hits them)

## Session 1 — 2026-06-05 — task-001 (Phase 0 baseline) ✅ done

**Agent:** harness-coder (autonomous, /harness:harness-next via /loop)
**Task:** task-001 — repo hygiene + live baseline + smoke-test shipped surfaces

**Hygiene:**
- `main` clean, 0 ahead / 0 behind `origin/main`.
- 0 **merged** feature branches to prune (Session 0 already swept ~80 worktrees + merged branches).
- 11 remote branches remain, all **unmerged** with large ahead-counts
  (deploy-validation 539, fix-lakehouse-upload-doctype 388, sweep-pbi-warehouse 376,
  uat-iter-2-green 361, docs/dename-* 1–2). NOT pruned — deleting unmerged branches
  autonomously violates the look-before-delete rule. → see operator item below.
- Open PRs: only #580 (release-please `0.24.0`, automated, BLOCKED/MERGEABLE — left for release flow).
- Open issues: only #655 (intentionally folded into task-016).

**Live baseline:**
- Live console `loom-console` (rg-csa-loom-admin-eastus2) = Running, image tag `192dcbac…`.
- HEAD `4d173f79` touches **only** `.harness/**` (PRP+ledger) → **no console roll required**;
  the live console is already on the latest *code* commit (192dcbac).
- Dispatched `csa-loom-validate` @ main (run 26995594136) → **success**:
  **`=== 34 pass · 0 not-configured · 0 fail (of 34) ===`**, Hard failures: 0.
  All families GREEN (Cosmos, Synapse, Databricks, ADF, APIM, Foundry, AI Search,
  Fabric opt-in, Power Platform, Copilot Studio, Loom Search Index, ARM + all navigators).
  Probes run inside Azure with a real minted session secret = canonical real-backend smoke-test.

**Honest boundary (not a failure):** the console env is VNet-integrated (CNAME →
`privatelink.eastus2.azurecontainerapps.io`), so the four named UI surfaces
(Monitor KQL/Diagnostics/Cost · data-agent tools panel · Copilot usage/build-assist ·
Governance Access-policy/Classifications) can't be click-tested via curl from this
workstation. Their **backends are verified live GREEN** by the probes above; UI-level
click-through needs operator browser access through the VNet.

**No code change** → no feature PR/roll for this task (acceptance "PR merged/console rolled"
is template boilerplate that doesn't apply to a verification-only Phase-0 task).

**Open items for the operator:**
- 11 stale unmerged remote branches (listed above) — confirm safe to delete, then prune.
- Optional: live browser click-through of the 4 named UI surfaces through the VNet
  (backends already GREEN).

**Next:** task-002 (Phase 1 — Setup wizard real server-side deploy). Depends on task-001 ✅.

## Session 2 — 2026-06-05 — task-002 + task-003 (continuous drain) ✅✅

**Agent:** harness-coder (continuous /harness:harness-next, cron paused)

### task-002 — Setup wizard streams live GitHub Actions deploy status ✅ (PR #708 merged)
- The deploy BFF already **dispatched the real boundary deploy workflow** (deploy-fiab-{commercial,gcc,gcch}.yml, all present) when `LOOM_GITHUB_ACTIONS_TOKEN` is set, with an honest `az deployment sub create` 503 fallback. The gap was the UI never streamed the run.
- deploy route 202 now returns `dispatchedAt`; `workflow-run-status` accepts `?since=` + filters `event=workflow_dispatch` (fixed the invalid `status=in_progress,completed` filter that surfaced stale prior runs); wizard polls every 6s → live Badge (Starting/Queued/Running/Succeeded/Finished-with-errors) + ProgressBar + Open-run-on-GitHub deep link.
- Parity doc rows 5/6 → built/streamed; documented `LOOM_GITHUB_ACTIONS_TOKEN`/`_REPO_OWNER`/`_REPO_NAME`. tsc clean on 3 touched files.

### task-003 — deploy-dlz Feature-Permission gate ✅ (PR # pending in this session)
- Added `admin.deploy-dlz` capability to `lib/auth/feature-catalog.ts` (Admin → Tenant Admin, parent `workload.admin`). Shows up in the `/admin/permissions` RBAC tree automatically.
- `POST /api/setup/deploy` now calls `enforceCapability(session, 'admin.deploy-dlz', 'Admin')` before anything: tenant admins bypass (`LOOM_TENANT_ADMIN_OID`/`_GROUP_ID`); other principals must be delegated the capability at /admin/permissions. 403 → wizard shows a clear "you don't have permission to deploy…" MessageBar.
- Tests: mocked `cosmos-client` feature container; existing deploy tests run as bootstrap admin; added 403-non-admin + allowed-delegated-Admin-grant tests. tsc clean on touched files.

### Notes / gotchas this session
- Direct push to `main` is **branch-protected** → every change (incl. `.harness` bookkeeping) needs a PR + `gh pr merge --squash --admin`. Folding the ledger/session-notes updates INTO each feature branch to avoid a separate bookkeeping PR per task.
- Recurring stale `.git/index.lock` (0-byte) appears between git ops on this Windows box — `rm -f .git/index.lock` before git commands when it bites.
- GitHub auto-deletes the head branch on merge (remote `--delete` then errors "remote ref does not exist" — harmless).
- Live console: task-002 merge (#708) triggered CSA Loom Console Build on main → console auto-rolls to the new image.

**Next:** task-004 (Phase 1 — capacity-sizing clarity F-SKU ↔ DBU/ADX/Spark).

### task-004 — capacity-sizing clarity (F-SKU ↔ DBU/ADX/Spark) ✅ (PR # pending)
- New `lib/setup/capacity-equivalence.ts` — grounded in Microsoft Learn:
  CU = F-number (plan-capacity); Synapse Spark vCores = CU×2 (optimize-capacity);
  Power BI v-cores = CU÷8 (licenses); Warehouse SQL vCores/sec = official table
  (usage-reporting). Databricks DBU + ADX SKUs have NO official Fabric equivalence
  → banded Loom sizing guidelines, disclosed. Cost = relative tier + estimator
  deep-link (NO fabricated dollars, per no-vaporware).
- New `lib/components/setup/capacity-equivalence-panel.tsx` — Fluent v9 + Loom
  tokens, itemVisual icons, "Microsoft-official" vs "Loom guideline" badges,
  cost pips, honest MessageBar. Rendered in the wizard capacity step under the
  F-SKU dropdown.
- Parity doc row 3 enriched + backend table + (no new env var).

### task-005 — WYSIWYG deploy/Git/infra wizards on Deployment page ✅ (PR # pending)
- Audit finding: the `/deployment-pipelines` page (pipelines + Git + infra tabs)
  was ALREADY fully guided — Field/Input/Dropdown/Checkbox/Switch, real Fabric
  REST + ARM REST backends, comprehensive parity doc, zero ❌, NO raw-JSON config
  (only a legit optional free-text deployment note). So task-005's "guided forms,
  no JSON" was substantially pre-satisfied.
- Closed the one concrete gap (parity row 13, was "⚙ client-only"): surfaced the
  per-resource ARM **operation breakdown**. New BFF route
  `arm/[name]/operations` (real Microsoft.Resources/deployments/{name}/operations
  REST) + a **Steps** drill-in dialog on each infra row → sortable LoomDataTable
  (resource/type/state/status/duration/timestamp). tsc clean.
- OBSERVATION for operator (NOT in task-005 scope, → backlog): the pipelines +
  Git tabs are Fabric-workspace-centric (Fabric deployment-pipelines REST, Fabric
  git REST). The Azure-native promotion path is the ARM/bicep infra tab. If strict
  no-fabric-dependency parity is wanted for CI promotion, that's a separate epic
  (relates to tasks 013–016 A+ edges), not a guided-forms fix.

**Next:** task-006 (Phase 2 — Functions-hosted MCP tool server, bicep + REST).

### task-006 — Functions-hosted MCP tool server (bicep + REST) ✅ (PR # pending)
- New `azure-functions/mcp-server/` (Python Functions v2):
  - `function_app.py` — MCP Streamable-HTTP (stateless JSON) JSON-RPC server:
    initialize / tools/list / tools/call over POST /api/mcp + GET /api/health.
    API-key auth (x-api-key / Bearer) vs LOOM_MCP_API_KEY; 503 honest gate when
    key unset; never serves anonymously.
  - `mcp_tools.py` — 3 REAL read-only tools (loom_search_catalog → AI Search,
    loom_list_resources / loom_list_deployments → ARM REST) via managed identity;
    ToolError honest gates when a backend/role is missing. No mocks.
  - `deploy/main.bicep` — deploy-from-scratch Function App + storage + App
    Insights + Y1 Linux plan + system MI + KV-referenced LOOM_MCP_API_KEY +
    Reader(RG) + KV Secrets User RBAC. `az bicep build` clean.
  - `tests/` — 9 unit tests (JSON-RPC + auth, no Azure) GREEN.
  - `DEPLOYMENT.md` + `docs/fiab/console/mcp-tool-server.md`.
- Console env wiring + honest gate: `GET /api/admin/mcp-servers/builtin` reads
  `LOOM_BUILTIN_MCP_URL` → returns endpoint when set, else honest gate naming the
  bicep module + env var. tsc clean. (Connect-panel consumption = task-007.)
- Opt-in: not wired into the main orchestrator (mirrors copilot-chat precedent);
  a Loom deploy is fully functional without it. LIVE-DEPLOY of the Function is the
  operator step (can't deploy a new Function to the live sub from here) — honest
  gates + DEPLOYMENT.md cover it.

**Next:** task-007 (Connect MCP tools agent panel — surfaces builtin + external).

### task-007 — Connect MCP tools agent panel ✅ (PR # pending)
- The External MCP Tools panel (lib/components/admin/mcp-servers-panel.tsx,
  mounted in Copilot & Agents) already did register (URL + header/key-vault
  secretRef) + Test-Connection (real tools/list) + enable/disable/edit/delete.
- Added the increment that surfaces task-006's server: a **BuiltinMcpCard** at the
  top reading GET /api/admin/mcp-servers/builtin →
  one-click "Register built-in tools" (key-vault auth → loom-mcp-api-key) when
  LOOM_BUILTIN_MCP_URL is set, "Registered" badge if already added, or honest gate
  (env var + bicep module + DEPLOYMENT.md) when not provisioned. tsc clean (the one
  tsc error in the file is the PRE-EXISTING Body2 weight line, not mine).
- docs/fiab/console/mcp-tool-server.md updated.

**Next:** task-008 (data-agent EXECUTES its generated query on real rows).

### task-008 — data-agent EXECUTES its generated query on real rows ✅ (PR # pending)
- New `lib/azure/data-agent-execute.ts` — `executeSourceQuery(source, query)` runs
  the model's per-source query READ-ONLY on the Azure-native backend:
  warehouse → Synapse dedicated SQL (TDS), lakehouse → Synapse serverless SQL,
  kql → ADX (kusto). Hard read-only guards (SELECT/WITH only; KQL mgmt/ingest
  blocked) + 25-row cap. semantic-model/ai-search/ontology/graph → honest gate.
  Unreachable backend → honest gate string (no mock, never throws out).
- `chatGrounded()` (data-agent-client.ts) is now 2-phase: phase-1 AOAI proposes
  answer+queries → execute each → phase-2 re-prompt AOAI with the REAL rows for a
  grounded final answer. DataAgentTool carries {executed,rowCount,columns,rows,gate}.
- Editor (phase4-editors.tsx data-agent chat): each tool shows `✓ ran · N rows`
  badge + a compact result table, or an honest ⚠ gate. tsc clean (pre-existing
  Option/UdfState/GraphDecl errors only).
- Identity note: queries run under the console UAMI (ChainedTokenCredential), not
  per-end-user passthrough; read-only enforced by query guards. Live verify is the
  operator step (needs provisioned warehouse/ADX + AOAI).
- parity doc data-agent.md row 7 + backend table updated.

**Next:** task-009 (Governance Insights redesign — real content, sortable UI).

### task-009 — Governance Insights redesign (real content, sortable UI) ✅ (PR # pending)
- /api/governance/insights now computes (live Cosmos, no sample data):
  ownership coverage (state.owner/ownerUpn/contact/steward), endorsement coverage
  (state.endorsement Certified/Promoted || state.certified), a composite
  compliance score (mean of the 4 coverage dims), and an active-policies list.
- /governance/insights page: 8 KPI cards (compliance score headline + ownership +
  endorsement added), per-type coverage table gains Owned + Endorsed sortable
  columns, new Policy-effectiveness sortable LoomDataTable (type/scope/status/updated).
- Branch was accidentally cut before #714 merged → rebased onto origin/main (task-008)
  so it carries data-agent-execute; ahead-by-1, not behind.
- parity doc governance.md insights row updated. tsc clean (only pre-existing
  makeStyles numeric-px errors in the untouched useStyles block).

**Next:** task-010 (Purview portal page web-3.0 cleanup).

## Session 3 — 2026-06-05 — Loom Thread roadmap (backlog item #1) — continuous

Working the Thread roadmap (highest-value cross-service "Weave" fabric) ahead of
the numbered tasks 010–022, per the operator's drain order.

### Thread PR5 (headline) — *Build a Power BI model* edge ✅ (PR # pending)
- New Thread edge `build-powerbi-model` on warehouse / synapse-dedicated-sql-pool:
  gold table → a REAL Power BI **push dataset** (the supported REST authoring
  path — no XMLA needed for push models). All-dropdown wizard:
  - workspace ← `/api/powerbi/workspaces` (real `listWorkspaces`, honest SP gate)
  - table ← new `/api/thread/powerbi-model/tables?fromType=&fromId=`
    (`sql-objects-client.listTables` over the Azure-native Synapse dedicated pool;
    honest gate if LOOM_SYNAPSE_WORKSPACE/_DEDICATED_POOL unset)
  - model name (text) + "push sample rows" (toggle, default on)
- New `/api/thread/build-powerbi-model`: reads catalog columns (`listColumns`) →
  maps SQL→push types (`lib/thread/sql-to-pushdataset.ts`) → `createPushDataset`
  → `SELECT TOP 500` (read-only, bracket-quoted catalog identifiers) →
  `postPushRows`; deep-links to the model in the Power BI service. Owner-scoped.
  401/403 from PBI surfaced verbatim + the exact SP-authorization remediation.
- Wizard machinery generalized: `optionsRoute` now supports `{fromId}`/`{fromType}`
  tokens (substituted from the source item) and surfaces a route's honest
  `ok:false` gate in the field validation message. Benefits all future edges.
- no-fabric-dependency: Power BI is the explicitly-chosen Weave *target*, not a
  default item dependency; the source warehouse is Azure-native Synapse.
- Docs: new `docs/fiab/thread/thread-edges.md` (edge catalog); PRP delivery plan
  PR5 row updated. tsc clean on all touched files (only pre-existing px noise in
  untouched powerbi-tree.tsx remains).
- LIVE-VERIFY is the operator step: needs a Power BI workspace the Console SP is a
  Member of + the tenant "Service principals can use Fabric APIs" setting; and a
  populated Synapse dedicated pool. Both are operator-side; honest gates cover the
  unconfigured paths.

**Deferred to next Thread PRs (noted, not stubbed):** lakehouse/KQL/azure-sql →
PBI model (needs the per-backend schema adapter, PR4); report build + embedded
report in Loom; data-agent semantic-model (DAX) execution via `executeQueries`.

### Thread PR3 — *Publish as an API* edge ✅ (PR # pending)
- New Thread edge `publish-as-api` on warehouse / synapse-dedicated-sql-pool:
  warehouse table → a REAL `data-api-builder` Loom item (REST + GraphQL). Builds
  a `DabConfig` from the table's catalog schema (columns + PK via `listColumns`),
  `dwsql` source = Azure-native Synapse dedicated pool, runs `validateDabConfig`
  (blocks on hard errors), `createOwnedItem('data-api-builder', …)` — the SAME
  path the DAB editor uses. Deep-links to the editor; deploy is the editor's
  existing explicit step (no hidden hosting claimed).
- Secure by default: "Require authentication" toggle → entity permission role
  `authenticated` (vs anonymous). NOTE/bugfix: do NOT force host authProvider
  EntraId at creation — that fails `dab validate` without jwt issuer/audience;
  provider+jwt is an editor/deploy-time config. Toggle controls the role only.
- Consolidated the warehouse table discovery into one shared route
  `/api/thread/warehouse-tables` (deleted the PR5 powerbi-model/tables route;
  pointed the Build-a-Power-BI-model edge at the shared one). DRY.
- New `api` menu icon (PlugConnected). Docs: thread-edges.md + PRP PR3 row.
  tsc clean on touched files.
- LIVE-VERIFY (operator): needs a populated Synapse dedicated pool; the item +
  config are created regardless, deploy is the editor step. Honest gate when the
  pool env is unset.

### Thread PR4 (spine) — edge graph + Lineage view ✅ (PR # pending)
- New Cosmos container `thread-edges` (PK /tenantId) in cosmos-client + a
  `threadEdgesContainer()` accessor (+ added to KNOWN_CONTAINER_IDS for
  scale-by-SKU). `lib/thread/thread-edges.ts`: `recordThreadEdge` (best-effort
  UPSERT — never blocks the edge action) + `listThreadEdges`.
- Wired `recordThreadEdge` into ALL 4 edge routes (analyze-in-notebook,
  add-data-agent-source [both new + append paths], build-powerbi-model [external
  PBI target + deep link], publish-as-api). tenantId = claims.oid (single-tenant
  convention, matches mcp-servers).
- `GET /api/thread/edges` read API + new `/thread` **Lineage** page (left nav):
  KPI cards (totals + per-action) + sortable/filterable LoomDataTable
  (Source → Weave → Target, When, By); Loom targets deep-link to editors,
  external (Power BI) opens in service; honest empty state. Fluent v9 + Loom
  tokens. tsc clean on all touched files.
- Deferred: medallion promotion flow + React Flow node-link rendering of the
  same graph (data + list view ship first).

**Next:** Thread PR2 finish (lakehouse → Synapse Serverless SQL view edge +
columns adapter), or extend the Weave registry further, then numbered ledger
task-010+ (Purview web-3.0, access-policy enforcement, catalog detail…).

### task-010 — Purview portal page web-3.0 cleanup ✅ (PR # pending)
- Rewrote app/governance/purview/page.tsx with loom-design-standards: all raw
  px → Loom tokens (also clears the makeStyles px tsc errors in this file), a
  branded gradient connected-status hero Card, and the 8 native governance
  surfaces rendered as per-surface **icon cards** (icon tile + label + one-line
  desc, hover lift) in a responsive grid — replacing the plain text-link list.
  Honest PurviewGate + live-only rendering preserved; portal launch unchanged.
- tsc clean on the file (zero errors). UI-only; backend (purview/status probe)
  untouched. Live-verify = operator browser (VNet); probe already GREEN.

**Next:** task-011 (non-ADLS access-policy enforcement: warehouse Synapse SQL
GRANT + kql ADX role) or continue Thread. Then task-012 (catalog detail).

### task-011 — non-ADLS access-policy enforcement (warehouse + KQL) ✅ (PR # pending)
- access-policy-client now enforces 3 real Azure-native scopes (was ADLS-only):
  - **warehouse** → Synapse dedicated SQL: `CREATE USER [upn] FROM EXTERNAL
    PROVIDER` (if absent) + `ALTER ROLE db_datareader|db_datawriter|db_owner ADD
    MEMBER` via synapse-sql-client. Honest pending-gate if pool env unset.
  - **kql-database** → ADX `.add database ["db"] viewers|users|admins ('<aad
    token>')` via kusto-client executeMgmtCommand. aaduser=UPN (no tenant) or
    aaduser/aadgroup/aadapp=oid;AZURE_TENANT_ID; honest gate if tenant missing
    for group/SP. Honest pending-gate if ADX env unset.
  - SQL identifiers bracket-escaped, literals quote-escaped (no injection); role
    names from fixed maps only.
- Symmetric revoke: new `revokeStructuredGrant` (ALTER ROLE DROP MEMBER /
  `.drop database` role); DELETE route calls it for warehouse/kql (ADLS still
  revokes by roleAssignmentId). Best-effort, never blocks the delete.
- policies route: scopeType enum + validation extended; passes principalName;
  DELETE wired. UI (/governance/policies Access form): new "Scope (data plane)"
  dropdown (ADLS container / Warehouse / KQL database) + conditional target
  (container input · kql-database dropdown from by-type · warehouse caption).
  Passes UPN as principalName. All dropdowns (loom-no-freeform-config).
- parity doc governance.md Access row updated. tsc clean on touched files (only
  pre-existing px noise at lines 29-33 in the untouched useStyles block).
- LIVE-VERIFY (operator): needs Synapse pool + ADX cluster reachable and the
  Console UAMI as a SQL db_owner / ADX AllDatabasesAdmin to run the grants;
  errors surface verbatim as enforcement status 'error'.

**Next:** task-012 (Data Catalog detail + request-access + lineage), then 013+
(kill deferred-v3 TDS-via-PE), or continue Thread PR2.

### task-012 — Data Catalog detail + request-access + lineage ✅ (PR # pending)
- governance/catalog route enriched: each asset now carries `ownerUpn`,
  `endorsement` (state.endorsement || certified→'Certified'), `description`.
- New `/api/catalog/request-access`: REAL durable request — writes an
  `access-requested` audit-log entry on the asset (owner sees it in item
  activity) + a confirmation notification to the requester (oid-keyed). Owner
  grants via Governance → Policies (which now enforces real RBAC/SQL/ADX, task-011).
- /governance/catalog page: click (or right-click) a row → **detail Drawer**
  with full metadata grid + endorsement/sensitivity/type badges + description,
  and actions: **Open in editor**, **View lineage** (→ /governance/lineage),
  **Request access** (inline permission dropdown + justification → POST). Rows
  clickable; Open link stopsPropagation. tsc clean on new code (only the
  pre-existing borderColor/px shorthand errors remain in the untouched
  useStyles block).
- LIVE-VERIFY (operator): VNet browser; backends are Cosmos (audit-log +
  notifications) already GREEN.

**Next:** task-013 (kill deferred-v3 TDS-via-PE reads) or task-018 web-3.0
beautify, or Thread PR2. Continue down the ledger.

### task-013 — TDS-via-PE reads (Azure SQL MI navigator) ✅ (PR # pending)
- INVESTIGATION finding: the live `azure-sql-database` editor is the
  **UnifiedSqlDatabaseEditor** (registry.ts:129), which ALREADY has the real
  `SqlDbTree` navigator over TDS. The "deferred to v3.x" text in
  `azure-sql-editors.tsx` `AzureSqlDatabaseEditor` is **dead code** (that export
  isn't registered) — left untouched (not user-facing; flagged for later removal).
- The one LIVE TDS-via-PE deferral was the **Managed Instance** editor
  (`SqlManagedInstanceEditor`), which only listed instances + an honest gate.
  Wired it to ATTEMPT real reads: select an instance row → `SqlDbTree` renders
  in the left panel with `server=<MI fqdn>` + a DB input (default master),
  reusing the existing `/api/sqldb/*` routes' `?server=&database=` override.
  Real `sys.*` over TDS; the navigator surfaces the real connection error as the
  honest fallback if the PE/AAD-admin isn't in place — squarely the task's
  "editor runs real reads OR honest infra gate". MessageBar reframed info (no
  "deferred"). tsc clean on touched code (only pre-existing px noise in useStyles).
- LIVE-VERIFY (operator): needs a provisioned MI + PE in the MI subnet + UAMI
  Entra admin; reads attempt regardless and show the real error otherwise.
- Other "deferred to v3.x" markers (geo-pipeline ADF, vector-store similarity,
  Fabric-mirror) are SEPARATE tasks (016/014), not TDS-via-PE.

**Next:** task-014 (Azure SQL mirroring Azure-native) or task-016 (geo/graph +
postgres + #655 auto-mount) or task-017/018 UI. Continue down the ledger.

### task-018 (slice) — Data Catalog → LoomDataTable ✅ (PR # pending)
- Converted /governance/catalog's raw Fluent `<Table>` to the shared
  **LoomDataTable** (sortable + filterable + resizable + sticky header + the
  standard loading/empty states) — directly the task-018 mandate ("sortable/
  resizable/filterable tables", "no smushed tables"). Columns: Name (+ endorsement
  badge), Type, Workspace, Owner, Classifications (chips), Sensitivity (badge),
  Size, Updated, Open. Row click still opens the task-012 detail drawer.
- tsc clean (only pre-existing borderColor/px noise in the untouched useStyles).
- task-018 stays `todo` (multi-page beautify; this is the catalog slice). Other
  high-traffic pages (Home, Browse, Monitor, editors) remain.
- Investigated but NOT taken (need operator decisions, documented for resume):
  task-016 **postgres query** needs the `pg` npm driver added (supply-chain
  decision on this enterprise repo) — gate is correctly honest meanwhile;
  task-014 Azure-SQL→ADF-CDC mirroring + #655 Spark auto-mount need live
  Spark/ADF verification.

**Next:** more task-018 page slices (Home/Browse/Monitor), or operator picks a
heavy item (pg driver / CDC mirroring / live app-install tasks 019-021).

### task-014 — Azure SQL mirroring Azure-native (replace Fabric-mirror gate) ✅ (PR # pending)
- `enableMirroring` (azure-sql-client) rewritten Azure-native: dropped the
  `LOOM_AZURE_SQL_MIRRORING_LIVE` Fabric-mirror gate + "Fabric deferred" framing;
  now runs the REAL `sys.sp_change_feed_enable_db` (Azure-native CDC) on the
  explicit toggle, idempotent, honest real error if not db_owner/unsupported tier.
  MirroringConfig gains backend:'azure-native-cdc' + note (downstream → ADLS
  Bronze Delta via ADF CDC / Synapse Link / Loom mirroring engine, no Fabric).
- mirroring route doc reframed; dead AzureSqlDatabaseEditor mirroring text fixed.
- The LIVE editor (UnifiedSqlDatabaseEditor) had NO mirroring surface — added a
  **Mirroring tab** (azure-sql family) that POSTs the route + shows the config.
- tsc clean on touched code (pre-existing untyped-`mssql`-import error tolerated by
  ignoreBuildErrors; not mine).

**Next:** task-015 (Power BI/PP navigators + import/export) or task-016 remainder
(geo/graph + #655), then 017/018 UI, 019-021 live, 022 docs.

### task-015 (slice) — Power BI Deployment Pipelines navigator ✅ (PR # pending)
- Built the deferred powerbi-tree "Deployment pipelines" node (was a static
  "coming" gate): real Power BI REST — `listPipelines` + `getPipelineStages` +
  `deployPipelineAll` in powerbi-client; new tenant-scoped route
  `/api/powerbi/pipelines` (GET list+stages, POST deployAll). Tree node
  lazy-loads on expand, lists pipelines → Dev/Test/Prod stages (+ bound
  workspace), with a Promote (deployAll 0→1 / 1→2) action per stage; honest SP
  gate / verbatim 401-403. tsc clean.
- task-015 stays `todo`: the Power Platform **import/export** (solution
  import/export vs maker-portal hand-off) remains.

**Next:** task-015 PP import/export, task-016 remainder, 017/018 UI, 022 docs.

### task-016 (slice) — PostgreSQL in-database query LIVE ✅ (PR # pending)
- Operator approved adding the `pg` driver. Added `pg`@^8.13.1 + `@types/pg` via
  **pnpm** (repo uses pnpm-lock.yaml — `pnpm install --no-frozen-lockfile`; npm
  install FAILS on this repo, "Cannot read properties of null (reading 'matches')").
- `postgres-flex-client.ts`: replaced the `queryGateReason`/`isPostgresQueryLive`
  honest-gate stubs with REAL `executePostgresQuery(fqdn, db, sql)` — `pg` Client,
  Entra token as password (scope https://ossrdbms-aad.database.azure.com/.default,
  Gov override via LOOM_POSTGRES_AAD_SCOPE), SSL, 30s statement timeout, lazy
  `await import('pg')`. New `postgresQueryGate()` honest-gates when
  LOOM_POSTGRES_AAD_USER unset (names the one-time pgaadauth_create_principal setup).
- Query route `/api/items/postgres-flexible-server/[id]/query` now resolves the
  server FQDN (getServer) + runs real SQL (was a 501 stub). The unified editor
  ALREADY POSTed here (Query tab + schema browser) — no editor wiring needed;
  updated the stale admin note (LOOM_POSTGRES_QUERY_LIVE → LOOM_POSTGRES_AAD_USER).
- Bicep-sync: `loomPostgresAadUser` param + LOOM_POSTGRES_AAD_USER env in
  admin-plane/main.bicep; documented in docs/fiab/v3-tenant-bootstrap.md. NOTE:
  bicep-touching PR adds the slow "Bicep Lint" required check.
- tsc clean on touched code (pre-existing px noise only). LIVE-VERIFY (operator):
  set LOOM_POSTGRES_AAD_USER + register the principal in PG; query attempts real
  exec and surfaces the real PG error otherwise.
- task-016 stays `todo` (geo/graph deferred edges + #655 notebook abfss
  auto-mount remain — both need live Spark/ADF to verify).

**Next:** task-018 page slices, or geo/graph (task-016 remainder), or operator
picks a live-Azure item (CDC mirroring, app-installs 019-021).

### task-018 (slice 2) — Governance classifications + sensitivity → LoomDataTable ✅ (PR # pending)
- Converted /governance/classifications "Applied classifications" table and
  /governance/sensitivity "Labeled items" table from raw Fluent `<Table>` to the
  shared **LoomDataTable** (sortable/filterable/resizable + standard empty state).
  Sensitivity keeps its label-distribution card filter (rows reflect the picked
  label). Open links stopPropagation. tsc clean.
- task-018 still `todo`. Remaining raw-table pages: governance/scans,
  governance/policies, governance/insights, workspaces, + high-traffic Home/Browse/Monitor.

### task-018 (slices 3-5) — more LoomDataTable conversions ✅ (PRs #742/#743 merged, +1 pending)
- #742 governance/scans (Registered data sources, with Scans/Remove row actions).
- #743 governance/policies (list, with enabled Switch + Delete + enforcement badge).
- pending: catalog/data-quality (rules list, with Edit/Delete actions).
- All: raw `<Table>` → shared LoomDataTable (sortable/filterable/resizable);
  interactive cells preserved via render columns + stopPropagation. tsc clean;
  console live-GREEN 34/34 across the batch.
- governance/insights was already on LoomDataTable. Remaining raw tables:
  catalog/{domains,metastores,[source]/[id]}, workspaces (selection checkboxes —
  needs care), + high-traffic Home/Browse/Monitor (bespoke layouts).
- GOTCHA reminder: after merging a PR I `git checkout main`; must create the NEXT
  feature branch BEFORE editing or commits land on local main (happened once on
  #742 — recovered via `git branch <new>` + `git reset --hard origin/main`).
