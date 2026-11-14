---
name: spark-id-W00-spike
status: backlog
priority: P2
order: 1
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
branch: spike/spark-identity-w00
---
# W00: Measurement spike (live Synapse, four boundaries)

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Replace the design assumptions about Synapse passthrough, batch identity, ABAC availability and submitter-host limits with measurements, and record a go/no-go on ABAC (b1) vs ACL (b2) per boundary.

## Why
The whole design (option b) rests on facts taken from docs: that a Livy session created with a UAMI token does ADLS I/O as that UAMI, and that ABAC path conditions work in each Gov boundary. Nothing in this repo has measured either. No W0 receipt, spike report or GitHub issue exists (grep 2026-11-14). Every later wave is blocked until this lands.

## Scope / Non-goals
Nine measurements (below) across Commercial, GCC-High, IL5 and (if a tenant exists) GCC. Evidence document only. Non-goals: any product code, any bicep change, any change to shared grants.

## Acceptance criteria
Each names the value or output that would make it fail.
- The spike report `docs/fiab/spikes/spark-identity-w0.md` exists and has one filled receipt (template below) per boundary; a boundary with no measurement says `not-exercised` and why. Fails if any of the 9 measurements has an empty value cell or a boundary row is missing.
- Measurement 1 states the observed storage identity (object id) for a session created with a `uami-ws-*` token, read from ADLS diagnostic logs or `mssparkutils` token claims. Fails if the report asserts passthrough without an object id that differs from the Console UAMI and the Synapse MSI.
- Measurement 5 records the HTTP status of a rename from inside the scoped root to outside it under the ABAC condition. Fails if the status is not 403 and the report still recommends (b1).
- Measurement 4 records the ABAC condition byte size at 50 roots and the platform maximum; if it exceeds the maximum, the report names the split rule.
- The go/no-go row names (b1) or (b2) per boundary with a one-line reason; IL5 and GCC-High default to (b2) when ABAC is unconfirmed.

## Read first
- `PRPs/backlog/per-workspace-spark-identity/REFERENCE.md` sections 2.1, 2.5, 2.6, 3
- `apps/fiab-console/lib/azure/synapse-dev-client.ts` `createLivySessionAsync`, `submitLivyBatch`
- `apps/fiab-console/lib/azure/workspace-identity-client.ts` `getWorkspaceCredential`
- `platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep` `blobOnlyCondition`
- `docs/fiab/runbooks/workspace-identity-grants.md`; `PRPs/active/loom-health-data-services/W0-RECEIPT.md` (house style for a W0 receipt)

## Owns
- `docs/fiab/spikes/spark-identity-w0.md` (new)
- `temp/` probe scripts (gitignored, not committed)
- a throwaway sandbox resource group; no repo bicep

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10). No product code. No change to Console UAMI or Synapse MSI grants in a shared estate; use a sandbox storage account and a sandbox `uami-ws-*`.

## Consumes
Live Synapse + Storage in each boundary; Gov via a GitHub Actions workflow_dispatch probe with the operator-approved deploy identity. Operator holds: any Gov approval gate and sandbox subscription access (see memory: LHDS W0 sandbox is a separate DLZ; do not reuse it without asking).

## Provides
A go/no-go (b1 vs b2) per boundary; measured default-filesystem path allowlist (staging, event logs, warehouse, libraries); submitter-host attachment limits for Q2; ACL throughput per 10k files; the dev-endpoint token audience per Gov boundary. Unblocks W01-W12.

## Steps
1. Create `docs/fiab/spikes/spark-identity-w0.md` from the receipt template (below) with every cell empty.
2. Commercial: create sandbox storage + two roots + `uami-ws-a` / `uami-ws-b`; grant `uami-ws-a` an ABAC-conditioned Blob Data Contributor on root A only; get a dev-endpoint token as `uami-ws-a`; create a Livy session with it; run read/write inside root A and an attempt on root B; capture ADLS diagnostic log principal ids (measurements 1, 5, 6).
3. Measurement 2: submit a batch (`submitLivyBatch`) and record the storage principal id (expect Synapse MSI).
4. Measurement 3: list every default-filesystem path a session touches (staging, event logs, warehouse, libraries) from the storage log of an idle-then-run session.
5. Measurement 4: build an ABAC condition with 50 `(container,path)` pairs; record byte size and whether ARM accepts it.
6. Measurement 7: apply a recursive ACL to a 10k-file tree; record wall time and continuation-token count.
7. Measurement 9: measure how many user-assigned identities the candidate submitter host (Container App / job, per Q2) accepts and the token-request latency.
8. Repeat measurements 1, 5, 6, 8 for GCC-High and IL5 via a dispatch workflow that runs the probe with the deploy identity; GCC records `not-exercised` unless a tenant exists.
9. Fill the go/no-go table. Commit only the report. Tear down the sandbox and record the teardown readback.

## Validation
Run from the repo root unless stated.
- `test -f docs/fiab/spikes/spark-identity-w0.md && grep -c "NOT MEASURED" docs/fiab/spikes/spark-identity-w0.md` : the file exists and the count of `NOT MEASURED` placeholders is 0 except rows explicitly marked `not-exercised`.
- `python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .` exit 0.
- Live probe commands are recorded verbatim in the report; Gov probe run URLs are cited (PR/run link, not pasted logs).
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists.

## Rollback
No product change to roll back. Delete the sandbox resource group and the sandbox UAMIs; read back that they are gone. Because role-assignment and MI token caches can take hours to expire, do not reuse the sandbox principal ids for 4 h.

## Docs to update
`docs/fiab/spikes/spark-identity-w0.md` only. Hub `PRP.md` Execution state row W00 updated by the orchestrator.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 · Blocked-by: none · Branch: spike/spark-identity-w00 · Worktree: E:/Repos/_spark-id-w00

## Hot files
None. touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md and spark-id-W00-spike.md, then REFERENCE.md sections 2.5, 2.6, 3. Do the nine measurements in the sandbox, filling docs/fiab/spikes/spark-identity-w0.md from the receipt template. Gov boundaries only via an Actions dispatch. Proof of done: the report has zero empty measurement cells and a b1/b2 verdict per boundary.

## W0 receipt template (copy into `docs/fiab/spikes/spark-identity-w0.md`, one block per boundary)

```
### Boundary: <Commercial | GCC-High | IL5 | GCC>      Status: verified-live | not-exercised | blocked(<owner>)
Date (UTC): ____   Run/PR link: ____   Operator/identity that ran it: ____   Sandbox sub/rg: ____ (torn down: yes/no, readback ____)
| # | Measurement                                              | Observed value (name the number/id)            | Pass/fail vs expectation |
| 1 | Storage principal id of a session created with uami-ws-a | objectId ____ (!= Console UAMI, != Synapse MSI) |                          |
| 2 | Storage principal id of a batch                          | objectId ____ (expect Synapse MSI)             |                          |
| 3 | Default-FS paths a session touches                       | ____ (list)                                    |                          |
| 4 | ABAC condition size at 50 roots / platform max           | ____ B / ____ B ; ARM accepted: y/n            |                          |
| 5 | Rename in-root -> out-of-root under condition            | HTTP ____ (expect 403); runAsSuperUser: ____   |                          |
| 6 | ABAC available in this boundary                          | y/n, evidence ____                             |                          |
| 7 | Recursive ACL per 10k files                              | ____ s, ____ continuations                     |                          |
| 8 | Dev-endpoint token audience                              | ____                                           |                          |
| 9 | UAMI attachment limit on submitter host (Q2)             | ____ identities; token latency ____ ms         |                          |
Verdict: (b1) ABAC | (b2) ACL   Reason: ____
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W00 | todo | spike/spark-identity-w00 | sonnet | none (no issue yet) | 2026-11-14 |
