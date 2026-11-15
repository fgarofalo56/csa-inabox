---
name: apigw-W03c-requests-marketplace
status: backlog
priority: P1
order: 28
depends_on: [apigw-W03b-governed-renderer-keys, apigw-W02c-workbench-adopt]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W3c - Access requests, marketplace access and the access verifier

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
Consumers request, receive, connect and rotate access from the marketplace; approvals on the F16 engine create grants atomically; administrators see effective access; a live verifier and G1 walk prove the whole W3 chain per cloud.

## Why
Completes the W3 user journey on top of grants (apigw-W03a), enforcement (apigw-W03b) and published models (apigw-W02c, needed for `409 notPublished`). Also the chain owner for W3 docs.

## Scope / Non-goals
**Scope:** items W3-6 (requests/approvals), W3-7 (marketplace), W3-8 (verifier, docs, receipts).

**Non-goals:**
- No renderer or key-backend changes (apigw-W03b).
- No MCP request kinds beyond declaring the type (apigw-W06b); `pool-model` kind reserved for apigw-W07b.
- No bicep.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] Approving the same request twice returns the same grant; value that breaks it: two grant documents.
- [ ] Approving when a direct grant exists returns 409 conflict; value that breaks it: 200.
- [ ] A request for an unpublished model returns 409 `notPublished`; value that breaks it: a request record created.
- [ ] Bulk review of up to 100 with one failing item leaves the others approved; value that breaks it: all-or-nothing rollback or a 101st accepted.
- [ ] Playwright: request -> approve -> My access -> reveal (60 s clear proven by clock advance) -> call with the key succeeds; value that breaks it: key still in DOM after 60 s, or in URL, history state or storage.
- [ ] `verify-model-access.mjs` matrix runs on Commercial (key + token path) and GCC-High through Actions (key path at minimum); value that breaks it: a missing run id or an expectation without a named breaking input.
- [ ] Parity and docs rows for W3 are flipped with the backend named per control.

## Read first
- `adr/ADR-005-entitlements-and-apim-binding.md`; `TEST-STRATEGY.md` sections 3 and 4.
- `apps/fiab-console/app/api/access-requests/` (F16 engine; only resource-kind branches change), `lib/types/access-request-workflow.ts`, `app/api/approval-policies/route.ts`.
- `apps/fiab-console/app/marketplace/page.tsx` and `lib/components/marketplace/` (sibling surfaces to match; web3-ui).
- `apps/fiab-console/lib/api-gateway/entitlements/` (apigw-W03a, apigw-W03b) and `app/api/me/api-gateway/keys/**`.

## Owns
Exact repo-relative paths:
- `apps/fiab-console/lib/api-gateway/entitlements/approve.ts`
- `apps/fiab-console/app/api/access-requests/**`
- `apps/fiab-console/app/api/admin/access-requests/**`
- `apps/fiab-console/app/api/approval-policies/route.ts`
- `apps/fiab-console/lib/types/access-request-workflow.ts`
- `apps/fiab-console/app/admin/api-gateway/entitlements/requests/**`
- `apps/fiab-console/app/admin/api-gateway/entitlements/effective/**`
- `apps/fiab-console/app/marketplace/page.tsx`
- `apps/fiab-console/app/marketplace/access/page.tsx`
- `apps/fiab-console/app/api/me/api-gateway/catalog/**`
- `apps/fiab-console/app/api/me/api-gateway/access/**`
- `apps/fiab-console/app/api/me/api-gateway/requests/**`
- `apps/fiab-console/app/api/me/api-gateway/connection/**`
- `apps/fiab-console/lib/components/marketplace/**`
- `scripts/measure/apiplane/verify-model-access.mjs`
- `apps/fiab-console/e2e/api-gateway-access.uat.ts`
- `docs/fiab/admin/api-management.md`
- `docs/fiab/parity/apim-ai-gateway.md`

## Must NOT touch
- `app/api/me/api-gateway/keys/**` (apigw-W03b).
- `app/marketplace/**` outside the offering-kind and access additions listed under Owns.
- `docs/fiab/parity/apim-service.md` (apigw-W04c in this chain).
- Any `platform/fiab/bicep/**` file.
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W03b-governed-renderer-keys (keys, fragment).
- apigw-W03a (grants, principals).
- apigw-W02c-workbench-adopt (publication records for `notPublished`).

## Provides
- Marketplace Models offering and My access surfaces; request/approval resource kind `model-api`.
- Docs chain position 2 (after apigw-W02c): apigw-W04c and apigw-W05 extend the same docs afterwards.

## Steps
1. W3-6: resource kinds `model-api` (later `pool-model`, `mcp-server`) on the F16 engine; request records with environment snapshot and cost center; approval creates grant + decision + audit atomically; `409 notPublished`; re-confirmation on environment change; unregistered requester -> `user` principal; bulk review up to 100; Requests and Effective tabs; approval-policy resource types.
2. W3-7: Marketplace Models offering kind (model-first rows, environment badge, shape), request-access drawer naming the offering and cost center, My access (grouped rows; Connection details drawer with endpoint, operations, `tenantId`, `entraClientId`, `entraScope`, `requiredAppRole`, cost-center header, copy-ready MSAL device-code and Anthropic SDK samples with placeholders; key create/rotate/delete), My requests reuse.
3. W3-8: `verify-model-access.mjs` (matrix in `TEST-STRATEGY.md` section 3), docs, G1 walk Commercial, GCC-High matrix through Actions.

### Integration step (serialized)
- Hub navigation: Marketplace/Entitlements links via `app/admin/api-gateway/_lib/hub-model.ts` (owner: apigw-W01, shipped), one additive line.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run app/api/access-requests app/api/me/api-gateway lib/api-gateway/entitlements
make validate-typescript
node scripts/measure/apiplane/verify-model-access.mjs   # Commercial; Gov via Actions
pnpm --dir apps/fiab-console exec playwright test e2e/api-gateway-access.uat.ts
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
Marketplace offering kind hidden by feature flag; grants disabled through the plane; request kinds are additive and ignored when the flag is off.

## Docs to update
`docs/fiab/admin/api-management.md` (entitlements, marketplace, keys), `docs/fiab/parity/apim-ai-gateway.md` W3 rows.

## Wave / Blocked-by / Branch / Worktree
Wave: 5 · Blocked-by: apigw-W03b-governed-renderer-keys, apigw-W02c-workbench-adopt · Branch: feat/apigw-w03c · Worktree: E:/Repos/_apigw-w03c

## Hot files
`docs/fiab/admin/api-management.md` and `docs/fiab/parity/apim-ai-gateway.md` (chain: W02c, W03c, W04c, W05). `app/api/access-requests/**` is a shared F16 engine: resource-kind branches only.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W03c-requests-marketplace.md, ADR-005, TEST-STRATEGY.md sections 3-4.
Goal: access requests/approvals, marketplace access and keys UI, verifier + docs (W3-6..W3-8). apigw-W03b and apigw-W02c must be merged.
Edit only files under Owns. Worktree E:/Repos/_apigw-w03c, branch feat/apigw-w03c.
Proof: vitest on access-requests + me/api-gateway; make validate-typescript; verify-model-access.mjs Commercial + Gov via Actions; Playwright api-gateway-access.uat.ts.
Report merged-not-deployed.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W3-6 requests + approvals | todo | | sonnet | | 2026-11-14 |
| W3-7 marketplace | todo | | sonnet | | 2026-11-14 |
| W3-8 verifier + receipts | todo | | sonnet | | 2026-11-14 |
