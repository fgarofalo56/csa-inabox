# ms-agent-skills — parity with the Microsoft agent-skills library + Microsoft MCP servers

Source UI (upstream):

- Agent skills — **github.com/microsoft/skills** (open-source markdown "skill"
  folders that teach an agent *how* to do a task well: provision/deploy/validate
  Azure, audit RBAC, work with Foundry models, author KQL, build an MCP server,
  etc.).
- Remote MCP servers — **github.com/microsoft/mcp** + Microsoft Learn
  (`learn.microsoft.com/api/mcp`), Foundry MCP, the Microsoft Graph / Sentinel /
  Dataverse / GitHub remote MCP servers.

This is **not** a new subsystem. The Microsoft skills are distilled into pure
Loom-native Copilot **skill descriptors** that REUSE the already-committed Power
BI plumbing one-for-one — the same `LoomCopilotSkill` contract, the same per-pane
persona injection, the same remote-MCP `mcp_<slug>_<tool>` shim, and the same
honest opt-in gate. Only the *content* (37 Azure-native skills) and two additive
optional fields (`mcpToolPrefix`, `attribution`) are new.

Implementation (single-sourced):

| Concern | File | What it provides |
|---|---|---|
| Skill descriptors (37) + selectors | `apps/fiab-console/lib/copilot/ms-skills.ts` | `MS_AGENT_SKILLS`, `MsAgentSkill`, `msSkillsForPane`, `msSkillSystemBlock`, `msSkillSystemBlocksForPane`, `msMcpPrefix` |
| Descriptor contract (reused, widened) | `apps/fiab-console/lib/copilot/powerbi-skills.ts` | `LoomCopilotSkill` (+ optional `mcpToolPrefix` / `attribution`) |
| Remote MCP family (12 entries) | `apps/fiab-console/lib/mcp/catalog.ts` | `REMOTE_BUILTIN_MCP_CATALOG`, `RemoteBuiltinMcpEntry`, `msRemoteMcp*`, `defaultOnRemoteMcps` |
| Deployable MS servers (Fabric explicit opt-in) | `apps/fiab-console/lib/mcp/catalog.ts` | `MCP_CATALOG` (`source:'microsoft'`, `fabricFamily` flag) |
| Auth schema | `apps/fiab-console/lib/types/mcp-config.ts` | `authMethod 'none'/'header'/'key-vault'/'entra-obo'`, `oboResource`/`oboScopes`/`oboResourceKey` |
| Per-user token + tool registration | `apps/fiab-console/lib/azure/mcp-client.ts`, `apps/fiab-console/lib/azure/mcp-shim.ts` | `resolveAuthHeader`, threaded `userToken`, `mcp_<slug>_<tool>` |
| Pane persona injection | `apps/fiab-console/lib/azure/copilot-personas.ts` | imports `MS_AGENT_SKILLS`; appends `msSkillBlockForPane(slug)` to each persona's `systemPrompt` |
| Orchestrate-time injection | `apps/fiab-console/lib/azure/copilot-orchestrator.ts` | `msSkillSystemBlocksForPane(contextSlug, { connectedPrefixes })` extra system message; runs `buildMcpShim` before the loop |
| Admin BFF route | `apps/fiab-console/app/api/admin/mcp-servers/ms-remote/route.ts` | per-server status + honest gate; `POST` register (`source:'remote-builtin'`); `?probe=1` real handshake |
| Admin UI | `apps/fiab-console/lib/components/admin/mcp-servers-panel.tsx` | "Microsoft MCP servers" section (web3-ui Loom-token cards, reuses the `pbiCard` styles) |

---

## Source feature inventory — the Microsoft MCP remote-builtin family

Every skill grounds on Loom's Azure-native tools by default and, *when connected*,
the relevant Microsoft remote MCP. The remote family (`REMOTE_BUILTIN_MCP_CATALOG`)
is the generalized form of the Power BI `RemoteBuiltinMcp`. Microsoft Learn is the
**sole default-on** server (no auth, no config) — every other server is opt-in and
inert until its gate is satisfied (no-fabric-dependency).

| Server (`id`) | Tool prefix | Endpoint (provenance) | Auth | Default | Gate (env / secret / scope / consent) |
|---|---|---|---|---|---|
| Microsoft Learn (`ms-learn`) | `mcp_mslearn_` | `https://learn.microsoft.com/api/mcp` (GA) | `none` | **ON** | On by default; `LOOM_MS_LEARN_MCP_ENABLED=false` to disable; `LOOM_MS_LEARN_MCP_ENDPOINT` to override |
| Azure Resources / ARM (`azure-arm`) | `mcp_azurearm_` | endpoint-env-gated (self-hosted Azure MCP w/ OBO) | `entra-obo` (`management.azure.com/user_impersonation`) | opt-in (preview) | `LOOM_AZURE_ARM_MCP_ENDPOINT` + `LOOM_AZURE_ARM_MCP_ENABLED=true` + `LOOM_MSAL_CLIENT_ID` |
| Microsoft Foundry (`ms-foundry`) | `mcp_msfoundry_` | `https://mcp.ai.azure.com` (preview) | `entra-obo` (`ai.azure.com/.default`) | opt-in (preview) | `LOOM_FOUNDRY_MCP_ENABLED=true` + `LOOM_MSAL_CLIENT_ID` |
| GitHub (`github`) | `mcp_github_` | `https://api.githubcopilot.com/mcp` (GA) | `key-vault` (GitHub PAT, **not** Entra) | opt-in | `LOOM_GITHUB_MCP_PAT_SECRET` = KV secret name |
| Microsoft Graph / Enterprise (`ms-graph`) | `mcp_msgraph_` | `https://mcp.svc.cloud.microsoft/enterprise` (preview) | `entra-obo` (`graph.microsoft.com/.default`) | opt-in (preview) | MCP.* delegated Graph consent + `LOOM_MS_GRAPH_MCP_ENABLED=true` + `LOOM_MSAL_CLIENT_ID` |
| Microsoft Sentinel (`ms-sentinel`) | `mcp_mssentinel_` | `https://sentinel.microsoft.com/mcp/data-exploration` (preview) | `entra-obo` (`sentinel.microsoft.com/.default`) | opt-in (preview) | Security Reader on the Sentinel data lake + `LOOM_SENTINEL_MCP_ENABLED=true` + `LOOM_MSAL_CLIENT_ID` |
| Microsoft Dataverse (`dataverse`) | `mcp_dataverse_` | `https://<org>.crm.dynamics.com/api/mcp` (per-org) | `entra-obo` (org origin `/.default`) | opt-in (preview) | `LOOM_DATAVERSE_MCP_ENDPOINT` + Power Platform admin MCP setting + `LOOM_DATAVERSE_MCP_ENABLED=true` |
| Microsoft 365 (`m365`) | `mcp_m365_` | endpoint-env-gated (not yet GA) | `entra-obo` (`graph.microsoft.com/.default`) | opt-in (preview) | `LOOM_M365_MCP_ENDPOINT` + `LOOM_M365_MCP_ENABLED=true` + `LOOM_MSAL_CLIENT_ID` |
| Microsoft Teams (`teams`) | `mcp_teams_` | endpoint-env-gated (not yet GA) | `entra-obo` (`graph.microsoft.com/.default`) | opt-in (preview) | `LOOM_TEAMS_MCP_ENDPOINT` + `LOOM_TEAMS_MCP_ENABLED=true` + `LOOM_MSAL_CLIENT_ID` |
| OneDrive & SharePoint (`onedrive-sharepoint`) | `mcp_onedrivesharepoint_` | endpoint-env-gated (not yet GA) | `entra-obo` (`graph.microsoft.com/.default`) | opt-in (preview) | `LOOM_ONEDRIVE_SHAREPOINT_MCP_ENDPOINT` + `_ENABLED=true` + `LOOM_MSAL_CLIENT_ID` |
| M365 Admin Center (`admin-center`) | `mcp_admincenter_` | endpoint-env-gated (not yet GA) | `entra-obo` (`graph.microsoft.com/.default`) | opt-in (preview) | `LOOM_ADMIN_CENTER_MCP_ENDPOINT` + `_ENABLED=true` + `LOOM_MSAL_CLIENT_ID` |
| Power BI (`powerbi-remote`, projected in unchanged) | `mcp_powerbiremote_` | `https://api.fabric.microsoft.com/v1/mcp/powerbi` | `entra-obo` (Power BI delegated) | opt-in (Fabric family) | `LOOM_POWERBI_MCP_CLIENT_ID` + PBI-admin tenant setting (`isPbiMcpConfigured()`) |

Microsoft **Fabric (Core)** and **Fabric RTI** live in the *deployable* `MCP_CATALOG`
as explicit Fabric-family opt-ins (`govSafe:false`, `defaultRecommended:false`,
`fabricFamily:true`, `externalHosts:['api.fabric.microsoft.com']`) — filtered out of
gov boundaries and never on any default code path. **No skill descriptor references a
Fabric/Power BI prefix** — the 37 skills below map only to Learn / ARM / Foundry /
Graph / Sentinel.

---

## Loom coverage — the 37 curated skills

Each row is a `MsAgentSkill` descriptor (`defaultTarget:'azure-native'`,
`attribution:` github.com/microsoft/skills). **Loom-native tools** are REAL,
already-registered `LoomToolRegistry` tools (no-vaporware). **Opt-in MS MCP** names
the `mcpToolPrefix` whose live tools augment the skill *only when that server is
connected*; until then `msSkillSystemBlock` emits the catalog entry's honest gate.
Coverage is ✅ when the descriptor exists and its default tools are wired; the
opt-in MCP augmentation is ⚠️-gated (honest) until connected.

### Group 1 — Infrastructure & operations (13)

| Skill (`id`) | Loom pane(s) | Loom-native default tools | Opt-in MS MCP | Cov |
|---|---|---|---|---|
| `azure-prepare` — prepare for deployment | deploy-planner, health, default | `loom_self_audit`, `item_list`, `workspace_list` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-deploy` — deploy resources | deploy-planner, default | `item_create`, `item_configure`, `workspace_create`, `loom_self_audit` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-validate` — validate deployment | deploy-planner, health, default | `loom_self_audit`, `loom_heal`, `item_list` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-rbac` — RBAC & access | rbac, default | `loom_self_audit`, `item_list`, `item_configure` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-cost` — cost analysis | cost, default | `loom_self_audit`, `item_list`, `ops_scale_sql_pool`, `ops_scale_adx` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-diagnostics` — diagnostics & troubleshooting | health, monitor, default | `loom_self_audit`, `loom_heal`, `adx_query`, `kql_execute` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-compliance` — compliance & governance posture | rbac, health, default | `loom_self_audit`, `item_list`, `item_configure` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-resource-lookup` — resource lookup | default, deploy-planner | `item_list`, `workspace_list`, `loom_self_audit` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-resource-visualizer` — resource & topology visualizer | default, health, deploy-planner | `item_list`, `workspace_list`, `loom_self_audit` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-storage` — storage & data lake (ADLS Gen2 + Delta) | lakehouse, default | `lakehouse_list`, `lakehouse_read`, `lakehouse_write`, `item_create` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-messaging` — messaging & streaming (Event Hubs) | eventstream, event-schema-set, default | `item_create`, `item_configure`, `item_list` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-quotas` — quotas & limits | deploy-planner, default | `loom_self_audit`, `item_list` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-aigateway` — AI gateway (APIM) | apim-api, apim-product, apim-policy, default | `apim_list_apis`, `apim_list_products`, `apim_publish_api`, `item_configure` | `mcp_azurearm_` | ✅ / ⚠️ |

### Group 2 — Microsoft Foundry & AI (8)

| Skill (`id`) | Loom pane(s) | Loom-native default tools | Opt-in MS MCP | Cov |
|---|---|---|---|---|
| `microsoft-foundry` — projects & agents | ai-foundry-project, ai-foundry-hub, data-agent, default | `foundry_list_connections`, `item_create`, `item_configure` | `mcp_msfoundry_` | ✅ / ⚠️ |
| `foundry-models` — model catalog & deployment | ai-foundry-project, ml-model, automl, data-agent | `foundry_list_connections`, `item_create`, `item_configure` | `mcp_msfoundry_` | ✅ / ⚠️ |
| `foundry-iq-knowledge-bases` — knowledge bases & grounding | data-agent, ai-search-index, ai-foundry-project | `iq_list_ontologies`, `iq_get_ontology`, `iq_search`, `iq_list_semantic_models`, `foundry_list_connections` | `mcp_msfoundry_` | ✅ / ⚠️ |
| `foundry-observability` — AI observability | ai-foundry-project, tracing, evaluation, monitor | `foundry_list_connections`, `loom_self_audit` | `mcp_msfoundry_` | ✅ / ⚠️ |
| `foundry-governance` — AI governance | ai-foundry-project, content-safety, rbac | `foundry_list_connections`, `item_configure`, `loom_self_audit` | `mcp_msfoundry_` | ✅ / ⚠️ |
| `azure-ai` — app patterns (RAG / agents / structured output) | ai-foundry-project, data-agent, default | `foundry_list_connections`, `item_create`, `item_configure` | `mcp_msfoundry_` | ✅ / ⚠️ |
| `azure-ai-contentsafety` — Content Safety | content-safety, ai-foundry-project | `foundry_list_connections`, `item_configure` | `mcp_msfoundry_` | ✅ / ⚠️ |
| `azure-ai-document-intelligence` — Document Intelligence | ai-foundry-project, data-agent, default | `foundry_list_connections`, `item_create` | `mcp_msfoundry_` | ✅ / ⚠️ |

### Group 3 — Data & messaging (5)

| Skill (`id`) | Loom pane(s) | Loom-native default tools | Opt-in MS MCP | Cov |
|---|---|---|---|---|
| `azure-cosmos` — Cosmos DB | azure-cosmos-account, cosmos-gremlin-graph, vector-store, default | `item_create`, `item_configure`, `item_list` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-postgres` — Azure Database for PostgreSQL | postgres-flexible-server, postgres, sql-database, default | `item_create`, `item_configure`, `sql_explain`, `sql_optimize` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-eventhub` — Event Hubs | eventstream, event-schema-set, default | `item_create`, `item_configure`, `item_list` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-servicebus` — Service Bus | eventstream, default | `item_create`, `item_configure`, `item_list` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-eventgrid` — Event Grid | eventstream, event-schema-set, default | `item_create`, `item_configure`, `item_list` | `mcp_azurearm_` | ✅ / ⚠️ |

### Group 4 — Identity, security & monitoring (6)

| Skill (`id`) | Loom pane(s) | Loom-native default tools | Opt-in MS MCP | Cov |
|---|---|---|---|---|
| `entra-app-registration` — Entra app registration | rbac, default | `loom_self_audit`, `item_configure` | `mcp_msgraph_` | ✅ / ⚠️ |
| `azure-keyvault` — Key Vault | rbac, default | `loom_self_audit`, `item_configure` | `mcp_azurearm_` | ✅ / ⚠️ |
| `azure-kusto` — Azure Data Explorer (Kusto) | kql-database, eventhouse, kql-dashboard, default | `adx_list_databases`, `adx_list_tables`, `adx_query`, `kql_get_schema`, `kql_execute` | `mcp_azurearm_` | ✅ / ⚠️ |
| `kql` — KQL authoring | kql-database, kql-queryset, kql-dashboard, monitor | `kql_execute`, `kql_get_schema`, `kql_list_databases`, `kql_list_tables`, `adx_query` | `mcp_mssentinel_` | ✅ / ⚠️ |
| `azure-monitor-query` — query logs & metrics | monitor, health, default | `kql_execute`, `adx_query`, `loom_self_audit` | `mcp_azurearm_` | ✅ / ⚠️ |
| `appinsights-instrumentation` — App Insights instrumentation | monitor, tracing, default | `loom_self_audit`, `item_configure` | `mcp_azurearm_` | ✅ / ⚠️ |

### Group 5 — Developer & meta (5)

| Skill (`id`) | Loom pane(s) | Loom-native default tools | Opt-in MS MCP | Cov |
|---|---|---|---|---|
| `cloud-solution-architect` — end-to-end Azure design (WAF) | default, copilot, deploy-planner | `item_list`, `workspace_list`, `loom_self_audit` | `mcp_mslearn_` (**default-on**) | ✅ |
| `mcp-builder` — MCP server builder | default, copilot | `item_create`, `item_configure` | `mcp_mslearn_` (**default-on**) | ✅ |
| `microsoft-docs` — Microsoft Learn docs | default, copilot | (none — Learn MCP-backed) | `mcp_mslearn_` (**default-on**) | ✅ |
| `react-flow-node-ts` — React Flow node (TypeScript) | default, copilot | (none — authoring guidance) | `mcp_mslearn_` (**default-on**) | ✅ |
| `skill-creator` — author a new Copilot/agent skill | default, copilot | (none — authoring guidance) | `mcp_mslearn_` (**default-on**) | ✅ |

**Zero ❌.** Every skill is ✅ on its Azure-native default path. The `/ ⚠️` marks the
opt-in MS MCP augmentation, which renders the catalog entry's honest Fluent
MessageBar gate (naming the exact env / secret / scope / consent) until that server
is connected. The five Group-5 skills are ✅ outright because their backing MCP
(Microsoft Learn) is default-on and live day-one.

---

## Backend per control

- **Default path is always Azure-native.** A skill drives the listed
  `LoomToolRegistry` tools (already backed by ARM / Synapse SQL / ADX-Kusto /
  ADLS Gen2 + Delta / Event Hubs / APIM / Cosmos / Foundry connections / the
  `loom_self_audit`+`loom_heal` posture engine). No Fabric/Power BI host is on any
  default path; the Group-5 skills additionally use the no-auth Microsoft Learn MCP,
  which carries no tenant dependency.
- **Opt-in MS MCP augmentation** is surfaced by `buildMcpShim`, which registers each
  *enabled* remote server's tools as `mcp_<slug>_<tool>` and threads the per-user
  token. The orchestrator computes the set of genuinely-connected `mcp_<slug>_`
  prefixes for the turn and passes them to `msSkillSystemBlocksForPane(slug,
  { connectedPrefixes })`, so a skill advertises its remote tools **only when they
  are live** (no-vaporware).
- **Per-user OBO** for ARM / Foundry / Graph / Sentinel / Dataverse / M365 / Teams /
  OneDrive-SharePoint / Admin-Center reuses the existing confidential client
  (`LOOM_MSAL_CLIENT_ID` + the `loom-msal-client-secret` Key Vault secret) — no new
  static secret. The token store is keyed by the server's `oboResource`
  (`oboResourceKey`) so each server gets the correct delegated audience. **GitHub**
  is the lone non-Entra server: its PAT resolves from a Key Vault secret name
  (`LOOM_GITHUB_MCP_PAT_SECRET`), never a literal.
- **`?probe=1`** on the `ms-remote` BFF route makes a REAL Streamable-HTTP
  `initialize → tools/list` handshake against the resolved endpoint under the
  caller's delegated token — the honest connectivity test (mirrors the Power BI
  `powerbi/route.ts` probe).

## no-fabric-dependency compliance

- **Microsoft Learn (no auth) is the SOLE default-on server** (`defaultOn:true`,
  injected by `defaultOnRemoteMcps()` / `buildMcpShim`); it has zero Fabric/Power BI
  dependency and works day-one with no config.
- Every other remote MCP is opt-in and inert until its `configured()` gate is true.
- Microsoft Fabric / Fabric RTI are **explicit opt-ins** in the deployable
  `MCP_CATALOG` (`fabricFamily:true`, gov-filtered out), and **no skill maps to a
  Fabric/Power BI prefix** — the 37 descriptors only reference Learn / ARM / Foundry
  / Graph / Sentinel. `api.fabric.microsoft.com` / `api.powerbi.com` appear on no
  default path.

## no-vaporware compliance

- Advertised `toolNames` are all real registered tools.
- Remote endpoints are real and confirmed via `microsoft_docs_search` (2026-06) where
  a GA/preview host exists; where a Microsoft host is **not yet GA** (ARM self-host,
  M365, Teams, OneDrive-SharePoint, Admin-Center) the entry carries an **empty
  `defaultEndpoint` + a required `endpointEnv`**, so the server can never be reached
  until an admin supplies the published endpoint (`preview:true`).
- Unconfigured opt-in servers render the single-sourced honest gate (`entry.gate`)
  naming the exact env var / Key Vault secret / scope / consent — never a silent
  failure, never a dead tool advertisement.

## Day-one / bicep wiring

- `LOOM_MS_LEARN_MCP_ENABLED` defaults true; a synthetic enabled Learn row is injected
  by `listMcpServers` / `buildMcpShim` so Learn tools are live with zero config.
- Opt-in toggles and per-server endpoint/scope overrides fold into the
  `loomBackends.mcp` sub-object (the same ARM-256-param trick as
  `loomWarehouseBackend` / the Power BI envs) so the parameter count stays bounded.
- OBO servers reuse the existing `LOOM_MSAL_CLIENT_ID` + `loom-msal-client-secret`
  confidential client; GitHub uses a KV secretRef. No new secret literal is
  introduced.

## Verification

- Unit: `getMsSkill` / `msSkillsForPane` / `msSkillMcpPrefixes` resolve the 37
  descriptors; `msSkillSystemBlock` advertises the default tools and, per
  `opts.connected` / the catalog `configured()`, either the live `mcp_<slug>_*`
  tools or the honest gate (Learn → live; opt-in servers → gate until enabled).
- Wiring: `copilot-personas.ts` appends `msSkillBlockForPane(slug)` to each persona's
  system prompt; `copilot-orchestrator.ts` injects
  `msSkillSystemBlocksForPane(contextSlug, { connectedPrefixes })` as an extra system
  message after running `buildMcpShim`.
- Live acceptance (Learn, default-on): open the cross-item Copilot (`default` pane)
  → ask an Azure how-to/limit question → the answer is grounded via the
  `mcp_mslearn_*` tools with a cited Learn URL, with no admin action. Opt-in servers:
  enable one (e.g. set `LOOM_FOUNDRY_MCP_ENABLED=true`), open Admin →
  External MCP Tools → **Microsoft MCP servers** → the Foundry card flips from gate to
  connected, and `?probe=1` returns a real `tools/list`.
