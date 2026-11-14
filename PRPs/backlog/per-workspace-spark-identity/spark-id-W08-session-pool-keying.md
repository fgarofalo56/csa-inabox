---
name: spark-id-W08-session-pool-keying
status: backlog
priority: P2
order: 5
depends_on: [spark-id-W02-client-credential, spark-id-W04-token-source]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w08-pool
---
# W08: Per-workspace warm session pool

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Key the warm Livy session pool by workspace so a session created under one workspace identity is never reused by another.

## Why
A shared warm session would run later submits under the first workspace's identity, defeating isolation (REFERENCE.md 4(b) latency note).

## Scope / Non-goals
`spark-session-pool.ts` keying, per-workspace caps, warm-hit metric. Non-goals: pool sizing policy changes beyond the cap.

## Acceptance criteria
Each names the value or output that would make it fail.
- Unit test: sessions acquired for workspace A and B are distinct objects and a released A session is never returned for B; fails if B receives A's session id.
- Platform-tag (`platform`) submits keep using the shared pool.
- Warm hit rate per workspace is exposed (value non-NaN, test asserts 0 on cold and 1/2 after one hit in two acquires).

## Read first
- `lib/azure/spark-session-pool.ts`
- REFERENCE.md 4(b)

## Owns
- `apps/fiab-console/lib/azure/spark-session-pool.ts` and tests

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10).

## Consumes
W02 tag; W04 credential.

## Provides
Workspace-keyed acquire/release for W09/W10.

## Steps
1. Add workspace to the pool key and the per-workspace cap.
2. Add the hit-rate counter.
3. Tests for isolation and platform pool.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/azure/__tests__/spark-session-pool`
- Sandbox mutation: drop workspace from the key; the isolation test must go RED.
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists. Unit-level; live receipt arrives with W10 shadow data.

## Rollback
Revert the PR; pool returns to a single key. In-flight sessions finish under their current identity.

## Docs to update
None until W11.

## Wave / Blocked-by / Branch / Worktree
Wave: 5 · Blocked-by: W02, W04 · Branch: feat/spark-id-w08-pool · Worktree: E:/Repos/_spark-id-w08

## Hot files
`spark-session-pool.ts` sole owner; touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W08-session-pool-keying.md. Key spark-session-pool.ts by workspace. Done = tsc + vitest for the pool pass and the isolation test goes RED when the workspace is removed from the key.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W08 | todo | feat/spark-id-w08-pool | sonnet | none (no issue yet) | 2026-11-14 |
