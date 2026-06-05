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
