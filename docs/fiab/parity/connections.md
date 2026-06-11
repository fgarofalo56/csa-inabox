# connections — parity with Azure portal "Add a connection" / data-source linking

Source UI: Azure portal resource pickers + Synapse/ADF "Linked services" + the
cross-resource "Select an existing resource" blade (subscription-scoped resource
browse). Grounded in Microsoft Learn:
- Azure Resource Graph query language + `type in~` and `ResourceContainers`
  subscription-name join (governance/resource-graph/concepts/query-language,
  /advanced-query-samples).
- Resource Graph paging via `$skipToken` (governance/resource-graph/concepts/work-with-data).
- Key Vault secret REST + RBAC "Key Vault Secrets Officer" (b86a8fe4-44ce-4948-aee5-eccb2c155cd7).
- Sovereign endpoints (azure-government/compare-azure-government-global-azure).

## Azure feature inventory (every capability)

| Capability | Where in Azure |
|---|---|
| Create a new connection by entering coordinates + credentials | Synapse/ADF "New linked service" |
| Pick an EXISTING resource you already have access to | Portal resource picker "Select existing" |
| Browse resources across ALL subscriptions you can read | Portal "Subscriptions" filter + ARG |
| Honor the caller's RBAC + ABAC (see only what you're entitled to) | ARM delegated token / ARG |
| Group results by subscription + show subscription display name | Portal resource list |
| Per-resource type icon / brand glyph | Portal all-services + resource lists |
| Managed-identity (no-secret) auth as the default | Linked-service "System/User-assigned MI" |
| Secret-bearing auth (password / conn-string / key / SPN secret) | Linked-service "Key/SPN/Connection string" |
| Store secrets in Key Vault, reference (never inline) | Linked-service "Azure Key Vault" + secretRef |

## Loom coverage

| Capability | Status | Notes |
|---|---|---|
| New connection (manual) | ✅ | `ConnectionBuilder` dialog (pre-existing) — now icon-decorated type dropdown |
| Add existing (cross-sub import) | ✅ | `AddExistingConnectionWizard` → `GET /api/azure/connectables` |
| Discover across ALL subscriptions | ✅ | ARG query omits `subscriptions` → spans every readable sub |
| RBAC + ABAC honored | ✅ | `via:'user'` delegated ARM token (OBO), UAMI fallback `via:'uami'` |
| `$skipToken` paging (no 1000-row truncation) | ✅ | route loops on `body.$skipToken` |
| Group by subscription + display name | ✅ | `ResourceContainers` leftouter join → `subName` |
| Per-type icons everywhere | ✅ | `itemVisual()` in tiles, list Type column, both dialogs; registry slugs added: postgres, storage-adls, event-hub, service-bus, key-vault |
| MI-first import (no secret) | ✅ | imported connections POST `authMethod:'entra-mi'` |
| Secrets → Key Vault (secretRef only) | ✅ | `connections-store.createConnection` → `putKeyVaultSecret`; Cosmos stores `secretRef` only |
| Per-cloud KV endpoint + scope | ✅ | `kv-secrets-client` now uses `kvScope()`/`kvUrlFromName()` (Gov fix) |
| Honest infra gate (no mock data) | ⚠️ | route returns `code:'no_access'` naming the 2 one-time admin actions |

Zero ❌ — no stub banners, no empty tabs.

## Backend per control

| Control | Backend |
|---|---|
| Add existing — list | `GET /api/azure/connectables` → ARG `POST {ARM}/providers/Microsoft.ResourceGraph/resources` with the user's delegated ARM token (UAMI fallback) |
| Add existing — import row | `POST /api/connections` → `connections-store.createConnection` (Cosmos `connections` container, partition `/tenantId`) |
| New connection — secret field | `putKeyVaultSecret('loom-conn-<id>')` over KV REST `api-version=7.4`, scope `kvScope()` |
| Delete connection | `DELETE /api/connections?id=` → Cosmos delete + best-effort `deleteKeyVaultSecret` |

## Connectable ARM types → Loom ConnectionType

`microsoft.sql/servers/databases`→azure-sql · `microsoft.dbforpostgresql/*`→postgres ·
`microsoft.storage/storageaccounts`→storage-adls · `microsoft.documentdb/databaseaccounts`→cosmos ·
`microsoft.synapse/workspaces`→synapse-serverless · `microsoft.databricks/workspaces`→databricks-sql ·
`microsoft.eventhub/namespaces`→event-hub · `microsoft.servicebus/namespaces`→service-bus ·
`microsoft.keyvault/vaults`→key-vault.

## Bicep / infra

- Connections Key Vault: `modules/admin-plane/keyvault.bicep` (`kv-loom-*`, RBAC, private endpoint).
- Console UAMI grant "Key Vault Secrets Officer" (`b86a8fe4-…`) — `keyvault.bicep` `consoleKvSecretsRole`,
  wired via `consolePrincipalId: identity.outputs.uamiConsolePrincipalId` in `admin-plane/main.bicep`.
- Env: `LOOM_KEY_VAULT_URI = keyvault.outputs.keyVaultUri` (admin-plane/main.bicep).
- Delegated ARM scope `{ARM}/user_impersonation` requested at sign-in (`app/auth/sign-in/route.ts`),
  cached encrypted by `lib/azure/user-token-store.ts`.

## Verification

- Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — pure Azure ARM/ARG/KV, no Fabric/Power BI host.
- `pnpm vitest connectable-types` (mapping + registry coverage) + `connections/page` (entry points).
- Live: `GET /api/azure/connectables` returns real ARG rows (or honest gate); imported connection
  shows `hasSecret:false` + `origin:'existing'` with no plaintext in Cosmos.
