# Loom MCP tool server

A [Model Context Protocol](https://modelcontextprotocol.io) server, hosted as an
Azure Function, that exposes a **vetted, read-only** subset of Loom operations as
MCP tools. Any MCP client — the Loom agent loop, Claude, VS Code, etc. — can
discover and call them.

It is **opt-in and Azure-native**: it has its own bicep deploy module and is not
provisioned by the main Loom orchestrator, and every tool calls Azure REST (AI
Search, ARM) with the Function App's managed identity — no Fabric dependency, no
mocks.

## Source

`azure-functions/mcp-server/`
- `function_app.py` — JSON-RPC 2.0 MCP server (`initialize` / `tools/list` / `tools/call`) over `POST /api/mcp`; `GET /api/health` liveness.
- `mcp_tools.py` — the vetted tool registry + real Azure REST handlers.
- `deploy/main.bicep` — deploy-from-scratch Function App + storage + App Insights + RBAC.
- `tests/` — JSON-RPC + auth unit tests (no Azure needed).
- `DEPLOYMENT.md` — full deploy + post-deploy grant steps.

## Tools

| Tool | Backend | Honest gate when unconfigured |
|------|---------|-------------------------------|
| `loom_search_catalog` | AI Search `loom-items` index | "Set `LOOM_AI_SEARCH_SERVICE` … or grant Search Index Data Reader" |
| `loom_list_resources` | ARM `…/resources` | "Set `LOOM_RESOURCE_GROUPS` / grant Reader on the RGs" |
| `loom_list_deployments` | ARM `…/deployments` | "Set `LOOM_RESOURCE_GROUPS` / grant Reader on the RGs" |

## Transport & auth

Stateless Streamable-HTTP (JSON-RPC over a single `POST /api/mcp`). Every request
must send the shared key in `x-api-key` (or `Authorization: Bearer`), matched
against `LOOM_MCP_API_KEY` (Key Vault `secretRef`). Missing key → **503** naming
the setting; it never serves tools anonymously.

## Console wiring + honest gate

The console reads `LOOM_BUILTIN_MCP_URL` (the deployed `/api/mcp` URL). The route
`GET /api/admin/mcp-servers/builtin` returns:
- **configured** `{ endpoint, healthEndpoint }` when the var is set — so the
  Connect-MCP panel can offer one-click registration;
- an **honest gate** naming `LOOM_BUILTIN_MCP_URL` + the bicep module when it
  isn't. A Loom deployment is fully functional without the MCP server.

The **External MCP Tools** panel (Admin → Tenant Settings → Copilot & Agents,
`lib/components/admin/mcp-servers-panel.tsx`) renders a **built-in tools card**
above the server table:
- configured + not yet registered → **Register built-in tools** one-click (saves
  it as a `key-vault`-auth server pointing at `loom-mcp-api-key`);
- configured + already registered → a **Registered** badge;
- not provisioned → the honest gate (env var + bicep module + DEPLOYMENT.md).

The panel already supports the rest of task-007 for any server (built-in or
external): register (URL + `key-vault` secretRef or header auth), **Test
Connection** (real `tools/list` round-trip showing the discovered tool names),
enable/disable, edit, delete. The agent loop discovers each enabled server's
tools at orchestrate time.

## Deploy

See `azure-functions/mcp-server/DEPLOYMENT.md`. Summary: create the
`loom-mcp-api-key` Key Vault secret → `az deployment group create` the bicep →
`func azure functionapp publish` → grant Reader / Search Index Data Reader →
register in Loom and set `LOOM_BUILTIN_MCP_URL`.
