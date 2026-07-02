# mcp-catalog — parity with deployable MCP server catalog (Azure Container Apps)

Source UI: there is no single Azure portal page for "deploy an MCP server"; the
parity target is the operational workflow of standing up a vetted Model Context
Protocol server as an Azure Container App and registering it for Loom Copilot —
the same lifecycle a platform admin runs in the Azure portal (Container Apps →
Create → image + ingress + identity + per-field secrets), distilled to a
one-click catalog + deploy wizard. Grounded in Microsoft Learn:
- Azure Container Apps (containerApps): https://learn.microsoft.com/azure/container-apps/
- Manage secrets in Azure Container Apps (Key Vault references): https://learn.microsoft.com/azure/container-apps/manage-secrets
- Azure Files storage mounts in Container Apps: https://learn.microsoft.com/azure/container-apps/storage-mounts-azure-files
- Key Vault Secrets User RBAC role: https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#key-vault-secrets-user

Vetting source: `temp/mcp-gov-research.md` (top-25 gov-safe MCP servers,
permissive licenses only) and `docs/adr/0026-ms-learn-mcp-as-external-grounding.md`.

> **Three catalog families (source-of-truth: `lib/mcp/catalog.ts`).** This doc now
> covers all three families this file exports, NOT just the deploy-an-image path:
> 1. **`MCP_CATALOG` (`DeployableMcpServer[]`)** — the authoritative gov-safety +
>    curated library (license / `govSafe` / `airGapSafe` / `source` / `externalHosts`
>    / `fabricFamily`) that `govMetaFor()` joins the deploy tiles to. It now also
>    carries the **Microsoft-official deployable servers** (`github.com/microsoft/mcp`)
>    and the **Fabric-family opt-ins** — see "Microsoft-official deployable servers"
>    and "Fabric family" below.
> 2. **`MCP_DEPLOY_CATALOG` (`McpCatalogEntry[]`)** — the operational subset with
>    real, pullable HTTP/SSE images the browse-and-deploy wizard provisions.
> 3. **`REMOTE_BUILTIN_MCP_CATALOG` (`RemoteBuiltinMcpEntry[]`)** — the new
>    **remote built-in Microsoft MCP family**: already-hosted Microsoft HTTPS
>    Streamable-HTTP endpoints reached per-user (NOT images). This GENERALIZES the
>    Power BI `RemoteBuiltinMcp` / `isPbiMcpConfigured()` plumbing — see "Remote
>    built-in Microsoft MCP family" below — and is paired with ~30 Microsoft agent
>    skills (`lib/copilot/ms-skills.ts`, attributed to `github.com/microsoft/skills`).
>
> A separate, legacy 29-entry operational array also lives in
> `lib/azure/mcp-catalog.ts` (`MCP_CATALOG` of `McpCatalogEntry`, integrity-tested
> in `lib/azure/__tests__/mcp-catalog.test.ts`); it predates the per-field
> `configSchema` consolidation and is **not** where the Microsoft additions live —
> those are in `lib/mcp/catalog.ts`.

> Reconciliation note (audit-t45): two parallel implementations of this surface
> existed. The canonical one — documented here — is the **per-server
> `configSchema` + per-field Key Vault secret** path in `lib/mcp/catalog.ts`. The
> older single-`secretEnv` modules (`lib/azure/mcp-catalog.ts`,
> `lib/azure/mcp-deploy-client.ts`, `lib/components/admin/mcp-catalog-panel.tsx`)
> are RETAINED (the legacy gov array + its tests still build), but the duplicate
> `app/api/admin/mcp-catalog/*` route family was removed so the panel renders ONE
> coherent deploy surface (`ui-parity.md`). New work — including the Microsoft
> additions + the remote built-in family — lands ONLY in `lib/mcp/catalog.ts`.

## Capability inventory (the deploy lifecycle a platform admin performs)

| # | Capability | Azure-portal equivalent |
|---|------------|-------------------------|
| 1 | Pick a server from a curated, license-/gov-vetted catalog | Choose an image (here: an allow-list, not arbitrary images) |
| 2 | Provide each setting via a typed field (one Fluent control per `configSchema` entry) | Container App → Environment variables / Secrets |
| 3 | Provision it as a Container App with internal ingress | Container Apps → Create |
| 4 | Bind a user-assigned managed identity (UAMI) for in-container + KV auth | Container App → Identity |
| 5 | Write each **secret** field to Key Vault, surface as a `secretRef` env var | Container App → Secrets → Key Vault reference |
| 6 | Pass each **non-secret** field as a plain env var | Container App → Environment variables |
| 7 | Warn before deploying an external-SaaS server on a gov boundary | (Loom-specific governance gate) |
| 8 | Read live provisioning + running status | Container App → Overview / Revisions |
| 9 | Tear the deployment down (app + KV secrets + connection) | Container App → Delete |
| 10 | Surface the server as a registered Loom MCP connection | (Loom-specific) tool discovery at orchestrate time |

## Loom coverage

| # | Capability | Status | Backend per control |
|---|------------|--------|---------------------|
| 1 | Catalog grid (vetted allow-list cards, egress + license + Preview badges) | built ✅ | `MCP_DEPLOY_CATALOG` in `lib/mcp/catalog.ts`; rendered by `McpCatalogBrowser` (`lib/components/admin/mcp-catalog-wizard.tsx`) |
| 2 | Typed deploy wizard (password Input for secret, Dropdown for enum, Switch for bool, Input otherwise — no JSON) | built ✅ | `DeployWizard` renders one control per `entry.configSchema`; validated by `validateConfigValues` |
| 3 | Deploy as Container App (internal ingress) | built ✅ | `POST /api/admin/mcp-servers/deploy` (body has `catalogId`) → `createMcpContainerApp` → ARM `PUT Microsoft.App/containerApps` |
| 4 | UAMI binding (`uami-loom-mcp`) | built ✅ | container-app `identity.userAssignedIdentities` from `LOOM_MCP_CATALOG_UAMI_ID` |
| 5 | Per-field KV secret → `secretRef` (e.g. GitHub PAT, Grafana token) | built ✅ | `f.secret` → `putKeyVaultSecret` + `configuration.secrets[].keyVaultUrl` (versionless, auto-rotates) resolved by the MCP UAMI; env `{ name, secretRef }` |
| 6 | Per-field non-secret → plain env var | built ✅ | `!f.secret` → env `{ name: f.envVar, value }`; persisted to `configValues` |
| 7 | External-SaaS pre-deploy warning (egress badge + host list) | built ✅ | `entryEgress` / `reachesExternalSaas` (`lib/mcp/catalog.ts`); MessageBar in the wizard |
| 8 | Live status (provisioningState + runningStatus + FQDN) | built ✅ | `GET /api/admin/mcp-servers/deployed/status` → `getMcpContainerAppStatus` → ARM `GET containerApps/{name}` |
| 9 | Teardown (Container App + KV secrets in `secretRefs` + Cosmos doc) | built ✅ | `DELETE /api/admin/mcp-servers/deployed/teardown` → `deleteMcpContainerApp` + `deleteKeyVaultSecret` + `deleteMcpServer` |
| 10 | Persisted as an MCP connection (Cosmos `mcp-servers`) | built ✅ | `saveMcpServer` (source: `catalog`, `deployment{}` metadata, `secretRefs` = names only — secret values NEVER in Cosmos) |
| 11 | Per-cloud catalog narrowing (commercial / gcc / gcc-high / il5) | built ✅ | `deployServersForCloud` (`lib/mcp/catalog.ts`) for server-side filtering |
| 12 | Gov-safety badges on each tile (Air-gap safe / Gov-safe / license) | built ✅ | `govMetaFor(id)` joins the deploy tile to the research-grounded `MCP_CATALOG` (`DeployableMcpServer`) gov facet — `govSafe`/`airGapSafe`/`license`/`source`/`defaultRecommended` from `temp/mcp-gov-research.md` (25 servers + Grafana). Undefined ⇒ no badge (honest, never fabricated). |
| 13 | Edit / disable / delete a deployed server | built ✅ | existing `McpServersPanel` table; PUT carries forward `catalogId`/`secretRefs` |

Honest gates (no fabricated success — `no-vaporware.md`):
- Container Apps platform not wired → `503 { ok:false, gate }` naming the missing
  env (`LOOM_ACA_ENV_ID` / `LOOM_ACA_ENV_DOMAIN` / `LOOM_MCP_CATALOG_UAMI_ID` /
  `LOOM_SUBSCRIPTION_ID` / `LOOM_ACA_RG`) plus a copy-pasteable
  `az containerapp create` fallback. The catalog grid still renders.
- No Key Vault configured but the chosen server has a secret field → `503` gate
  naming `LOOM_KEY_VAULT_URI` + the required RBAC (Console UAMI = Key Vault
  Secrets Officer to write at deploy; MCP UAMI = Key Vault Secrets User to read).
- AKS boundary (GCC-High / IL5) → deploy honest-gates: `Microsoft.App/containerApps`
  has no AKS analog; those clouds deploy MCP workloads via the AKS/Helm GitOps
  manifest path (mirror: `admin-plane/mcp-catalog-app.bicep`).
- ARM 403 (Console UAMI lacks Contributor on the admin RG) → real status code +
  message propagate (`502`), never swallowed. On any post-secret-write failure
  the route rolls back every KV secret it wrote (no orphaned secrets).

Key Vault create-time constraint (Microsoft Learn, "Manage secrets in Azure
Container Apps"): a **system-assigned** identity can't be used with the create
command (it doesn't exist until after the app is created), so a catalog deploy
uses a **user-assigned** identity (`LOOM_MCP_CATALOG_UAMI_ID`) for the create-time
Key Vault `secretRef`. The KV secret URI is versionless
(`<vault>/secrets/<name>`) so ACA auto-refreshes within ~30 min on rotation.

No Microsoft Fabric / Power BI dependency — these are plain OCI images on Azure
Container Apps + Key Vault + Cosmos (`no-fabric-dependency.md`); the surface works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

- Browse grid: static `MCP_DEPLOY_CATALOG` (curated, real images — no network
  call) joined to gov metadata via `govMetaFor()` against the authoritative
  research-grounded `MCP_CATALOG` (`DeployableMcpServer[]`). The gov catalog also
  exposes `serversForCloud(cloud)`, `defaultRecommendedServers()`, and
  `airGapSafeServers()` selectors for boundary-aware filtering.
- Deploy: `POST /api/admin/mcp-servers/deploy`
  - gate: `enforceCapability(session,'admin.deploy-mcp','Admin')`
  - validate: `validateConfigValues(entry, values)` (typed + required)
  - secrets: KV REST `PUT /secrets/<name>?api-version=7.4` via `putKeyVaultSecret`
    (Console UAMI holds **Key Vault Secrets Officer**)
  - create: ARM `PUT Microsoft.App/containerApps/{name}?api-version=2025-02-02-preview`
    via `createMcpContainerApp` / `deployMcpContainerApp` (Console UAMI
    **Contributor** + **Managed Identity Operator**; MCP UAMI assigned to the app
    holds **Key Vault Secrets User** to resolve secretRefs). The Container Apps
    api-version is pinned consistently across the two runtime clients,
    `mcp-storage.bicep`, and `mcp-catalog-app.bicep` (bicep+bootstrap sync).
  - register: `saveMcpServer` → Cosmos `mcp-servers`
  - audit: `auditLogContainer`
- Tool discovery: `copilot-orchestrator` → `buildMcpShim` → `listMcpServers` →
  `listMcpTools` per server. The MCP client speaks **Streamable HTTP** — it
  POSTs JSON-RPC to the single configured endpoint URL (the `method` field
  selects `initialize` / `tools/list` / `tools/call`; there are NO
  `/tools/list` sub-paths), sends `initialize` first, echoes the returned
  `Mcp-Session-Id`, and parses either a JSON or `text/event-stream` body.
- Connectivity probe persists on save: POST/PUT `/api/admin/mcp-servers` runs
  the real handshake and writes `lastTestResult` so the registered-servers
  table shows live tool counts + a "Tested" badge day-one.

## Bicep + env sync

- `keyvault.bicep` — MCP UAMI granted **Key Vault Secrets User**
  (`4633458b-17de-408a-b874-0445c86b69e6`) for `secretRef` resolution; the
  Console UAMI holds **Key Vault Secrets Officer** to write secrets at deploy.
- `mcp-storage.bicep` — hardened StorageV2 account + Azure Files share +
  `Microsoft.App/managedEnvironments/storages` child on the CAE (optional /data mount).
- `admin-plane/mcp-catalog-app.bicep` — GitOps mirror of the deploy route's ARM
  PUT (params `envVars`, `kvSecrets`, `secretEnvVars`, `mcpUamiId`); the IL5/AKS
  deploy story.
- `admin-plane/main.bicep` — wires `mcpPrincipalId` into the KV module, calls
  `mcp-storage`, and sets the canonical console env for the configSchema/per-field
  path: **`LOOM_ACA_ENV_ID`**, **`LOOM_ACA_ENV_DOMAIN`**,
  **`LOOM_MCP_CATALOG_UAMI_ID`** (all from `containerPlatformModule.outputs` /
  `identity.outputs.uamiMcpId`), plus the shared `LOOM_CONTAINER_PLATFORM`,
  `LOOM_MCP_UAMI_ID`, `LOOM_MCP_UAMI_CLIENT_ID`, `LOOM_ACR_LOGIN_SERVER`,
  `LOOM_MCP_STORAGE_NAME`, `LOOM_MCP_FILE_SHARE`, and `LOOM_LOCATION`.
- Commercial / GCC (`containerPlatform == containerApps`): full path. `LOOM_ACA_ENV_ID`
  / `LOOM_ACA_ENV_DOMAIN` populated from `containerPlatformModule.outputs`.
- GCC-High / IL5 (`containerPlatform == aks`): `caeId` output is `''` →
  `LOOM_ACA_ENV_ID` empty → deploy returns the honest gate (no CAE; use AKS/Helm).
  `mcp-client.resolveAuthHeader` uses `kvSuffix()`/`kvScope()` so per-field secret
  resolution works against `*.vault.usgovcloudapi.net`. `serversForCloud('il5')`
  (`lib/azure/mcp-catalog.ts`) restricts the deployable list to air-gap-safe +
  Azure-native servers (Azure MCP, Postgres, Kubernetes, Redis, dbhub) so IL5
  admins never see ungated SaaS tiles.

## Curated gov-safety library (`MCP_CATALOG` — `DeployableMcpServer[]`)

`lib/mcp/catalog.ts` `MCP_CATALOG` is the AUTHORITATIVE gov-safety + curated
library that `govMetaFor()` joins the deploy tiles to (research-grounded in
`temp/mcp-gov-research.md`, integrity-tested in `lib/mcp/__tests__/catalog.test.ts`,
which asserts ≥ 25 entries + unique ids). It is **33 entries** today — the 25
gov-research servers + Grafana + the **7 Microsoft additions** below (5 Microsoft-
official deployables + 2 Fabric opt-ins). Each entry carries: `category`, `source`
(`anthropic` / `microsoft` / `vendor` / `community`), `repo`, `license`,
`govSafe` / `airGapSafe` / `defaultRecommended`, `externalHosts`, an optional
`fabricFamily` flag, and a typed `configSchema` (one Fluent field per setting —
`secret: true` → Key Vault secretRef; never a JSON box, per
`loom-no-freeform-config`). Almost every entry is `transport: 'stdio'` +
`hostVia: 'container-apps'` → `requiresHosting()` honest-gates them ("deploy to
Container Apps for an HTTPS endpoint, then register") rather than implying they
are already connectable; Grafana is the lone `transport: 'http'` /
`hostVia: 'already-http'` exception.

## Microsoft-official deployable servers (`github.com/microsoft/mcp`)

Added to `MCP_CATALOG` as `source: 'microsoft'`, `hostVia: 'container-apps'`,
all Azure-native (zero Fabric/Power BI host on the default path). Azure MCP
(`azure`, `@azure/mcp`) and Playwright (`playwright`, `@playwright/mcp`) were
already present and are left untouched. Confirmed via `microsoft_docs_search`
(2026-06):

| id | server | image / package | gov / air-gap | honest gate when no public image |
|----|--------|-----------------|---------------|----------------------------------|
| `microsoft-sql` | Microsoft SQL (Data API builder) | `mcr.microsoft.com/azure-databases/data-api-builder:latest` | govSafe ✅ / air-gap ✅ | — (real first-party image; supply the Azure SQL connection string → Key Vault) |
| `azure-devops` | Azure DevOps | `npx @azure-devops/mcp <org>` | govSafe ✅ / air-gap ✗ (`dev.azure.com`) | — (Entra ID / PAT; a Microsoft-hosted remote `https://mcp.dev.azure.com/<org>` variant also exists) |
| `aks` | Azure Kubernetes Service | `IMAGE_REF` (build `Azure/aks-mcp` from source) | govSafe ✅ / air-gap ✗ | **IMAGE_REF required** — no first-party public image yet; build, push to ACR, set the ref |
| `markitdown` | MarkItDown | `uvx markitdown-mcp` | govSafe ✅ / air-gap ✅ | — (runs fully local, no external calls) |
| `nuget` | NuGet | `IMAGE_REF` (package the NuGet MCP server) | govSafe ✅ / air-gap ✗ (`api.nuget.org`) | **IMAGE_REF required** — no first-party public image yet |

Where no first-party public HTTP image exists, the entry carries a required
`IMAGE_REF` `configSchema` field → an honest "set image ref" gate
(`no-vaporware`), so a tile can never imply a non-existent image will deploy.

## Fabric family — explicit opt-in ONLY (`no-fabric-dependency`)

Two `fabricFamily: true` entries reach `api.fabric.microsoft.com` and REQUIRE a
Microsoft Fabric capacity. They are `govSafe: false` + `defaultRecommended: false`
→ filtered out of gov boundaries (`serversForCloud`), never auto-deployed, never
on any default code path. Loom's Azure-native analytics (ADX / Synapse / Data API
builder) stays the day-one default; these only augment it when an admin explicitly
browses + deploys them.

| id | server | Microsoft-hosted endpoint (remote) | Azure-native equivalent |
|----|--------|------------------------------------|-------------------------|
| `fabric` | Microsoft Fabric (Core) | `https://api.fabric.microsoft.com/v1/mcp/core` (Entra OAuth) | ADX / Synapse / Data API builder |
| `fabric-rti` | Microsoft Fabric RTI | `https://api.fabric.microsoft.com/v1/mcp` | Azure Data Explorer (ADX) + Azure Monitor alerts |

Both have no first-party public image (local `Fabric.Mcp.Server` builds from
`microsoft/mcp`) → `IMAGE_REF`-gated, with the remote endpoint noted in the `desc`
for clients that point a remote MCP at it.

## Operational deploy catalog (`MCP_DEPLOY_CATALOG` — `McpCatalogEntry[]`)

The browse-and-deploy wizard (`McpCatalogBrowser`) renders this operational
subset — entries with a real, pullable HTTP/SSE image and a working transport —
joined to gov metadata via `govMetaFor()`. Today: `github`
(`ghcr.io/github/github-mcp-server`, streamable-HTTP), `grafana`
(`mcp/grafana`, streamable-HTTP), `fetch` and `time` (`mcp/*`, SSE, `preview`).
Per-field `secret: true` → Key Vault secretRef; everything else → plain env var.
The deploy route's env vars derive from module outputs — no manual post-deploy
step.

## Remote built-in Microsoft MCP family (`REMOTE_BUILTIN_MCP_CATALOG`)

A THIRD family, distinct from both image-deploy catalogs. These are
**already-hosted Microsoft HTTPS Streamable-HTTP endpoints reached per-user** —
there is no image to pull. It **generalizes the Power BI plumbing** (the
literal-typed `RemoteBuiltinMcp` / `isPbiMcpConfigured()` / `pbiMcpScopeUris()`
that already shipped) into a string-typed `RemoteBuiltinMcpEntry` so one shape
covers Learn (no auth), the Entra-OBO servers, and GitHub (Key Vault PAT). It is
NOT a parallel system: every entry registers as the SAME `McpServerConfig` shape
(`source: 'remote-builtin'`), is reached by the SAME `mcp-client`
(`resolveAuthHeader` + threaded `userToken`), and is advertised by the SAME
`buildMcpShim` as `mcp_<slug>_<tool>`. The existing Power BI entry is **projected
in unchanged** (`POWERBI_REMOTE_ENTRY`, still gated by `isPbiMcpConfigured()`).

`McpServerConfig` (`lib/types/mcp-config.ts`) needed only backward-compatible
widenings: `authMethod` already had `'header' | 'key-vault' | 'entra-obo'` (+
`'none'`) with `oboResource` / `oboScopes`, and `source` already had
`'remote-builtin'`; the one additive field is **`oboResourceKey?`** — the key the
per-user token store is keyed by, so ARM / Graph / Foundry / Dataverse each resolve
their OWN delegated token (defaults to `oboResource`).

### Auth models + honest gates (`no-vaporware`)

- **`none`** → maps to `authMethod: 'header'` with an empty value (`resolveAuthHeader`
  emits no `Authorization` header). Microsoft Learn only.
- **`entra-obo`** → per-user On-Behalf-Of bearer for `oboResource`/`oboScopes`,
  minted via the SHARED Loom confidential client (`LOOM_MSAL_CLIENT_ID` +
  `loom-msal-client-secret`) — **no new secret literal**. Each carries an honest
  gate naming the exact `LOOM_*_ENABLED` toggle, the endpoint env, the OBO
  resource/scope, and any tenant consent.
- **`key-vault`** → a stored bearer (GitHub PAT, GitHub OAuth — NOT Entra),
  resolved from a Key Vault **secretRef name** (`LOOM_GITHUB_MCP_PAT_SECRET`),
  never a literal.

### Catalog rows + endpoint provenance (`microsoft_docs_search`, 2026-06)

| id | server | auth | resolved endpoint (env override) | default-on? |
|----|--------|------|----------------------------------|-------------|
| `ms-learn` | Microsoft Learn | none | `https://learn.microsoft.com/api/mcp` | **YES — sole default-on** |
| `azure-arm` | Azure Resources (ARM) | entra-obo (`management.azure.com/user_impersonation`) | endpoint-env-gated (self-host w/ OBO) | opt-in |
| `ms-foundry` | Microsoft Foundry | entra-obo (`ai.azure.com/.default`) | `https://mcp.ai.azure.com` (preview) | opt-in |
| `github` | GitHub | key-vault PAT | `https://api.githubcopilot.com/mcp` | opt-in |
| `ms-graph` | Microsoft Graph (Enterprise) | entra-obo (`graph.microsoft.com/.default`) | `https://mcp.svc.cloud.microsoft/enterprise` (preview) | opt-in |
| `m365` | Microsoft 365 | entra-obo (Graph) | endpoint-env-gated (not GA) | opt-in |
| `teams` | Microsoft Teams | entra-obo (Graph) | endpoint-env-gated (not GA) | opt-in |
| `onedrive-sharepoint` | OneDrive & SharePoint | entra-obo (Graph) | endpoint-env-gated (not GA) | opt-in |
| `ms-sentinel` | Microsoft Sentinel | entra-obo (`sentinel.microsoft.com/.default`) | `https://sentinel.microsoft.com/mcp/data-exploration` (preview) | opt-in |
| `admin-center` | M365 Admin Center | entra-obo (Graph) | endpoint-env-gated (not GA) | opt-in |
| `dataverse` | Microsoft Dataverse | entra-obo (per-org origin) | endpoint-env-gated (`https://<org>.crm.dynamics.com/api/mcp`) | opt-in |
| `powerbi-remote` | Power BI (remote) | entra-obo (`analysis.windows.net/powerbi/api`) | `https://api.fabric.microsoft.com/v1/mcp/powerbi` | opt-in (unchanged) |

**`no-fabric-dependency`:** Microsoft Learn (auth `none`, zero config) is the
**SOLE default-on** entry — `defaultOnRemoteMcps()` returns it, and
`listMcpServers` / `buildMcpShim` inject it as a synthetic enabled row so
`mcp_mslearn_*` tools are live day-one with zero admin action. Every other entry
is inert until its gate is satisfied. Where a Microsoft host is not yet GA
(`m365` / `teams` / `onedrive-sharepoint` / `admin-center` / `azure-arm`) the
`defaultEndpoint` is **empty** and the admin must supply `endpointEnv` first — so
an unconfirmed host is NEVER on a live path. No `api.fabric.microsoft.com` /
`api.powerbi.com` host appears on any default path; the Power BI + Dataverse
(tenant-setting) + Fabric rows stay strictly opt-in.

Selectors mirror the Power BI helpers: `msRemoteMcp(id)`,
`msRemoteMcpConfigured(id)` (generalized `isPbiMcpConfigured()`),
`msRemoteMcpScopeUris(id)` (generalized `pbiMcpScopeUris()`, deriving a per-org
audience from the endpoint origin when `oboResource` is empty), and
`defaultOnRemoteMcps()`.

### Shim generalization (`lib/azure/mcp-shim.ts`)

The one real architectural extension: `buildMcpShim` previously hard-coded
`getPbiUserToken(oid)` for the entra-obo path. It now resolves the per-user token
keyed by the server's `oboResourceKey ?? oboResource`, falling back to
`getPbiUserToken` for a legacy Power BI row with no resource (back-compat). Tool
prefixes (`mcp_<slug>_`) are derived identically by `msMcpPrefix()` in
`ms-skills.ts` and the shim's `mcpToolPrefixSlug`.

## Microsoft agent skills (`lib/copilot/ms-skills.ts`)

~30 descriptors adapted from the open-source Microsoft agent skills
(`github.com/microsoft/skills`), EXTENDING the Power BI skill plumbing rather
than forking it: each is a `LoomCopilotSkill` (imported from
`lib/copilot/powerbi-skills.ts`) widened additively with optional
`mcpToolPrefix?` + `attribution?` (the `MsAgentSkill` interface). Every skill's
`defaultTarget` is `'azure-native'` and its `toolNames` map ONE-FOR-ONE to tools
already registered in the `LoomToolRegistry` (`loom_self_audit` / `loom_heal` /
`item_*` / `lakehouse_*` / `adx_*` / `kql_*` / `apim_*` / `foundry_list_connections`
/ `iq_*` …) — no new tools minted. `mcpToolPrefix` ties a skill to the OPT-IN
Microsoft MCP that augments it once connected (`mcp_mslearn_` is default-on);
`msSkillSystemBlock` advertises those `mcp_<slug>_*` tools when connected and
otherwise emits the HONEST gate **verbatim from the catalog entry's `gate`** (so
gate copy can never drift from `lib/mcp/catalog.ts`).

Wiring (single source, no parallel path): `copilot-personas.ts` imports
`MS_AGENT_SKILLS` and injects them into pane `systemPrompt`s; the orchestrator
(`copilot-orchestrator.ts`) composes `msSkillSystemBlocksForPane(contextSlug,
{ connectedPrefixes: msConnectedMcpPrefixes(reg) })` as an extra system message
after running `buildMcpShim`. Grouped: infra/ops (Azure prepare/deploy/validate/
RBAC/cost/diagnostics/compliance/storage/messaging/quotas/AI-gateway), Foundry/AI,
data/messaging (Cosmos / Postgres / Event Hubs / Service Bus / Event Grid),
identity/monitoring (Entra / Key Vault / Kusto / KQL / Monitor / App Insights),
and dev (cloud-architect / mcp-builder / Learn docs / React-Flow node /
skill-creator).

## Admin UI — "Microsoft MCP servers" section (web3-ui)

BFF route `app/api/admin/mcp-servers/ms-remote/route.ts` generalizes
`powerbi/route.ts`: `GET ?id=<entry-id>` returns per-server status + the honest
gate; `GET` with no id summarizes the whole family (no probe — the panel never
hangs on load); `GET ?id=…&probe=1` (when configured) runs a REAL
`initialize → tools/list` Streamable-HTTP handshake; `POST` registers the row as
`source: 'remote-builtin'` with the right `authMethod` + `oboResource`/`oboScopes`
/`oboResourceKey`. `mcp-servers-panel.tsx` renders the
`MicrosoftMcpServersSection` as a card grid reusing the existing `pbiCard`
Web-3.0 styling (Loom tokens, `shadow4 → shadow16` on hover): Learn shows
"default-on, no auth"; OBO servers show the honest gate naming the env + scopes +
consent; GitHub shows the Key Vault-secret gate. Deployable Microsoft entries
appear automatically in the existing `McpCatalogBrowser`.

## Remote-family bicep + env sync (`docs_source_of_truth`)

- **`LOOM_MS_LEARN_MCP_ENABLED` defaults true** → Learn tools live day-one with
  zero config (synthetic enabled row from `defaultOnRemoteMcps()`); set `=false`
  to disable, or `LOOM_MS_LEARN_MCP_ENDPOINT` to override.
- Per-server opt-in toggles (`LOOM_<SERVER>_MCP_ENABLED`) + endpoint/scope
  overrides fold into the `loomBackends.mcp` sub-object — the same
  under-the-256-ARM-param trick as `loomWarehouseBackend` / the Power BI envs.
- OBO servers **reuse the existing confidential client** (`LOOM_MSAL_CLIENT_ID` +
  `loom-msal-client-secret`) for the per-user OBO exchange — no new secret literal.
- GitHub PAT via Key Vault `secretRef` only (`LOOM_GITHUB_MCP_PAT_SECRET` = the
  secret NAME, sent as `Authorization: Bearer <PAT>`).

## Rule compliance

- **`no-fabric-dependency`**: Microsoft Learn (no auth) is the SOLE default-on
  server; everything else opt-in; Fabric / Fabric-RTI / Power BI / Dataverse are
  explicit opt-ins; no `api.fabric` / `api.powerbi` host on any default path.
- **`no-vaporware`**: real endpoints + auth; honest Fluent MessageBar gate naming
  the exact env / secret / scope / consent when unconfigured; `?probe=1` makes a
  REAL `initialize → tools/list` call; not-yet-GA hosts are endpoint-env-gated.
- **Secrets**: Key Vault `secretRef` only; OBO carries no static secret.
- **`web3-ui`**: Loom tokens for every admin card (reuses `pbiCard`).
- **TypeScript**: all additions are additive; the only interface widenings
  (`LoomCopilotSkill` optional fields; `McpServerConfig.oboResourceKey?`) are
  backward-compatible — zero new `tsc` errors atop the pre-existing baseline.
