---
name: apigw-W02c-workbench-adopt
status: backlog
priority: P1
order: 25
depends_on: [apigw-W02a-plan-engine, apigw-W02b-endpoints]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W2c - Publications workbench, adopt existing APIs, docs and receipts

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
Operators create, review (plan), apply, smoke-test and unpublish publications from Models -> Publications; existing AI APIs and MCP servers and the deploy-owned pool are adopted as records; W2 docs, parity rows and per-cloud receipts are written.

## Why
This is the first user-visible gateway write path and where the W2 done-receipt is produced. Depends on the engine (W02a) and endpoints (W02b).

## Scope / Non-goals
**Scope:** items W2-5 (workbench), W2-6 (adopt/import) and W2-7 (docs, parity, receipts).

**Non-goals:**
- No governed access / entitlements (apigw-W03*).
- No MCP publishing: MCP import is records only until apigw-W06a.
- Deploy-owned pool is read-only here; adoption into a managed pool is apigw-W07c.
- No bicep.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] Playwright: create -> plan -> apply -> smoke 200 -> unpublish succeeds on the Commercial estate; value that breaks it: a non-200 smoke or a leftover API after unpublish.
- [ ] A Development endpoint x Production gateway is refused with the `permits()` wording; value that breaks it: a plan that reaches apply.
- [ ] Editing the API policy in Azure then re-planning shows content drift; value that breaks it: an empty drift list.
- [ ] The smoke test creates and deletes a temporary API-scoped subscription, audited; value that breaks it: that subscription still listed after the smoke.
- [ ] Import with a missing name fails the whole import (all-or-nothing); value that breaks it: partial records written.
- [ ] The deploy-owned publication refuses plan/apply with "owned by the deploy; adopt in W7"; value that breaks it: a plan produced.
- [ ] Parity rows 126, 145 and the fragment part of 134 in `apim-service.md` flipped with the backend named per control; value that breaks it: a row marked built with no backend named.
- [ ] GCC-High: the Gov Foundry deployment publish run through Actions with run id quoted, or the declared limitation with its W0 measurement.

## Read first
- `adr/ADR-002-plan-apply-digest-rollback.md`; `TEST-STRATEGY.md` sections 3 and 4.
- `apps/fiab-console/lib/api-gateway/plan/` (apigw-W02a contract and step registry) and `registry/endpoints.ts` (apigw-W02b).
- `apps/fiab-console/lib/api-gateway/observe/` (inventory, detection) and `environments/` `permits()`.
- `scripts/measure/apiplane/registry-probe.mjs` (pattern for `publish-probe.mjs`) and `e2e/api-gateway-registry.uat.ts` (pattern for the UAT).
- `docs/fiab/admin/api-management.md`, `docs/fiab/parity/apim-ai-gateway.md`, `docs/fiab/parity/apim-service.md`.

## Owns
Exact repo-relative paths:
- `apps/fiab-console/lib/api-gateway/plan/publication.ts`
- `apps/fiab-console/lib/api-gateway/observe/import.ts`
- `apps/fiab-console/app/api/admin/api-gateway/publications/**`
- `apps/fiab-console/app/api/admin/api-gateway/mcp-servers/import/**`
- `apps/fiab-console/app/admin/api-gateway/models/publications/**`
- `apps/fiab-console/app/admin/api-gateway/models/import/**`
- `apps/fiab-console/e2e/api-gateway-publish.uat.ts`
- `scripts/measure/apiplane/publish-probe.mjs`
- `docs/fiab/admin/api-management.md`
- `docs/fiab/parity/apim-ai-gateway.md`
- `docs/fiab/parity/apim-service.md`

## Must NOT touch
- `lib/api-gateway/plan/{plan,digest,apply,rollback,lease,recovery,registry}.ts` (apigw-W02a engine files).
- `registry/endpoints.ts`, `registry/readiness.ts` (apigw-W02b).
- Other `app/api/admin/api-gateway/mcp-servers/**` paths (apigw-W06a).
- Any `platform/fiab/bicep/**` file.
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W02a-plan-engine (engine, renderers).
- apigw-W02b-endpoints (endpoint records, readiness).

## Provides
- Publication records and the publication plan builder consumed by apigw-W03b (governed variant) and apigw-W06a.
- Docs sections that apigw-W03c, W04c and W05 extend in sequence: `api-management.md` and the parity docs are chained W02c -> W03c -> W04c -> W05, so no two concurrent PRPs edit them.

## Steps
1. Publications workbench: create (gateway, endpoint, deployment, auto-assessed shape, limits where available), Review plan (ordered steps, warnings), Apply with per-step results, More actions -> Unpublish review, drift banner on re-plan, recovery action; environment enforcement through `permits()`; publication smoke test with a temporary API-scoped subscription.
2. Adopt: records-only import (deterministic ids, re-import refreshes, deleted gateway deletes imports); deploy-owned pool (`aoaiPool`, `aoaiBackends` from `apim.bicep` outputs) adopted as publication `ownedBy:'deploy'`, read-only with drift reported; Models -> Import and MCP -> Import dialogs.
3. Docs and parity: `api-management.md` publishing section; parity rows 126, 145, fragment part of 134; `apim-ai-gateway.md` W2 rows.
4. G1 walk Commercial with screenshots; GCC-High publish through Actions; `publish-probe.mjs` and `api-gateway-publish.uat.ts`.

### Integration step (serialized)
- Hub navigation: add the Models section link in `app/admin/api-gateway/_lib/hub-model.ts` (owner: apigw-W01-gateway-registry-observe, shipped); one additive line, rebase on main last.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/plan lib/api-gateway/observe app/api/admin/api-gateway/publications
make validate-typescript
node scripts/measure/apiplane/publish-probe.mjs   # Commercial; Gov via Actions
pnpm --dir apps/fiab-console exec playwright test e2e/api-gateway-publish.uat.ts
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
Unpublish plans for anything applied; engine flag off refuses to run; no bicep to revert; import records removable by deleting the gateway.

## Docs to update
`docs/fiab/admin/api-management.md` (publishing), `docs/fiab/parity/apim-ai-gateway.md`, `docs/fiab/parity/apim-service.md`.

## Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: apigw-W02a-plan-engine, apigw-W02b-endpoints · Branch: feat/apigw-w02c · Worktree: E:/Repos/_apigw-w02c

## Hot files
`docs/fiab/admin/api-management.md`, `docs/fiab/parity/apim-ai-gateway.md`, `docs/fiab/parity/apim-service.md` (chain owner order: W02c, W03c, W04c, W05). Hub nav link for Models: see Integration step.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W02c-workbench-adopt.md, ADR-002, TEST-STRATEGY.md sections 3-4.
Goal: publications workbench (plan/apply/smoke/unpublish), adopt existing APIs, W2 docs + receipts (W2-5..W2-7). apigw-W02a and W02b must be merged.
Edit only files under Owns. Worktree E:/Repos/_apigw-w02c, branch feat/apigw-w02c.
Proof: pnpm --dir apps/fiab-console vitest run lib/api-gateway/plan app/api/admin/api-gateway/publications; make validate-typescript; publish-probe.mjs on Commercial; Gov via Actions.
Report merged-not-deployed; G1 screenshots dark and light.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W2-5 publications workbench | todo | | sonnet | | 2026-11-14 |
| W2-6 adopt existing APIs | todo | | sonnet | | 2026-11-14 |
| W2-7 docs, parity, receipts | todo | | sonnet | | 2026-11-14 |
