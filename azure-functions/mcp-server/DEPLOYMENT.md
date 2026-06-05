# CSA Loom MCP tool server — deployment

An [MCP](https://modelcontextprotocol.io) server hosted as an Azure Function that
exposes a **vetted, read-only** subset of Loom operations as MCP tools, so any
MCP client (the Loom agent loop, Claude, VS Code, …) can call them.

It is **opt-in** — it has its own deploy module and is *not* deployed by the main
Loom orchestrator. A Loom deployment is fully functional without it.

## What it exposes

| Tool | What it does | Backend |
|------|--------------|---------|
| `loom_search_catalog` | Keyword search the Loom catalog | AI Search `loom-items` index (REST) |
| `loom_list_resources` | List Azure resources in the Loom RGs | ARM `…/resources` |
| `loom_list_deployments` | Recent ARM/bicep deployments, newest first | ARM `…/deployments` |

All tools are read-only and call real Azure REST with the Function App's managed
identity. When a backing service/permission is missing, the tool returns an
**honest error** naming the exact setting/role to fix — never a fake result.

## Transport

MCP **Streamable HTTP** in stateless JSON mode: a single `POST /api/mcp`
JSON-RPC 2.0 endpoint handling `initialize`, `tools/list`, `tools/call`.
`GET /api/health` is an unauthenticated liveness probe.

## Auth

Every `/api/mcp` request must send the shared key in `x-api-key` (or
`Authorization: Bearer <key>`), matched against the `LOOM_MCP_API_KEY` app
setting (a Key Vault `secretRef`). If the key isn't configured the server
returns **503** naming the missing setting — it never serves tools anonymously.

## Deploy

1. Create the API-key secret in the Loom Key Vault:

   ```bash
   az keyvault secret set --vault-name <kv> --name loom-mcp-api-key \
     --value "$(openssl rand -hex 32)"
   ```

2. Provision the Function App + supporting resources:

   ```bash
   az deployment group create -g <rg> \
     -f azure-functions/mcp-server/deploy/main.bicep \
     -p keyVaultName=<kv> apiKeySecretName=loom-mcp-api-key \
        loomSubscriptionId=<sub> \
        loomResourceGroups="['rg-csa-loom-admin-eastus2','rg-csa-loom-dlz-single-eastus2']" \
        aiSearchService=<search-service-name>
   ```

3. Publish the code:

   ```bash
   cd azure-functions/mcp-server
   func azure functionapp publish <functionAppName> --python
   ```

4. **Post-deploy grants (honest gates the bicep does not cover):**
   - `loom_list_resources` / `loom_list_deployments` across *other* RGs: grant the
     output `principalId` **Reader** on each RG in `loomResourceGroups`.
   - `loom_search_catalog`: grant the output `principalId` **Search Index Data
     Reader** on the AI Search service, or set `LOOM_AI_SEARCH_KEY`.

5. Register it in Loom: Admin → MCP servers → add `https://<host>/api/mcp` with
   the API key as a Key Vault `secretRef` (see the Connect-MCP-tools panel).

## Verify

```bash
curl https://<host>/api/health            # → {ok, tools, apiKeyConfigured}
curl -s https://<host>/api/mcp -H 'x-api-key: <key>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

## Local dev

```bash
cd azure-functions/mcp-server
cp local.settings.json.sample local.settings.json   # fill in values
pip install -r requirements.txt
func start
python -m pytest tests/                              # unit tests (no Azure needed)
```
