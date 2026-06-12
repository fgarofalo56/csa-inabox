# mcp-catalog — parity with the MCP server library + deploy experience

Source UI: VS Code / Copilot "MCP server" install gallery + Azure portal
"Container Apps → Create" wizard (the two surfaces this fuses: pick a server from
a catalog, then deploy it preconfigured). Grounded in Microsoft Learn
(Container Apps secrets from Key Vault, Container Apps create) and the official
MCP server registries (GitHub MCP server, Grafana MCP server, the
modelcontextprotocol reference servers).

This is a NEW Loom surface (no single Azure/Fabric analog) that gives a tenant
admin a one-click "browse a library → deploy preconfigured → wired into Copilot"
flow, replacing manual "register a running endpoint" with "deploy + register".

## Feature inventory (the experience we mirror)

1. Browse a curated library of MCP servers, grouped/badged, with description.
2. Per-server typed configuration (not freeform JSON): credentials, options,
   feature toggles.
3. Secrets handled securely — credentials go to a secret store, never plaintext.
4. One-click deploy that provisions the server and makes it usable with no
   further config.
5. The deployed server is discoverable by the agent/Copilot automatically.
6. Honest state when the platform can't deploy (missing infra / wrong boundary).

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Browse deployable library (25 vetted servers, category, Egress/Preview/Recommended badges) | built ✅ | `McpCatalogPanel` over `MCP_CATALOG` (`lib/azure/mcp-catalog.ts`, 25 entries) + the card-grid `McpCatalogBrowser` (`lib/mcp/catalog.ts`) |
| 2 | Per-server typed config wizard (Input / password / Dropdown / Switch — no JSON) | built ✅ | `DeployWizard` renders one Fluent control per `configSchema` field |
| 3 | Per-field secret → Key Vault; non-secret → Container App env | built ✅ | `secret:true` fields → `putKeyVaultSecret` + ACA `secretRef`; values never in Cosmos |
| 4 | One-click deploy (real ARM PUT, internal Container App, preconfigured) | built ✅ | `createMcpContainerApp` (ARM `Microsoft.App/containerApps`) |
| 5 | Auto-register for Copilot (zero further config) | built ✅ | `saveMcpServer` → orchestrator `buildMcpShim` discovers tools next turn |
| 6 | Honest infra gate (no CAE / AKS boundary / missing KV) | honest-gate ⚠️ | 503 + `gate{}` MessageBar naming env var + bicep module + `az` fallback |
| 7 | Admin-only, delegable permission | built ✅ | `admin.deploy-mcp` capability + `enforceCapability(...,'Admin')` |
| 8 | Edit / disable / delete a deployed server | built ✅ | existing `McpServersPanel` table; PUT carries forward `catalogId`/`secretRefs` |

Zero ❌. The only non-functional state is the honest infra gate (⚠️), which still
renders the full wizard and names the exact remediation.

## Backend per control

- Browse grid: static `MCP_CATALOG` (curated, real images — no network call).
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
  `listMcpTools` (`<endpoint>/tools/list`) per server.

## Sovereign-cloud behavior

- Commercial / GCC (`containerPlatform == containerApps`): full path. `LOOM_ACA_ENV_ID`
  / `LOOM_ACA_ENV_DOMAIN` populated from `containerPlatformModule.outputs`.
- GCC-High / IL5 (`containerPlatform == aks`): `caeId` output is `''` →
  `LOOM_ACA_ENV_ID` empty → deploy returns the honest gate (no CAE; use AKS/Helm).
  `mcp-client.resolveAuthHeader` uses `kvSuffix()`/`kvScope()` so per-field secret
  resolution works against `*.vault.usgovcloudapi.net`. `serversForCloud('il5')`
  (`lib/azure/mcp-catalog.ts`) restricts the deployable list to air-gap-safe +
  Azure-native servers (Azure MCP, Postgres, Kubernetes, Redis, dbhub) so IL5
  admins never see ungated SaaS tiles.

## Deployable 25-server library

`lib/azure/mcp-catalog.ts` `MCP_CATALOG` is the curated, vetted set of **exactly
25** deployable MCP servers (integrity-tested in `__tests__/mcp-catalog.test.ts`).
Each entry is a real, pullable HTTP/SSE image (`mcp/*` Docker MCP catalog,
`mcr.microsoft.com/*`, or `ghcr.io/*`), permissively licensed (Apache-2.0 / MIT),
and carries: category, egress profile, `govSafe`/`airGapSafe`/`defaultRecommended`
flags, `externalHosts`, optional `secretEnv` (→ Key Vault secretRef), `needsStorage`
(→ Azure Files mount at `/data`), and a **dedicated `healthPath`** (`/health` or
`/healthz`) wired as Container Apps liveness/readiness probes — never the MCP
JSON-RPC endpoint, per Learn. Community-HTTP-transport entries are tagged
`preview: true`.

## No-Fabric / No-vaporware

Azure-native end-to-end: Container Apps + Key Vault + Cosmos. No
`api.fabric.microsoft.com` / `api.powerbi.com` on any path. No mock arrays — the
catalog lists only real, pullable images; `preview:true` flags entries whose HTTP
transport is community-maintained. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset.

## Bicep sync

- Console env: `LOOM_ACA_ENV_ID`, `LOOM_ACA_ENV_DOMAIN`, `LOOM_MCP_CATALOG_UAMI_ID`
  (admin-plane/main.bicep).
- RBAC: MCP UAMI → Key Vault Secrets User (keyvault.bicep `mcpPrincipalId`);
  Console UAMI → Managed Identity Operator (mcp-catalog-rbac.bicep). Console UAMI
  already holds Contributor (scaling-rbac.bicep) + Secrets Officer (keyvault.bicep).
- Deploy-from-scratch IaC mirror: `mcp-catalog-app.bicep`.

## Verification

`npx tsc --noEmit` clean for all touched files. Live E2E (operator): browse →
deploy GitHub MCP server with a PAT → confirm Container App created + secret in
KV + server registered + tools surfaced in Copilot. With `LOOM_ACA_ENV_ID` unset,
confirm the honest gate renders the `az containerapp create` fallback.
