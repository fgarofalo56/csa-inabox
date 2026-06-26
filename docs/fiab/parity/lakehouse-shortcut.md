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

A shortcut is a **named pointer** to external Delta/Parquet that a lakehouse reads
**in place** without copying a byte. Loom persists the pointer (name + target ADLS
container/path, resolved to an `abfss://` location) as a Cosmos workspace item; the
**live backend is ADLS Gen2** (reused via `adls-client`). Create + Verify list the
target path with the real ADLS client to prove the pointer resolves. Route:
`app/api/items/lakehouse-shortcut/route.ts`.

| Capability | Loom | Backend |
| --- | --- | --- |
| List shortcuts in a workspace | ✅ | Cosmos `items` query |
| Verify a target (resolve, list, no copy) | ✅ | `adls-client.listPaths` (real DFS list) |
| Create a shortcut (resolves before persisting) | ✅ | ADLS resolve + Cosmos `create` |
| Delete a shortcut pointer | ✅ | Cosmos `delete` |

## Azure-native backend

The **existing DLZ ADLS Gen2 lakehouse** — no new resource. The `abfss://` host
suffix is derived from the configured container URL (sovereign-cloud-correct, no
hard-coded `core.windows.net`).

## Env vars / role to provision (reuses ADLS — nothing new)

| Env var | Purpose |
| --- | --- |
| `LOOM_ADLS_ACCOUNT` | The DLZ ADLS Gen2 account the lakehouse + shortcuts read |
| `LOOM_BRONZE_URL` / `LOOM_SILVER_URL` / `LOOM_GOLD_URL` | Medallion container URLs the shortcut resolves against (empty ⇒ honest gate) |

RBAC: the Console UAMI's existing **Storage Blob Data Reader/Contributor** on the
DLZ ADLS account (granted by `landing-zone/storage.bicep`) covers shortcut resolve.

## Bicep module that deploys it

**None new.** The backing infra is `platform/fiab/bicep/modules/landing-zone/storage.bicep`
(the medallion ADLS Gen2 account) + the `LOOM_ADLS_ACCOUNT` / `LOOM_*_URL` env
vars already emitted by `admin-plane/main.bicep` and `hub-console-dlz-env.bicep`.
When no ADLS account is configured the Verify/Create step returns a precise message
naming the missing `LOOM_*_URL` containers (`no-vaporware.md`).
