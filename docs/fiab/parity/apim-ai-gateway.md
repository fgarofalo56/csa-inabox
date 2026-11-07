# apim-ai-gateway — parity with the Azure portal's AI gateway, Models and MCP surfaces (plus what Mosaic adds)

Source UI: Azure portal -> API Management -> APIs (Create from Azure resource -> Microsoft Foundry; Models; MCP servers) and Monitoring; Learn `azure-ai-foundry-api` (2026-03-30), `unified-model-api` (2026-05-29), `mcp-server-overview` (2026-09-11), `expose-existing-mcp-server` (2026-04-28), `secure-mcp-servers` (2026-09-11), `api-management-howto-llm-logs` (2026-06-12), `genai-gateway-capabilities` (2026-05-29). Inventory grounded in `PRPs/active/loom-api-gateway-plane/AZURE-PARITY-INVENTORY.md` (Learn sources retrieved 2026-10-28).

This document sits beside, and does not replace, [`apim-service.md`](apim-service.md), [`apim-api.md`](apim-api.md), [`apim-product.md`](apim-product.md), [`apim-policy.md`](apim-policy.md) and [`apim-developer-portal.md`](apim-developer-portal.md). Operator guide: [`../admin/api-management.md`](../admin/api-management.md).

## State of this document

**W1 (gateway registry and observe) is merged, not deployed.** Every row flipped to built ✅ below is flipped on the strength of code that exists on `feat/apigw-w01` and unit tests that pass. **No row is live-verified**: nothing has been deployed, and no in-browser walk (ux-baseline G1) has been done. Each flipped row carries a "Verified" note saying exactly that. A surface is A-grade only after the G1 walk and zero ❌ here; **this surface is not A-grade.**

Legend: built ✅ · honest gate ⚠️ (the platform cannot act) · partial ◐ (built with the stated gap; counts as a gap, not as parity) · MISSING ❌ with the wave it lands in (-> W#) · out of scope ✗ (named, with the owner).

## Azure feature inventory and Loom coverage

### 1. APIs -> + Add API -> Create from Azure resource -> Microsoft Foundry

| Azure capability | Loom status | Plan |
|---|---|---|
| Select AI Service (subscription picker, Foundry tool list, deployments link) | MISSING ❌ | -> W2 endpoint registry (discovery by subscription scan, observed AI hosts, pasted id) |
| Configure API (display name, description, base path, products) | partial: API editor has name/path; products via Products pane | -> W2 publication workspace |
| Client compatibility: Azure OpenAI / Azure AI / Azure OpenAI v1 | MISSING ❌ | -> W2 `apiShape` values |
| Auto-created operations, system identity + role, backend + `set-backend-service`, managed-identity auth | MISSING ❌ | -> W2 plan steps; readiness names the role |
| Manage token consumption (`llm-token-limit`, `llm-emit-token-metric`) | bicep opt-in for Loom's own gateway only | -> W2 (per publication), W3 (per grant); `llm-emit-token-metric` stays #4442 Wave E |
| Semantic caching | ⚠️ bicep opt-in, Commercial/GCC only | gate per boundary; owner #4442 Wave F |
| AI content safety | ⚠️ absent in bicep | owner #4442 Wave D/E |
| Test console with all-access key | marketplace Try console only | -> W2 test action using the caller's own grant key |

### 2. APIs -> Models -> Unified model API (preview)

| Azure capability | Loom status | Plan |
|---|---|---|
| One OpenAI-compatible endpoint over Chat Completions and Anthropic Messages backends; `/models`; aliases | ✗ deferred (D16, preview) | W7 model pools give one URL per vendor and shape; revisit at GA |
| Per-model auth: headers or managed identity | MISSING ❌ | -> W2 |
| Token policies and content safety in the wizard | see section 1 | see section 1 |

### 3. APIs -> MCP servers

| Azure capability | Loom status | Plan |
|---|---|---|
| Expose a REST API as an MCP server | MISSING ❌ | -> W6-7 |
| Expose an existing MCP server (URL, transport, name, path, products) | partial: `admin/mcp-servers` registry (Cosmos only), now hosted as a tab in the hub | -> W6 publication (SSE-only refused with reason) |
| MCP server list with Server URL column | MISSING ❌ (W1 only *observes* MCP-typed APIs as a count and for findings) | -> W6 workbench |
| Policies at MCP scope | MISSING ❌ | -> W6 `loom-mcp-*` fragment |
| Inbound: subscription key / `validate-azure-ad-token` / PRM | MISSING ❌ | -> W6 |
| Outbound: credential manager / header forwarding | MISSING ❌ | -> W6 managed identity; credential manager ✗ (apim-service backlog) |
| Diagnostics: frontend response payload bytes = 0 | MISSING ❌ | -> W6 warning, W4 writer |
| Tools only; tier limits | n/a | stated on readiness per gateway tier |
| API Center registry / Copilot Studio connector | ✗ out of scope | apim-service backlog |

### 4. Monitoring -> Diagnostic settings / API Settings -> Diagnostic Logs / Analytics

| Azure capability | Loom status | Plan |
|---|---|---|
| Diagnostic setting "Logs related to generative AI gateway" -> Log Analytics | ◐ **bicep half built ✅, UI half MISSING ❌** | bicep: `apiplaneLlmLogs` param in `apim.bicep` adds `GatewayLlmLogs` where the boundary supports it (true in `commercial*.bicepparam`; false in `gcc-high`, `il5`, `dod`, `gcc`). UI: the Telemetry card does **not** show routing state or an `az` command; it shows read access only (no logger or routing check exists in code) -> W4 |
| Per-API Log LLM messages, byte caps | MISSING ❌ | -> W4 diagnostics writer |
| `ApiManagementGatewayLlmLog` join on `CorrelationId` | MISSING ❌ | -> W4 rollup KQL |
| Analytics -> Language models tab | MISSING ❌ | -> W4 |
| Export to Foundry evaluation dataset | ✗ needs prompt bodies the plane never logs | Loom evaluation features |

### 5. Backends and resiliency

| Azure capability | Loom status | Plan |
|---|---|---|
| Backend load balancer (round-robin, weighted, priority, session-aware) | bicep pool for Loom's own gateway; Backends pane lacks pools (apim-service row 134) | -> W7 |
| Circuit breaker honouring `Retry-After` | bicep only | -> W7 |
| Multi-region, scale units | ✗ | #4442 Wave C / Q5 |

### 6. Security and safety

| Azure capability | Loom status | Plan |
|---|---|---|
| Managed identities to AI services | bicep `authentication-managed-identity` only | -> W2 readiness by data actions |
| OAuth for AI apps/agents via credential manager | ✗ | apim-service backlog |
| Content safety policy | see section 1 | #4442 |

### 7. AI gateway in Microsoft Foundry (preview)

| Azure capability | Loom status | Plan |
|---|---|---|
| Associate an APIM instance with a Foundry resource; per-deployment quota from Foundry; register agents/tools in the Foundry control plane | ✗ not adopted (D22, review 2027-04-28) | Loom is the control plane |

### 8. Beyond the portal (what Mosaic adds)

| Mosaic view | Loom location | Status | Wave |
|---|---|---|---|
| Gateways: register, list, detail | Admin -> API Gateway -> Gateways | **built ✅** | W1 |
| Gateways: APIs and endpoints counts from inventory sync | gateway Overview tiles | **built ✅** (Endpoints count comes from the last sync response only; see Known W1 gaps) | W1 |
| Gateways: Telemetry card | gateway Overview | ◐ read access only | checks beyond read access -> W4 |
| Gateways: existing eight tabs under Manage | gateway Manage | ◐ five of eight scoped per gateway; APIs, Products, Policies show a not-scoped message for a non-default gateway | scoped item routes -> follow-up (unowned) |
| Gateways: gates and Fix its (role grant), declared gaps | gateway Overview | **built ✅** (Fix it shows the command; it does not run it) | W1 |
| Settings: Environments (catalog, matrix, classification, suggestions) | Settings -> Environments | **built ✅** | W1 |
| Settings: Findings | Settings -> Findings | **built ✅** (one producer; list is empty until W2 registers endpoints) | W1 |
| Settings: Runtime (who holds `apiplane-admin`) | Settings -> Runtime | **built ✅** | W1 |
| Settings: Connections | -> Settings | MISSING ❌ | -> W8 |
| Settings: Notifications | -> Settings | MISSING ❌ | -> W5 |
| Dashboard (pending approvals, telemetry health, pools with problems, budget overflow) | Overview | ◐ shell with gateway totals only; cards MISSING ❌ | -> W4 / W5 / W7 |
| Models (Publications, Endpoints, Register, Deploy model) | -> Models | MISSING ❌ | -> W2, W7 |
| Pools | -> Pools | MISSING ❌ | -> W7 |
| MCP servers workbench (absorbs `admin/mcp-servers`) | hub MCP tab hosts the existing panel unchanged | ◐ | -> W6 |
| Identity / Entitlements (Agents, Users, Groups, Grants, Requests, Effective, Approval policies) | -> Entitlements | MISSING ❌ | -> W3, W9 |
| Cost centers | -> Cost centers | MISSING ❌ | -> W4, W5 |
| Analytics | -> Analytics | MISSING ❌ | -> W4 |
| Pricing | -> Pricing | MISSING ❌ | -> W4 |
| Notifications inbox; preferences | bell + `/notifications` | MISSING ❌ | -> W5 |
| Portal: Catalog, My access, Requests, Usage and cost, Notifications, Preferences | Marketplace pages | MISSING ❌ | -> W3, W4, W5 |

## Verified (per flipped row)

All "built ✅" rows above are **unit-tested, not live-verified**. "Unit-tested" is the W1 merge evidence recorded on the W1 execution board (vitest and Playwright-spec-written results as reported by each lane); it is not re-run by this document. Nothing is deployed, so no row has a browser or estate receipt.

| Flipped row | Unit-tested | Live-verified |
|---|---|---|
| Gateways: register, list, detail | yes (registry service, preflight, route tests, hub model tests) | **no** |
| Gateways: APIs and endpoints counts | yes (sync tests, hub model) | **no**. The probe `scripts/measure/apiplane/registry-probe.mjs` (offline unit test only) is the intended receipt: Loom's API count against `az rest` for the same gateway. |
| Gateways: gates, Fix its, declared gaps | yes (gate family tests, mutation checks RED) | **no** |
| Settings: Environments | yes (catalog, permits, service, route tests) | **no** |
| Settings: Findings | yes (producer + wiring test that goes RED if the import is removed) | **no** |
| Settings: Runtime | yes (route + tab tests) | **no**; not click-walked |
| Brownfield registration | the access preflight and 422 message are unit-tested | **no** brownfield receipt exists. Registration is by pasted resource id; **discovery and offer (deploy-integrity R5) are not built**. |

## Known W1 gaps (stated, not hidden)

1. `/api/items/apim-api`, `apim-product` and `apim-policy` are not gateway-scoped, so the APIs, Products and Policies tabs show a not-scoped message for any non-default gateway.
2. The Telemetry card shows **read access only**. There is no logger check and no diagnostic-routing check in code, and none is shown as passing. The `api-gateway.monitoring-reader` gate cannot fire because no telemetry probe runs.
3. The **Endpoints** tile comes from the last sync response held in the page; after a reload it is blank until the next sync. Other counts come from the stored gateway record.
4. The three gates (`api-gateway.gateway-role`, `.monitoring-reader`, `.llm-logs-unavailable`) are exported and rendered on the gateway Overview but are **not on the Admin gate-registry page and Copilot cannot discover them** (ux-baseline G2).
5. The `GatewayLlmLogs` diagnostic is **Commercial-only** per W0 (absent on GCC-High; IL5 and GCC not measured). The `api-gateway.llm-logs-unavailable` gate is a declared gap with no Fix it, by design.
6. APIM service **discovery** across subscriptions (deploy-integrity R5) is not built.
7. Unknown to this doc: the behaviour of any of the above on a live estate.

## Per-cloud status

| Boundary | W0 measured | W1 code | W1 deployed or verified |
|---|---|---|---|
| Commercial | yes | merged | no |
| GCC-High | yes | merged | no |
| IL5 | no (never deployed; supported-in-code) | merged | no |
| DoD | no (hub maps it to IL5 gaps) | merged | no |
| GCC | no (no tenant; supported-in-code, never exercised) | merged | no |

## Backend per control

| Control | Calls |
|---|---|
| Register a gateway | `GET {scope}/providers/Microsoft.Authorization/permissions` (api-version 2022-04-01); fallback `GET {scope}` (2024-06-01-preview); Cosmos `apiplane-desired` upsert; audit write |
| Sync inventory | ARM list calls via `apim-client` `pagedGet` (APIs, per-API operations, products, subscriptions, users, groups, backends, named values, policy fragments) and an MCP-typed API list; per-API policy read (analysed, text discarded); Cosmos `apiplane-observed` upsert and sweep |
| Remove gateway | Cosmos remove + audit (deploy-owned refused) |
| Environments / reclassify / suggestions / matrix | Cosmos catalog and gateway documents; atomic batch; audit per resource |
| Findings | observed `mcp` documents x registered MCP endpoints (none until W2) |
| Runtime | capability grants in Cosmos |
| Gate Fix it | no backend call; shows the role, scope and `az` command |
| Manage panes | existing `/api/apim/*` routes with `?gateway=` for non-default gateways (five panes); `/api/items/apim-*` (three panes, default gateway only) |

## Bookkeeping

`apim-service.md` rows this program closes are unchanged by W1: 126 (W2), 134 (W2/W7), 145 (W2), 163-164 and 86 (W4). W1 closes none of them and this document does not claim them.
