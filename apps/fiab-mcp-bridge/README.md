# Loom MCP stdio→HTTP/SSE bridge

Runs **stdio-transport** MCP servers — the ones you'd normally launch with
`npx` or `uvx` — inside the Loom Admin Plane and exposes each one over
**HTTP/SSE** on an internal-ingress Container App (`:8080`).

## Why this exists

Loom's External-MCP registration path is **HTTP-only**: `McpServerConfig`
(`apps/fiab-console/lib/types/mcp-config.ts`) carries a single `endpoint`
URL, and `apps/fiab-console/lib/azure/mcp-client.ts` talks JSON-RPC over
HTTP. A stdio MCP server launched via `npx`/`uvx` can't be registered as-is.

This bridge is the missing front-end for those servers: it spawns the stdio
child, speaks newline-delimited JSON-RPC to it, and serves the result over
HTTP — producing exactly the endpoint the Console + `copilot-orchestrator`
already consume. **No change to the Console contract.**

> Azure Functions can't host this — `npx`/`uvx` start commands are
> unsupported there. Container Apps (Commercial/GCC) or an AKS workload
> (GCC-High/IL5) is required. See *Connect agents to MCP servers* on
> Microsoft Learn.

## Endpoints (per catalog entry `<id>`)

| Method + path | Purpose | Consumer |
|---|---|---|
| `POST /servers/<id>/tools/list` | JSON-RPC `tools/list` | Loom Console `mcp-client.ts` |
| `POST /servers/<id>/tools/call` | JSON-RPC `tools/call` | Loom Console `mcp-client.ts` |
| `GET  /servers/<id>/sse` | MCP SSE stream (`endpoint` event then messages) | External agents (Foundry / Agent 365 / Copilot Studio) |
| `POST /servers/<id>/message?sessionId=…` | SSE-channel JSON-RPC in | External agents |
| `GET  /.well-known/health` | Liveness/readiness | Container App probes |
| `GET  /servers` | Catalog summary (no secrets) | Console one-click card |

Register a bridged server in the Console with
`endpoint = http://loom-mcp-bridge:8080/servers/<id>`.

## Catalog (no free-form config)

Bridged servers come from the typed catalog `config/loom-mcp-bridge.json`
— **never** a UI command/JSON textarea (per `.claude/rules/loom-no-freeform-config.md`).
Each entry:

```jsonc
{
  "id": "time",                       // route segment + Console server id
  "displayName": "Time & timezone",
  "description": "…",
  "transport": "stdio",
  "launcher": "npx" | "uvx",          // only these two are allowed
  "launcherArgs": ["-y"],             // e.g. npx -y
  "package": "mcp-server-time",       // package the launcher runs
  "args": [],                         // args passed to the server
  "envAllowlist": ["MCP_GIT_REPO"],   // ONLY these env names reach the child
  "outputTransport": "sse",
  "boundaries": ["AzureCloud", "AzureUSGovernment"],
  "enabled": true
}
```

`envAllowlist` is the secret boundary: secrets arrive as Key Vault
`secretRef` env vars on the Container App, and **only allow-listed names**
are forwarded to the child process — the bridge's own identity/config env
is never exposed to a bridged server.

## Boundary awareness (per-cloud)

`AZURE_CLOUD` (`AzureCloud` | `AzureUSGovernment`) filters the catalog at
startup: an entry whose `boundaries` omits the active cloud is **disabled**.
This keeps a server that reaches `*.azure.com` (e.g. `fetch`) out of a
`*.azure.us` tenant — the same discipline as `tools-commercial.yaml` /
`tools-gov.yaml` in `../fiab-mcp-config`.

- **Commercial / GCC**: Container App, internal ingress, Managed Identity.
- **GCC-High / IL5**: AKS workload (Container Apps not at IL4+) via the
  `gitopsManifest` path in `app-deployments.bicep`; set
  `AZURE_AUTHORITY_HOST=login.microsoftonline.us`.

## Auth & transport

- TLS terminated at the ingress; the pod listens HTTP on `:8080`
  (`external: false`).
- The bridge itself is reachable only inside the Loom vnet. Bridged-child
  outbound auth (if any) is supplied via `envAllowlist` secrets.

## Deploy wiring

- Container image tag: `appImageTags.mcpBridge` in
  `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- App entry: `loom-mcp-bridge` in the `apps:` array (gated by
  `deployAppsEnabled`), UAMI `uamiMcpBridge*` from `identity.bicep`.
- Output: `mcpBridgeUrl`.
- Console env: `LOOM_MCP_BRIDGE_URL=http://loom-mcp-bridge:8080` → the
  External-MCP panel offers each bridged server for one-click registration;
  unset → honest Fluent gate.
- azd service: `mcp-bridge` in `platform/fiab/azd/azure.yaml`.

## Local run

```bash
node src/server.mjs              # listens on :8080
curl localhost:8080/.well-known/health
curl localhost:8080/servers
curl -XPOST localhost:8080/servers/time/tools/list \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Related

- MCP library index: `docs/fiab/mcp/csa_loom_mcp_library.md`
- Analog: `../fiab-mcp-config` (self-hosted Azure MCP server)
- Console contract: `apps/fiab-console/lib/types/mcp-config.ts`,
  `apps/fiab-console/lib/azure/mcp-client.ts`
- Parity doc: `docs/fiab/parity/mcp-stdio-bridge.md`
- Rules: `.claude/rules/{no-vaporware,no-fabric-dependency,loom-no-freeform-config}.md`
