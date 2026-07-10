# lakehouse-shortcut — parity with the OneLake / lakehouse shortcut

> **rev-94 item.** Azure-native equivalent of a Microsoft Fabric **OneLake
> shortcut**, built with **no OneLake / Fabric dependency**
> (`no-fabric-dependency.md`). **Doc-only for bicep-sync** — the shortcut reuses
> the EXISTING DLZ ADLS Gen2 account; there is no new infrastructure to deploy.

Source UI: **Microsoft Fabric → Lakehouse → New shortcut** (point a lakehouse at
external Delta/Parquet read-in-place)
- OneLake shortcuts: <https://learn.microsoft.com/fabric/onelake/onelake-shortcuts>
- ADLS Gen2: <https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction>

## What it is

A shortcut is a **named pointer** to external data that a lakehouse reads **in
place** without copying a byte. Loom persists the pointer — a **connector**
(source type + non-secret coordinates + an optional Key Vault `secretRef`) — as a
Cosmos workspace item; each source resolves against its **real Azure/cloud
backend**. Create + Verify list one level of the target to prove the pointer
resolves. Route: `app/api/items/lakehouse-shortcut/route.ts`.

## Source types (parity with Fabric's New-shortcut dialog)

Fabric's New-shortcut dialog offers ~7 sources; the Azure-native achievable set
(no Fabric / OneLake) is built one-for-one:

| Source | Loom | Connection inputs | Real backend |
| --- | --- | --- | --- |
| Internal lakehouse-to-lakehouse | ✅ | medallion container + path | `adls-client` (Console UAMI) |
| ADLS Gen2 (external) | ✅ | account + container + path (+ optional SAS) | `shortcut-client.browseAdls` / `listAdlsWithSas` |
| Azure Blob | ✅ | account + container + path (+ optional SAS) | `shortcut-client.browseAdls` / `listAdlsWithSas` |
| Amazon S3 | ✅ | bucket + region + access key (KV secret) | `shortcut-client.listS3Objects` (SigV4) |
| S3-compatible (MinIO / Wasabi) | ✅ | + endpoint host | `shortcut-client.listS3Objects` (endpoint override) |
| Google Cloud Storage | ✅ | bucket + service-account JSON (KV secret) | `shortcut-client.listGcsObjects` (JWT→OAuth) |
| Dataverse | ✅ | environment URL + Synapse Link ADLS export path | `shortcut-client.listDataverseEntities` |

| Capability | Loom | Backend |
| --- | --- | --- |
| List shortcuts in a workspace | ✅ | Cosmos `items` query |
| Pick a source type (7-source picker) | ✅ | in-editor connector step |
| Verify a target (resolve, list, no copy) | ✅ | real per-source list (above) |
| Create a shortcut (resolves before persisting) | ✅ | resolve + Cosmos `create` |
| Persist credentials (S3/GCS/SAS) | ✅ | Key Vault via `putShortcutSecret` — only a `secretRef` in Cosmos |
| Delete a shortcut pointer (+ its KV secret) | ✅ | Cosmos `delete` + `deleteShortcutSecret` |

## Azure-native backend

The **existing DLZ ADLS Gen2 lakehouse** — no new resource. The `abfss://` host
suffix is derived from the configured container URL (sovereign-cloud-correct, no
hard-coded `core.windows.net`).

## Env vars / role to provision (reuses ADLS — nothing new)

| Env var | Purpose |
| --- | --- |
| `LOOM_ADLS_ACCOUNT` | The DLZ ADLS Gen2 account the lakehouse + internal shortcuts read |
| `LOOM_BRONZE_URL` / `LOOM_SILVER_URL` / `LOOM_GOLD_URL` | Medallion container URLs the internal shortcut resolves against (empty ⇒ honest gate) |
| `LOOM_SHORTCUT_KEYVAULT` (or `LOOM_KEY_VAULT_URI`) | Key Vault for S3/GCS/SAS shortcut credentials — only a `secretRef` persists (unset + a credentialed source ⇒ honest gate) |

RBAC: the Console UAMI's existing **Storage Blob Data Reader/Contributor** on the
DLZ ADLS account (granted by `landing-zone/storage.bicep`) covers internal +
external-ADLS resolve; **Key Vault Secrets Officer** on the shortcut vault covers
S3/GCS/SAS credential storage. External-ADLS/Blob without a SAS additionally needs
the UAMI granted **Storage Blob Data Reader** on the target account.

## Bicep module that deploys it

**None new.** The backing infra is `platform/fiab/bicep/modules/landing-zone/storage.bicep`
(the medallion ADLS Gen2 account) + the `LOOM_ADLS_ACCOUNT` / `LOOM_*_URL` env
vars already emitted by `admin-plane/main.bicep` and `hub-console-dlz-env.bicep`.
When no ADLS account is configured the Verify/Create step returns a precise message
naming the missing `LOOM_*_URL` containers (`no-vaporware.md`).

## UX-baseline lift (UX-Wave 2 · UX-201)

A UX-only lift adopting shared UX-baseline components; the real backend calls
(`load` / `verify` / `create` / `del`) are unchanged.

| # | Bar item (SC) | State | Where |
| --- | --- | --- | --- |
| 6 | Guided multi-path empty state (SC-4) | ✅ built | `GuidedEmptyState` replaces the plain "No shortcuts yet" MessageBar; four per-source launcher cards (Internal / ADLS-Blob / Amazon S3 / Dataverse) each open the **real** New-shortcut dialog preset to that connector, plus a Learn-more link |
| 12 | Teaching banner (SC-6) | ✅ built | `TeachingBanner surfaceKey="lakehouse-shortcut-inplace"` — "Read data where it lives — no copy", persistent dismiss + Learn-more |
| 11 | Command search Ctrl+Q / Alt+Q (SC-9) | ✅ built | `commandSearch` on the chrome + `useRegisterRibbonCommands(ribbon, item.slug)` publishes New shortcut / Refresh |
| 8 | Entity/relationship diagram (SC-10) | ⚠️ honest-defer | A shortcut is a storage pointer with **no relational schema** (`entity-diagram-sources` supports only `semantic-model \| lakehouse \| kql-database`); a source→shortcut topology visual is deferred rather than fabricate a schema (`no-vaporware.md`) |
| 1 | Canvas node-kit (SC-1) | ⚠️ honest-defer | Dialog-driven navigator, not a canvas — no node graph to adopt |

Test: `lib/editors/__tests__/lakehouse-shortcut.test.tsx` (banner + ribbon + guided-card render).
