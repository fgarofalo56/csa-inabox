---
name: apigw-W02b-endpoints
status: backlog
priority: P1
order: 24
depends_on: [apigw-W02a-plan-engine]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W2b - Endpoint registry, runtime readiness and key-authenticated endpoints

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
Foundry and Azure OpenAI endpoints are registered by resource id with runtime readiness verdicts (data-action based), and key-authenticated Azure AI endpoints work with the key written once to the environment vault and never read back.

## Why
Publishing (apigw-W02c) needs registered endpoints and honest readiness; credential handling is the riskiest part of W2, hence `review: required`.

## Scope / Non-goals
**Scope:** items W2-3 (endpoint registry + readiness) and W2-4 (key-authenticated endpoints).

**Non-goals:**
- No publications workbench, import/adopt (apigw-W02c).
- No plan/apply engine changes (apigw-W02a).
- No bicep: Secrets User readiness is checked and reported, not granted by this PRP.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] A project-scoped role assignment yields `narrowerScope` / cannot invoke; value that breaks it: a ready verdict.
- [ ] A conditional role assignment yields not confirmed; value that breaks it: a confirmed verdict.
- [ ] Public network access disabled with no VNet path yields `networkUnreachable`; value that breaks it: a ready verdict.
- [ ] A pasted API key never appears in any stored document, log line or error body, paired with: the secret identifier is stored and the named-value plan step references it; value that breaks it: the key text found in any of the three.
- [ ] The Key Vault writer refuses to parse the vault write response; value that breaks it: a response body surfaced to the caller.
- [ ] Registration of a host outside `*.openai.azure.com`, `*.cognitiveservices.azure.com`, `*.services.ai.azure.com` is refused; value that breaks it: a record created for `example.com`.
- [ ] Commercial receipt on the estate Foundry account quotes the verdict and the role; a key registration, publish, call and replace-key round trip is recorded (scratch publication deleted).

## Read first
- `adr/ADR-004-identity-registrations-and-principals.md` and `adr/ADR-008-environments.md` (endpoint classification).
- `apps/fiab-console/lib/azure/foundry-client.ts` (existing symbols; add role-assignment and deny-assignment reads only).
- `apps/fiab-console/lib/api-gateway/registry/resource-id.ts`, `registry/gateway-service.ts` (patterns to match).
- `apps/fiab-console/lib/api-gateway/environments/` (`permits()` and findings that extend to endpoints).
- `apps/fiab-console/lib/azure/cloud-endpoints.ts` (sovereign hosts).

## Owns
Exact repo-relative paths:
- `apps/fiab-console/lib/api-gateway/registry/endpoints.ts`
- `apps/fiab-console/lib/api-gateway/registry/readiness.ts`
- `apps/fiab-console/lib/api-gateway/registry/key-endpoints.ts`
- `apps/fiab-console/lib/api-gateway/secrets/key-vault-writer.ts`
- `apps/fiab-console/lib/api-gateway/policy/backend-keys.ts`
- `apps/fiab-console/app/api/admin/api-gateway/endpoints/**`
- `apps/fiab-console/app/admin/api-gateway/models/endpoints/**`
- `apps/fiab-console/app/admin/api-gateway/models/register/**`
- `apps/fiab-console/lib/azure/foundry-client.ts`

## Must NOT touch
- `lib/api-gateway/plan/**` and `lib/azure/apim-client.ts` (apigw-W02a): consume them, add no changes. If a needed function is missing, raise it on W02a before this PRP starts.
- `app/admin/api-gateway/models/publications/**` (apigw-W02c).
- Any `platform/fiab/bicep/**` file.
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W02a-plan-engine: step registry (the `<backend>-key` named-value step is contributed as the first step), `apim-client.ts` named-value and backend functions, renderers.
- ASSUMPTION: the environment vault is the Key Vault the console already uses for env secrets; confirm its name symbol (look for the existing KEYVAULT_NAME reader) before writing `key-vault-writer.ts`. Issue #5184 (app-registration name drift keyed on KEYVAULT_NAME) shows this naming is not yet uniform.

## Provides
- Endpoint records and readiness verdicts for apigw-W02c (workbench) and apigw-W07a/W07b (pools).
- `registerKeyEndpoint`, **Replace API key** route, key check (`GET /openai/models`, status only).

## Steps
1. Endpoint registry by resource id: pasted id, hosts observed as AI backends, per-subscription scan with partial-read detection; projects map to `account_scope`; overlap refusal; deployment sync (`2024-10-01`) into `observedModelDeployment`; removal guard.
2. Runtime readiness by data actions: direct / inherited / narrower scope, three-valued conditions, deny assignments, network path; states and recommended roles.
3. Models -> Endpoints tab with the Access card (guided empty state, no red first open).
4. Key endpoints: URL registration with refusals; `credentialSecretUri` or pasted `apiKey` written once as `loom-apiplane-key-<resource>-<hex>` with tags, versionless identifier, 422 scrub; declared deployments (immutable); key check; `<backend>-key` named-value plan step with `keyVault.lastStatus` read-back; gateway identity Secrets User readiness; Replace API key; Register -> "Azure AI with an API key" tab.
5. Tests per Acceptance criteria; mutation arms in a sandbox copy.
6. Commercial live receipt (G1 walk with real data).

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/registry app/api/admin/api-gateway/endpoints app/admin/api-gateway/models
make validate-typescript
# G1: browser walk Models -> Endpoints and key registration on the estate; attach screenshots (dark + light)
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
Endpoints removable through the removal guard; stored key secrets are deleted by the Replace/remove path; flag off hides the tab. No bicep to revert.

## Docs to update
Parity rows are written by apigw-W02c; leave doc edits to it.

## Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: apigw-W02a-plan-engine · Branch: feat/apigw-w02b · Worktree: E:/Repos/_apigw-w02b

## Hot files
`lib/azure/foundry-client.ts` (read additions only). `app/api/admin/api-gateway/endpoints/**` is shared only within this PRP.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W02b-endpoints.md and ADR-004/ADR-008.
Goal: endpoint registry + readiness + key-authenticated endpoints (W2-3, W2-4). A pasted key must never be stored, logged or read back.
Edit only files under Owns. Worktree E:/Repos/_apigw-w02b, branch feat/apigw-w02b; apigw-W02a must be merged first.
Proof: pnpm --dir apps/fiab-console vitest run lib/api-gateway/registry app/api/admin/api-gateway/endpoints; make validate-typescript; Commercial G1 receipt.
Report merged-not-deployed.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W2-3 endpoint registry + readiness | todo | | sonnet | | 2026-11-14 |
| W2-4 key-authenticated endpoints | todo | | sonnet | | 2026-11-14 |
