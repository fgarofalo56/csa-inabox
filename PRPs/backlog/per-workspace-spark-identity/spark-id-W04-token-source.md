---
name: spark-id-W04-token-source
status: backlog
priority: P2
order: 3
depends_on: [spark-id-W00-spike]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w04-token
---
# W04: Token source for uami-ws-<id> (separate submitter host)

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Obtain a dev-endpoint token as `uami-ws-<id>` in every boundary via a separate Spark-submitter host (Q2=B), within the attachment limits W00 measured.

## Why
`getWorkspaceCredential` returns `ManagedIdentityCredential({clientId})`, which only works if the UAMI is attached to the hosting compute; the Console cannot hold 200 attached identities (REFERENCE.md 2.7, risks).

## Scope / Non-goals
The submitter host, its infra, and the credential-factory branch that selects it. Non-goals: grants (W05/W06), session pooling (W08).

## Acceptance criteria
Each names the value or output that would make it fail.
- For each boundary with a deployment, a token request for workspace A returns a JWT whose `oid` equals `uami-ws-A` and whose `aud` equals the Synapse dev audience recorded in W00; fails if `oid` is the Console UAMI.
- If the host is unreachable the credential factory returns a typed error and does not fall back to the shared chain when mode is `enforce` (unit test with a failing host).
- The host count of attached identities stays under the limit W00 measured; a test or deploy output states the number and the limit.

## Read first
- W00 report (measurement 9)
- `lib/azure/workspace-identity-client.ts:getWorkspaceCredential`
- `lib/azure/workspace-credential-factory.ts`
- `platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep`

## Owns
- `apps/fiab-console/lib/azure/workspace-identity-client.ts`
- `apps/fiab-console/lib/azure/workspace-credential-factory.ts`
- `platform/fiab/bicep/modules/admin-plane/workspace-identity-host.bicep` (new host module; ASSUMPTION: exact filename, ONE bicep PR, take the INTERLOCK slot first)
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (env-var wiring only, declared edit window)
- `apps/loom-workspace-identity-host/**` (new; only if a container app is chosen in the W00 verdict)

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10). `workspace-grants.ts` (W05/W06), `synapse-dev-client.ts` (W02).

## Consumes
W00 measurements (host choice, audience); W02 credential parameter.

## Provides
`credentialFor({workspaceId, backend:"spark"})` returning a working credential; the host.

## Steps
1. Confirm host choice from W00 (ASSUMPTION: container app/job, per Q2=B, unless W00 shows attachment limits forbid it).
2. Author the host + bicep (params for every boundary file) and wire env vars into `admin-plane/main.bicep`.
3. Add the factory branch and tests.
4. Deploy in sandbox, Commercial then GCC-High then IL5 via Actions; capture token claims (no token text in logs).

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/azure/__tests__/workspace-credential-factory lib/azure/__tests__/workspace-identity-client`
- `az bicep build -f platform/fiab/bicep/main.bicep` and the per-boundary what-if via the existing deploy workflow (what-if output cited by run link)
- Live token-claim receipt per boundary (oid/aud only, never the token).
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists.

## Rollback
Set `LOOM_SPARK_IDENTITY_MODE=off` (credential factory then never calls the host); redeploy bicep without the host module. Role and token caches can take hours; plan rollback in hours.

## Docs to update
`docs/fiab/runbooks/workspace-identity-grants.md` (host section).

## Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: spark-id-W00-spike · Branch: feat/spark-id-w04-token · Worktree: E:/Repos/_spark-id-w04

## Hot files
`platform/fiab/bicep/main.bicep` wiring, `admin-plane/main.bicep`, `params/*.bicepparam`: ONE bicep PR in flight; touches_bicep: yes.
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W04-token-source.md, the W00 report, workspace-identity-client.ts. Build the submitter host and credentialFor spark branch. First claim the bicep INTERLOCK slot. Done = tsc + named vitest pass and a live oid/aud claim receipt exists per deployed boundary.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W04 | todo | feat/spark-id-w04-token | sonnet | none (no issue yet) | 2026-11-14 |
