---
name: spark-id-W02-client-credential
status: backlog
priority: P2
order: 3
depends_on: [spark-id-W00-spike]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w02-client
---
# W02: Client layer takes explicit credential and workspace context

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Let every Livy/batch call carry a credential and a workspace context (or an explicit `platform` tag), with no behaviour change while the mode is off.

## Why
None of the client functions accepts a credential today (REFERENCE.md 2.2); the shared console chain is built at module level in `synapse-dev-client.ts`. Without this seam no submit can ever be made as a workspace identity.

## Scope / Non-goals
Optional `{credential, workspaceContext}` parameter on the client functions and propagation through the 27 call sites as a typed tag (`workspace:<id>` or `platform`). Non-goals: choosing the credential (W04), changing any route logic.

## Acceptance criteria
Each names the value or output that would make it fail.
- `node scripts/ci/check-spark-submit-identity.mjs` exits 0 only when every call site listed in REFERENCE.md 2.1 passes a workspace context or is tagged `platform`; it exits non-zero for a copy where one call site drops the tag (name the site in the sandbox mutation).
- With no credential supplied, `createLivySessionAsync` issues the same token request as before (unit test asserts the shared chain is used). Fails if the default path asks a different credential.
- With a credential supplied, the bearer token on the Livy request comes from that credential (test uses two distinct fake tokens and asserts the request carries the supplied one, not the shared one).

## Read first
- REFERENCE.md 2.1, 2.2
- `lib/azure/synapse-dev-client.ts` `createLivySessionAsync`, `submitLivyBatch`, `submitSparkBatchJob`, `submitLivyStatement`, `runSparkSqlAndWait`
- `lib/azure/synapse-livy-client.ts`
- `lib/azure/workspace-credential-factory.ts` `credentialFor`, `runWithWorkspaceContext`

## Owns
- `apps/fiab-console/lib/azure/synapse-dev-client.ts`
- `apps/fiab-console/lib/azure/synapse-livy-client.ts`
- the 27 call-site files listed in REFERENCE.md 2.1 (tag-only edits, one line each)
- `scripts/ci/check-spark-submit-identity.mjs` (new) and its test

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10). Do not alter lakehouse route logic beyond adding the tag (W03 owns that), `spark-session-pool.ts` (W08), `run-adapters.ts` and `launch-item.ts` beyond the tag (W09).

## Consumes
`workspace-credential-factory.ts` (`credentialFor`, ambient workspace id).

## Provides
Client signature `{credential?, workspace}`; the ratchet; the tag vocabulary W03/W08/W09/W10 consume.

## Steps
1. Add the optional parameter and a per-call token path in `synapse-dev-client.ts` and `synapse-livy-client.ts`.
2. Tag every call site (workspace or `platform`).
3. Add the ratchet script and wire it into CI.
4. Add the two-token unit test and the default-path regression test.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/azure/__tests__/synapse-dev-client lib/azure/__tests__/synapse-livy-client`
- `node --test scripts/ci/__tests__/check-spark-submit-identity.test.mjs`
- `node scripts/ci/check-spark-submit-identity.mjs`
- Sandbox-copy mutation: remove the tag from one named call site; ratchet goes RED; tracked tree untouched.
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists. No live receipt required (mode off); state that explicitly.

## Rollback
Revert the PR. The parameter is optional and defaults to the shared chain, so partial adoption is safe. `LOOM_SPARK_IDENTITY_MODE` does not exist yet and is not consulted.

## Docs to update
None until W11.

## Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: W00 · Branch: feat/spark-id-w02-client · Worktree: E:/Repos/_spark-id-w02

## Hot files
`synapse-dev-client.ts`, `synapse-livy-client.ts` (this wave is the sole owner); touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W02-client-credential.md, REFERENCE.md 2.1-2.2. Add an optional {credential, workspace} to the Livy/batch client functions and tag all 27 call sites; add scripts/ci/check-spark-submit-identity.mjs. Done = tsc, the named vitest, node --test, and the ratchet pass; default path unchanged.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W02 | todo | feat/spark-id-w02-client | sonnet | none (no issue yet) | 2026-11-14 |
