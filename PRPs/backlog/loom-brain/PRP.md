---
name: loom-brain
status: backlog
priority: P2
order: 3
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-08-23
issues: [3933, 3937, 4255, 4241]
---

# PRP (hub): Loom Brain - self-managing estate intelligence (re-baselined 2026-11-14)

Parent tracking issue: #3933 (OPEN). Reference design (mandate, graph substrate, detectors, security s3.7/3.8): `DESIGN.md` in this directory. Do not restate it here.
This hub replaces the old DRAFT PRP, which had only a Definition of Done and no work items. The Brain is largely BUILT; this PRP maps the DoD to code and hands the remainder to three small PRPs.

## 1. Goal
Close the gap between what is built in `apps/fiab-console/lib/brain/**` and `app/admin/brain/**` and the DESIGN s5 definition of done, in Commercial and Gov.

## 2. Why
The program started 2026-08-23 and shipped W1-W10 (graph, detectors, agents, cost, security layer, history, scheduler, Perform). What is left is operational (the nightly scan is red), applicability (0 of 17 recommendations approvable per #4255) and Gov parity (#3937).

## 3. Scope / Non-goals
Scope: the three child PRPs. Non-goals: autonomous mutation (decision 1: recommend-only, human approves), learned models (decision 2), non-Loom subscriptions, GCC exercised receipt (supported-in-code, never exercised).

## 4. Acceptance criteria
DESIGN s5 DoD, as baselined below. Each row must be confirmed LIVE before this program ships; code presence alone is "built, not verified live".

### DoD baseline (confirmed by path/symbol at origin/main ea1a38d72, 2026-11-14)
| DoD row (s5) | Code evidence | Status |
|---|---|---|
| Graph builds across all six subscriptions, node/edge counts reported | `lib/brain/graph/graph.ts`; `lib/brain/run/azure/arg-graph-source.ts` (`subscriptions` option); `lib/brain/run/report.ts`, `run/scan.ts` | BUILT. Live: UNVERIFIED and currently not producing; `loom-brain-scan.yml` last 3 scheduled runs failed (#4721: 10/10 failing since 2026-09-16) |
| Every detector returns `{findings, population}`; shrinking `judged` is P0 | `lib/brain/detectors/detector-kit.ts` (`Population`, blind/vacuity checks); `lib/brain/types.ts` `Population`; `lib/brain/run/population.ts` (`detectPopulationRegression`) | BUILT; guard-strength gaps open: #3963, #3964, #3967, #3970, #4379 |
| `loom-capacity-broker` appears as unreachable always-on node with evidence chain | `lib/brain/__tests__/detectors/acceptance-capacity-broker.test.ts`; `detectors/unreachable-service.ts`, `always-on-unused.ts` | BUILT as a fixture acceptance test. Live: UNVERIFIED (and `LOOM_BROKER_URL` is still `''` at `admin-plane/main.bicep:5336`, so the founding defect itself is unfixed; out of this PRP's scope, flagged) |
| Every detector reports examined population; mutation of subject changes verdict | `lib/brain/run/__tests__/mutation/`; security detectors under `lib/brain/security/detectors/` | BUILT; mutation arms not all in a workflow (#3970) |
| Cost labelled `billed` or `derived`, never conflated | `lib/brain/cost/figure.ts` (`BilledFigure`, compile-time guard), `export-reader.ts`, `derived.ts` | BUILT. Live Cost Management export read: UNVERIFIED |
| A recommendation can be reviewed and approved by a human; nothing executes without that | `app/api/admin/brain/{proposals,perform}/route.ts`; `lib/brain-actions/{guards,perform,executors}.ts`; Approve button in `app/admin/brain/recommendations.tsx` | BUILT, but 0 of 17 approvable until ownership is established (#4255) -> `brain-ownership` |
| Works in MAC and MAG, or untested boundary named | `loom-brain-scan.yml` has Commercial and Gov jobs; `lib/brain/run/azure/scan-credential.ts` | PARTIAL. Gov has no nightly scan (#4051); Gov W11 open (#3937) -> `brain-gov-parity` |
| Visualizer (s3.6) and synapse security view (s3.7) | `app/admin/brain/{brain-canvas,synapse-view,synapse-panel,recommendations}.tsx`; `lib/brain/security/**`; `lib/brain/history/**` | BUILT; readability/G1 receipts owed (#4241, #4242, #4251) |

Verdict: the DoD is substantially met IN CODE (5 of 7 rows built, 2 partial) and NOT met live. Proposed status: keep `backlog` until the three children are scheduled, then `active`; do NOT mark shipped (no live receipt exists; the scan is red). > ASSUMPTION: orchestrator decides the status move.

## 5. Read first
`DESIGN.md` s0, s3.1-3.2, s5; issue #3933 body; the DoD table above.

## 6. Owns
This directory only. Source ownership is declared per child.

## 7. Must NOT touch
`PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md` (orchestrator; REGISTER currently points at `active/loom-brain`, which is wrong: the PRP lives in `backlog/`).

## 8. Consumes
Estate-power pause contract; `loom-estate-id` tag (stamped by #4274, merged).

## 9. Provides
A measured Brain: fresh nightly graph (Commercial and Gov), approvable and batch-executable recommendations, per-cloud receipts.

## 10. Steps
Children and order (operator priority: ownership first because it blocks approvable actions, Gov second):

| Order | PRP | Wave | Blocked-by | Issues |
|---|---|---|---|---|
| 1 | `brain-ownership` | 1 | none | #4255 (#3922, #4241, #4242) |
| 2 | `brain-gov-parity` | 2 | `brain-scan-restore` | #3937, #4051 |
| (prereq for live receipts) | `brain-scan-restore` | 1 (parallel with ownership; disjoint files) | none | #4721 |

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W1-W10 build (graph, detectors, agents, cost, security, history, scheduler, Perform) | merged | | | code at ea1a38d72; fix PRs #4223, #4245, #4317, #3992; ownership #4267, stamp #4274 | 2026-11-14 |
| brain-ownership | todo | feat/brain-ownership-4255 | sonnet | #4255 open | 2026-11-14 |
| brain-scan-restore | todo | fix/brain-scan-restore-4721 | sonnet | #4721 open; latest 3 runs failed | 2026-11-14 |
| brain-gov-parity | todo | feat/brain-gov-3937 | sonnet | #3937, #4051 open | 2026-11-14 |

Not in these children (open Brain issues left as separate follow-ups, not lost): guard-strength #3963, #3964, #3967, #3970, #4029, #4379, #4807, #4016; UI #4251; false positive #4258.

## 11. Validation
Per child. Program done = DoD baseline all rows BUILT and LIVE-VERIFIED in Commercial and Gov, reported as merged / deployed / verified separately.

## 12. Rollback
Per child; all additive.

## 13. Docs to update
`docs/fiab/brain/` (ownership, per-cloud status).

## 14. Wave / Blocked-by / Branch / Worktree
Hub. See table in section 10.

## 15. Hot files
`loom-brain-scan.yml`: brain-scan-restore then brain-gov-parity (serialized). `recommendations.tsx`: brain-ownership only. touches_bicep: only `brain-gov-parity` (possible runner module); one bicep PR in flight across programs.

## 16. Kickoff prompt
```
Read PRPs/backlog/loom-brain/PRP.md (DoD baseline), then your child PRP and the DESIGN.md sections it cites.
Measure current live state first (approvable count, latest scan run) and record it; do not assume the baseline table is still true.
Proof of done is in the child's Validation section; report merged vs deployed vs verified separately.
```
