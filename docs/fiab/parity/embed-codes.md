# embed-codes — parity with Fabric / Power BI Admin "Embed codes"

Source UI: Power BI / Fabric Admin portal → **Tenant settings → Embed codes**
(`https://app.powerbi.com/admin-portal/embedCodes`). Microsoft Learn:
[Manage embed codes](https://learn.microsoft.com/power-bi/collaborate-share/service-admin-portal-embed-codes).

Azure-native backing (no Fabric / Power BI workspace): a read-only **Blob Storage
user-delegation SAS** URL (signed with the Console UAMI's Microsoft Entra
credentials — never the account key) over a Loom embed-manifest blob in the DLZ
`org-visuals` Blob container.

## Fabric/Power BI feature inventory

| # | Capability (real Admin UI) | Notes |
|---|----------------------------|-------|
| 1 | List all embed codes for the tenant | report name, status, who published, date |
| 2 | See an embed code's **status** (Active / Revoked / etc.) | badge |
| 3 | See the **publisher** (created-by) of each code | UPN |
| 4 | Copy / view the embed URL | the loadable URL |
| 5 | **Revoke** an embed code (Delete) | invalidates the URL |
| 6 | Search / filter the list | by report / publisher |

## Loom coverage

| # | Capability | Status | Loom surface |
|---|------------|--------|--------------|
| 1 | List embed codes | ✅ built | `LoomDataTable` rows from `GET /api/admin/embed-codes` |
| 2 | Status badge (active/revoked) | ✅ built | Fluent `Badge` success/danger |
| 3 | Created-by column | ✅ built | from `createdBy` (session UPN) |
| 4 | Copy / open the signed URL | ✅ built | Copy + open buttons; URL also shown in a read-only `Input` on create |
| 5 | Revoke | ✅ built | `DELETE /api/admin/embed-codes?id=` → deletes backing blob + flips status |
| 6 | Search/filter | ✅ built | `Toolbar` search + per-column filter |
| — | Create embed code | ✅ built | `POST` → mints a real user-delegation SAS over a manifest blob |
| — | Honest infra gate | ⚠️ gate | `NotConfiguredBar` names `LOOM_ORG_VISUALS_URL` + `org-visuals-rbac.bicep` |

Zero ❌. Zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| List | Cosmos `embed-codes` query (PK /tenantId), lazy SAS refresh within 24h |
| Create | `adls-client.uploadBlob` (manifest) → `adls-client.generateReadSasUrl` (user-delegation SAS) → Cosmos upsert |
| Revoke | `adls-client.deletePath` (blob) → Cosmos replace (status=revoked, signedUrl='') |
| Copy / open | client-side over the real `signedUrl` |

## Per-cloud

| | Commercial | GCC | GCC-High | IL5/DoD |
|-|-----------|-----|----------|---------|
| Blob suffix | `blob.core.windows.net` | `blob.core.windows.net` | `blob.core.usgovcloudapi.net` | `blob.core.usgovcloudapi.net` |
| User-delegation SAS | ✅ | ✅ | ✅ | ✅ |
| SAS max TTL | 7 days | 7 days | 7 days | 7 days |
| Fabric/Power BI dependency | none | none | none | none |

## Verification

`npx vitest run lib/clients/__tests__/embed-codes-org-visuals.test.ts` — create
writes a real manifest blob + mints a SAS; revoke deletes the blob + flips
status. With `LOOM_ORG_VISUALS_URL` unset the route returns a 503 + hint and the
pane renders `NotConfiguredBar`. No `LOOM_DEFAULT_FABRIC_WORKSPACE` required.
