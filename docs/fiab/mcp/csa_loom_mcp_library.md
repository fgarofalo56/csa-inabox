# CSA Loom MCP Library

The **MCP library** is the curated, typed catalog of Model Context Protocol
servers CSA Loom can run for you — and the front-end + wiring that turns each
catalog entry into a one-click, zero-Azure-portal registration in the Console's
**Admin Portal → External MCP Tools** panel.

This document is the canonical index for the **stdio→HTTP/SSE bridge** slice of
that library: the `npx`/`uvx` (stdio-transport) servers, the bridge that exposes
them over HTTP/SSE, and the one-click registration flow. It is grounded in
Microsoft Learn and stays 1:1 with the typed catalog file — there is **no
free-form config surface**; the catalog is the only place a bridged server is
declared (per `.claude/rules/loom-no-freeform-config.md`).

> Azure-native by default. Nothing here requires a real Microsoft Fabric
> capacity, workspace, or `LOOM_DEFAULT_FABRIC_WORKSPACE`. The bridge runs on
> an Azure Container App (Commercial/GCC) or an AKS workload (GCC-High/IL5).
> See `.claude/rules/no-fabric-dependency.md`.

## Why stdio servers need a bridge

Loom's External-MCP registration path is **HTTP-only**. `McpServerConfig`
(`apps/fiab-console/lib/types/mcp-config.ts`) carries a single `endpoint` URL,
and `apps/fiab-console/lib/azure/mcp-client.ts` speaks JSON-RPC over HTTP
(`POST {endpoint}/tools/list`, `POST {endpoint}/tools/call`). A stdio MCP server
— the kind you'd normally launch with `npx <pkg>` (Node) or `uvx <pkg>`
(Python) — cannot be registered as-is: it talks newline-delimited JSON-RPC over
a child process's stdin/stdout, not HTTP.

The **stdio→HTTP/SSE bridge** (`apps/fiab-mcp-bridge/`) is the missing
front-end for those servers. It spawns the stdio child, speaks JSON-RPC over its
stdin/stdout, and re-exposes the result over HTTP/SSE — producing exactly the
endpoint the Console + `copilot-orchestrator` already consume. **No change to
the Console contract.** It is the Loom-native, Azure-hosted equivalent of the
open-source `supergateway` / `mcp-proxy` stdio↔SSE gateways.

### Microsoft Learn grounding

- **Connect agents to Model Context Protocol servers** —
  <https://learn.microsoft.com/azure/foundry/agents/how-to/tools/model-context-protocol>
  — UVX/NPX start commands are **Supported on Azure Container Apps** and **Not
  supported on Azure Functions** (`npx` start commands unsupported there). This
  is why the bridge ships as a Container App / AKS workload, never a Function.
- **Host MCP servers on Azure Container Apps** —
  <https://learn.microsoft.com/azure/container-apps/mcp-overview> — ACA hosts
  MCP over HTTP POST/GET with JSON-RPC 2.0 (streamable HTTP / SSE), and private
  MCP servers use **internal-only ingress** on a dedicated subnet delegated to
  `Microsoft.App/environments`. The bridge runs `external: false` (internal
  ingress) to match.

## How a bridged server is exposed (per catalog `<id>`)

The bridge serves every enabled catalog entry under `/servers/<id>`:

| Method + path | Purpose | Consumer |
| --- | --- | --- |
| `POST /servers/<id>/tools/list` | JSON-RPC `tools/list` | Console `mcp-client.ts` |
| `POST /servers/<id>/tools/call` | JSON-RPC `tools/call` | Console `mcp-client.ts` |
| `GET  /servers/<id>/sse` | MCP SSE stream (`endpoint` event then messages) | External agents (Foundry / Agent 365 / Copilot Studio) |
| `POST /servers/<id>/message?sessionId=…` | SSE-channel JSON-RPC in | External agents |
| `GET  /.well-known/health` | Liveness/readiness | Container App probes |
| `GET  /servers` | Catalog summary (no secrets) | Console one-click card |

The **registration endpoint** for any bridged server is:

```
http://loom-mcp-bridge:8080/servers/<id>
```

This is the value the Console's `BridgeMcpCard` registers as the
`McpServerConfig.endpoint` when you click **Register** — no JSON, no command
string, no port to pick.

## Catalog (the library entries)

Source of truth: **`apps/fiab-mcp-bridge/config/loom-mcp-bridge.json`**. Each
entry is a typed record (no free-form `command` field). The fields are:

| Field | Meaning |
| --- | --- |
| `id` | Route segment + Console server id (`/servers/<id>`). |
| `displayName` | Human label shown on the one-click card. |
| `description` | What the server does + its network posture. |
| `transport` | Always `stdio` for bridged servers. |
| `launcher` | `npx` or `uvx` **only** — any other value is rejected by `stdio-client.mjs`. |
| `launcherArgs` | e.g. `["-y"]` for `npx -y`. |
| `package` | The package the launcher runs. |
| `args` | Args passed to the server. |
| `envAllowlist` | The **only** env names forwarded to the child (secret boundary). |
| `outputTransport` | `sse`. |
| `boundaries` | Clouds the entry is allowed in; filtered at startup by `AZURE_CLOUD`. |
| `enabled` | Off-by-default entries stay disabled until explicitly turned on. |

### Library entries (current)

| id | Display name | Launcher | Package | envAllowlist | Boundaries | Enabled | Registration endpoint |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `everything` | MCP Reference (everything) | `npx -y` | `@modelcontextprotocol/server-everything` | — | AzureCloud, AzureUSGovernment | yes | `http://loom-mcp-bridge:8080/servers/everything` |
| `time` | Time & timezone | `uvx` | `mcp-server-time` | — | AzureCloud, AzureUSGovernment | yes | `http://loom-mcp-bridge:8080/servers/time` |
| `git` | Git repository tools | `uvx` | `mcp-server-git` | `MCP_GIT_REPO` | AzureCloud, AzureUSGovernment | yes | `http://loom-mcp-bridge:8080/servers/git` |
| `fetch` | Web fetch | `uvx` | `mcp-server-fetch` | — | AzureCloud (Commercial/GCC only) | no | `http://loom-mcp-bridge:8080/servers/fetch` |

Notes:

- **`everything`** is the official MCP reference server. It exercises tools,
  prompts, and resources with no outbound network — use it to validate the
  bridge end-to-end in any boundary.
- **`time`** is pure compute (no outbound network), safe in every boundary.
- **`git`** reads a Git repo mounted into the bridge; the repo path arrives via
  the allow-listed `MCP_GIT_REPO` env var — nothing else from the bridge's own
  environment reaches the child.
- **`fetch`** reaches arbitrary public URLs, so it is **Commercial/GCC only**
  (`boundaries: ["AzureCloud"]`) and ships **disabled** — turn it on explicitly,
  and it is dropped from the Gov catalog by the boundary filter regardless.

## The secret boundary (`envAllowlist`)

Secrets arrive on the Container App as Key Vault `secretRef` env vars. The
bridge forwards **only** the names in an entry's `envAllowlist` to the child
process (`StdioMcpClient.childEnv()` also passes through PATH/HOME/locale).
The bridge's own identity/config env is never exposed to a bridged server. This
mirrors the `tools-commercial.yaml` / `tools-gov.yaml` discipline in
`apps/fiab-mcp-config`.

## Boundary awareness (per-cloud)

`AZURE_CLOUD` (`AzureCloud` | `AzureUSGovernment`) filters the catalog at
startup (`loadCatalog()` in `src/server.mjs`): an entry whose `boundaries`
omits the active cloud is disabled. This keeps a server that reaches
`*.azure.com` (e.g. `fetch`) out of a `*.azure.us` tenant.

| Boundary | Host | `AZURE_CLOUD` | `AZURE_AUTHORITY_HOST` | Notes |
| --- | --- | --- | --- | --- |
| Commercial / GCC | Azure Container App, internal ingress, UAMI `uami-loom-mcp-bridge-<region>` | `AzureCloud` | `https://login.microsoftonline.com/` | Default Azure-native path. |
| GCC-High / IL5 | AKS workload (Container Apps not at IL4+) | `AzureUSGovernment` | `https://login.microsoftonline.us/` | `*.azure.com` servers (e.g. `fetch`) excluded by boundary tag. |

No `api.fabric.microsoft.com` / `api.powerbi.com` / OneLake is reached on any
path — the bridge is Azure-native only.

## One-click registration flow (Console)

1. Operator opens **Admin Portal → External MCP Tools** in the Loom Console.
2. The **bridged-servers card** (`BridgeMcpCard` in
   `apps/fiab-console/lib/components/admin/mcp-servers-panel.tsx`) calls
   `GET /api/admin/mcp-servers/bridge`
   (`apps/fiab-console/app/api/admin/mcp-servers/bridge/route.ts`).
3. That route reads `LOOM_MCP_BRIDGE_URL`:
   - **Unset** → the card renders an **honest Fluent gate** naming the env var,
     the bicep module that deploys the bridge, and the bootstrap doc. No
     fabricated server list (per `.claude/rules/no-vaporware.md`).
   - **Set** → the route fetches the bridge's `GET /servers` (5 s abort
     timeout). If the bridge is unreachable it degrades to an honest
     "unreachable" warning rather than inventing state.
4. For each enabled, boundary-matched entry the card shows a **Register**
   button. Clicking it registers `endpoint =
   http://loom-mcp-bridge:8080/servers/<id>` as an `McpServerConfig` — no JSON
   textarea, no command field, no port selection.

## Deployment wiring

Everything below is already wired and kept in sync with bicep + azd (per the
bicep-sync requirement in `.claude/rules/no-vaporware.md`):

| Concern | Where |
| --- | --- |
| Bridge image | `apps/fiab-mcp-bridge/Dockerfile` (`node:20-slim`, pins `uv` for `uvx`, non-root, `HEALTHCHECK` on `/.well-known/health`, `EXPOSE 8080`). |
| Wrapper config (catalog) | `apps/fiab-mcp-bridge/config/loom-mcp-bridge.json`. |
| Bridge server | `apps/fiab-mcp-bridge/src/server.mjs`, `src/stdio-client.mjs`, `entrypoint.sh`. |
| Image tag | `appImageTags.mcpBridge` in `platform/fiab/bicep/modules/admin-plane/main.bicep` (default `v0.1`). |
| Container App entry | `loom-mcp-bridge` in the `apps:` array of `admin-plane/main.bicep` (ingress 8080, `external: false`, health `/.well-known/health`, tier `mcp`). |
| Managed identity | `uamiMcpBridge` in `admin-plane/identity.bicep` (outputs `uamiMcpBridgeId/ClientId/PrincipalId`). |
| Per-boundary env | `AZURE_CLOUD` / `AZURE_AUTHORITY_HOST` set conditionally on `boundary == 'GCC-High' || boundary == 'IL5'`. |
| Bridge URL output | `mcpBridgeUrl` output of `admin-plane/main.bicep`. |
| Console env injection | `LOOM_MCP_BRIDGE_URL=http://loom-mcp-bridge:8080` on the Console app (gated by `deployAppsEnabled`). |
| azd service | `mcp-bridge` in `platform/fiab/azd/azure.yaml` (`host: containerapp`). |

## Adding a server to the library

1. Add a typed entry to `apps/fiab-mcp-bridge/config/loom-mcp-bridge.json`
   (`launcher` must be `npx` or `uvx`; set `envAllowlist`, `boundaries`,
   `enabled`).
2. If the server needs a secret, add the Key Vault `secretRef` env var to the
   bridge app's env in `admin-plane/main.bicep` and list its **name** in the
   entry's `envAllowlist`.
3. Rebuild/push the bridge image (the new `package` is pulled at runtime via
   `npx`/`uvx`, but `entrypoint.sh` pre-warms enabled, boundary-matched caches).
4. The Console card surfaces the new entry automatically — no Console change.

## Related

- Bridge app README: `apps/fiab-mcp-bridge/README.md`
- Parity doc: `docs/fiab/parity/mcp-stdio-bridge.md`
- Console contract: `apps/fiab-console/lib/types/mcp-config.ts`,
  `apps/fiab-console/lib/azure/mcp-client.ts`
- Self-hosted Azure MCP analog: `apps/fiab-mcp-config`
- Rules: `.claude/rules/{no-vaporware,no-fabric-dependency,loom-no-freeform-config}.md`
