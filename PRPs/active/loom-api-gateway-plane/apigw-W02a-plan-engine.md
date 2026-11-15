---
name: apigw-W02a-plan-engine
status: backlog
priority: P1
order: 23
depends_on: [apigw-W01-gateway-registry-observe]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W2a - Plan / apply / rollback engine, shapes and renderers

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
A deterministic plan -> review -> apply -> rollback engine for gateway writes, plus the curated API shapes and policy-fragment renderers it applies. First gateway-write machinery of the plane (ADR-002, ADR-003, ADR-010). Opus produces the module contract and mutation table in one design session; Sonnet implements.

## Why
Every later write (publications, governed access, budget block list) rides this engine. It must exist, with a pinned contract, before the endpoint, workbench and entitlement PRPs can run. Split out of the old W02 so it fits one session.

## Scope / Non-goals
**Scope:** items W2-1 (engine design + core) and W2-2 (shapes and renderers).

**Non-goals:**
- No endpoint registry or readiness (apigw-W02b).
- No publications UI, adopt/import or docs/receipts (apigw-W02c).
- No governed-access policy (apigw-W03b); the engine exposes an extension point for it (see Provides).
- No bicep.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] `plan()` over a gateway where a product with the target id already exists returns a step marked found (not created); value that breaks it: a plan step list that includes a create for the pre-existing product.
- [ ] `apply()` with a stale digest is refused; value that breaks it: an apply that proceeds when the re-read gateway digest differs from the reviewed one.
- [ ] `apply()` on a gateway in observe mode is refused; value that breaks it: any write recorded on the APIM double.
- [ ] `rollback()` deletes only resources whose step result is created in that run; value that breaks it: a delete recorded for a found (pre-existing) resource.
- [ ] `assessDeployment()` refuses a claude deployment on a `cognitiveservices` origin with a reason string; value that breaks it: an assessed-ok result.
- [ ] Snapshot tests match the Mosaic-derived expected XML using `loom-` prefixes; value that breaks it: any `mosaic-` string in rendered output.
- [ ] Mutation receipts for `plan`, `digest`, `apply` re-read and `rollback` ownership are recorded per `TEST-STRATEGY.md` section 1, run in a sandbox copy.

## Read first
- `ARCHITECTURE.md` plan/apply sections; `adr/ADR-002-plan-apply-digest-rollback.md`, `adr/ADR-003-policy-xml-never-stored.md`, `adr/ADR-010-native-rebuild-and-port-list.md`.
- `TEST-STRATEGY.md` section 1 (pure cores and mutation receipts).
- `apps/fiab-console/lib/api-gateway/registry/gateway-service.ts`, `registry/arm-port.ts`, `registry/actor.ts` (how gateway access is resolved; `canWrite`).
- `apps/fiab-console/lib/api-gateway/observe/policy-analysis.ts` and `environments/` `permits()` (consumed by the plan).
- `apps/fiab-console/lib/azure/apim-client.ts` (existing read helpers added in W1) and its `ApimError`.
- `apps/fiab-console/lib/api-gateway/types.ts` (container names, `apiplane-plans` container exists from W1-1).

## Owns
Exact repo-relative paths:
- `apps/fiab-console/lib/api-gateway/plan/plan.ts`
- `apps/fiab-console/lib/api-gateway/plan/digest.ts`
- `apps/fiab-console/lib/api-gateway/plan/apply.ts`
- `apps/fiab-console/lib/api-gateway/plan/rollback.ts`
- `apps/fiab-console/lib/api-gateway/plan/lease.ts`
- `apps/fiab-console/lib/api-gateway/plan/recovery.ts`
- `apps/fiab-console/lib/api-gateway/plan/registry.ts`
- `apps/fiab-console/lib/api-gateway/plan/__tests__/**`
- `apps/fiab-console/lib/api-gateway/types.ts`
- `apps/fiab-console/lib/api-gateway/shapes/**`
- `apps/fiab-console/lib/api-gateway/policy/publication.ts`
- `apps/fiab-console/lib/api-gateway/policy/common.ts`
- `apps/fiab-console/lib/api-gateway/policy/__tests__/**`
- `apps/fiab-console/lib/azure/apim-client.ts`

## Must NOT touch
- `lib/api-gateway/plan/publication.ts` (apigw-W02c), `plan/governed-access.ts` (apigw-W03b), `plan/steps/ensure-block-list.ts` (apigw-W05).
- `lib/api-gateway/policy/backend-keys.ts` (apigw-W02b), `policy/access.ts` (apigw-W03b).
- `apps/fiab-console/lib/azure/apim-client.ts` existing functions: add new functions only.
- Any `platform/fiab/bicep/**` file.
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W01-gateway-registry-observe (merged, not deployed): gateway registry, `resolve-gateway.ts`, `permits()`, observed inventory.
- ADR-002 / ADR-003 as the contract.
- W0 measurement `W0-RECEIPT.md` for which policy elements and shapes each tier supports.

## Provides
- `plan()`, `digest`, `apply()`, `rollback()` and the step-contributor registry (`plan/registry.ts`) that apigw-W02c, apigw-W03b and apigw-W05 register steps into.
- `assessDeployment()`, `renderPublicationFragment()`, shape operation sets.
- New `apim-client.ts` functions: policy-fragment PUT/GET/DELETE with LRO, backend body with circuit breaker and pool, named value with Key Vault identifier, API diagnostics read.
- `apiplane-plans` document kinds in `types.ts` (the only edit to that file in this program; later PRPs keep entity types in their own module directories).

## Steps
1. Opus design session: write the module contract (signatures, step-result shape created/found, lease semantics, recovery action, error bounding via `ApimError`) and the mutation table; commit it as a comment block / doc in `plan/` before implementing. ASSUMPTION: the contract includes a step-contributor registry so governed access (W3-4) and the block-list step (W5-2) plug in without editing engine files; the design session may change the extension mechanism, but must keep later PRPs from editing engine files.
2. Implement `plan()`, digest, `apply()` (observe/manage gate, stale-digest refusal, write lock lease, dependency order, existence re-read, LRO polling, per-step results, ownership merge), `rollback()` of this run's creations, interrupted-run recovery action.
3. Implement shapes (`azureOpenAi`, `foundryModels`, `anthropicMessages` ported with attribution), `assessDeployment()`, `renderPublicationFragment()` (managed identity; key named-value variant; token policies only where the tier supports them, D25; thin API policy; trace metadata `-` rule).
4. Add the `apim-client.ts` functions (new functions only).
5. Run mutation arms in a sandbox copy for plan / digest / apply re-read / rollback ownership / renderer; record RED and prove the tracked tree unchanged (`git hash-object`).
6. Live Commercial apply with a deliberately pre-created product to prove the refusal (scratch resources deleted after).

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/plan lib/api-gateway/shapes lib/api-gateway/policy
make validate-typescript
# live probe (Commercial): node scripts/measure/apiplane/publish-probe.mjs is created in apigw-W02c; until then run the apply refusal by hand and quote the response
```
Per-cloud receipts (cloud-parity; a boundary is claimed only with its own receipt):

| Boundary | Receipt required | State |
|---|---|---|
| Commercial | live run against the estate gateway, ids quoted | to be produced by this PRP |
| GCC-High | Actions run in-boundary (never local `az`); or the declared gap with its W0 measurement (`W0-RECEIPT.md`) | to be produced by this PRP; if the Gov estate is stood down, lifting the pause-declaration file is the operator's step |
| GCC | vitest / `az bicep build` parity only | supported-in-code, never exercised (no GCC tenant); not claimed |
| IL5 / DoD | vitest / `az bicep build` parity only | supported-in-code, never exercised; not claimed |

Merged is not done (`deploy-integrity.md` R2): until the change is rolled and the receipt observed on the estate, report it as "merged, not deployed".

## Rollback
Feature flag off: the engine refuses to run (`LOOM_APIPLANE_ENABLED`). No bicep or data migration to revert; `git revert` the PR. Scratch resources from the live probe are deleted by their own rollback.

## Docs to update
None here; the W2 docs and parity rows are owned by apigw-W02c. Record the design contract in a comment block under `lib/api-gateway/plan/`.

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: apigw-W01-gateway-registry-observe · Branch: feat/apigw-w02a · Worktree: E:/Repos/_apigw-w02a

## Hot files
`lib/api-gateway/types.ts` and `lib/azure/apim-client.ts` are owned by this PRP only within the program; lane files (W06+) that need `apim-client.ts` functions must sequence after it. `lib/api-gateway/policy/common.ts` is shared by later renderers: they import, not edit.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W02a-plan-engine.md, ADR-002, ADR-003, TEST-STRATEGY.md section 1.
Goal: ship plan/apply/rollback + shapes/renderers (items W2-1, W2-2). Opus first: write the module contract and mutation table, then implement.
Edit only the files under Owns. Worktree E:/Repos/_apigw-w02a, branch feat/apigw-w02a from origin/main.
Proof: pnpm --dir apps/fiab-console vitest run lib/api-gateway/plan lib/api-gateway/shapes lib/api-gateway/policy; make validate-typescript;
mutation receipts per TEST-STRATEGY section 1 in a sandbox copy. Report merged-not-deployed.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W2-1 engine design + core | todo | | opus (design) / sonnet | | 2026-11-14 |
| W2-2 shapes + renderers | todo | | sonnet | | 2026-11-14 |
