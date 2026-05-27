# AI Foundry / APIM / Copilot Studio editor family — sweep status (2026-05-27)

> Family covers 19 editors across three Azure surfaces: APIM (4), AI Foundry (9), Copilot Studio (6 editors + 1 template library). Every editor is wired to real Azure / Power Platform REST APIs; there is no mock data in the BFF layer for this family. Honest config-only state (env var missing, tenant role not granted, Foundry hub not provisioned) surfaces as a Fluent UI MessageBar with the remediation hint per [`.claude/rules/no-vaporware.md`](../../.claude/rules/no-vaporware.md).

## Per-editor production status

| Editor slug | Surface | Backend client | BFF routes | Per-editor parity spec | Grade |
| --- | --- | --- | --- | --- | --- |
| `apim-api` | APIM | `apim-client.ts` | `/api/items/apim-api[/[id][/operations,/spec]]` | [`apim-api-parity-spec.md`](apim-api-parity-spec.md) | B |
| `apim-product` | APIM | `apim-client.ts` | `/api/items/apim-product[/[id]]` | [`apim-product-parity-spec.md`](apim-product-parity-spec.md) | B |
| `apim-policy` | APIM | `apim-client.ts` (Global / API / Product / Operation scopes) | `/api/items/apim-policy/[id]?scope=…` | [`apim-policy-parity-spec.md`](apim-policy-parity-spec.md) | **B** (was C — v3.27 added Operation scope; v3.28 added Monaco) |
| `data-product` | Cosmos + APIM + Purview | `purview-client.ts` + Cosmos | `/api/cosmos-items/data-product/[id]`, `/api/items/apim-product`, `/api/items/data-product/[id]/register-purview` | embedded in `apim-editors.tsx` | B+ (Purview gate is honest config-only) |
| `ai-foundry-hub` | AI Foundry workspace | `foundry-client.ts` | `/api/foundry/{workspace,connections,deployments,computes,datastores}`, `/api/items/{ml-model,ml-experiment}` | [`ai-foundry-hub-parity-spec.md`](ai-foundry-hub-parity-spec.md) | B+ |
| `ai-foundry-project` | AI Foundry child workspace | `foundry-client.ts` | `/api/items/ai-foundry-project[/[id]]` | [`ai-foundry-project-parity-spec.md`](ai-foundry-project-parity-spec.md) | B |
| `prompt-flow` | Foundry data-plane | `foundry-client.ts` | `/api/items/prompt-flow[/[id]][/run]` | implicit | B (edit-and-save deferred to v2.6 — disclosed in editor MessageBar) |
| `evaluation` | Foundry data-plane | `foundry-client.ts` | `/api/items/evaluation[/[id]]` | implicit | B |
| `content-safety` | Azure AI Content Safety | `foundry-client.ts` | `/api/items/content-safety` | implicit | B |
| `tracing` | App Insights via Foundry | `foundry-client.ts` | `/api/items/tracing` | implicit | B |
| `ai-search-index` | Azure AI Search admin API | `foundry-client.ts` | `/api/items/ai-search-index[/[id]][/search]` | implicit | B (vector search shown; capacity issue noted below) |
| `compute` | Foundry ARM | `foundry-client.ts` | `/api/items/compute[/[id]][/start,/stop]` | implicit | B |
| `dataset` | Foundry data-plane | `foundry-client.ts` | `/api/items/dataset[/[id]]` | implicit | B |
| `copilot-studio-agent` | Dataverse `msdyn_copilot` | `copilot-studio-client.ts` | `/api/items/copilot-studio-agent[/[id]][/publish]` | [`copilot-studio-agent-parity-spec.md`](copilot-studio-agent-parity-spec.md) | B (Dataverse AppUser gate) |
| `copilot-studio-knowledge` | Dataverse `msdyn_knowledgesources` | `copilot-studio-client.ts` | `/api/items/copilot-studio-knowledge[/[id]]` | [`copilot-studio-knowledge-parity-spec.md`](copilot-studio-knowledge-parity-spec.md) | B |
| `copilot-studio-topic` | Dataverse `msdyn_botcomponents` | `copilot-studio-client.ts` | `/api/items/copilot-studio-topic[/[id]]` | [`copilot-studio-topic-parity-spec.md`](copilot-studio-topic-parity-spec.md) | B (view-source Monaco for YAML) |
| `copilot-studio-action` | Dataverse `msdyn_bot_actions` | `copilot-studio-client.ts` | `/api/items/copilot-studio-action[/[id]]` | [`copilot-studio-action-parity-spec.md`](copilot-studio-action-parity-spec.md) | B |
| `copilot-studio-channel` | Dataverse `msdyn_botchannels` | `copilot-studio-client.ts` | `/api/items/copilot-studio-channel[/[id]][/publish]` | [`copilot-studio-channel-parity-spec.md`](copilot-studio-channel-parity-spec.md) | B |
| `copilot-studio-analytics` | Dataverse + BAP admin | `copilot-studio-client.ts` | `/api/items/copilot-studio-analytics/[id]` | [`copilot-studio-analytics-parity-spec.md`](copilot-studio-analytics-parity-spec.md) | B |
| `copilot-template-library` | Cosmos `templates` container | Cosmos | `/api/items/copilot-template-library[/[id]]` | [`copilot-template-library-parity-spec.md`](copilot-template-library-parity-spec.md) | B+ |

> **Definition of grade per [`.claude/rules/no-vaporware.md`](../../.claude/rules/no-vaporware.md):** `B` = production-grade with real backend; `B+` = `B` + thoughtful honest-config disclosure for tenant-gated features. The pre-sweep `C` grades on APIM Policy and a few Foundry sub-editors were lifted to `B` once Operation-scope + Monaco landed and the honest-config-only MessageBar pattern was added everywhere.

## Bicep deploy state

The three feature flags that gate this family land via `platform/fiab/bicep/main.bicep`:

| Flag | `params/commercial-full.bicepparam` | `params/gcc-high.bicepparam` | `params/il5.bicepparam` | Bicep module |
| --- | --- | --- | --- | --- |
| `apimEnabled` | `true` | `true` | `true` | [`platform/fiab/bicep/modules/admin-plane/apim.bicep`](../../platform/fiab/bicep/modules/admin-plane/apim.bicep) |
| `aiFoundryEnabled` | `true` | `true` | `false` (Foundry not certified for IL5 — use MAF + AOAI direct) | [`platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep`](../../platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep) |
| `aiSearchEnabled` | `false` | `false` | `false` | [`platform/fiab/bicep/modules/admin-plane/ai-search.bicep`](../../platform/fiab/bicep/modules/admin-plane/ai-search.bicep) |

### Why `aiSearchEnabled = false` everywhere

Azure AI Search S1+ provisioning regularly fails in `eastus2` with a "no capacity in this region" 400. Operators flipping this on must either (a) target `eastus`/`westus3` instead, or (b) accept the AI Search Index editor returning a `503 notDeployed` until the resource lands. The editor's MessageBar surfaces the env-var (`LOOM_AI_SEARCH_SERVICE`) and the bicep path explicitly. Switching the default to `true` is the v3.4 cleanup task — gated on the capacity advisory being closed.

### APIM provisioning latency

`apim.bicep` provisions an APIM Developer-tier service which takes 30 – 45 minutes on first deploy. The post-deploy bootstrap in [`.github/workflows/csa-loom-post-deploy-bootstrap.yml`](../../.github/workflows/csa-loom-post-deploy-bootstrap.yml) waits up to 60 minutes for `provisioningState=Succeeded` before granting the `API Management Service Contributor` role to the Loom UAMI (`scripts/csa-loom/grant-apim-rbac.sh`).

### Copilot Studio — Dataverse Application User bootstrap

Copilot Studio editors require the Loom MSAL Web App SP (`LOOM_MSAL_CLIENT_ID`) to be registered as a Dataverse **Application User** in every target environment, with the `System Administrator` security role (or `Copilot Studio Maker` if least-privilege is required). The bootstrap is fully automated:

1. **Promote-To-Admin (one-time, manual):** The Default environment requires a human admin click in `admin.powerplatform.microsoft.com` to enable the System Administrator role grant from CLI. Documented at [`docs/fiab/dataverse-app-user.md`](dataverse-app-user.md).
2. **AppUser registration (automated):** `scripts/csa-loom/dataverse-add-appuser.sh` iterates every environment with a Dataverse database via the BAP admin API and POSTs a `systemuser` row with `applicationid = LOOM_MSAL_CLIENT_ID`. Idempotent (skips envs where the user already exists).
3. **Workflow chain:** `.github/workflows/csa-loom-post-deploy-bootstrap.yml` calls the script at line 233 immediately after the APIM RBAC grant — so a one-button `az deployment sub create` + workflow run produces a fully wired Loom with all three families talking to their backends.

## Acceptance receipts

Per `.claude/rules/no-vaporware.md`, every editor must have a real-data E2E receipt before a merge claims `B+` or higher. Receipts live in `test-results/uat/` after a Playwright run; the per-editor smoke is at [`apps/fiab-console/e2e/ai-apim-copilot-family.uat.ts`](../../apps/fiab-console/e2e/ai-apim-copilot-family.uat.ts).

Vitest unit tests (logic-layer pin) covering this family:

- [`apim-policy-scope.test.ts`](../../apps/fiab-console/__tests__/apim-policy-scope.test.ts) — APIM policy scope resolver (8 cases, all 4 scope levels)
- [`apim-xml-validation.test.ts`](../../apps/fiab-console/__tests__/apim-xml-validation.test.ts) — SSR fallback contract for `isWellFormedXml`
- [`copilot-studio-dataverse-scope.test.ts`](../../apps/fiab-console/__tests__/copilot-studio-dataverse-scope.test.ts) — `isDataverseScope` regex pin (Dataverse credential routing)
- [`registry-coverage.test.ts`](../../apps/fiab-console/__tests__/registry-coverage.test.ts) — every editor in this family stays registered

Run them with `pnpm --filter @csa-loom/fiab-console test`.

## Known gaps (tracked, not vaporware)

- **APIM Policy editor:** snippet picker right-rail, policy-expression IntelliSense, "Calculate effective policy" merge, and the test runner are all still gaps versus the Azure portal. Tracked in `apim-policy-parity-spec.md` § Gaps.
- **Prompt flow editor:** Save-back is view-only in v2.5; tracked for v2.6 with the explicit MessageBar in the editor.
- **AI Search index editor:** create / update index, indexer + skillset management deferred to a dedicated v2.7 wave.
- **Copilot Studio analytics:** custom date ranges + per-topic drill-down deferred to v2.6.

Last updated: 2026-05-27 (worktree `sweep-ai-apim-copilot`).
