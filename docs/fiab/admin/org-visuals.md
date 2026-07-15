# Organizational visuals admin page

> **Surface:** `/admin/org-visuals`
> **BFF:** `apps/fiab-console/app/api/admin/org-visuals/{route.ts,dashboards}`
> **Store:** Cosmos `org-visuals` (PK `/tenantId`) + Azure Blob (bundle bytes)

The **Organizational visuals** page manages tenant-wide custom visual bundles
(`.pbiviz`) — upload, version, enable/disable and remove — stored Azure-natively
in Blob. It's how an organization makes an approved set of custom visuals
available across its reports and dashboards without a Fabric admin portal.

## What you can do

- **Upload & version** — add a `.pbiviz` bundle; each upload is a new version, so
  you can roll forward/back.
- **Enable / disable** — control which bundles are available tenant-wide without
  deleting them.
- **Remove** — delete a bundle entirely.
- **Where used** — `/api/admin/org-visuals/dashboards` shows the dashboards /
  reports referencing a visual.

## Backend

| Control | Backend |
|---|---|
| Bundle metadata + enabled/version | Cosmos `org-visuals` (PK `/tenantId`) |
| Bundle bytes | Azure Blob (`org-visuals` container) |

The enabled toggle + version live in Cosmos; the `.pbiviz` bytes live in Blob —
no Fabric / Power BI workspace required.

## RBAC & honest gates

Tenant-admin, with the Console UAMI holding **Storage Blob Data Contributor** on
the org-visuals container. Missing rights surface the exact role to grant.

## Related

- [Embed codes](embed-codes.md) — signed URLs that can serve these bundles.
