---
name: W11b-hardening-bicep
status: backlog
priority: P1
order: 29
depends_on: [W11a-chaos-dr, W09b-editors-admin, W07-search-performance-at-scale]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W11b — Alternate-region failover (bicep), scale-out and MPI, upgrade rehearsal, measured SLOs

Split from the old W11. Shared rules: `PRP.md` section 5.

## Goal
An alternate-region stamp with a region failover drill (replica promotion, Blob object replication, routing flip), scale-out from 1 to 3 stamps with measured linearity, MPI `$match` and bounded cross-stamp `$everything`, a blue/green engine upgrade rehearsal with an upstream watch job, and the measured SLO table, runbooks and cost views replacing the TARGET values.

## Why
`OPERATIONS-AND-BCDR.md` section 1 is a TARGET table; this wave measures it or marks each row "not measured: why" (D11 matching evaluation and D26 included).

## Scope / Non-goals
In: W11-4, W11-5, W11-6, W11-7. Out: Gov failover where no second Gov region is funded (stated per cloud), full-scale 10 M claims (W13).

## Acceptance criteria
- [ ] W11-4: RPO/RTO measured on a failover drill; the per-cloud table says which clouds were drilled. Fails if the table lists Gov as drilled without a Gov run id.
- [ ] W11-5: aggregate QPS with 3 stamps within 10 % of linear; MPI pointers are correct for every one of the 10 synthetic tenants' patients; matching precision and recall reported on synthetic data.
- [ ] W11-6: promotion is gated on SLO and conformance smoke; a rollback flip is timed; the watch job opens an issue on a seeded new upstream tag.
- [ ] W11-7: every TARGET row is replaced by a value with a receipt id or marked "not measured: why".

## Read first
`OPERATIONS-AND-BCDR.md` sections 1, 5, 7, 9, `AZURE-GOV-AVAILABILITY.md`, `adr/ADR-006-routing-mpi.md`, `adr/ADR-018-device-ingest-and-engine-upgrades.md` (upgrade policy), `platform/fiab/bicep/modules/health/stamp.bicep`, `W11a-chaos-dr.md` receipts.

## Owns
`platform/fiab/bicep/modules/health/stamp.bicep` (replication / alternate-region params; one bicep PR), `apps/loom-health-cp/src/jobs/failover-*.ts`, `apps/loom-health-cp/src/jobs/upgrade-*.ts`, `apps/loom-health-cp/src/mpi/**`, `tests/health/load/scale-out-*.js`, `.github/workflows/health-upstream-watch.yml`, `W11-RECEIPT.md`, `OPERATIONS-AND-BCDR.md` sections 1, 5, 7, `docs/fiab/health/runbooks/**` (other than W11a files). (Admin-page panels: see the Integration step in Steps.)

## Must NOT touch
Chaos and restore files (W11a), `engines.bicep`, editors, the rest of the admin page.

## Consumes
W11a measured restore and evacuation values, W1 routing, `health-params/*.bicepparam`, the bicep ledger. > ASSUMPTION: the alternate Gov region is not funded (Q1/Q2), so Gov failover is stated as not drilled.

## Provides
Measured SLO table, failover and MPI capability, upgrade rehearsal receipts for W12.

## Steps
1. W11-4 bicep (ledger first) and drill. 2. W11-5 and W11-6 beside it (different files). 3. W11-7 last, once receipts exist.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W11-4 | Alternate-region stamp + failover drill | W11-3 | Sonnet | required (bicep) | RPO/RTO measured |
| W11-5 | Scale-out 1 to 3 stamps, MPI, matching evaluation | W11-3 | Sonnet | none | Linearity within 10 %; MPI pointers |
| W11-6 | Blue/green engine upgrade rehearsal + watch job | W2, W3 | Sonnet | none | Gated promotion; rollback timed |
| W11-7 | Measured SLO table, runbooks, cost views | W11-4..W11-6 | Sonnet | none | No TARGET without receipt or reason |

### Integration step (serialized)
- `apps/fiab-console/app/admin/health-services/**`: cost and drill panels. Owner: `W09b-editors-admin` (now in `depends_on`). `tests/health/load/**` harness owner: `W07-search-performance-at-scale` (now in `depends_on`).

## Validation
```
cd apps/loom-health-cp && npx vitest run src/jobs src/mpi && npx tsc --noEmit -p tsconfig.test.json
make lint-bicep
az bicep build -f platform/fiab/bicep/health.bicep --stdout > /dev/null   # ARM size budget check
```
Receipts: Commercial failover drill run id; GCC-High: scale-out and upgrade rehearsal via Actions, failover only if a second Gov region is funded (stated). Mutation receipt on a sandbox copy: break the MPI pointer lookup and the pointer test goes red. "Merged, not deployed" until a run id exists. IL5, DoD, GCC supported-in-code only.

## Rollback
Alternate stamp parameter-gated and deletable; scale-out stamps are synthetic; upgrades roll back by the timed flip.

## Docs to update
`OPERATIONS-AND-BCDR.md`, runbooks, `ARCHITECTURE.md` section 6, `CAPACITY-MODEL.md` pointer to W13 for anything beyond scale-out linearity.

## Wave / Blocked-by / Branch / Worktree
`Wave: 9 · Blocked-by: W11a-chaos-dr, W09b-editors-admin, W07-search-performance-at-scale · Branch: feat/lhds-w11b-hardening-bicep · Worktree: E:/Repos/_lhds-w11b`

## Hot files
`platform/fiab/bicep/modules/health/stamp.bicep` (ledger), `apps/fiab-console/app/admin/health-services/**` (integration step). `touches_bicep: yes`.
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
```
Wave W11b (LHDS failover bicep, scale-out, MPI, upgrades, SLOs). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w11b, branch feat/lhds-w11b-hardening-bicep.
Read first: PRP.md (section 5), this file, OPERATIONS-AND-BCDR.md, adr/ADR-006, W11a receipts.
One bicep PR at a time (INTERLOCK.md). Gov failover only if a second Gov region is funded; otherwise state "not drilled".
Do W11-4 first (W11-5 and W11-6 in parallel), then W11-7.
Proof: cd apps/loom-health-cp && npx vitest run src/jobs src/mpi ; failover drill run id with RPO/RTO.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W11-4 | todo | | sonnet | | 2026-11-14 |
| W11-5 | todo | | sonnet | | 2026-11-14 |
| W11-6 | todo | | sonnet | | 2026-11-14 |
| W11-7 | todo | | sonnet | | 2026-11-14 |
