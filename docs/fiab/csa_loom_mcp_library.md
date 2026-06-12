# CSA Loom — MCP Server Library (deploy-to-Container-Apps + Azure Files)

Source-of-truth spec for the CSA Loom MCP server library / deploy experience.
Referenced by `docs/fiab/prp/AUDIT-2026-06-10-deep.md` (audit-T44…T49) and
`.claude/workflows/loom-audit-deep.js`. This page documents the **implemented**
design — every symbol named below exists in the working tree.

> Operator ask (verbatim intent): "Admin Portal → Tenant settings → External MCP
> Tools gets a library of MCP servers users pick from → deployed to Azure
> Container Apps, preconfigured (KV secretRef env + Azure Files mount for
> persistence), wired into Copilot, with zero user config."

This document is the design record for **audit-T46 — MCP deploy-to-Container-Apps
path + Azure Files mount**. The surrounding catalog/wizard/routes (T44, T45, T47,
T48, T49) are tracked separately; their experience-level parity record lives in
`docs/fiab/parity/mcp-catalog.md` (mirrored under
`apps/fiab-console/docs/fiab/parity/mcp-catalog.md`).

---

## audit-T46 — acceptance

> container-apps-arm-client deploys MCP image with KV secretRef env + Azure
> Files persistence.

**Status: done.** `apps/fiab-console/lib/azure/container-apps-arm-client.ts`
exposes the full MCP management-plane surface. There are no mocks — real ARM REST
only (`callArm`), with an honest gate when the boundary is not Container Apps.

---

## The deploy primitives (`lib/azure/container-apps-arm-client.ts`)

| Symbol | ARM operation | What it does |
|--------|---------------|--------------|
| `getStorageAccountKey(account, rg)` | `POST Microsoft.Storage/storageAccounts/{a}/listKeys` | Fetches the primary account key. Required because **Container Apps cannot mount Azure Files with a managed identity** (Learn) — the key is mandatory on the storages resource. Console UAMI needs `…/listkeys/action` (covered by Contributor on the admin RG, `scaling-rbac.bicep`). |
| `upsertEnvStorage(opts)` | `PUT Microsoft.App/managedEnvironments/{env}/storages/{name}` | Registers the Azure Files share on the managed environment (`azureFile`: accountName / accountKey / shareName / accessMode). Rejects a missing `accountKey` with an honest 400. |
| `deployMcpContainerApp(opts)` | `GET` then `PUT Microsoft.App/containerApps/{name}` | GET-merge-PUT: layers `template.volumes[]` (`storageType:'AzureFile'`) + per-container `volumeMounts[]`, an optional image roll, optional `workloadProfileName`, **KV-backed `configuration.secrets[]`** (`{name, keyVaultUrl, identity}`, identity picked from the app's own UAMI), and **allowlisted `secretRef`/value env** onto the existing app, preserving every bicep-declared property. |
| `createMcpContainerApp(opts)` | `PUT Microsoft.App/containerApps/{name}` (create) | Full create for a brand-new catalog-deployed server: internal ingress, assigned UAMI, KV secrets, secretRef env. |
| `readMcpFilesConfig()` | — | Resolves `LOOM_MCP_FILES_ACCOUNT` / `LOOM_MCP_FILES_SHARE` / `LOOM_MCP_FILES_RG` / `LOOM_MCP_STORAGE_NAME` / `LOOM_MCP_DATA_DIR`; throws `McpFilesNotConfiguredError` (→ honest 503) when unset. |
| `assertAcaPlatform()` | — | Throws `AcaPlatformError` on AKS boundaries (GCC-High / IL5 / DoD), naming the Azure Files PVC remediation on the AKS workload. |

### KV secretRef env (no plaintext secrets)

`deployMcpContainerApp` / `createMcpContainerApp` write Key Vault-backed entries
to `configuration.secrets[]` as `{ name, keyVaultUrl, identity }` and reference
them from container `env[].secretRef`. The resolving identity is the app's own
user-assigned managed identity (it must hold **Key Vault Secrets User**). Secret
*values* never touch Cosmos or the container template — only the KV URL + the
secret name do.

### Azure Files mount = two ARM resources (Learn)

Mounting a share is a two-step operation per
[Use storage mounts in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/storage-mounts-azure-files):

1. Register `Microsoft.App/managedEnvironments/{env}/storages/{name}` with
   `azureFile` (accountName / accountKey / shareName / accessMode) —
   `upsertEnvStorage`.
2. Add `template.volumes[].storageType='AzureFile'` + container `volumeMounts[]`
   and roll a new revision — `deployMcpContainerApp`.

With `activeRevisionsMode: 'Single'` the new revision replaces the old, so expect
a brief MCP connection drop on apply. `mountPath` must be absolute; `subPath`
must not start with `/` (Azure Files constraint) — both enforced.

> **CRITICAL real-world constraint.** Container Apps does **not** support
> identity-based access to Azure file shares; the storage-account key is
> mandatory on the storages resource (`allowSharedKeyAccess: true` on the
> account). The code honors this instead of attempting a silent-fail identity
> mount. The app's *env* secrets stay Key Vault-backed; only the file-share
> account key is inline.

---

## loom-no-freeform-config compliance

The deploy path never accepts an arbitrary env/secrets blob:

- `MCP_ENV_NAME_RE = /^(LOOM_|MCP_|AZURE_|APPLICATIONINSIGHTS_|KEYVAULT_|CSA_LOOM_)[A-Z0-9_]*$/`
  allowlists every env name; a non-matching name is a 400.
- `ACA_WORKLOAD_PROFILES` (a `Set`) constrains the workload-profile string.
- `accessMode` is constrained to `ReadWrite` | `ReadOnly`.
- An env entry cannot set both `value` and `secretRef`.

---

## BFF wiring (ui-parity)

`POST /api/admin/mcp-servers/deploy` →
`apps/fiab-console/app/api/admin/mcp-servers/deploy/route.ts`:

- `mountMcpPersistence()` runs the real 3-step op:
  `getStorageAccountKey` → `upsertEnvStorage` → `deployMcpContainerApp`
  (mounts `mcp-data` into `loom-mcp` and re-publishes `LOOM_MCP_DATA_DIR`).
- `deployCatalogServer()` writes per-field KV secrets, then
  `createMcpContainerApp`; on failure it rolls back any secrets it wrote so a
  failed deploy never orphans them.
- Honest gates surface a copy-pasteable `az containerapp create` fallback and a
  `gate{}` MessageBar naming the exact env var / role / resource.

`POST /api/admin/mcp-catalog/deploy` (the catalog wizard path) uses the slimmer
`lib/azure/mcp-deploy-client.ts` (`deployMcpContainerApp({catalogId,…})`), which
does the same KV-secretRef + volumes/volumeMounts shape for catalog entries that
`needsStorage`. Two routes, two intentionally-scoped clients — see *Two deploy
clients* below.

UI: `lib/components/admin/mcp-servers-panel.tsx`,
`mcp-catalog-panel.tsx`, `mcp-catalog-wizard.tsx` (dropdowns / typed wizard, no
raw JSON).

---

## Bicep + bootstrap sync

| Module | Role |
|--------|------|
| `platform/fiab/bicep/modules/admin-plane/mcp-storage.bicep` | StorageV2 (`allowSharedKeyAccess:true`) + Files share + `managedEnvironments/storages` registration. Outputs `envStorageName`, `fileShareName`. |
| `platform/fiab/bicep/modules/admin-plane/mcp-catalog-app.bicep` | IaC mirror of `createMcpContainerApp` (KV `secrets[]`, secretRef env). |
| `platform/fiab/bicep/modules/admin-plane/main.bicep` | `mcpPersistenceEnabled` param; `mcpFilesActive` guard (Container Apps + deployApps only); inline `mcpEnvStorage`; wires `LOOM_MCP_FILES_ACCOUNT/_SHARE/_RG`, `LOOM_MCP_STORAGE_NAME`, `LOOM_MCP_DATA_DIR`, `LOOM_ACA_ENVIRONMENT` onto loom-console; attaches `mcp-data-vol` to the loom-mcp app. |

**api-version consistency (bicep+bootstrap-sync).** The
`managedEnvironments/storages` resource is the SAME resource mounted from three
places; all three are pinned to GA **`2024-03-01`** — `main.bicep` (`mcpEnvStorage`),
`mcp-storage.bicep` (`envStorage` + the existing-CAE reference), and the runtime
client `container-apps-arm-client.ts` (`ACA_API`). The `azureFile` storages
contract is identical across api-versions, so this is a pure consistency pin. The
**containerApps** resource (the app itself) stays on `2025-02-02-preview` in
`app-deployments.bicep` / `mcp-deploy-client.ts` to match how the loom-mcp app is
actually deployed; that is a deliberate, documented split, not drift.

The post-deploy bootstrap (`.github/workflows/csa-loom-post-deploy-bootstrap.yml`)
is RBAC-only — env-var sync is bicep's responsibility and is in sync. No
bootstrap change is required for the Azure Files mount.

---

## Sovereign-cloud behavior (no-fabric-dependency / Azure-native default)

- **Commercial / GCC (Container Apps boundary):** full path active.
  `mcpFilesActive = mcpPersistenceEnabled && containerPlatform=='containerApps'
  && deployAppsEnabled`. Azure Files via account key; KV secretRef resolved by
  the MCP / console UAMI.
- **GCC-High / IL5 / DoD (AKS boundary):** `assertAcaPlatform()` throws
  `AcaPlatformError`; the route returns an honest 409/503 gate, never a fake
  success. Persistence there is an Azure Files **PersistentVolumeClaim** on the
  AKS Deployment (GitOps manifest path in `app-deployments.bicep`), not a
  `managedEnvironments/storages` mount.

The entire surface is Container Apps + Key Vault + Cosmos + Azure Files — zero
Microsoft Fabric / Power BI. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

---

## Two deploy clients (intentional, scoped)

There are two `deployMcpContainerApp` implementations:

- `container-apps-arm-client.ts` — the **management-plane** primitive used by
  `/api/admin/mcp-servers/deploy` (mount-persistence + workload-profile + env
  allowlist on an existing app). This is the audit-T46 target.
- `mcp-deploy-client.ts` — the **catalog-create** client used by
  `/api/admin/mcp-catalog/deploy` (create a fresh app from a catalog entry, with
  volumes/volumeMounts when `entry.needsStorage`).

These are kept separate on purpose: the first re-deploys/mounts onto the
already-bicep-provisioned `loom-mcp` app, the second creates a new app per
catalog selection. **Do not add a third deploy method** — extend the matching
client.

---

## Verification

- `apps/fiab-console/lib/azure/__tests__/scaling-clients.test.ts` (container-apps-arm-client
  MCP path): asserts `upsertEnvStorage` PUT body, missing-key rejection,
  `getStorageAccountKey` listKeys, `deployMcpContainerApp` GET-then-PUT with
  volumes + volumeMounts + KV secret-with-identity + secretRef env,
  relative-mountPath / leading-slash-subPath rejection, and `AcaPlatformError`
  on AKS.
- `apps/fiab-console/lib/azure/__tests__/mcp-catalog.test.ts` (mcp-deploy-client path).
- `npx tsc --noEmit` clean for all touched files.
- Live E2E (operator): mount persistence on `loom-mcp` → confirm the
  `managedEnvironments/storages` resource exists, the new revision carries the
  `AzureFile` volume + `/data` mount, and KV-backed env resolves. With
  `LOOM_MCP_FILES_ACCOUNT` unset, confirm the honest 503 gate names the missing
  env vars.
