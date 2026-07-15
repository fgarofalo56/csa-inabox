# Embed codes admin page

> **Surface:** `/admin/embed-codes`
> **BFF:** `apps/fiab-console/app/api/admin/embed-codes/route.ts`
> **Store:** Cosmos `embed-codes` (PK `/tenantId`)

The **Embed codes** page generates and revokes **read-only signed embed URLs**
for reports and visuals — each an Azure Blob **user-delegation SAS** — so an
asset can be embedded in an external page **without a Fabric / Power BI
workspace**. It's the Azure-native parity of "publish to web / embed", kept
inside the tenant's storage boundary.

## What you can do

- **Generate an embed code** — mint a signed, time-bounded URL for a report or
  visual; the bytes are served from the org-visuals / report Blob container.
- **Revoke** — invalidate an embed code immediately; the signed URL stops
  resolving.
- **Audit** — see who created each code, its target, and expiry.

## Backend

| Control | Backend |
|---|---|
| Embed registry | Cosmos `embed-codes` (PK `/tenantId`) |
| Signed URL | Azure Blob user-delegation SAS (Entra-issued, not an account key) |

No Fabric / Power BI dependency — the embed is a scoped SAS over Loom-owned Blob
storage.

## RBAC & honest gates

Tenant-admin. The Console UAMI needs **Storage Blob Data Reader** (delegation) on
the backing container to mint the SAS; absent that, the page shows the exact role
to grant rather than a dead link.

## Related

- [Organizational visuals](org-visuals.md) — the bundles embed codes can serve.
