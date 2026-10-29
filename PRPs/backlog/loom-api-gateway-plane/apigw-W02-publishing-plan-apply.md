---
name: apigw-W02-publishing-plan-apply
status: backlog
priority: P1
order: 23
depends_on: [apigw-W01-gateway-registry-observe]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W2 — Publishing: plan / apply / rollback engine, shapes, endpoints, readiness

**Goal**: a Foundry or Azure OpenAI deployment becomes a governed API on a
managed gateway through a deterministic plan, a human review and an apply
with per-step results and tracked rollback; endpoints are registered with
runtime readiness verdicts; key-authenticated endpoints work; existing AI
APIs and the deploy-owned pool are adopted as records. First gateway writes
of the plane. ADR-002, ADR-003, ADR-010. `review: required` (gateway writes).

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W2-1 | Plan/apply/rollback engine design and core: `plan()`, digest, `apply()` with observe/manage gate, stale-digest refusal, gateway write lock lease, dependency order, existence re-read, LRO polling, step results (created vs found), ownership merge, `rollback()` of this run's creations, interrupted-run recovery action, error bounding (`ApimError`) — **one Opus design session producing the module contract and the mutation table, then Sonnet implements** | `lib/api-gateway/plan/**`, `apiplane-plans` kinds in `lib/api-gateway/types.ts` | none | **Opus** (design), Sonnet (impl) | **required** (gateway writes) | mutation receipts for `plan`, `digest`, `apply` re-read, `rollback` ownership (`TEST-STRATEGY.md` § 1); a live Commercial apply with a deliberately pre-created product proves the refusal |
| W2-2 | Shapes and renderers: curated operation sets for `azureOpenAi`, `foundryModels`, `anthropicMessages` (ported, attributed), `assessDeployment()` (format + ARM flags + origin + gateway tier), `renderPublicationFragment()` (managed identity; key named value variant; token policies only where the tier supports them, D25), thin API policy, trace metadata `-` rule; `apim-client.ts` additions: policy fragment PUT/GET/DELETE with LRO, backend body incl. circuit breaker and pool, named value with Key Vault identifier, API diagnostics read | `lib/api-gateway/shapes/**`, `lib/api-gateway/policy/{publication,common}.ts`, `lib/azure/apim-client.ts` (new functions only) | none | Sonnet | **required** | renderer mutation receipts; `assessDeployment` receipt (claude on `cognitiveservices` origin refused with reason); snapshot tests compare against Mosaic-derived expected XML with `loom-` prefixes; a test fails on any `mosaic-` string |
| W2-3 | Endpoint registry by resource id: discovery (pasted id; hosts observed as AI backends; per-subscription scan with partial-read detection), projects → `account_scope`, overlap refusal, deployment sync (`2024-10-01`) into `observedModelDeployment`, removal guard, runtime readiness by data actions (direct/inherited/narrower; conditions three-valued; deny assignments; network path; states and recommended roles), Models → Endpoints tab with the Access card | `lib/api-gateway/registry/endpoints.ts`, `lib/api-gateway/registry/readiness.ts`, `app/api/admin/api-gateway/endpoints/**`, `app/admin/api-gateway/models/endpoints/**`, `lib/azure/foundry-client.ts` (role-assignment and deny-assignment reads only) | W1 | Sonnet | **required** | readiness test matrix: project-scoped role → `narrowerScope`/cannot invoke; conditional assignment → not confirmed; public access disabled + no VNet → `networkUnreachable`; Commercial receipt on the estate's Foundry account quoting the verdict and the role |
| W2-4 | Key-authenticated Azure AI endpoints: registration by URL (`*.openai.azure.com`, `*.cognitiveservices.azure.com`, `*.services.ai.azure.com`; refusals), `credentialSecretUri` **or** pasted `apiKey` written once to the env vault (`loom-apiplane-key-<resource>-<hex>`, tags, no read-back, 422 scrub), versionless identifier, declared deployments (immutable), key check (`GET /openai/models`, status only), `<backend>-key` named value plan step first in order with `keyVault.lastStatus` read-back, gateway identity Secrets User readiness, **Replace API key**; Register → "Azure AI with an API key" tab | `lib/api-gateway/registry/key-endpoints.ts`, `lib/api-gateway/secrets/key-vault-writer.ts` (new), `lib/api-gateway/policy/backend-keys.ts`, `app/api/admin/api-gateway/endpoints/**` (key routes), UI under `app/admin/api-gateway/models/**` | W2-1, W2-2 | Sonnet | **required** (credential handling) | tests: a pasted key never appears in any stored document, log line or error body (paired with: the secret identifier is stored and the named value step references it); the writer refuses to parse Key Vault's write response; a live Commercial registration against the estate's own Foundry by key, publish, call, replace key |
| W2-5 | Publications workbench (Models → Publications): create (gateway, endpoint, deployment, shape auto-assessed, limits where available), **Review plan** (ordered steps, warnings: unclassified pairing, limits unavailable, diagnostics requirement), **Apply**, per-step results, **More actions → Unpublish** review listing deletes, drift banner on re-plan, recovery action; environment enforcement in plan via `permits()`; publication smoke test through the gateway with a temporary API-scoped subscription created and deleted inside the smoke (audited) | `app/api/admin/api-gateway/publications/**`, `app/admin/api-gateway/models/publications/**`, `lib/api-gateway/plan/publication.ts` | W2-1..W2-4 | Sonnet | **required** | Playwright: create → plan → apply → smoke 200 → unpublish; a Development endpoint × Production gateway refused with the `permits()` wording; drift: edit the API policy in Azure, re-plan shows the content drift |
| W2-6 | Adopt existing APIs and MCP servers as records (Cosmos only, all-or-nothing import, deterministic ids, re-import refreshes, deleted gateway deletes imports); the deploy-owned pool (`aoaiPool`, `aoaiBackends` from `apim.bicep` outputs) adopted as a publication `ownedBy:'deploy'`, read-only in the plane, drift reported; Models → Import dialog; MCP → Import dialog (records only until W6) | `lib/api-gateway/observe/import.ts`, `app/api/admin/api-gateway/{publications,mcp-servers}/import/**`, UI dialogs | W2-5 | Sonnet | none | import test: a missing name fails the whole import; the deploy-owned publication refuses plan/apply with "owned by the deploy; adopt in W7" |
| W2-7 | Docs, parity and receipts: parity rows 126, 145 and the fragment part of 134 in `apim-service.md`; `apim-ai-gateway.md` W2 rows; `docs/fiab/admin/api-management.md` publishing section; G1 walk Commercial; GCC-High: publish the Gov Foundry deployment through Actions on the Gov APIM, quote the plan, apply and smoke results (or the declared limitation if W0 found the shape or policy unavailable) | `docs/fiab/parity/*.md`, `docs/fiab/admin/api-management.md`, `e2e/api-gateway-publish.uat.ts` (new), `scripts/measure/apiplane/publish-probe.mjs` (new) | W2-1..W2-6 | Sonnet | none (G1 walk) | screenshots; Gov run id; parity rows flipped with the backend named per control |

Lanes: L1 = W2-1 → W2-5; L2 = W2-2 → W2-4; L3 = W2-3; W2-6 after W2-5;
W2-7 last. No bicep in this wave.

## Done receipt (per cloud)

Commercial: a real deployment published, called through the gateway with the
smoke subscription, unpublished; refusal on pre-created resource proven;
readiness verdicts quoted; key endpoint round trip. GCC-High: the same probe
through Actions with run id, or the declared gap with its W0 measurement.

## Rollback

Unpublish plans for anything applied; the engine refuses to run with the
feature flag off; no bicep change to revert.

## Cost / credit estimate

~16 Sonnet sessions + 1 Opus design session; Azure: scratch publications on
the estate's gateway, deleted.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W2-1 | todo | | opus (design) / sonnet | | 2026-10-28 |
| W2-2 | todo | | sonnet | | 2026-10-28 |
| W2-3 | todo | | sonnet | | 2026-10-28 |
| W2-4 | todo | | sonnet | | 2026-10-28 |
| W2-5 | todo | | sonnet | | 2026-10-28 |
| W2-6 | todo | | sonnet | | 2026-10-28 |
| W2-7 | todo | | sonnet | | 2026-10-28 |
