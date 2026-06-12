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

> Reconciliation note (audit-t45): two parallel implementations of this surface
> existed. The canonical one — kept and documented here — is the **per-server
> `configSchema` + per-field Key Vault secret** path. The older single-`secretEnv`
> implementation (`lib/azure/mcp-catalog.ts`, `lib/azure/mcp-deploy-client.ts`,
> `lib/components/admin/mcp-catalog-panel.tsx`, `app/api/admin/mcp-catalog/*`)
> was removed so the panel renders ONE coherent deploy surface (`ui-parity.md`).

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

The retired single-secret path's env vars (`LOOM_CAE_ID`, `LOOM_CAE_NAME`,
`LOOM_CAE_DEFAULT_DOMAIN`, `LOOM_MCP_CATALOG_REGISTRY`) were pruned from
`admin-plane/main.bicep` when Implementation B was removed, so bicep and runtime
stay in sync (no dead env). All env vars derive from module outputs — no manual
post-deploy step.
