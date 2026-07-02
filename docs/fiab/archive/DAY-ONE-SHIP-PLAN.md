# CSA Loom — Day-One Ship Plan (Master, consolidated)

> Single source of truth for finishing CSA Loom to a **day-one-shippable** state.
> Created at the end of a very long session to survive a context reset. Pairs with:
> - `docs/fiab/audit/day-one-validation-matrix.md` (the honest PASS/FAIL matrix — the gate)
> - `docs/fiab/audit/live-ui-e2e-findings.md` (frontend findings log)
> - `docs/fiab/audit/full-e2e-audit-2026-06.md` (code audit, 974 findings)
> - `docs/fiab/audit/live-e2e-every-item-and-app-202606160304.md` (Wave-1 items)
> - `docs/fiab/audit/live-e2e-feature-surfaces-v2.md` (Wave-2 feature surfaces, 243 leaves, 107 UI updates)
> - memory: `csa_loom_v07_resume.md`, `csa_loom_live_provisioning_centralus.md`, `csa_loom_aca_managed_identity_bug.md`

## 0. THE MANDATE (operator, verbatim intent)
Validate + test **every item, every function, every capability, every app, every control-plane surface — anything a user could ever do — to work 100% end-to-end (backend + FRONTEND + Azure services + APIs)** before day-one ship. **No claims without frontend proof. No vaporware. No fake/missing datasets — every dataset an app bundle references must be hosted IN THE REPO and actually loaded/installed by the flow.** The operator has repeatedly caught "said fixed, isn't" — the root cause is validating via API/health instead of the real UI. **Rule: nothing is "done" until driven + observed in the browser.**

## 1. CURRENT STATE (as of context reset)
- **Live console:** `loom-console:v0.10` (single revision, 100% traffic, build-marker confirms live code; HTML served no-cache). Sub `<YOUR_SUBSCRIPTION_ID>`, rg `rg-csa-loom-admin-centralus`, host `csa-loom.limitlessdata.ai`.
- **main HEAD:** `e1ddbda6` — **AHEAD of live**: gated-services (#1424) + others are merged on main but NOT yet built/rolled → **v0.11 build owes**.
- **Releases:** 0.42.0, 0.43.0, 0.43.1, 0.44.0 cut.
- **FRONTEND-VERIFIED working** (trustworthy): AutoML (after AmlCompute+concurrency fix), Notebook (real Spark Livy session), App-install FinOps (real provisioning), CoE report viewer render, hub detection, /monitor.
- **FRONTEND-VERIFIED broken:** Lakehouse Inspector `synapse-serverless-sql-pool` step (scoped-credential/external-data-source on loom_lakehouse — MSI grant applied, NOT cleared); Shortcuts register (parser fixed, pending roll; bundle ships unreachable example data); right-click (reported, not reproduced); notebook perf/cell-edit (reported, not diagnosed).
- **Everything else = NOT frontend-tested.** Do not assume working.

## 2. OPEN PRs / branches to land into v0.11 (verify state at kickoff)
- `#1426` self-update-clean — in-product no-clone update path (clean reconstruction).
- `#1428` fix-dlz-setup-wizard — DLZ overview/visualize + setup-wizard UX + cross-sub deploy honest-gate.
- `fix-shortcut-parser` — branch pushed, **NO PR yet → open it** (blob/onelake URI support).
- `fix-bundle-real-datasets` — in flight (agent fix-bundle-datasets): real repo-hosted datasets + load wiring.
- AutoML concurrency-validation UI fix — **never opened, still owed** (cap max-concurrent ≤ cluster maxNodeCount in the AutoML Settings step).
- `#1423` release-please — cut release after the batch lands.
- ALREADY MERGED (on main, need v0.11 roll): #1424 gated-services, #1421 copilot-studio, #1422 map/mirror, #1415 deploy-parity, #1416/#1427 docs, #1419/#1420 UI waves.

## 3. LIVE config already applied (in bicep via deploy-parity #1415 + this session) — verify on clean deploy
AcaManagedIdentity credential fix; LA audience (api.loganalytics.io); hub auto-detect; built-in MCP function + LOOM_BUILTIN_MCP_URL + catalog deploy-env; ADX `loomdb-default`; AML env (un-mangled) + `cpu-cluster` AmlCompute; Synapse system MSI → Storage Blob Data Contributor on ADLS (via az rest); Synapse Entra SQL admin = UAMI; EH `loom-telemetry` + EG defaults; Purview Data Map roles; Console UAMI Reader at subscription; LOOM_VERSION→0.43.1. **Deploy-parity #1415 mirrored most into bicep; cross-check each on a fresh deploy.**

## 4. CONSOLIDATED BACKLOG (prioritized) — nothing lost
### P0 — broken basics a user hits immediately (frontend-verify each fix)
1. **Lakehouse Inspector serverless-SQL** — diagnose the scoped-credential/external-data-source creation on the serverless endpoint directly (connect as UAMI; CREATE DATABASE SCOPED CREDENTIAL + EXTERNAL DATA SOURCE on loom_lakehouse); confirm after MSI grant propagation. Fix in the serverless provisioner + bicep/bootstrap.
2. **App-bundle real datasets** (fix-bundle-datasets in flight) — all 29 bundles: real data in repo + actually loaded. Verify in UI per bundle.
3. **Shortcuts** — parser fix (done, roll in v0.11) + bundle shortcuts point at real/loaded data or anonymous-public support; verify register + query in UI. Right-click context menu — reproduce + fix.
4. **Notebook** — perf (cold-start UX), cell editing, error surfaces — reproduce + fix.
### P1 — every ITEM (104) end-to-end in the UI
Drive New→item→create→primary action for all 104; fix each FAIL. (Wave-1 #1414 addressed 13 broken at code level but NONE frontend-verified.)
### P2 — every APP (29) install→provision→load data→use, in the UI
Only FinOps PASS, Lakehouse Inspector FAIL. Do all 29.
### P3 — every FEATURE SURFACE (243 leaves) + CONTROL PLANE
RTH, RTI catalog, Activators, Mirroring (all sources), APIs, Warp/Weave, Workload Hub, Connections, Business Events, Event Hubs, git/deploy pipelines, ALL admin pages, Setup Wizard, DLZ. (Wave-2 found 15 broken + 107 UI updates; 26 UI done; rest queued + none frontend-verified.)
### P4 — honest-gated services actually work day-one
DAB runtime (deployed), Weave-PG (deployed; needs AGE bootstrap as UAMI), dbt-runner (image not built — BUILD IT), EH-receive (activates v0.11). Verify each in UI.
### P5 — tutorials build-as-written; #229 PE hardening; medium parity tail; param-256 bicep consolidation (admin-plane at ceiling).

## 5. EXECUTION METHOD (new loops/workflows — trustworthy by construction)
- **Validation loop (per surface):** drive in authenticated browser → observe → record PASS/FAIL+evidence in the matrix → if FAIL, fix (code PR / live az / bicep) → re-drive → flip PASS only on observation. NO exceptions.
- **Fix generation (parallel OK):** agents/workflows may generate FIX PRs in parallel (worktree-isolated — beware branch contamination; ALWAYS diff-verify two-dot vs main before merge). But **validation is browser-observed by the lead, not the agent.**
- **Per-version frontend re-validation:** after every image roll, re-drive the changed surfaces in the UI before claiming.
- **Datasets:** real data in repo + installer uploads/loads it + verified queryable in UI.
- **Cadence:** report honest counts (N driven / M PASS / K FAIL / rest NOT-TESTED). Never "100%" until the matrix is all-PASS.
- **az gotcha:** `az role assignment create` intermittently fails `MissingSubscription` under agent contention → use `az rest` PUT for role assignments; don't run two live workflows at once.
- **build/roll recipe:** `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`; toggle ACR public → `az acr build ... --no-logs` → re-lock (Deny + public-disabled) → `az containerapp update --image`.

## 6. KICKOFF (fresh context window)
1. Read this file + `day-one-validation-matrix.md` + the memory files.
2. Land the open v0.11 batch: open the fix-shortcut-parser PR; diff-verify (two-dot vs main) + merge #1426, #1428, fix-shortcut-parser, fix-bundle-real-datasets, the AutoML-concurrency PR; build + roll **v0.11**; cut the release (#1423).
3. Re-pair the operator's authenticated Chrome (claude-in-chrome) → begin the **validation loop** at P0, working down. Fix→reroll→re-verify.
4. Update the matrix continuously (committed) as the auditable ship-readiness record.

## 7. WORKTREE CLEANUP (do FIRST in the fresh session, before new work)
This session + the prior one left ~15+ agent worktrees under `.claude/worktrees/agent-*` (each isolation:worktree agent). Most are for ALREADY-MERGED PRs; they hold branch locks (caused "cannot delete branch used by worktree" errors) + consume disk. **Before starting new work in the fresh context:**
1. Confirm no agent is still running (this session's last in-flight: `fix-bundle-datasets` → `fix-bundle-real-datasets` branch/PR; everything else done/merged). Do NOT remove a running agent's worktree.
2. Remove all agent worktrees + prune + delete merged branches:
   ```bash
   cd /e/Repos/GitHub/csa-inabox
   git worktree list | grep '/.claude/worktrees/agent-' | awk '{print $1}' \
     | while read w; do git worktree remove --force "$w"; done
   git worktree prune
   # delete local branches already merged to origin/main (keep open-PR branches):
   git fetch origin --prune
   git branch --merged origin/main | grep -vE '^\*|main' | xargs -r git branch -D
   ```
3. Open-PR branches to KEEP until merged: `self-update-clean` (#1426), `fix-dlz-setup-wizard` (#1428), `fix-shortcut-parser` (#1429), `fix-bundle-real-datasets` (pending), `docs-ship-plan` (#? these docs), the AutoML-concurrency branch (owed). Their worktrees can be removed once their PRs merge.
4. The primary checkout (`E:/Repos/GitHub/csa-inabox`) is currently on branch `docs-ship-plan` — switch it back to `main` (`git checkout main && git pull`) at kickoff.

## 8. MEMORY POINTERS (don't lose)
- `csa_loom_v07_resume.md` — version/roll history + live fixes + deep-E2E status.
- `csa_loom_live_provisioning_centralus.md` — full live provisioning ledger.
- `csa_loom_aca_managed_identity_bug.md` — the credential root-cause (do not re-litigate).
- All `docs/fiab/audit/*.md` — the audit reports + this matrix.
