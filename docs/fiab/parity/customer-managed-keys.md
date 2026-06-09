# customer-managed-keys — parity with Azure Storage "Encryption (Customer-managed keys)"

Source UI: Azure portal → Storage account → **Security + networking → Encryption →
Customer-managed keys** (and the equivalent Cosmos DB **Data encryption** blade).
Grounded in Microsoft Learn:
- https://learn.microsoft.com/azure/storage/common/customer-managed-keys-overview
- https://learn.microsoft.com/azure/storage/common/customer-managed-keys-configure-key-vault
- https://learn.microsoft.com/azure/cosmos-db/how-to-setup-customer-managed-keys
- https://learn.microsoft.com/rest/api/storagerp/storage-accounts/update

There is **no Microsoft Fabric / Power BI** equivalent — CMK is an Azure storage
control-plane capability. Loom binds the **same Azure storage account / Cosmos
account the DLZ already deploys** (per no-fabric-dependency.md). Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Azure feature inventory

| # | Azure portal capability | Notes |
|---|--------------------------|-------|
| 1 | Show current key source (Microsoft-managed vs Customer-managed) | `encryption.keySource` |
| 2 | Select Key Vault | data-plane vault selection |
| 3 | Select key from the vault | `keys/list` on the vault |
| 4 | Select key version (or "always use current version" = auto-rotate) | `keyversion: ''` = auto-rotate |
| 5 | Choose the user-assigned identity used to access the key | `encryption.identity.userAssignedIdentity` |
| 6 | Save → PATCH `encryption.keyVaultProperties` on the account | ARM `2023-05-01` |
| 7 | Show live key id / rotation state | `currentVersionedKeyIdentifier` |
| 8 | Revert to Microsoft-managed keys | `keySource = Microsoft.Storage` |
| 9 | Cosmos DB: bind `keyVaultKeyUri` + `defaultIdentity` (optional) | ARM `2024-12-01-preview` |
| 10 | Surface required RBAC (Key Vault Crypto Service Encryption User) | role gate |

## Loom coverage

| # | Loom surface | Backend | State |
|---|--------------|---------|-------|
| 1 | `CmkPane` status card — Badge "Customer-managed key" / "Microsoft-managed key" | `getStorageCmkStatus()` ARM GET | built ✅ |
| 2 | Bind wizard step "Key Vault" (from `LOOM_KEY_VAULT_URI`) | `cmkVaultUrl()` | built ✅ |
| 3 | Bind wizard "Key" dropdown | `listVaultKeys()` KV `GET /keys` 7.4 | built ✅ |
| 4 | Bind wizard "Version" dropdown incl. "Latest (auto-rotate)" | `listKeyVersions()` KV `GET /keys/{n}/versions` | built ✅ |
| 5 | Encryption identity (Console UAMI) | `LOOM_UAMI_RESOURCE_ID` | built ✅ |
| 6 | "Bind key" → PATCH | `bindStorageCmk()` ARM PATCH | built ✅ |
| 7 | Status "Live key id" row | `currentVersionedKeyIdentifier` | built ✅ |
| 8 | "Revert to Microsoft-managed" button | `unbindStorageCmk()` ARM PATCH | built ✅ |
| 9 | "Also bind the Cosmos DB account" checkbox + 990-byte advisory | `bindCosmosCmk()` ARM PATCH | honest-gate ⚠️ (set `LOOM_COSMOS_ACCOUNT_ID`) |
| 10 | Role gate MessageBars (KV Crypto + Storage Contributor) | `runCmkRoleChecks()` ARM role-assignment reads | built ✅ |

Zero ❌, zero stub banners. The only non-functional state is the honest infra
gate when a role / env var is missing.

## Backend per control

| Control | REST / data-plane |
|---------|-------------------|
| List keys / versions | Key Vault data plane `7.4` (`kvScope()` — sovereign-correct) |
| Read / bind / unbind storage CMK | ARM `Microsoft.Storage/storageAccounts` `2023-05-01` PATCH |
| Cosmos CMK | ARM `Microsoft.DocumentDB/databaseAccounts` `2024-12-01-preview` PATCH |
| Role checks | ARM `Microsoft.Authorization/roleAssignments` `2022-04-01` |
| UAMI principal id | ARM `Microsoft.ManagedIdentity/userAssignedIdentities` `2023-01-31` |

## Required RBAC (honest gates)

| Identity | Role | GUID | Scope | Granted by |
|----------|------|------|-------|-----------|
| Console UAMI | Key Vault Crypto Service Encryption User | `e147488a-f6f5-4113-8e2d-b22465e65bf6` | Key Vault | `admin-plane/keyvault.bicep` (`consolePrincipalNeedsCmkRole`) |
| Console UAMI | Storage Account Contributor | `17d1049b-9a84-46fb-8f53-869881c3d3ab` | Storage account | `landing-zone/storage-lifecycle-rbac.bicep` (`consolePrincipalNeedsCmkBind`) |

The KV Crypto role both lets the BFF **list keys** (`keys/read`) and lets the
storage account **use the key** as its encryption identity (wrap/unwrap), so one
assignment covers both. The Storage Account Contributor role is shared with the
OneLake lifecycle feature (same role + principal + scope → a single assignment).

## Per-cloud matrix

| Aspect | Commercial / GCC | GCC-High / IL5 (USGov) |
|--------|------------------|------------------------|
| ARM host | `management.azure.com` | `management.usgovcloudapi.net` |
| KV data plane | `*.vault.azure.net` | `*.vault.usgovcloudapi.net` |
| KV token scope | `https://vault.azure.net/.default` | `https://vault.usgovcloudapi.net/.default` |
| Storage API | `2023-05-01` | `2023-05-01` |
| Role GUIDs | global (same) | global (same) |
| HSM (IL5) | software keys OK | Managed HSM (`*.managedhsm.azure.net`); RSA-HSM keys; same `7.4` paths |

`cmk-client.ts` derives every host/scope from `cloud-endpoints` (`armScope()` /
`kvScope()`), so a hard-coded Commercial vault scope cannot 401 a Gov deployment.

## Env vars

| Variable | Purpose | Wired by |
|----------|---------|----------|
| `LOOM_KEY_VAULT_URI` | CMK vault (reused from Connections) | `admin-plane/main.bicep` |
| `LOOM_KEY_VAULT_ID` | KV ARM id (scopes the Crypto role check) | `admin-plane/main.bicep` |
| `LOOM_UAMI_RESOURCE_ID` | Storage encryption identity (Console UAMI resource id) | `admin-plane/main.bicep` |
| `LOOM_SUBSCRIPTION_ID` + `LOOM_DLZ_RG` | resolve the backing storage account | existing |
| `LOOM_COSMOS_ACCOUNT_ID` | optional Cosmos CMK target | operator-set |

## Verification

- `npx vitest run lib/clients/__tests__/cmk-client.test.ts` — KV/ARM request
  shapes, sovereign KV scope, auto-rotate vs pinned version, role parsing.
- Live: open a workspace → Settings → **Encryption** tab → bind a real KV key →
  the status card reflects the live `keyVaultProperties` re-read from ARM. With
  the Crypto role absent, the role-gate MessageBar names the role + GUID + bicep
  module (HTTP 403 from ARM is surfaced honestly, never a 5xx).
