# admin-mcp-servers — Admin MCP Servers, full inline enable + configure

Source UI: Loom-native admin surface (`/admin/mcp-servers`). Not a 1:1 mirror of a
single Azure/Fabric page — it is Loom's own control plane for the Model Context
Protocol tools Loom Copilot can call. Parity here means **every server in the
catalog can be seen, enabled, configured, and probed from this one page** — no
env-var redeploy required for the opt-in remote family.

## Server classes on the page

| Class | Source | Where | Enable | Configure inline | Status/probe |
|-------|--------|-------|--------|------------------|--------------|
| Loom built-in MCP (Azure Function) | `azure-functions/mcp-server` | BuiltinMcpCard | Register button | honest env gate | reachability |
| stdio→HTTP/SSE bridge servers | `apps/fiab-mcp-bridge` | BridgeMcpCard | Register per server | bridge catalog | reachable check |
| Deployable catalog (Container Apps) | `MCP_DEPLOY_CATALOG` | McpCatalogBrowser wizard | Deploy | ✅ per-field wizard (KV secretRefs) | deployed status |
| **Remote built-in family (12)** | `REMOTE_BUILTIN_MCP_CATALOG` | MicrosoftMcpServersSection + PowerBiRemoteMcpCard | ✅ **inline Configure** | ✅ **inline** (enable / endpoint / KV secret name) | ✅ `?probe=1` initialize→tools/list |
| External endpoints | admin-registered | Registered servers table | enabled flag | typed form | probe on save |
| Loom-as-MCP | `/api/iq/mcp` | IqMcpPanel | publish | — | — |

## What this change added (the gap it closed)

Before: the remote built-in family (Microsoft Learn, Azure ARM, Foundry, Graph,
M365, Teams, OneDrive/SharePoint, Sentinel, Admin Center, Dataverse, GitHub, plus
the projected Power BI entry) was configurable **only via deployment environment
variables** — an admin could *see* the honest gate but could not enable a server
from the UI. Now each card has an inline **Configure** dialog with typed fields
driven by the descriptor's declared shape (loom-no-freeform-config):

- **Enabled** — a Switch. Disabled + explained when the deployment env force-on it
  (`envForced`); otherwise the admin's per-tenant enable toggle.
- **Endpoint** — for the not-yet-GA servers (`defaultEndpoint: ''`). SSRF-checked
  before persist.
- **Key Vault secret name** — for the key-vault (GitHub PAT) server. Stores the
  secret **name** only, never the value.

## Backend per control (all real, no vaporware)

- Persistence: `lib/azure/mcp-remote-config-store.ts` → one per-tenant doc in the
  `mcp-servers` Cosmos container (PK `/tenantId`; `type:'remote-builtin-config'`,
  no `enabled`/`source` so it never collides with the server-list queries). No new
  container / bicep change.
- Merge: `effectiveRemoteState()` (`lib/mcp/catalog.ts`) — **env-first + additive**.
  A deployment env force-on always wins; overrides only add capability the env left
  off. With no override the result is byte-for-byte identical to `configured()`, so
  every existing env-configured deployment is unchanged.
- Routes: `PUT /api/admin/mcp-servers/ms-remote/config` (tenant-admin,
  SSRF-checked, audited) persists the typed override; `GET .../ms-remote[?probe=1]`
  returns the merged effective state + a real Streamable-HTTP handshake;
  `POST .../ms-remote` registers the effective config as an `McpServerConfig` row.
- Runtime honors overrides end-to-end: `listMcpServers`/`decorateMcpServers` keep +
  inject servers by effective state; the login OBO mint (`captureUserMcpOboTokens`,
  `captureUserMsRemoteMcpTokens`) mints per-user delegated tokens for
  admin-enabled entra-obo servers so they actually work at chat time.

## Loom coverage

- See ✅ — every catalog class rendered in one organized surface, web3 cards.
- Enable ✅ — Configure/Register/Deploy per class; remote family enable is inline.
- Configure ✅ — typed per-server fields (no freeform JSON); KV secret **names** only.
- Status ✅ — real `initialize → tools/list` probe (remote), deployed status (ACA).
- Honest gates ⚠️ — OBO servers still name `LOOM_MSAL_CLIENT_ID` (the shared
  confidential client is a platform prerequisite, not a per-tenant toggle); Power BI
  keeps its dedicated opt-in card (its Entra app registration
  `LOOM_POWERBI_MCP_CLIENT_ID` is a real app-reg, surfaced as an honest gate).

## Verification

`node scripts/ci/check-{bff-errors,route-guards,env-sync,no-freeform,docs-hygiene,no-raw-px,no-bare-client-fetch,duplicate-env,sql-quoting,bicep-sync}.mjs` — all green.
Unit: `lib/mcp/__tests__/remote-config.test.ts` locks the env-first-additive
semantics of `effectiveRemoteState`.
