---
name: apigw-W03a-bootstrap-principals-grants
status: backlog
priority: P1
order: 26
depends_on: [apigw-W01b-close-gaps, apigw-W02a-plan-engine, apigw-W04a-cost-centers-pricing]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
issues: [5184, 5185]
---

# PRP: W3a - Runtime app registrations, principals directory and grants

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
Idempotent bootstrap of the model-runtime and model-client Entra app registrations, a principals directory (users, applications, agents, groups) and the entitlement (grant) entity with its create/enable/disable/revoke routes and Grants tab.

## Why
Entitlements are the access model for governed models (ADR-004, ADR-005). Identity bootstrap is security-sensitive (`review: required`). Grants need the cost-center entity from apigw-W04a (W3-3 depends on W4-1) and the plan-engine contract from apigw-W02a.

## Scope / Non-goals
**Scope:** items W3-1 (bootstrap), W3-2 (principals), W3-3 (grants).

**Non-goals:**
- No governed-access policy rendering or keys (apigw-W03b).
- No requests/approvals or marketplace (apigw-W03c).
- No change to cost-center entity itself (apigw-W04a owns it); this PRP only reads/selects it.
- Does not fix #5184/#5185 beyond what W3-1 touches; see Scope notes.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] A second bootstrap run changes nothing; value that breaks it: `az ad app list` before/after differing (new app, new secret, changed scope list).
- [ ] Commercial and GCC-High bootstrap run ids are quoted; value that breaks it: a missing run id for either boundary.
- [ ] The `api-gateway.runtime-consent` gate renders with a Fix-it when the grant is absent and disappears once created; value that breaks it: gate still rendered after the grant exists, or no Fix-it button.
- [ ] Withheld consent yields a warning, not a failed bootstrap; value that breaks it: non-zero exit with consent withheld.
- [ ] Principal search selects only id, displayName, appId, type and returns at most 25 results; value that breaks it: a 26th result or a field beyond those four.
- [ ] A denied Graph read shows retry + guidance + manual object-id fallback; value that breaks it: an empty list rendered.
- [ ] Re-granting the same subject x resource x cost center returns 409; value that breaks it: a second entitlement document.
- [ ] An enforcement object with no restriction is refused; value that breaks it: a stored zero-valued enforcement. Unrestricted renders as "Unrestricted", never 0.
- [ ] The Graph app id used in any remediation text is `00000003-0000-0000-c000-000000000000` (Microsoft Graph); value that breaks it: `...000000000046` (issue #5185).

## Read first
- `adr/ADR-004-identity-registrations-and-principals.md`, `adr/ADR-005-entitlements-and-apim-binding.md`, `SECURITY-AND-COMPLIANCE.md`.
- `scripts/csa-loom/bootstrap-msal-app-reg.sh` and `.github/workflows/csa-loom-post-deploy-bootstrap.yml` (MSAL step and the persist-to-repo-variables step).
- Issues #5184 (sign-in app registration name drift: `main.bicep` uses `<resource group>`, bootstrap script uses `<KEYVAULT_NAME>`) and #5185 (console remediation hints use Graph app id `...000000000046` instead of `...000000000000`): verify their state with `gh issue view` before starting and decide whether this PRP's bootstrap naming follows the fix or the open drift (ASSUMPTION: new registrations use the `loom-<env>-model-*` names from the PRD and are independent of the sign-in app name).
- `apps/fiab-console/lib/azure/graph-principals.ts` (`searchEntraPrincipals`, users and groups only today) and `lib/gates/registry/api-gateway.ts` (existing gates, pattern for the new gate).
- `apps/fiab-console/lib/api-gateway/cost-centers/` as delivered by apigw-W04a (`resolveCostCenter`).
- `docs/fiab/v3-tenant-bootstrap.md`.

## Owns
Exact repo-relative paths:
- `scripts/csa-loom/bootstrap-msal-app-reg.sh`
- `.github/workflows/csa-loom-post-deploy-bootstrap.yml`
- `platform/fiab/bicep/modules/admin-plane/main.bicep`
- `apps/fiab-console/lib/gates/registry/api-gateway.ts`
- `docs/fiab/v3-tenant-bootstrap.md`
- `apps/fiab-console/lib/api-gateway/entitlements/principals.ts`
- `apps/fiab-console/lib/api-gateway/entitlements/grants.ts`
- `apps/fiab-console/lib/api-gateway/entitlements/types.ts`
- `apps/fiab-console/lib/azure/graph-principals.ts`
- `apps/fiab-console/app/api/admin/api-gateway/principals/**`
- `apps/fiab-console/app/api/admin/api-gateway/entitlements/route.ts`
- `apps/fiab-console/app/api/admin/api-gateway/entitlements/[id]/route.ts`
- `apps/fiab-console/app/admin/api-gateway/entitlements/principals/**`
- `apps/fiab-console/app/admin/api-gateway/entitlements/grants/**`
- `apps/fiab-console/lib/api-gateway/entitlements/__tests__/**`

## Must NOT touch
- `app/api/admin/api-gateway/entitlements/[id]/keys/**` (apigw-W03b), `app/api/admin/access-requests/**` (apigw-W03c).
- `lib/api-gateway/cost-centers/**` (apigw-W04a).
- In `main.bicep`: only the two env vars `LOOM_APIPLANE_RUNTIME_CLIENT_ID`, `LOOM_APIPLANE_MODEL_CLIENT_ID`; nothing else.
- `docs/fiab/admin/api-management.md` and parity docs (chained docs owners; see Integration step).
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W04a-cost-centers-pricing: cost-center entity and `resolveCostCenter` (W3-3 selection).
- apigw-W02a-plan-engine: plan kinds only (grants reference published-resource ids; ASSUMPTION: resource ref is an opaque string validated against publications in apigw-W03c, since publications arrive in apigw-W02c).

## Provides
- Entitlement entity + routes consumed by apigw-W03b (renderer snapshot, keys) and apigw-W03c (approval creates grants).
- Principal records and search.
- Env vars `LOOM_APIPLANE_RUNTIME_CLIENT_ID` and `LOOM_APIPLANE_MODEL_CLIENT_ID`; gate `api-gateway.runtime-consent`.

## Steps
1. Bootstrap (W3-1): idempotent creation of `loom-<env>-model-runtime` (scopes `Models.Invoke`, `Mcp.Invoke`; roles `Models.Invoke.Application`, `Mcp.Invoke.Application`; `groupMembershipClaims: SecurityGroup`; identifier URI) and `loom-<env>-model-client` (public client, loopback redirect, two delegated permissions); `AllPrincipals` `oauth2PermissionGrant` attempt; Graph application permissions for the Console UAMI (D18); client ids persisted as repo variables -> the two env vars in admin-plane `main.bicep`; Gov login path; gate `api-gateway.runtime-consent` with Fix-it.
2. Principals (W3-2): directory search (users; applications and managed identities when `Application.Read.All` granted, else manual object id with an "unverified" badge; agent identities/users where W0-4 found Agent ID; security groups with read-only members and read-verification status), principal records, Entitlements -> Principals tabs, cross-linked from `/admin/users`. New read helpers only in `graph-principals.ts`.
3. Grants (W3-3): `entitlement` entity (deterministic id; token vs request structures; enforcement optional and non-zero when present), create/enable/disable/revoke routes, Grants tab with limits editor, cost-center selector using apigw-W04a (`general` default).
4. Run bootstrap twice in Actions on Commercial and GCC-High; record before/after `az ad app list`; screenshot the gate flow.

### Integration step (serialized)
- Docs: add W3 sections to `docs/fiab/admin/api-management.md` and `docs/fiab/parity/apim-ai-gateway.md` NOT here; apigw-W03c (chain owner) writes them. Record facts for it in the PR body.
- Hub navigation: add the Entitlements section link in `app/admin/api-gateway/_lib/hub-model.ts` (owner: apigw-W01-gateway-registry-observe, shipped); one additive line, rebase last.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/entitlements app/api/admin/api-gateway/principals app/api/admin/api-gateway/entitlements
make validate-typescript
make validate-bicep
node scripts/ci/check-bicep-sync.mjs
# bootstrap idempotence: run the csa-loom-post-deploy-bootstrap workflow twice; compare `az ad app list --display-name loom-<env>-model` output before/after
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
Grants disabled through the plane; app registrations are left in place and documented (deleting them breaks issued tokens); env vars removed by reverting the bicep PR; gate hidden by feature flag.

## Docs to update
`docs/fiab/v3-tenant-bootstrap.md` (runtime and client registrations, consent step). Other docs are chained to apigw-W03c.

## Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: apigw-W01b-close-gaps, apigw-W02a-plan-engine, apigw-W04a-cost-centers-pricing · Branch: feat/apigw-w03a · Worktree: E:/Repos/_apigw-w03a
Cross-program order: after `gov-W3-permissions-infra` (both edit `.github/workflows/csa-loom-post-deploy-bootstrap.yml`; rebase on it).

## Hot files
`platform/fiab/bicep/modules/admin-plane/main.bicep` (two env vars), `lib/gates/registry/api-gateway.ts` (one gate; also touched later by apigw-W05, which depends on this PRP transitively), `.github/workflows/csa-loom-post-deploy-bootstrap.yml`, `scripts/csa-loom/bootstrap-msal-app-reg.sh`. Bicep applies to `main.bicep` only; the rest of the PRP is non-bicep and can be split into two PRs if the slot is busy.
`touches_bicep: yes`
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md (one bicep-touching PR in flight; ledger `PRPs/reference/INTERLOCK.md`).

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W03a-bootstrap-principals-grants.md, ADR-004, ADR-005, issues #5184 and #5185.
Goal: idempotent runtime/client app registrations, principals directory, grants (W3-1..W3-3). apigw-W02a and apigw-W04a must be merged.
Edit only files under Owns; only two env vars in admin-plane main.bicep (take the bicep slot first).
Worktree E:/Repos/_apigw-w03a, branch feat/apigw-w03a.
Proof: vitest on lib/api-gateway/entitlements + principals + entitlements routes; make validate-typescript; make validate-bicep; bootstrap run twice in Actions (before/after az ad app list identical).
Report merged-not-deployed.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W3-1 bootstrap | todo | | sonnet | | 2026-11-14 |
| W3-2 principals | todo | | sonnet | | 2026-11-14 |
| W3-3 grants | todo | | sonnet | | 2026-11-14 |
