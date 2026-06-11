# mcp-catalog — parity with deployable MCP server catalog (Azure Container Apps)

Source UI: there is no single Azure portal page for "deploy an MCP server"; the
parity target is the operational workflow of standing up a vetted Model Context
Protocol server as an Azure Container App and registering it for Loom Copilot —
the same lifecycle a platform admin runs in the Azure portal (Container Apps →
Create → image + ingress + identity + volume), distilled to a one-click catalog.
Grounded in Microsoft Learn:
- Azure Container Apps (containerApps): https://learn.microsoft.com/azure/container-apps/
- Azure Files storage mounts in Container Apps: https://learn.microsoft.com/azure/container-apps/storage-mounts-azure-files
- Key Vault Secrets User RBAC role: https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#key-vault-secrets-user

Vetting source: `temp/mcp-gov-research.md` (top-25 gov-safe MCP servers,
permissive licenses only) and `docs/adr/0026-ms-learn-mcp-as-external-grounding.md`.

## Capability inventory (the deploy lifecycle a platform admin performs)

| # | Capability | Azure-portal equivalent |
|---|------------|-------------------------|
| 1 | Pick a server from a curated, license-/gov-vetted catalog | Choose an image (here: an allow-list, not arbitrary images) |
| 2 | Provision it as a Container App with internal ingress | Container Apps → Create |
| 3 | Bind a managed identity (UAMI) for in-container auth | Container App → Identity |
| 4 | Mount a persistent Azure Files volume at /data | Container App → Volumes / env storage |
| 5 | Resolve a secret (API token) from Key Vault via secretRef | Container App → Secrets → Key Vault reference |
| 6 | Read live provisioning + running status | Container App → Overview / Revisions |
| 7 | Tear the deployment down | Container App → Delete |
| 8 | Surface the server as a registered Loom MCP connection | (Loom-specific) tool discovery at orchestrate time |

## Loom coverage

| # | Capability | Status | Backend per control |
|---|------------|--------|---------------------|
| 1 | Catalog dropdown (vetted allow-list, egress + license badges) | built ✅ | `GET /api/admin/mcp-catalog` → `lib/azure/mcp-catalog.ts` (`MCP_CATALOG`) |
| 2 | Deploy as Container App (internal ingress, scale-to-0) | built ✅ | `POST /api/admin/mcp-catalog/deploy` → ARM `PUT Microsoft.App/containerApps` (`mcp-deploy-client.deployMcpContainerApp`) |
| 3 | UAMI binding (`uami-loom-mcp`) | built ✅ | container-app `identity.userAssignedIdentities` (`LOOM_MCP_UAMI_ID`) |
| 4 | Azure Files volume at /data | built ✅ (honest-gate ⚠️ when `LOOM_MCP_STORAGE_NAME` unset) | `template.volumes[]` + `volumeMounts[]`; provisioned by `mcp-storage.bicep` |
| 5 | KV secretRef for secret-gated servers (e.g. GitHub/Brave) | built ✅ | `configuration.secrets[].keyVaultUrl` resolved by the MCP UAMI (Key Vault Secrets User, granted in `keyvault.bicep`) |
| 6 | Live status (provisioningState + runningStatus + FQDN) | built ✅ | `GET /api/admin/mcp-catalog/status` → ARM `GET containerApps/{name}` |
| 7 | Teardown | built ✅ | `DELETE /api/admin/mcp-catalog/delete` → ARM `DELETE containerApps/{name}` (idempotent on 404) |
| 8 | Persisted as an MCP connection (Cosmos `mcp-servers`) | built ✅ | `lib/azure/mcp-config-store.saveMcpServer` (source: `catalog`, `deployment{}` metadata) |

Honest gates (no fabricated success — `no-vaporware.md`):
- Container Apps platform not wired → `{ ok:false, gate }` naming the missing
  env (`LOOM_SUBSCRIPTION_ID` / `LOOM_ADMIN_RG` / `LOOM_CAE_ID`). Catalog still renders.
- AKS boundary (GCC-High / IL5) → deploy honest-gates: `Microsoft.App/containerApps`
  has no AKS analog; those clouds deploy MCP workloads via the GitOps manifest path.
- ARM 403 (Console UAMI lacks Contributor on the admin RG) → the real status
  code + message propagate, never swallowed.

No Microsoft Fabric / Power BI dependency — these are plain OCI images on Azure
Container Apps (`no-fabric-dependency.md`); the surface works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Bicep + env sync

- `keyvault.bicep` — MCP UAMI granted **Key Vault Secrets User**
  (`4633458b-17de-408a-b874-0445c86b69e6`) for secretRef resolution.
- `mcp-storage.bicep` — hardened StorageV2 account + Azure Files share +
  `Microsoft.App/managedEnvironments/storages` child on the CAE.
- `admin-plane/main.bicep` — wires `mcpPrincipalId` into the KV module, calls
  `mcp-storage`, and adds the console env: `LOOM_CONTAINER_PLATFORM`,
  `LOOM_CAE_ID`, `LOOM_CAE_NAME`, `LOOM_CAE_DEFAULT_DOMAIN`,
  `LOOM_ACR_LOGIN_SERVER`, `LOOM_MCP_UAMI_ID`, `LOOM_MCP_UAMI_CLIENT_ID`,
  `LOOM_MCP_STORAGE_NAME`, `LOOM_MCP_FILE_SHARE`, `LOOM_MCP_CATALOG_REGISTRY`.

All env vars derive from module outputs — no manual post-deploy step. The only
optional operator action is setting `LOOM_MCP_CATALOG_REGISTRY` to an ACR mirror
host for air-gapped boundaries that cannot reach the upstream Docker MCP catalog.
