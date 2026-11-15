---
name: gov-W5b-reconcile-job-and-native-scanner
status: backlog
priority: P2
order: 21
depends_on: [gov-W5a-triggers-and-reconcile-route, gov-W3-permissions-infra]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w5b-reconcile-job
---
# W5b - Reconcile Container App Job (bicep) and the native Loom scanner for boundaries without Data Map scanning

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
A Container App Job calls the internal reconcile route on schedule (D3/D11), and `apps/fiab-governance-scanner` provides a bounded-pattern native scan for IL5 `atlas-aks` and DoD where Purview scanning is unavailable (D7), disclosed as a subset.

## 2. Why
Without the job the sweep never runs; without the native scanner IL5/DoD get no classification (cloud-parity.md: the lacking service is the start of the design problem). DESIGN s5.2, s5.12, D7, D11.

## 3. Scope / Non-goals
In: `governance-reconcile-job.bicep` (new), wiring + params, `apps/fiab-governance-scanner/**` (new). Non-goals: UI, labels. IL5/DoD remain supported-in-code, never exercised; the PR must say so.
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] `az bicep build` exits 0 for the module and every boundary params file; What-If lists the job; a boundary with no job fails the per-boundary check.
- [ ] Job run (Commercial) hits the route with the service identity and returns a swept-count > 0 on an estate with bindings; a run that sweeps 0 reports its population (0 examined) rather than success.
- [ ] Native scanner flags a seeded SSN-pattern fixture and does NOT flag a near-miss; the pattern subset is listed in the docs.

## 5. Read first
- gov-W5a route contract
- `platform/fiab/bicep/modules/**` existing Container App Job modules (pattern)
- DESIGN.md s5.12, s11 D3/D7/D11
- `PRPs/reference/INTERLOCK.md`

## 6. Owns
- `platform/fiab/bicep/modules/**/governance-reconcile-job.bicep` (new)
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (job wiring lines; serialized after W3)
- `platform/fiab/bicep/params/*.bicepparam` (job schedule params; serialized after W3)
- `apps/fiab-governance-scanner/**` (new)
- image matrix entry only if unavoidable (hot file: serialized integration step)

## 7. Must NOT touch
- W3 modules
- `apim.bicep`, `health.bicep`
- the route (W5a)

## 8. Consumes
- gov-W5a reconcile route
- gov-W3 merged AND its bicep PR closed (one bicep PR in flight)

## 9. Provides
- scheduled self-heal sweep
- native scan path for atlas-aks/DoD

## 10. Steps
1. Wait for the interlock slot; bicep job module + params.
2. Scanner app with bounded pattern set and tests.
3. Image build wiring as a serialized integration step.
4. What-If per boundary; Commercial live run.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/governance
pnpm --dir apps/fiab-console exec tsc --noEmit
az bicep build on module + each params file
pnpm --dir apps/fiab-console exec vitest run  (scanner tests under its own package: run its test script)
Actions What-If run ids (Commercial, GCC-High)
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Disable the job schedule param; revert the module. The native scanner is not deployed unless a boundary opts in.

## 13. Docs to update
W10 writes the walkthrough; record scanner pattern list in DESIGN.md s5.12.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: gov-W5a-triggers-and-reconcile-route, gov-W3-permissions-infra · Branch: feat/gov-w5b-reconcile-job · Worktree: E:/Repos/_gov-w5b

## 15. Hot files
`admin-plane/main.bicep`, `params/*.bicepparam`, build-fiab-images matrix. ONE bicep PR at a time. touches_bicep: yes
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.12 and PRPs/reference/INTERLOCK.md; stop if another bicep PR is open or W3 is unmerged. Build the job module and apps/fiab-governance-scanner. Proof: az bicep build, What-If run ids, one Commercial job run with swept-count and population.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W5b-1 reconcile job bicep + params | todo | | sonnet | | |
| W5b-2 native scanner app | todo | | sonnet | | |
| W5b-3 image matrix integration step | todo | | sonnet | | |
| W5b-4 What-If + live run receipt | todo | | sonnet | | |
