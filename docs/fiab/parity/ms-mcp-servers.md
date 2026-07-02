# ms-mcp-servers — parity with the curated Microsoft MCP servers + agent skills

Source: the open-source Microsoft MCP server collection
(**github.com/microsoft/mcp**) and the Microsoft agent-skill library
(**github.com/microsoft/skills**). The parity target is "every relevant
Microsoft MCP server is reachable from CSA Loom Copilot, and the ~30 Microsoft
agent skills ground Loom's Copilot", with NO parallel system — the whole feature
**extends the already-committed Power BI remote-MCP + skill plumbing**.

Grounded in Microsoft Learn (microsoft_docs_search / docs_fetch, 2026-06):
- Microsoft Learn MCP: https://learn.microsoft.com/training/support/mcp (endpoint `https://learn.microsoft.com/api/mcp`, GA, **no auth**)
- Azure MCP Server: https://learn.microsoft.com/azure/developer/azure-mcp-server/ + remote/OBO: https://learn.microsoft.com/azure/developer/azure-mcp-server/deploy-remote-mcp-server-on-behalf-of
- Microsoft Foundry MCP: https://learn.microsoft.com/azure/ai-foundry/ (`https://mcp.ai.azure.com`, preview)
- Microsoft Graph / Enterprise MCP: https://learn.microsoft.com/graph/ (`https://mcp.svc.cloud.microsoft/enterprise`, preview)
- Microsoft Sentinel MCP: https://learn.microsoft.com/azure/sentinel/datalake/sentinel-mcp-overview (`https://sentinel.microsoft.com/mcp/data-exploration`, preview)
- Dataverse MCP: https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-mcp (`https://<org>.crm.dynamics.com/api/mcp`, preview)
- GitHub MCP: https://github.com/github/github-mcp-server (`https://api.githubcopilot.com/mcp`, GA, GitHub OAuth/PAT)
- Azure DevOps MCP: https://github.com/microsoft/azure-devops-mcp (`@azure-devops/mcp`; remote `https://mcp.dev.azure.com/<org>`)
- Data API builder SQL MCP: https://learn.microsoft.com/azure/data-api-builder/
- MarkItDown: https://github.com/microsoft/markitdown · AKS MCP: https://github.com/Azure/aks-mcp · NuGet MCP: https://github.com/microsoft/mcp

> **Reuse, not a parallel system.** The remote family is the GENERALIZED form of
> the Power BI `RemoteBuiltinMcp` descriptor (`lib/mcp/catalog.ts`); the skills
> are the SAME `LoomCopilotSkill` shape as `lib/copilot/powerbi-skills.ts`; the
> register/probe BFF generalizes `app/api/admin/mcp-servers/powerbi/route.ts`;
> registration, the MCP client (`resolveAuthHeader` + per-user `userToken`), and
> `buildMcpShim` (`mcp_<slug>_<tool>`) are all UNCHANGED paths.

## No-fabric-dependency posture (`.claude/rules/no-fabric-dependency.md`)

- **Microsoft Learn is the SOLE default-on server** — `auth: 'none'`, zero
  config, zero Fabric dependency. `defaultOnRemoteMcps()` (catalog) →
  `syntheticDefaultOnServers()` (`mcp-shim.ts`) / `listMcpServers()`
  (`mcp-config-store.ts`) inject it as a synthetic enabled row so its tools
  (`mcp_mslearn_*`) are live day-one with no admin action.
- **Every other remote server is STRICTLY OPT-IN** and inert until its
  descriptor `configured()` is true (an `enableEnv`, an endpoint, and either the
  shared Entra OBO client or a Key Vault PAT). Each renders an honest Fluent
  MessageBar gate until then; it is registered/called on NO code path.
- **The Fabric / Power BI family is explicit opt-in only.** The Fabric Core and
  Fabric RTI deployable entries carry `govSafe:false`, `defaultRecommended:false`,
  `fabricFamily:true`, `externalHosts:['api.fabric.microsoft.com']`; the Power BI
  remote entry is gated by `isPbiMcpConfigured()`. **No `api.fabric.microsoft.com`
  / `api.powerbi.com` host is reached on any default path.** Loom's Azure-native
  analytics (ADX / Synapse / Data API builder) and Azure-native semantic-model /
  report authoring remain the day-one defaults.

---

## A. Remote built-in servers (already-hosted HTTPS Streamable-HTTP, reached per-user)

`REMOTE_BUILTIN_MCP_CATALOG` in `lib/mcp/catalog.ts`. Each is registered as an
`McpServerConfig` row with `source:'remote-builtin'`; `auth:'none'` maps to
`authMethod:'header'` with an empty value (no `Authorization` header), `entra-obo`
and `key-vault` pass straight through. OBO servers carry **no static secret** —
the per-user token is minted at call time from the shared confidential client
(`LOOM_MSAL_CLIENT_ID` + `loom-msal-client-secret`) and looked up by
`oboResourceKey ?? oboResource` (`getUserOboToken`).

| Server | id | Endpoint (env override) | Auth | OBO resource / scopes | Default | Status |
|--------|----|--------------------------|------|------------------------|---------|--------|
| Microsoft Learn | `ms-learn` | `https://learn.microsoft.com/api/mcp` (`LOOM_MS_LEARN_MCP_ENDPOINT`) | none | — | **on** ✅ | built ✅ — live day-one |
| Azure Resources (ARM) | `azure-arm` | _(set `LOOM_AZURE_ARM_MCP_ENDPOINT`)_ | entra-obo | `https://management.azure.com` / `user_impersonation` | opt-in | honest-gate ⚠️ (preview) |
| Microsoft Foundry | `ms-foundry` | `https://mcp.ai.azure.com` (`LOOM_FOUNDRY_MCP_ENDPOINT`) | entra-obo | `https://ai.azure.com` / `.default` | opt-in | honest-gate ⚠️ (preview) |
| GitHub | `github` | `https://api.githubcopilot.com/mcp` (`LOOM_GITHUB_MCP_ENDPOINT`) | key-vault | PAT (GitHub OAuth, **not** Entra) | opt-in | honest-gate ⚠️ |
| Microsoft Graph (Enterprise) | `ms-graph` | `https://mcp.svc.cloud.microsoft/enterprise` (`LOOM_MS_GRAPH_MCP_ENDPOINT`) | entra-obo | `https://graph.microsoft.com` / `.default` | opt-in | honest-gate ⚠️ (preview) |
| Microsoft 365 | `m365` | _(set `LOOM_M365_MCP_ENDPOINT`)_ | entra-obo | `https://graph.microsoft.com` / `.default` | opt-in | honest-gate ⚠️ (preview, endpoint not GA) |
| Microsoft Teams | `teams` | _(set `LOOM_TEAMS_MCP_ENDPOINT`)_ | entra-obo | `https://graph.microsoft.com` / `.default` | opt-in | honest-gate ⚠️ (preview, endpoint not GA) |
| OneDrive & SharePoint | `onedrive-sharepoint` | _(set `LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT`)_ | entra-obo | `https://graph.microsoft.com` / `.default` | opt-in | honest-gate ⚠️ (preview, endpoint not GA) |
| Microsoft Sentinel | `ms-sentinel` | `https://sentinel.microsoft.com/mcp/data-exploration` (`LOOM_SENTINEL_MCP_ENDPOINT`) | entra-obo | `https://sentinel.microsoft.com` / `.default` | opt-in | honest-gate ⚠️ (preview, Security Reader+) |
| Microsoft 365 Admin Center | `admin-center` | _(set `LOOM_ADMIN_CENTER_MCP_ENDPOINT`)_ | entra-obo | `https://graph.microsoft.com` / `.default` | opt-in | honest-gate ⚠️ (preview, endpoint not GA) |
| Microsoft Dataverse | `dataverse` | _(set `LOOM_DATAVERSE_MCP_ENDPOINT` → `https://<org>.crm.dynamics.com/api/mcp`)_ | entra-obo | per-org (endpoint origin) / `.default` | opt-in | honest-gate ⚠️ (preview, tenant setting) |
| Power BI (Fabric family) | `powerbiremote` | `https://api.fabric.microsoft.com/v1/mcp/powerbi` (`LOOM_POWERBI_MCP_ENDPOINT`) | entra-obo | `https://analysis.windows.net/powerbi/api` / `Dataset.Read.All`, `MLModel.Execute.All`, `Workspace.Read.All` | **opt-in (never default)** | honest-gate ⚠️ — gated by `isPbiMcpConfigured()` |

Enable toggles: `LOOM_<SERVER>_MCP_ENABLED` (Learn defaults true; all others must
be `=true`). Where the Microsoft host is **not yet GA** the `defaultEndpoint` is
`''`, so the server stays gated until the admin supplies `…_MCP_ENDPOINT`
(no-vaporware — never a speculative host on a live path).

### Per-server backend / control

| Capability | Status | Backend |
|------------|--------|---------|
| List the whole family + per-server status (no probe) | built ✅ | `GET /api/admin/mcp-servers/ms-remote` → `statusFor(entry)` over `REMOTE_BUILTIN_MCP_CATALOG` |
| Honest gate when unconfigured (env / scopes / OBO resource / KV secret / tenant setting) | built ✅ | `gateFor(entry)` → `{ message, enableEnv, endpointEnv, scopes, oboResource, oboClientEnv, secretEnv, tenantSetting, docs }` from `entry.gate` + `msRemoteMcpScopeUris()` |
| Register a server | built ✅ | `POST /api/admin/mcp-servers/ms-remote` (capability `admin.deploy-mcp`) → `saveMcpServer` with `source:'remote-builtin'`, `catalogId`, `authMethod` from descriptor; idempotent in-place update |
| Real connectivity probe | built ✅ | `GET …?id=<id>&probe=1` → `listMcpTools(endpoint, authMethod, authValue, 8000, userToken)` — REAL `initialize → tools/list`; no mock |
| Per-user OBO token readiness | built ✅ | `getUserOboToken(oid, oboResource)`; surfaces `tokenReady`/`tokenNote` ("sign in again and consent") without faking OK |
| Day-one Learn tools live | built ✅ | `defaultOnRemoteMcps()` → synthetic enabled row in `mcp-shim.ts` / `mcp-config-store.ts` (`mcp_mslearn_*`) |
| OBO token keyed by the server's resource | built ✅ | `mcp-shim.ts` generalized from the hard-coded `getPbiUserToken(oid)` to `getUserOboToken(oid, oboResourceKey ?? oboResource)`; legacy PBI rows fall back to `getPbiUserToken` |
| Admin cards (web3-ui) | built ✅ | `MsRemoteMcpCard` grid in `mcp-servers-panel.tsx`, reusing the `pbiCard` Loom-token card (shadow4→shadow16 hover); Connect / Probe buttons hit the route above |

---

## B. Deployable servers (stdio → host on Azure Container Apps, then register)

`MCP_CATALOG` in `lib/mcp/catalog.ts`, `source:'microsoft'`. These have no
first-party hosted HTTPS endpoint, so they carry `hostVia:'container-apps'`
(`requiresHosting()` honest gate) and stand up through the existing deploy
catalog (`McpCatalogBrowser` / deploy wizard / `mcp-catalog.md`). They appear in
the catalog browser automatically.

| Server | id | Package / image | Host | Auth | Gov | Status |
|--------|----|------------------|------|------|-----|--------|
| Azure MCP Server | `azure` | `@azure/mcp` (npx) | container-apps | Entra (DefaultAzureCredential / MI) | ✅ | built ✅ (recommended) |
| Playwright | `playwright` | `@playwright/mcp` (npx) | container-apps | — | ✅ | built ✅ (recommended) |
| Microsoft SQL (Data API builder) | `microsoft-sql` | `mcr.microsoft.com/azure-databases/data-api-builder:latest` | container-apps | conn-string (KV secret) | ✅ | built ✅ — connection-string gate |
| Azure DevOps | `azure-devops` | `@azure-devops/mcp` (npx) | container-apps | Entra / PAT | ✅ | built ✅ — `ADO_ORGANIZATION` gate (remote `mcp.dev.azure.com/<org>` noted) |
| Azure Kubernetes Service (AKS) | `aks` | docker — **`IMAGE_REF` required** | container-apps | Entra / kubeconfig | ✅ | honest-gate ⚠️ — no public image; build from `Azure/aks-mcp` |
| MarkItDown | `markitdown` | `markitdown-mcp` (uvx) | container-apps | — (air-gap safe) | ✅ | built ✅ |
| NuGet | `nuget` | docker — **`IMAGE_REF` required** | container-apps | — (reaches `api.nuget.org`) | ✅ | honest-gate ⚠️ — no public image |
| **Microsoft Fabric (Core)** | `fabric` | docker — **`IMAGE_REF` required** | container-apps | Entra OAuth (`api.fabric.microsoft.com`) | ❌ | honest-gate ⚠️ — **explicit Fabric opt-in**, `fabricFamily:true` |
| **Microsoft Fabric RTI** | `fabric-rti` | docker — **`IMAGE_REF` required** | container-apps | Entra OAuth (`api.fabric.microsoft.com`) | ❌ | honest-gate ⚠️ — **explicit Fabric opt-in**, `fabricFamily:true` |

Where no first-party PUBLIC image exists (`aks`, `nuget`, `fabric`, `fabric-rti`)
the entry carries a **required `IMAGE_REF` configSchema field** → an honest "build
from source, push to your ACR, set the image ref" gate (no-vaporware — no
fabricated image tag). Secret fields (e.g. the SQL connection string) resolve via
Key Vault `secretRef`, never literals.

---

## C. Microsoft agent skills (~30, grounding Loom Copilot)

`lib/copilot/ms-skills.ts` — **37 `MsAgentSkill` descriptors** (`MS_AGENT_SKILLS`)
that `extends LoomCopilotSkill` with two additive optional fields,
`mcpToolPrefix?` and `attribution?` (backward-compatible — no fork of the shape).
Attributed to **github.com/microsoft/skills**. Every skill's `defaultTarget` is
`'azure-native'` and its `toolNames` map ONE-FOR-ONE to tools already registered
in the `LoomToolRegistry` (`loom_self_audit`/`loom_heal`, `item_*`, `lakehouse_*`,
`adx_*`/`kql_*`, `apim_*`, `synapse_*`, `foundry_*`, `iq_*`, …) — no new tools
minted. When the mapped opt-in MS MCP is connected the skill additionally surfaces
its live tools via `mcpToolPrefix` (e.g. `mcp_azurearm_`, `mcp_msfoundry_`,
`mcp_msgraph_`, `mcp_mssentinel_`, `mcp_dataverse_`, `mcp_github_`); the
default-on `mcp_mslearn_` is always available.

Skill groups (id → mapped MS MCP prefix): Azure platform (`azure-prepare`,
`azure-deploy`, `azure-validate`, `azure-rbac`, `azure-cost`, `azure-diagnostics`,
`azure-compliance`, `azure-resource-lookup`, `azure-resource-visualizer`,
`azure-storage`, `azure-messaging`, `azure-quotas`, `azure-aigateway`,
`azure-cosmos`, `azure-postgres`, `azure-eventhubs`, `azure-servicebus`,
`azure-eventgrid`, `entra-app-registration`, `azure-keyvault`, `azure-adx`,
`azure-monitor`, `app-insights` → `mcp_azurearm_`); Foundry / AI (`microsoft-foundry`,
`foundry-models`, `foundry-iq-knowledge-bases`, `foundry-observability`,
`foundry-governance`, `azure-ai`, `azure-ai-contentsafety`,
`azure-ai-document-intelligence` → `mcp_msfoundry_`); KQL authoring; cloud
solution architect; MCP server builder; Microsoft Learn docs (→ `mcp_mslearn_`);
React Flow node; skill creator.

| Capability | Status | Backend |
|------------|--------|---------|
| Skill descriptors (pure data + selectors) | built ✅ | `MS_AGENT_SKILLS` in `lib/copilot/ms-skills.ts` |
| Pane persona injection | built ✅ | `copilot-personas.ts` imports `MS_AGENT_SKILLS` / `msSkillsByIds` (single source) |
| Per-pane extra system message at orchestrate time | built ✅ | `copilot-orchestrator.ts` → `msSkillSystemBlocksForPane(contextSlug, …)` pushed as a `role:'system'` message; `buildMcpShim` runs before the loop |
| Honest skill gate (opt-in MS MCP not connected) | built ✅ | `msSkillSystemBlock` emits the catalog entry's verbatim `gate` (env / KV secret / scope / consent); Azure-native tools work regardless |

---

## D. Day-one / bicep + secrets

- `LOOM_MS_LEARN_MCP_ENABLED` defaults **true**; the Learn row is synthesized
  enabled by `listMcpServers` / `buildMcpShim` — Learn tools live with zero config.
- Opt-in toggles + per-server endpoint / scope overrides fold into the
  `loomBackends.mcp` sub-object (stays under the ARM 256-param limit, same trick
  as `loomWarehouseBackend` / the Power BI settings).
- **OBO servers reuse the existing confidential client** (`LOOM_MSAL_CLIENT_ID` +
  `loom-msal-client-secret`) for the per-user On-Behalf-Of exchange — **no new
  secret literal**. GitHub's PAT is a **Key Vault `secretRef` (name only)** via
  `LOOM_GITHUB_MCP_PAT_SECRET`; the PAT value never lands in Cosmos or env.

## E. Endpoints / scopes still needing GA confirmation

Each unconfirmed host is gated behind its `…_MCP_ENDPOINT` env (empty
`defaultEndpoint`) so it is NEVER on a default path until set; treat as **preview**:

- **Microsoft Foundry** — `https://mcp.ai.azure.com`; OBO audience modeled as
  `https://ai.azure.com/.default` (may instead be a Cognitive Services audience).
  Hosted server is public-endpoint only (no network isolation).
- **Microsoft 365 / Teams / OneDrive-SharePoint / Admin Center** — no published
  GA remote MCP endpoint yet; `defaultEndpoint` empty, OBO against
  `https://graph.microsoft.com/.default` pending the GA audience/scopes.
- **Microsoft Graph (Enterprise)** — `https://mcp.svc.cloud.microsoft/enterprise`
  is preview; requires the `MCP.*` delegated Graph permissions + admin consent.
- **Azure MCP remote/OBO** — `azure-arm` has no fixed Microsoft host; self-host
  the Azure MCP server with OBO (per the Learn deploy doc) and set the endpoint.
- **Deployable images** — `aks`, `nuget`, `fabric`, `fabric-rti` have no
  first-party PUBLIC OCI image confirmed; each requires `IMAGE_REF`.

Confirmed GA / available today: **Microsoft Learn** (no auth), **GitHub**
(`api.githubcopilot.com/mcp`), **Azure MCP** (`@azure/mcp`), **Azure DevOps**
(`@azure-devops/mcp` + remote `mcp.dev.azure.com`), **Data API builder SQL**,
**MarkItDown**, and **Microsoft Sentinel** / **Dataverse** in preview with
documented Microsoft-hosted endpoints.

## Verification

- `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET → Microsoft Learn tools (`mcp_mslearn_*`)
  register and answer via the synthetic default-on row; the Azure-native skills
  function with no MS MCP connected; every opt-in card shows its honest gate.
  No `api.fabric.microsoft.com` / `api.powerbi.com` host is reached.
- Connect an opt-in server in the admin panel → `?probe=1` makes a REAL
  `initialize → tools/list` under the correct credential and returns the live
  tool count (or an honest 401/403 naming the missing scope/consent/tenant
  setting). The Fabric / RTI deployable entries only stand up when an admin
  explicitly supplies `IMAGE_REF` and deploys them — never automatically.
