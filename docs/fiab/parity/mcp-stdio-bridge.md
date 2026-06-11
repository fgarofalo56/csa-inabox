# mcp-stdio-bridge — parity with stdio-transport MCP servers (npx / uvx)

Source: Model Context Protocol stdio transport (newline-delimited JSON-RPC over
a child process's stdin/stdout); Microsoft Learn — *Connect agents to MCP
servers* (UVX/NPX "Supported" on Azure Container Apps, "Not supported" on Azure
Functions), *Host MCP servers on Azure Container Apps* (ingress `transport:
auto|http`), *Troubleshoot MCP servers on ACA* (SSE vs streamable-HTTP). Bridge
analogs: `supergateway` / `mcp-proxy` (stdio↔SSE/streamable-HTTP gateways).

## The gap this closes

Loom's External-MCP registration path is **HTTP-only**: `McpServerConfig`
(`apps/fiab-console/lib/types/mcp-config.ts`) carries a single `endpoint` URL,
and `apps/fiab-console/lib/azure/mcp-client.ts` speaks JSON-RPC over HTTP
(`POST {endpoint}/tools/list`, `POST {endpoint}/tools/call`). A stdio MCP server
launched via `npx`/`uvx` cannot be registered. The bridge runs each stdio child
inside the Admin Plane and re-exposes it over HTTP/SSE, producing the exact
endpoint the Console + `copilot-orchestrator` already consume — **no change to
the Console contract.**

## stdio-MCP feature inventory (what a stdio server + a stdio↔HTTP gateway do)

- Launch a server via `npx <pkg>` (Node) or `uvx <pkg>` (Python) as a child
  process; speak JSON-RPC over stdin/stdout, newline-delimited.
- MCP lifecycle: `initialize` → `notifications/initialized` → `tools/list` /
  `tools/call` → server-initiated notifications.
- Gateway re-exposes the child over an HTTP transport: an **SSE** endpoint
  (`GET .../sse` streams an `endpoint` event then `message` events; the client
  POSTs JSON-RPC to the named message URL) and/or a **streamable-HTTP** endpoint.
- Pass environment/secrets into the child; restrict which env reaches it.
- Run multiple bridged servers behind one process; health endpoint for probes.

## Loom coverage

| Capability | Status | Notes |
| --- | --- | --- |
| Launch stdio server via `npx` | ✅ built | `stdio-client.mjs` `launcherCommand('npx')`; Node base image. |
| Launch stdio server via `uvx` | ✅ built | `launcherCommand('uvx')`; `uv` pinned-install in Dockerfile. |
| Reject any other launcher (no free-form command) | ✅ built | throws for non-npx/uvx; catalog has no `command` field. |
| MCP `initialize` + `notifications/initialized` handshake | ✅ built | `StdioMcpClient.ensureInitialized()` (lazy, once per live child). |
| Newline-delimited JSON-RPC framing | ✅ built | `_onData` splits on `\n`, matches responses by `id`. |
| `tools/list` over HTTP (Console-compat) | ✅ built | `POST /servers/<id>/tools/list` → `{jsonrpc,id,result|error}`. |
| `tools/call` over HTTP (Console-compat) | ✅ built | `POST /servers/<id>/tools/call`. |
| Standard MCP **SSE** transport (external agents) | ✅ built | `GET /servers/<id>/sse` (endpoint event) + `POST /servers/<id>/message`. |
| Server-initiated notifications fan-out | ✅ built | `onNotification` → SSE `message` events. |
| Auto-respawn on child exit | ✅ built | `child.on('exit')` clears state; next request re-spawns. |
| Health endpoint for probes | ✅ built | `GET /.well-known/health`; Docker HEALTHCHECK + ACA liveness/readiness. |
| Catalog summary (no secrets) | ✅ built | `GET /servers`. |
| Declarative catalog (no UI JSON/command textarea) | ✅ built | `config/loom-mcp-bridge.json` typed entries; loom-no-freeform-config. |
| Secret boundary (only allow-listed env to child) | ✅ built | `childEnv()` forwards PATH/HOME + `entry.envAllowlist` only. |
| Per-cloud boundary filter | ✅ built | `AZURE_CLOUD` drops entries whose `boundaries` omit the active cloud (e.g. `fetch` excluded from Gov). |
| Non-root container + pinned deps | ✅ built | `USER loom`; `ARG UV_VERSION` pinned; node:20-slim. |
| Console one-click registration | ✅ built | `BridgeMcpCard` (mcp-servers-panel.tsx) ← `GET /api/admin/mcp-servers/bridge`. |
| Honest gate when unprovisioned | ⚠️ honest-gate | `LOOM_MCP_BRIDGE_URL` unset → Fluent MessageBar naming env var + deploy module. |
| Honest "unreachable" when set but down | ⚠️ honest-gate | bridge `/servers` fetch fails → warning MessageBar (no fabricated state). |
| Bicep sync (image tag + app + UAMI + output + console env) | ✅ built | `appImageTags.mcpBridge`, `loom-mcp-bridge` apps[] entry, `uamiMcpBridge*`, `mcpBridgeUrl`, `LOOM_MCP_BRIDGE_URL`. |
| Build pipeline sync | ✅ built | `loom-mcp-bridge` in build-fiab-images(.yml + -acr-tasks.yml) + azd `mcp-bridge`. |
| Structural tests | ✅ built | `apps/fiab-mcp-bridge/tests/test_mcp_bridge.py` (22 tests). |

Zero ❌. The non-functional states are honest infra-gates, not stubs.

## Backend per control

| Control | Backend |
| --- | --- |
| `POST /servers/<id>/tools/list` | spawns the catalog entry's stdio child (npx/uvx), `initialize` + `tools/list` JSON-RPC over stdio, returns the real tool list. |
| `POST /servers/<id>/tools/call` | forwards `tools/call` to the live child; returns the real tool result. |
| `GET /servers/<id>/sse` + `POST /servers/<id>/message` | raw JSON-RPC pass-through to the child; replies streamed over the SSE channel. |
| `GET /.well-known/health`, `GET /servers` | catalog read; no child spawn. |
| Console `BridgeMcpCard` "Register" | `POST /api/admin/mcp-servers` → Cosmos `mcp-servers` (the normal external-MCP store) with `endpoint = <bridge>/servers/<id>`. |

## No-Fabric / per-cloud

Azure-native only: an internal-ingress Container App (Commercial/GCC) or AKS
workload (GCC-High/IL5) running under a UAMI. No `api.fabric.microsoft.com` /
`api.powerbi.com` / OneLake on any path. Gov boundary excludes catalog entries
that reach `*.azure.com` via the `boundaries` tag. Works fully with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset (it is irrelevant to this surface).

## Verification

- `pytest apps/fiab-mcp-bridge/tests/test_mcp_bridge.py` → 22 passed.
- Local boot: `node src/server.mjs` → `GET /.well-known/health` 200,
  `GET /servers` lists enabled catalog entries (boundary-filtered),
  unknown server id → 404.
- Console: `tsc --noEmit` clean for the touched files; `BridgeMcpCard`
  renders the honest gate when `LOOM_MCP_BRIDGE_URL` is unset.
