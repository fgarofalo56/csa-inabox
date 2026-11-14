---
name: gov-W3-permissions-infra
status: backlog
priority: P2
order: 18
depends_on: [gov-W2-ges-core]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w3-permissions-infra
---
# W3 - Permissions as infrastructure (Purview MSI scan grants, bootstrap steps, read-back script)

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
The Purview managed identity and Console UAMI hold every role the scans need on every backing source type, deployed by bicep and the post-deploy bootstrap in every supported boundary, with a read-back script that fails on a missing assignment.

## 2. Why
auto-bind-by-default.md: a scan that needs a hand-run grant is a defect. Today the grants are partial (`grant-purview-datamap-role.sh`). W4 cannot get a live receipt without them. DESIGN s5.6.

## 3. Scope / Non-goals
In: new `purview-scan-grants.bicep` module, wiring in `catalog.bicep`, landing-zone and admin-plane `main.bicep` (env only), params for all boundaries, bootstrap grant steps (Purview/Synapse/ADX/SQL only). Non-goals: scan logic (W4), any other bicep change. Role assignment is account-level, read-only, condition-free so it survives per-workspace-spark-identity ABAC (DESIGN s6.3).
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] `az bicep build` on each touched module exits 0; `lint-bicep` exits 0.
- [ ] What-If (Actions) for Commercial and GCC-High lists the new role assignments; a What-If with 0 added assignments fails (blind what-if is reported as such: what-if is blind to nested modules, read the deployed state).
- [ ] `scripts/measure/governance-permissions.mjs` exits non-zero when one Purview-MSI assignment is deleted (run on a sandbox fixture) and 0 when all exist.
- [ ] Post-deploy read-back in Commercial lists every expected assignment; any missing one is named by principal and scope.

## 5. Read first
- `platform/fiab/bicep/modules/admin-plane/catalog.bicep`
- `scripts/csa-loom/grant-purview-datamap-role.sh`
- `.github/workflows/csa-loom-post-deploy-bootstrap.yml`
- W0-RECEIPT.md s2b (Synapse grant mechanism), s2e (per-cloud endpoints)
- DESIGN.md s5.6, s6.3
- `PRPs/reference/INTERLOCK.md` (bicep ledger)

## 6. Owns
- `platform/fiab/bicep/modules/admin-plane/purview-scan-grants.bicep` (new)
- `platform/fiab/bicep/modules/admin-plane/catalog.bicep`
- `platform/fiab/bicep/modules/landing-zone/main.bicep` and `admin-plane/main.bicep` (env wiring lines only)
- `platform/fiab/bicep/params/*.bicepparam` (all boundaries)
- `scripts/csa-loom/grant-purview-datamap-role.sh`
- `.github/workflows/csa-loom-post-deploy-bootstrap.yml` (grant steps only)
- `scripts/measure/governance-permissions.mjs` (new)

## 7. Must NOT touch
- `apim.bicep`, `health.bicep`, `main.json` hand edits
- any non-governance role assignment
- spark-identity storage modules

## 8. Consumes
- gov-W2 `backingStore` map (which principals/scopes)
- a green Commercial deploy receipt (`deploy-integrity.md` R1) and a free slot in the bicep interlock

## 9. Provides
- deployed grants W4 live receipt needs
- `governance-permissions.mjs` read-back used by W9 and W10

## 10. Steps
1. Confirm the interlock ledger has no open bicep PR and the last Commercial deploy is green; otherwise stop.
2. Write the module from the W2 backingStore map.
3. Wire env vars and params for every boundary (GCC-High and IL5/DoD params included).
4. Add bootstrap steps and the read-back script.
5. Dispatch What-If via Actions for Commercial and GCC-High.

## 11. Validation
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/run-tests.ps1 -Fast
pnpm --dir apps/fiab-console exec tsc --noEmit
az bicep build --file platform/fiab/bicep/modules/admin-plane/purview-scan-grants.bicep
node scripts/measure/governance-permissions.mjs --cloud commercial  (post-deploy; paste exit code)
Gov: GitHub Actions What-If run id recorded; never local az
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Remove the role assignments by reverting the module; assignments are additive and read-only so removal only stops scans. Deployed state is not auto-removed: delete via the same module with `enabled=false`.

## 13. Docs to update
`docs/fiab/purview-setup.md` link (W10 writes the walkthrough).

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: gov-W2-ges-core · Branch: feat/gov-w3-permissions-infra · Worktree: E:/Repos/_gov-w3

## 15. Hot files
`catalog.bicep`, `admin-plane/main.bicep`, `params/*.bicepparam` (ONE bicep PR in flight across all programs; W5b queues behind this). touches_bicep: yes

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.6/s6.3, W0-RECEIPT.md s2b, and PRPs/reference/INTERLOCK.md first; stop if another bicep PR is open. Proof: az bicep build on touched modules, Actions What-If run ids for Commercial and GCC-High, governance-permissions.mjs exit code. Report merged vs deployed separately.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W3-1 purview-scan-grants.bicep + catalog wiring | todo | | sonnet | | |
| W3-2 params all boundaries | todo | | sonnet | | |
| W3-3 bootstrap grant steps | todo | | sonnet | | |
| W3-4 governance-permissions.mjs read-back | todo | | sonnet | | |
| W3-5 What-If receipts Commercial + GCC-High | todo | | sonnet | | |
