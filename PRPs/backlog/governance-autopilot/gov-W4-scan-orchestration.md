---
name: gov-W4-scan-orchestration
status: backlog
priority: P2
order: 19
depends_on: [gov-W2-ges-core]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w4-scan-orchestration
---
# W4 - Scan orchestration: create, run, schedule, read back, retries, failure classes, cost guard, pause contract

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
Given a binding, create the Purview data source and scan, run it, schedule it, read the result back, classify failures, retry what is transient with bounded backoff, and skip (with a visible reason, never auto-resume) when the source compute is paused.

## 2. Why
Scans are the half of enrollment that produces classifications. Today auto-onboard registers sources only. D1/D6 decisions apply (scans on by default with caps; skip when paused). DESIGN s5.5.

## 3. Scope / Non-goals
In: `lib/governance/enrollment/scans/**` (new), additive functions in `lib/azure/purview-client.ts` (scan trigger schedule, run read-back; no signature changes), new `governance-scan` JobKind in `lib/scheduler/run-adapters.ts`. Non-goals: triggers (W5a), grants (W3), labels (W6).
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] A paused-ADX fixture yields `skipped: paused` and ZERO scan API calls; one call fails.
- [ ] Retry exhaustion ends in `failed`, never retries forever; a retry loop that cannot fail is a defect (`deploy-integrity.md` R6).
- [ ] Each failure class (transient, config, permission naming exact role+scope, quota) has an injected-failure test with a distinct remediation string.
- [ ] Live receipt: one scan Created, run started, `Succeeded`, asset count read back; an unmeasured count is written as "not measured: <why>".

## 5. Read first
- `apps/fiab-console/lib/azure/purview-client.ts` (Data Map calls, W0-RECEIPT s2c)
- `apps/fiab-console/lib/scheduler/run-adapters.ts` (JobKind pattern)
- W0-RECEIPT.md s5 (scan cost), s10 (live Commercial run receipt), s2d (gates)
- DESIGN.md s5.5, s10, s11 D1/D6

## 6. Owns
- `apps/fiab-console/lib/governance/enrollment/scans/**` (new)
- `apps/fiab-console/lib/azure/purview-client.ts` (additive functions only)
- `apps/fiab-console/lib/scheduler/run-adapters.ts` (one new JobKind)
- tests for the above

## 7. Must NOT touch
- `lib/governance/enrollment/` files owned by W2 except to import
- `item-crud.ts`, `purview-autoonboard.ts`
- bicep

## 8. Consumes
- gov-W2 binding store + `enroll` core
- W3 grants for the LIVE receipt only (code and tests do not wait)
- pause contract of the estate-power program (DESIGN s5.5)

## 9. Provides
- `runScanForBinding(binding)` + failure-class enum consumed by W5a, W7b, W8a
- additive Purview client scan functions

## 10. Steps
1. Add the Purview client scan functions (additive).
2. Implement scan create/run/schedule/read-back with the failure classifier and bounded retry.
3. Cost guard: concurrency 2 and a daily full-scan cap from env; pause contract skip.
4. Register the `governance-scan` JobKind.
5. Injected-failure tests then a live Commercial receipt once W3 is deployed.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/governance
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/governance lib/scheduler
Mutation (sandbox copy): remove the paused-skip branch; the paused-ADX test must go RED.
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Revert the PR; scans are created only for bindings, which W5a has not yet wired, so nothing is orphaned. Any live receipt scan is deleted with the `deleteScan` function.

## 13. Docs to update
DESIGN.md s5.5 if failure classes change.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: gov-W2-ges-core · Branch: feat/gov-w4-scan-orchestration · Worktree: E:/Repos/_gov-w4

## 15. Hot files
`purview-client.ts` (this wave is the only editor in the program), `run-adapters.ts`. touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.5 and W0-RECEIPT.md s2c/s10, then implement lib/governance/enrollment/scans/**. Proof: vitest on lib/governance + lib/scheduler, paused-skip mutation RED in a sandbox copy, and (after W3 is deployed) one live scan Succeeded with asset count; otherwise say "live receipt pending W3".
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W4-1 purview-client scan functions (additive) | todo | | sonnet | | |
| W4-2 scan create/run/schedule/read-back | todo | | sonnet | | |
| W4-3 failure classes + bounded retry | todo | | sonnet | | |
| W4-4 cost guard + pause skip | todo | | sonnet | | |
| W4-5 JobKind + live receipt | todo | | sonnet | | |
