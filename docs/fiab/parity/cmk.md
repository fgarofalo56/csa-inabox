# cmk — parity with customer-managed-key encryption at rest

Source UI: Azure Storage **Encryption** blade; Key Vault; Fabric security
Reference: <https://learn.microsoft.com/azure/storage/common/customer-managed-keys-overview>
Also: <https://learn.microsoft.com/fabric/security/security-overview>
Run date: 2026-06-09

Loom surfaces (bicep-only — no console blade, matching Azure's deploy-time model):

- Storage CMK: `platform/fiab/bicep/modules/landing-zone/storage.bicep`
  (params `requireCmk`, `cmkKeyUri`, `cmkIdentityId`)
- Key Vault: `platform/fiab/bicep/modules/admin-plane/keyvault.bicep`
  (param `hsmIsolated`)
- IL5 params: `platform/fiab/bicep/params/il5.bicepparam`
- Commercial params: `platform/fiab/bicep/params/commercial.bicepparam`

CMK is **Azure-native infrastructure**, configured at deploy time exactly as in
the Azure portal (CMK is not a runtime portal action). There is **no dependency
on real Microsoft Fabric** — encryption is on the deployment's own Storage + Key
Vault and is independent of any Fabric workspace.

## Fabric/Azure feature inventory (grounded in Learn)

1. Encrypt storage at rest with a customer-managed key in Key Vault
2. Infrastructure (double) encryption
3. Key Vault with purge protection + soft delete
4. HSM-backed keys for high-assurance boundaries
5. Key rotation / key URL update

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Storage CMK encryption at rest | ✅ Built (IL5 mandated; optional elsewhere) | `requireCmk=true` → `Microsoft.Storage/storageAccounts@2023-05-01` `encryption.keySource:'Microsoft.Keyvault'` |
| Key Vault Premium (purge-protect, soft-delete 90d, public access disabled) | ✅ Built (all boundaries) | `keyvault.bicep` — always `sku.name:'premium'`, `enablePurgeProtection:true`, `softDeleteRetentionInDays:90` |
| Key Vault HSM isolated mode | ✅ Built (IL5) | `hsmIsolated=true` → isolated HSM key pool |
| Infrastructure encryption (double-encrypt) | ✅ Built (all) | `requireInfrastructureEncryption:true` always |
| CMK key URI wiring | ⚠️ Honest gate | `cmkKeyUri` is out-of-band: operator sets `LOOM_STORAGE_CMK_KEY_URI`; `main.bicep` passes it through to the storage module |
| Console UI for CMK rotation / key URL update | ⚠️ Honest gate | No console blade — ARM-only operation, matching Azure portal behaviour. Operator uses `az keyvault key rotate` + redeploy. |

Zero ❌ rows. The two ⚠️ gates (key-URI wiring, no rotation blade) are honest:
they mirror Azure's own deploy-time model where CMK is set via ARM, not a runtime
console toggle, per `no-vaporware.md`.

## Backend per control

- **Storage encryption** — `storage.bicep` sets `encryption.keySource` to
  `Microsoft.Keyvault` when `requireCmk`, referencing `cmkKeyUri` +
  `cmkIdentityId`; otherwise `Microsoft.Storage`. `requireInfrastructureEncryption`
  is always on for double-encryption.
- **Key Vault** — `keyvault.bicep` is always Premium with purge protection,
  90-day soft delete, and `publicNetworkAccess:'Disabled'`; `hsmIsolated` adds an
  isolated HSM pool at IL5.
- **Key URI / rotation** — operator-supplied via env + `az keyvault key rotate`;
  no console surface (Azure parity — there is no portal blade for this either).

## Per-cloud notes

| Cloud | `storageRequireCmk` | `keyVaultHsmIsolated` |
|---|---|---|
| Commercial | `false` (optional) | `false` |
| GCC | `false` (optional) | `false` |
| GCC-High | `false` by default (operator may enable) | optional |
| IL5 | `true` (mandated) | `true` (mandated) |

## Bicep sync

- Params `storageRequireCmk`, `keyVaultHsmIsolated` set per boundary
  (`il5.bicepparam` = both true; `commercial.bicepparam` = both false).
- Env `LOOM_STORAGE_CMK_KEY_URI` (optional) passed through `main.bicep` to the
  storage module.
- No console env var or role grant — this surface is entirely IaC.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — CMK is on the
  deployment's own Storage/Key Vault, never Fabric.
- Verify: deploy `il5.bicepparam` and confirm the storage account's
  `encryption.keySource == 'Microsoft.Keyvault'`, infrastructure encryption is
  on, and the Key Vault is Premium + purge-protected + HSM-isolated. Deploy
  `commercial.bicepparam` and confirm Microsoft-managed keys with infrastructure
  encryption still on.

Grade: **A** — full CMK/HSM infrastructure built in bicep and boundary-gated;
the lack of a runtime blade matches Azure's own deploy-time model (honest gate).
