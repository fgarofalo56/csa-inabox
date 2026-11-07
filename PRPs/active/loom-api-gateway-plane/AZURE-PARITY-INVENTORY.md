# Azure parity inventory — the Azure portal's AI gateway, Models and MCP surfaces → Loom

`ui-parity.md` requires the real UI to be inventoried from Learn before it is
built. Sources and `ms.date` stamps: `research/learn-apim-ai-gateway-sources.md`
(retrieved 2026-10-28). This file seeds `docs/fiab/parity/apim-ai-gateway.md`,
which the waves keep current; it does **not** replace the existing
`docs/fiab/parity/apim-service.md` (service blade), `apim-api.md`,
`apim-product.md`, `apim-policy.md`, `apim-developer-portal.md`.

Legend: built ✅ (today) · planned → W# · honest gate ⚠️ (platform cannot act)
· out of scope ✗ (named, with the owning backlog).

## 1. APIs → + Add API → Create from Azure resource → Microsoft Foundry (wizard)

| Azure capability (Learn `azure-ai-foundry-api`, 2026-03-30) | Loom today | Loom plan |
|---|---|---|
| Select AI Service: subscription picker, Foundry tool list, deployments link | ❌ | → W2 (endpoint registry: discovery by subscription scan, observed AI hosts, pasted ID) |
| Configure API: display name, description, base path, products | partial (API editor has name/path; products via Products pane) | → W2 publication workspace |
| Client compatibility: **Azure OpenAI** / **Azure AI** / **Azure OpenAI v1** | ❌ | → W2 `apiShape` `azureOpenAi`, `foundryModels`; **Azure OpenAI v1** (`/openai/v1/...`) is a fourth shape added as D5 permits; `anthropicMessages` is additional to the portal |
| Auto-created: operations per endpoint, system-assigned identity + role, backend + `set-backend-service`, managed-identity auth | ❌ | → W2 plan steps (backend, fragment, API, operations, policy); readiness check names the role instead of silently assigning it |
| Manage token consumption: `llm-token-limit`, `llm-emit-token-metric` | bicep opt-in for Loom's own gateway only (`apim.bicep:506-508`) | → W2 publication limits (per publication) + W3 (per grant); `llm-emit-token-metric` stays #4442 Wave E |
| Apply semantic caching | bicep opt-in, Commercial/GCC only | ⚠️ gate per boundary; owned by #4442 Wave F (Gov cache) |
| AI content safety | absent in bicep (#4442 § 3.1) | ⚠️ owned by #4442 Wave D/E; the plane shows the per-boundary verdict owner on the publication |
| Test console with all-access key | marketplace **Try** console (`seedSampleApi`) | → W2 test action on a publication using the caller's own grant key, never the all-access key |

## 2. APIs → Models → Unified model API (preview)

| Azure capability (Learn `unified-model-api`, 2026-05-29) | Loom today | Loom plan |
|---|---|---|
| One OpenAI-compatible endpoint over OpenAI Chat Completions and Anthropic Messages backends; `/models` discovery; aliases | ❌ | ✗ **deferred** (D16): preview, rolling out, classic tiers via early-release channel; the plane's **model pools** (W7) give one URL per vendor and shape without the preview dependency; revisit at GA |
| Per-model auth: headers or managed identity | ❌ | → W2 (managed identity; key via Key Vault named value) |
| Token policies and content safety in the wizard | see § 1 | see § 1 |

## 3. APIs → MCP servers

| Azure capability (Learn `mcp-server-overview` 2026-09-11, `expose-existing-mcp-server` 2026-04-28, `secure-mcp-servers` 2026-09-11) | Loom today | Loom plan |
|---|---|---|
| **Expose a REST API as an MCP server** (operations → tools; Tools blade selects operations) | ❌ | → W6-7: "Expose as MCP" action on a managed REST API (type `mcp`, source = API) with tool selection; same plan/apply engine |
| **Expose an existing MCP server** (base URL, transport Streamable HTTP/SSE, name, base path, description, products) | `admin/mcp-servers` registry (Cosmos only) | → W6 publication (passthrough); SSE-only servers refused with reason (Mosaic ADR 0017), stated on the form |
| MCP server list with Server URL column | ❌ | → W6 MCP servers workbench |
| Policies at MCP scope (rate limit, JWT, IP filter, caching); warning never to read `context.Response.Body` | ❌ | → W6 `loom-mcp-*` fragment; the XML Policies pane for customer-authored MCP policies is read-only for plane-owned ones |
| Inbound: subscription key; `validate-azure-ad-token`; PRM/OAuth (samples) | ❌ | → W6 Entra tokens with RFC 9728 PRM (built, not a sample); keys for MCP ✗ by design (Mosaic ADR 0017), stated on the form |
| Outbound: credential manager `get-authorization-context`; header forwarding | ❌ | → W6 managed-identity audience and no-auth upstreams; **credential manager** ✗ (apim-service parity backlog) |
| Diagnostics: frontend response payload bytes = 0 | ❌ | → W6 gateway-wide warning + W4 diagnostics writer sets 0 body bytes |
| Tools only; no resources or prompts; not in workspaces; tiers Developer…Premium v2 (no Consumption) | n/a | stated on the readiness surface per gateway tier |
| API Center registry and Copilot Studio connector | ❌ | ✗ out of scope (API Center is a separate product; tracked on the apim-service backlog) |

## 4. Monitoring → Diagnostic settings / API Settings → Diagnostic Logs / Analytics

| Azure capability (Learn `api-management-howto-llm-logs`, 2026-06-12) | Loom today | Loom plan |
|---|---|---|
| Diagnostic setting "Logs related to generative AI gateway" → Log Analytics | bicep writes `GatewayLogs` only (`apim.bicep:210`) | → W1 bicep adds `GatewayLlmLogs` where the boundary supports it (W0-1 measures); Telemetry card shows routing state and the `az` command for non-Loom gateways (the plane never writes diagnostic settings) |
| Per-API **Log LLM messages**, prompt/completion byte caps | ❌ | → W4 diagnostics writer on published APIs: LLM logs **on**, prompt/completion bytes **0** (token counts only; bodies never logged by the plane) |
| `ApiManagementGatewayLlmLog` join on `CorrelationId` | ❌ | → W4 rollup KQL |
| Analytics → **Language models** tab | ❌ (parity ❌ row 163) | → W4 Analytics (Overview, Cost, Consumers, Limits, Reliability, Unattributed, Access hygiene) exceeds the portal's tab |
| Export to Foundry evaluation dataset | ❌ | ✗ needs prompt bodies, which the plane never logs; left to Loom's own evaluation features |

## 5. Backends and resiliency

| Azure capability (Learn `genai-gateway-capabilities`, 2026-05-29) | Loom today | Loom plan |
|---|---|---|
| Backend load balancer: round-robin, weighted, priority, session-aware | bicep pool for Loom's own gateway (`apim.bicep:464`); Backends pane lacks pools (parity ❌ row 134) | → W7 pools (breaker, preferential, linear); Backends pane gains pool + circuit-breaker bodies |
| Circuit breaker honouring `Retry-After` | bicep `:431-461` | → W7 presets (throttling; throttling and errors) |
| Multi-region, scale units | ✗ | owned by #4442 Wave C / Q5 |

## 6. Security and safety

| Azure capability | Loom today | Loom plan |
|---|---|---|
| Managed identities to AI services | bicep `authentication-managed-identity` | → W2 readiness by data actions (exceeds portal: verdict before publishing) |
| OAuth for AI apps/agents via credential manager | ❌ | ✗ apim-service backlog |
| Content safety policy | see § 1 | #4442 |

## 7. AI gateway in Microsoft Foundry (preview)

| Azure capability (Learn `genai-gateway-capabilities` § AI gateway in Microsoft Foundry) | Loom plan |
|---|---|
| Associate an APIM instance with a Foundry resource; configure token quotas and rate limits per deployment from Foundry; register agents and tools into the Foundry control plane | ✗ **not adopted**: it binds governance to the Foundry portal; Loom is the control plane (`no-fabric-dependency.md` spirit, operator mandate). The plane reads deployments and quota from the same ARM surfaces (W2, W7). Recorded as D22 with a review date (2027-04-28) in case the Foundry-side registration becomes the only way to govern Foundry agents. |

## 8. Beyond the portal — what Mosaic adds and this set builds

These rows have no Azure-portal equivalent; they are the reason the plane
exists and are measured against Mosaic's console/portal IA
(`research/mosaic-apim-sources.md`, `screenshots.md`).

| Mosaic view | Loom location | Wave |
|---|---|---|
| Dashboard (pending approvals, telemetry health, pools with problems, budget overflow) | Admin → API & AI Gateway → Overview | W1 (shell), W4/W5/W7 (cards) |
| Gateways (list, overview, APIs and endpoints, Telemetry card) | → Gateways; existing eight tabs under Manage | W1 |
| Models (Publications, Endpoints, Register incl. API key, Deploy model → Review deployment) | → Models | W2, W7 |
| Pools (Overview, Models and deployments, Access and connection, Health, Suggestions) | → Pools | W7 |
| MCP servers (list, model-calling identity, Review changes) | → MCP servers (absorbs `admin/mcp-servers`) | W6 |
| Identity (Agents, Users, Security groups, Groups) | → Entitlements → Principals, cross-linked from `/admin/users` | W3 |
| Entitlements (Grants, Requests, Settings, Effective, Approval policies) | → Entitlements; Requests reuse the F16 inbox | W3, W9 |
| Cost centers (Members, Budget, New) | → Cost centers | W4, W5 |
| Analytics (Overview, Cost, Consumers, Limits, Reliability; Filters) | → Analytics | W4 |
| Pricing (Prices, Sources, Unpriced deployments, Clouds and endpoints) | → Pricing | W4 |
| Notifications inbox; Profile → preferences | bell + `/notifications`; preferences page | W5 |
| Settings (Environments, Connections, Findings, Runtime, Notifications) | → Settings | W1, W5, W8 |
| Portal: Catalog, My access (Connection details, keys), Requests, Usage & cost, Notifications, Preferences | Marketplace → Models / MCP; My access; My requests (`/governance/access-requests`); Usage & cost; bell; preferences | W3, W4, W5 |

## 9. Parity bookkeeping

- `docs/fiab/parity/apim-ai-gateway.md` is created in W1 with every row above
  and updated by each wave; A-grade requires zero ❌ and the G1 walk.
- `docs/fiab/parity/apim-service.md` rows this set closes: 126 (Key Vault
  named values, W2), 134 (backend credentials, circuit breaker, pool, W2/W7),
  145 (policy fragments, W2), 163–164 (monitoring, loggers, diagnostics, W4),
  86 (API diagnostics settings, W4). Rows it does not touch stay ❌ there with
  their own backlog; this set must not claim them.
