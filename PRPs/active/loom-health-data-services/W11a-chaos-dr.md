---
name: W11a-chaos-dr
status: backlog
priority: P1
order: 28
depends_on: [W02b-fhir-core-ops, W03b-dicom-core-b]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W11a — Chaos suite, backup/restore drills, stamp evacuation

Split from the old W11 (14 sessions, 7 items). W11b holds failover bicep, scale-out and MPI, upgrade rehearsal and the measured SLO table. Shared rules: `PRP.md` section 5. W11 does not need W9 (`PRP.md` section 2).

## Goal
Chaos drills (pod kills, PostgreSQL HA failover during writes, Blob 503 injection, PDP outage), backup/restore drills (tenant PITR to scratch, full-stamp restore) with measured RPO/RTO, and the stamp evacuation job (drain, copy, outbox replay, cutover, verification, read-only retention, crypto-shred) with its quarterly drill.

## Why
`OPERATIONS-AND-BCDR.md` carries TARGET numbers; sections 4 and 6 have no measured value until these drills run.

## Scope / Non-goals
In: W11-1, W11-2, W11-3. Out: alternate-region failover, scale-out, MPI, upgrades, SLO table (W11b). Drills run on synthetic tenants only.

## Acceptance criteria
- [ ] W11-1: zero committed writes lost across a PostgreSQL HA failover during writes (acked count equals stored count); PDP outage returns deny for every request; duplicates equal 0. Fails if one acked write is missing.
- [ ] W11-2: restored row counts and hashes equal the source at the restore point; durations recorded as measured RPO/RTO. Fails if the restore reads from the live database instead of the backup.
- [ ] W11-3: counts and hashes equal across source and target stamps; write freeze at most 60 s measured; crypto-shred only after an explicit confirm and a read-back that the source is unreadable.

## Read first
`OPERATIONS-AND-BCDR.md` sections 4, 5, 6, `TEST-STRATEGY.md` section 6, `apps/loom-health-cp/src/jobs/runner.ts`, `adr/ADR-003-fhir-persistence-sharding.md`, `adr/ADR-005-stamp-control-plane.md`, `adr/ADR-012-encryption-keys.md`, `.github/workflows/deploy-health.yml`.

## Owns
`tests/health/chaos/**`, `.github/workflows/health-chaos.yml`, `apps/loom-health-cp/src/jobs/restore-drill.ts`, `apps/loom-health-cp/src/jobs/evacuate-*.ts`, `OPERATIONS-AND-BCDR.md` sections 4 and 6 (measured values), `docs/fiab/health/runbooks/restore.md`, `evacuation.md`.

## Must NOT touch
`platform/fiab/bicep/**` (W11b), the admin page, SLO section 1 of `OPERATIONS-AND-BCDR.md` (W11b).

## Consumes
W02b and W03b deployed stamps; W1 job runner and routing; Chaos Mesh (Gov substitute per `AZURE-GOV-AVAILABILITY.md` section 2).

## Provides
Measured restore and evacuation values and drill receipts consumed by W11b and W12.

## Steps
1. W11-1 chaos suite. 2. W11-2 restore drills. 3. W11-3 evacuation (Opus design pass first). Run drills only with the estate unpaused and the operator informed.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W11-1 | Chaos suite and workflow | W2, W3 | Sonnet | none | Zero lost writes; fail closed; duplicates 0 |
| W11-2 | Backup/restore drills | W11-1 | Sonnet | required (touches production backups tooling) | Counts and hashes equal; durations recorded |
| W11-3 | Stamp evacuation job and quarterly drill | W11-2 | Opus design, Sonnet implement | required | Counts and hashes equal; freeze at most 60 s |

## Validation
```
cd apps/loom-health-cp && npx vitest run src/jobs && npx tsc --noEmit -p tsconfig.test.json
gh workflow run health-chaos.yml   # then gh run view <id> for the receipt
```
Receipts: Commercial drills with run ids; GCC-High chaos and restore drill via Actions; an evacuation drill states which clouds were drilled. Mutation receipt on a sandbox copy: break the outbox replay and the equal-counts check goes red. "Merged, not deployed" until a run id exists. IL5, DoD, GCC supported-in-code only.

## Rollback
Drills use synthetic tenants; evacuation never deletes the source until explicit confirmed crypto-shred; disable the workflow.

## Docs to update
`OPERATIONS-AND-BCDR.md` sections 4 and 6, runbooks, `TEST-STRATEGY.md` section 6 receipts.

## Wave / Blocked-by / Branch / Worktree
`Wave: 6 · Blocked-by: W02b-fhir-core-ops, W03b-dicom-core-b · Branch: feat/lhds-w11a-chaos-dr · Worktree: E:/Repos/_lhds-w11a`

## Hot files
`OPERATIONS-AND-BCDR.md` (sections 4 and 6 only here; section 1 is W11b). `touches_bicep: no`.

## Kickoff prompt
```
Wave W11a (LHDS chaos, restore, evacuation). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w11a, branch feat/lhds-w11a-chaos-dr.
Read first: PRP.md (section 5), this file, OPERATIONS-AND-BCDR.md sections 4-6, TEST-STRATEGY.md section 6.
Drills on synthetic tenants only; check the estate is not paused. Opus for the W11-3 design pass only.
Do W11-1, W11-2, W11-3.
Proof: gh run view <health-chaos run id> shows zero lost writes and duplicates 0.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W11-1 | todo | | sonnet | | 2026-11-14 |
| W11-2 | todo | | sonnet | | 2026-11-14 |
| W11-3 | todo | | opus | | 2026-11-14 |
