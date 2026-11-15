---
name: apigw-W03b-governed-renderer-keys
status: backlog
priority: P1
order: 27
depends_on: [apigw-W03a-bootstrap-principals-grants, apigw-W02a-plan-engine]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W3b - Governed-access renderer and keys

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
Grants are enforced at the gateway: a governed-access policy fragment validates keys and Entra tokens against the grant snapshot with per-grant limits and attribution traces, apply integration installs it safely, and owners create, rotate, reveal and delete keys for their own grants. One Opus design session for the renderer, then Sonnet implements.

## Why
This is the enforcement half of ADR-005 and the policy fragment that budgets (apigw-W05 W5-2) and attribution (apigw-W04b) read. Highest-risk code of W3 (entitlements and key reveal).

## Scope / Non-goals
**Scope:** items W3-4 (governed-access renderer + apply integration) and W3-5 (keys).

**Non-goals:**
- No requests/approvals/marketplace (apigw-W03c).
- No budget block-list writer (apigw-W05); this PRP renders only the fragment check against the named value.
- No bicep.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] Live Commercial apply: key call 200, token call 200, wrong audience 401, no grant 403 with trace `r=no-grant`; value that breaks it: any of the four returning a different status.
- [ ] Mutation receipts for `effectiveAccess`, `resolveCostCenter` and the governed variant of `renderPublicationFragment`, each run in a sandbox copy; value that breaks it: a mutation arm that stays green.
- [ ] Revocation removes both the key path and the token path; value that breaks it: a revoked grant whose key still returns 200.
- [ ] A non-owner session calling key reveal gets 403 with no `listSecrets` call recorded; value that breaks it: a recorded call.
- [ ] The reveal response carries `Cache-Control: no-store`; value that breaks it: absence or a cacheable value.
- [ ] The key never appears in the audit document, paired with: the audit document exists carrying the subscription id; value that breaks it: key text in the document or no document.
- [ ] Native subscription requirement is relaxed only after the policy is installed; value that breaks it: an apply order where relaxation precedes policy PUT.

## Read first
- `adr/ADR-005-entitlements-and-apim-binding.md`, `adr/ADR-006-cost-centers-per-workspace-and-budgets.md` (resolution order), `adr/ADR-003-policy-xml-never-stored.md`.
- `apps/fiab-console/lib/api-gateway/plan/` (apigw-W02a step registry and contract) and `policy/publication.ts`, `policy/common.ts`.
- `apps/fiab-console/lib/api-gateway/entitlements/grants.ts` (apigw-W03a) and `lib/api-gateway/cost-centers/` (apigw-W04a `resolveCostCenter`).
- `TEST-STRATEGY.md` section 1 (`effectiveAccess`, `resolveCostCenter` receipts) and section 5.

## Owns
Exact repo-relative paths:
- `apps/fiab-console/lib/api-gateway/policy/access.ts`
- `apps/fiab-console/lib/api-gateway/plan/governed-access.ts`
- `apps/fiab-console/lib/api-gateway/entitlements/snapshot.ts`
- `apps/fiab-console/lib/api-gateway/entitlements/keys.ts`
- `apps/fiab-console/app/api/me/api-gateway/keys/**`
- `apps/fiab-console/app/api/admin/api-gateway/entitlements/[id]/keys/**`
- `apps/fiab-console/lib/api-gateway/policy/__tests__/access.test.ts`

## Must NOT touch
- `lib/api-gateway/plan/{plan,digest,apply,rollback,lease,recovery,registry}.ts` and `plan/publication.ts`: integrate through the apigw-W02a step registry; ASSUMPTION: that extension point exists as designed in apigw-W02a. If the design session did not provide it, STOP and amend apigw-W02a rather than edit engine files here.
- `lib/api-gateway/entitlements/grants.ts` and `principals.ts` (apigw-W03a).
- Any `platform/fiab/bicep/**` file.
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W03a-bootstrap-principals-grants: entitlement entity, client/runtime ids.
- apigw-W02a-plan-engine: step registry, `renderPublicationFragment`, `apim-client.ts` functions.
- apigw-W04a cost-center resolution via apigw-W03a (transitive).

## Provides
- Governed fragment with attribution/deny traces (`loom-deny v=1 r=<reason>`) that apigw-W04b parses and apigw-W05 W5-2 exercises.
- Key routes consumed by apigw-W03c marketplace.
- Typed applied snapshots.

## Steps
1. Opus design session: fragment sections (key intake against grant snapshot; `validate-azure-ad-token` for the runtime audience with `scp`/`roles` rules; direct-then-group precedence within a cost center; overage fail-closed; cost-center resolution order and refusals; budget list check against a named value created by the first plan; attribution and deny traces with `-` defaults; per-grant counters via `llm-token-limit` or the request-counting substitute per D17 with plan warning; credential stripping).
2. Implement renderer, `governed-access.ts` plan step (prepare subscriptions without granting; install policy before relaxing native subscription requirement; suspend/reactivate keys; revocation removes both paths) and typed snapshots.
3. Keys (W3-5): create / rotate per slot / delete for own grant and any direct grant (admin); deterministic subscription naming ending with the cost-center code; reveal via `listSecrets` 2024-05-01 (owner-only, active API scope check, post-call grant recheck, non-cacheable, audited `keyRevealed`); UI transient 60 s cleared on unmount/navigation; admin handoff route shows no key (D7). UI for keys is delivered in apigw-W03c.
4. Mutation arms in a sandbox copy; live Commercial apply and four-call matrix.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/policy lib/api-gateway/plan lib/api-gateway/entitlements app/api/me/api-gateway/keys
make validate-typescript
# live: apply a governed publication on the Commercial estate gateway; call with key, token, wrong audience, no grant; quote the four statuses and trace
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
Grants disabled through the plane (reviewed apply); unpublish removes the fragment; keys deleted through the delete route; feature flag off blocks governed apply.

## Docs to update
Chained to apigw-W03c (api-management.md, parity). Record the snapshot contract in a comment block in `snapshot.ts`.

## Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: apigw-W03a-bootstrap-principals-grants, apigw-W02a-plan-engine · Branch: feat/apigw-w03b · Worktree: E:/Repos/_apigw-w03b

## Hot files
No hot files beyond the new files; `policy/access.ts` is the only home for fragment text so apigw-W05 imports it, not edits it.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W03b-governed-renderer-keys.md, ADR-005, ADR-006, TEST-STRATEGY.md section 1.
Goal: governed-access fragment + apply integration + keys (W3-4, W3-5). Opus design first, then implement.
Edit only files under Owns; integrate through the apigw-W02a step registry, not engine files.
Worktree E:/Repos/_apigw-w03b, branch feat/apigw-w03b; apigw-W03a merged first.
Proof: vitest on policy, plan, entitlements, keys routes; make validate-typescript; live Commercial matrix 200/200/401/403.
Report merged-not-deployed.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W3-4 governed renderer + apply | todo | | opus (design) / sonnet | | 2026-11-14 |
| W3-5 keys | todo | | sonnet | | 2026-11-14 |
