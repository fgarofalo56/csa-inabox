# APIM API-First Starter

> Minimum-viable, production-shaped Bicep starter for the **API-First Data Strategy** pillar on Azure. Deploys APIM Premium v2 with the full LLM policy set, Entra app registration patterns, Log Analytics + App Insights, Key Vault, and a sample backend. Foundation for every other accelerator in the [Solution Store](../../docs/solution-store/index.md).

## What this deploys

| Resource | Purpose |
|---|---|
| Azure API Management Premium v2 | The universal API gateway |
| Application Insights | Observability — request traces, custom metrics, token usage |
| Log Analytics workspace | Long-form logs + KQL surface |
| Azure Key Vault | TLS certs + secrets, with managed identity binding |
| User-assigned managed identity | Identity for APIM → backend calls without secrets |
| Azure OpenAI deployment (optional flag) | Sample backend for the LLM policy demo |
| Sample backend container (optional flag) | Simple echo backend in Container Apps |

The set is enough to validate the LLM policy chain (`llm-token-limit` + `llm-semantic-cache-*` + `llm-emit-token-metric` + `llm-content-safety`) end-to-end.

## Prerequisites

- Azure subscription with permissions to create APIM Premium v2 (requires sufficient quota)
- Azure CLI or Azure PowerShell
- Entra ID tenant with permissions to register applications

## What this is NOT

This is a starter — not a full production reference. It does NOT include:

- VNet integration with private endpoints (production should add)
- Multi-region active-active topology (production should add for HA)
- Application Gateway / Front Door WAF (production should add for public exposure)
- Custom domain with certificate (production should add)
- Cross-boundary federation (federal mission deployments should add per the [zero-trust guide](../../docs/guides/zero-trust-api-governance-federal.md))
- A Purview registration (do this manually for the starter; automate for the production accelerator)

These are intentional omissions to keep the starter readable. The [APIM Universal Gateway guide](../../docs/guides/apim-universal-gateway.md) covers production hardening.

## Deploy

```bash
az login
az account set --subscription "<subscription-id>"

# Create resource group
az group create --name rg-apim-starter --location eastus2

# Deploy
az deployment group create \
  --resource-group rg-apim-starter \
  --template-file bicep/main.bicep \
  --parameters \
      apimPublisherEmail="<your-email>" \
      apimPublisherName="Your Org" \
      deployOpenAi=true \
      deploySampleBackend=true
```

## Validate

After deployment:

```bash
# Capture outputs
APIM_NAME=$(az deployment group show -g rg-apim-starter -n main --query properties.outputs.apimName.value -o tsv)
APIM_GATEWAY=$(az deployment group show -g rg-apim-starter -n main --query properties.outputs.apimGatewayUrl.value -o tsv)

# Hit the sample echo API
SUB_KEY=$(az apim subscription show -g rg-apim-starter --service-name $APIM_NAME --sid master --query primaryKey -o tsv)
curl -H "Ocp-Apim-Subscription-Key: $SUB_KEY" "$APIM_GATEWAY/echo/ping"

# Test the LLM policy chain (requires Entra app + tokens for the AOAI API)
# See policies/aoai-chat.xml for the full inbound chain
```

## Files

| Path | Purpose |
|---|---|
| `bicep/main.bicep` | Main deployment template |
| `bicep/modules/apim.bicep` | APIM Premium v2 |
| `bicep/modules/observability.bicep` | App Insights + Log Analytics |
| `bicep/modules/keyvault.bicep` | Key Vault + managed identity |
| `bicep/modules/openai.bicep` | Optional AOAI deployment |
| `policies/aoai-chat.xml` | LLM policy bundle for AOAI chat completions |
| `policies/global.xml` | Global policy (CORS, default rate limit) |
| `samples/dataverse/read-accounts.py` | Sample: Databricks/Python reading Dataverse via Web API |
| `samples/mcp/mcp-server-skeleton.py` | Sample: MCP server fronting an HTTP API |

## What to do next

1. Read the [APIM Universal Gateway guide](../../docs/guides/apim-universal-gateway.md) to harden for production.
2. Add the policies you actually need — start from `policies/global.xml` and `policies/aoai-chat.xml`.
3. Register your first real backend; import its OpenAPI; assign policies; set subscriptions.
4. Register the API in Purview for governance.
5. Hook the App Insights token-emit metric into the [AI Chargeback Dashboard](../../docs/solution-store/index.md).

## Related material

- [Solution Store](../../docs/solution-store/index.md)
- [Whitepaper — API-first data strategy on Azure](../../docs/research/api-first-data-strategy-whitepaper.md)
- [Guide — APIM as the universal API gateway](../../docs/guides/apim-universal-gateway.md)
- [Guide — APIM + MCP layered orchestration](../../docs/guides/apim-mcp-layered-orchestration.md)
- [Best practice — API-first data strategy](../../docs/best-practices/api-first-data-strategy.md)
- [ADR-0025 — APIM as the integration fabric](../../docs/adr/0025-apim-as-integration-fabric.md)
