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
