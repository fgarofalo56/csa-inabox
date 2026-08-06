# FINISHLINE session notes

## Session 1 — 2026-08-06 (initializer + Wave 0 + Wave 1/2 entries)

**Initializer verification pass (measured, not assumed):**
- Seed 49f38c08 merged as PR #3049 → main fbe51385. PRP + AUDIT in tree; June
  ledger archived to `.harness/archive/2026-06-05/`.
- `state.json` seeded: 39 AUDIT rows → agent tasks + operator-status tasks, with
  a 10-entry operator_queue (now 16).
- Live cross-check at init: `gov-uc-purview-wire` (G1) was IN FLIGHT, then
  **CANCELLED** ~20 min in (run 31118998951) — G1 remains operator-gated.
- Release PR #3045 merged (0.88.1) under standing approval.

## THE BLOCKER THAT SHAPED THIS SESSION

**GitHub Actions has been in a major outage since ~16:55Z** (githubstatus:
`Actions = major_outage`, confirmed repeatedly through 20:00Z+). Every PR's
required checks are QUEUED, none started. Nothing was `--admin`-merged past
them: these checks are not stale, they never ran. **10 PRs are queued.**

## STATE: 9 tasks implemented + reviewer-verified in one session

| Task | Status | PR | Reviewer verdict |
|---|---|---|---|
| C9 verify-then-close | **done** | — | PASS 6/6, receipts reproduced |
| D1 risingwave | review | #3054 | PASS 6/6, mutation proof re-run |
| D3 degraded apps | review | #3052 | PASS 6/6, cross-checked to the digit |
| D9 uat CVE | review | #3055 | PASS 5/5, binaries downloaded + verified |
| E1 eval judge | review | #3053 | PASS 6/6, bicep recompiled byte-identical |
| D2 loom-unity | review | #3057 | PASS 6/6, mutation proof re-run |
| D4+D5+D6 brownfield | review | #3058 | PASS 7/7, mutation proof re-run |
| D15 honest scoring | review | #3051 | post-merge receipts owed |
| D13 workflow hygiene | review | #3061 | PASS (orchestrator-inline; agent gate died on API spend limit) |
| D10 inert plumbing | review | #3062 | PASS structural (orchestrator-inline) |
| ledger | — | #3059 | — |

**Live estate wins (verified by az, not by merge):** loom-risingwave Running for
the first time ever; loom-wrangler-host + loom-script-runner + loom-migrate all
Running; loom-unity Healthy/Running on Commercial with Entra auth + postgres +
console principal auto-bound; eval judge scoring again (cap 500→5000).

## AUDIT CORRECTIONS FOUND BY MEASUREMENT (do not re-litigate)

- **D2 premise was STALE**: #3013 (c74d7fea, 08-05) already wired the unity
  modules; params are 234/256, not capped; the workflow comment is TRUE. The
  real defects were a wrong Commercial privatelink zone, an inert classpath
  patch (v0.5.1 override never shipped → **#3060**, Gov exposure), and an
  unrendered authorizer key.
- **D4b**: not "empty record set" — APIM PremiumV2 reports `privateIPAddresses:
  null` deterministically; the live 10.0.4.4 record would have been WIPED.
- **D5**: the deny fires at Purview RP preflight over managed storage and is
  INVISIBLE to the deploy identity's policy API — honest preflight is
  what-if/validate itself.
- **E1**: root cause was the daily judge cap, not the deployment chain; and the
  gate will stay red on **three** surfaces (data-agent 0.1, eventstream 0.333,
  rbac 0.417), not rbac-only. **E2 re-scoped.**
- **D10 ×2 "real but worse"**: the wizard called an even weaker route with a
  coverage-counting lie; the deploy route ignored the wizard's whole plan, and
  #3013's claimed transport guard doesn't exist. #3017's guard half was already
  fixed by #3018.
- **D13**: `LOOM_MSAL_SECRET_ROTATED` exists NOWHERE in the repo (live marker
  hand-set, 2 rotations stale); masked guard steps were 75, not ~30.

## NEW ISSUES FILED THIS SESSION

- **#3056** internal-token rotation drift (broke 3 consumers; re-detonates on
  the next admin-plane deploy — on OP-13's watch list).
- **#3060** Gov unity catalog runs with the #1603 v0.5.1 override INERT.
- **#3063** `azure-mgmt-resource>=23.2.0` breaks under v24 (latent CI break).
- **#2678 REOPENED** (env bindings never applied) → new task D18.

## RESUME TRAIL — do this first next session

1. **Check the outage**: `curl -s https://www.githubstatus.com/api/v2/status.json`.
2. **Merge queue, IN THIS ORDER** (#3058 before #3062 — they share
   `brownfield.md` + `failure-recovery.md`; rebase #3062's doc hunks):
   #3054 (needs update-branch, BEHIND) · #3051 · #3052 · #3055 · #3053 ·
   #3057 · #3058 · #3062 · #3061 · #3059 (ledger).
   Checks green → `--squash`. WATCH main's run after each.
3. **Owed live receipts** (the difference between review and done):
   - D15: build-marker past merge SHA, then `gh workflow run loom-ui-verify.yml
     --ref main -f target_route=/admin/env-config` and `/admin/readiness`.
   - D9: green `full-app-deploy-commercial` → closes #3024/#3036.
   - D2: full-app-deploy (image producer) + bootstrap (unseal must no-op) +
     attended deploy wires Console `LOOM_UNITY_*`.
   - D13: guardrails green in CI + a 2-mutant branch showing BOTH red.
   - D10: Commercial roll + Gov `whatif-only` gcch dispatch.
   - D3: ui-verify run 31123017609 (queued) for `/admin/migrate`.
4. **Then Wave 2**: D7+D8 (need D4-D6 merged), D14, G2/G3/G4, E2 (re-scoped to
   3 surfaces), C1, C7.

## OPERATOR QUEUE (16 items — see `state.json.operator_queue`)

Highest leverage: **OP-13** (attended D4-D6 proving deploy, with the #3056
token-overwrite watch), **OP-1** (G1 Gov unity auth still DISABLED live —
needs a real 3.5-4.5h window or interim IP-restrict), **OP-6/#2330** (Gov SP
UAA grant), **OP-11** (#2678 audience registration a/b/c), **OP-4** (svc-postgres
cost ruling), **OP-16** (three D13 decisions).

## HAZARDS CONFIRMED THIS SESSION

Never `git stash` (repo-global). Every agent in its OWN worktree. `git show
<ref>:<path>` needs `MSYS_NO_PATHCONV=1` in Git Bash. `json.load` needs
`encoding='utf-8'` (cp1252 crash). Direct push to main is rule-blocked — ledger
goes through a PR. Deploy identity lacks `tags/write` on the ACR, so #2603
leases run unleased (OP-15).
