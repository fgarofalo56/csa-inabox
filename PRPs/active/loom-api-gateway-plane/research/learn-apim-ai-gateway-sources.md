# Research log — Microsoft Learn, Azure API Management AI gateway (retrieved 2026-10-28)

Used for `AZURE-PARITY-INVENTORY.md` (the `ui-parity.md` inventory must be
grounded in Learn, not memory). `ms.date` is the page's own stamp.

| Page | URL | ms.date | What it establishes |
|---|---|---|---|
| AI gateway capabilities in Azure API Management | https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities | 2026-05-29 | Applies to **all tiers**. Managed endpoints: OpenAI Chat Completions / Responses, **Anthropic Messages (v2 tiers only)**, Google Vertex AI, MCP servers, A2A agent APIs, self-hosted. Unified model API (preview). Policies: `llm-token-limit`, `llm-semantic-cache-lookup/store`, `llm-content-safety`, `llm-emit-token-metric`; backend pools (round-robin, weighted, priority, session-aware), circuit breaker honouring `Retry-After`; credential manager; LLM logging + built-in Analytics dashboard; API Center integration; **AI gateway in Microsoft Foundry (preview)** governing Models, Agents, Tools. Early-release channel is classic tiers only. |
| Import a Microsoft Foundry API | https://learn.microsoft.com/en-us/azure/api-management/azure-ai-foundry-api | 2026-03-30 | Portal wizard: Select AI Service → Configure API (display name, base path, products, **client compatibility: Azure OpenAI / Azure AI / Azure OpenAI v1**) → Manage token consumption (`llm-token-limit`, `llm-emit-token-metric`) → Apply semantic caching → AI content safety → Review. Auto-creates operations, system-assigned identity + role, backend + `set-backend-service`, managed-identity auth. Test console adds the all-access key. |
| Create and manage a unified model API (preview) | https://learn.microsoft.com/en-us/azure/api-management/unified-model-api | 2026-05-29 | Developer, Basic, Basic v2, Standard, Standard v2, Premium, Premium v2. One OpenAI-compatible endpoint (`/llm/v1/chat/completions`) over OpenAI Chat Completions and Anthropic Messages backends; `/models` discovery; **model aliases**; per-model auth (headers or managed identity); token policies and content safety in the wizard. Preview, rolling out; classic tiers via early-release channel. |
| Overview of MCP servers in API Management | https://learn.microsoft.com/en-us/azure/api-management/mcp-server-overview | 2026-09-11 | Developer, Basic, Basic v2, Standard, Standard v2, Premium, Premium v2 (not Consumption). Two sources: **REST API as MCP server** and **existing MCP server (passthrough)**. Tools only; no resources or prompts; **not supported in workspaces**. Policies apply to all tools. API Center for discovery. |
| Connect and govern an existing MCP server | https://learn.microsoft.com/en-us/azure/api-management/expose-existing-mcp-server | 2026-04-28 | Server must be MCP `2025-06-18` or later; Streamable HTTP or SSE; tools and resources, no prompts. Portal: MCP servers → + Create → Expose an existing MCP server (base URL, transport, name, base path, products). Diagnostic logging must set frontend response payload bytes to **0**. Policies at MCP scope; `context.Response.Body` must not be read. |
| Secure access to MCP servers | https://learn.microsoft.com/en-us/azure/api-management/secure-mcp-servers | 2026-09-11 | Inbound: `Ocp-Apim-Subscription-Key`, or Entra JWT via `validate-azure-ad-token`; PRM/OAuth samples (labs). Outbound: credential manager (`get-authorization-context`), header forwarding. |
| Set up logging for language model APIs | https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-llm-logs | 2026-06-12 | Diagnostic setting category "Logs related to generative AI gateway"; per-API **Log LLM messages** with prompt/completion byte caps (32 KB chunks, 2 MB max); table `ApiManagementGatewayLlmLog`, join on `CorrelationId`; Analytics → **Language models** tab; token usage may be missing on broken streams. |

## Facts this set relies on that Learn does **not** settle (→ W0)

- Availability of `GatewayLlmLogs`, `ApiManagementGatewayLlmLog` and
  `TraceRecords` in Azure Government Log Analytics.
- Whether the `llm-*` policy family is authorable on Premium classic in
  `usgovvirginia` (owned by #4460 / #4442 Wave 0 task 2; this set consumes it).
- MCP API type (`mcp`) availability in Government on
  `2025-09-01-preview`.
- Microsoft Entra Agent ID availability in Government tenants.
- Anthropic-on-Foundry (`services.ai.azure.com`) availability in Government.
- Azure Retail Prices API coverage for Government model SKUs.

## Live estate facts quoted from `PRPs/backlog/apim-ai-gateway/PRP.md`

Measured there on 2026-09-11, **not re-measured here**: the Commercial estate
runs one APIM `PremiumV2`, `capacity=1`, `virtualNetworkType=Internal`, in the
DMLZ subscription; the private zone `azure-api.net` carries exactly one A
record, so any second gateway hostname needs its own record (that PRP § 3.5).
W1's registry must honour that constraint when it lists gateways the console
cannot reach in-VNet.
