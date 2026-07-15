# Classifications admin page

> **Surface:** `/admin/classifications`
> **BFF:** `apps/fiab-console/app/api/admin/classifications/route.ts`

The **Classifications** page owns the tenant's data-classification catalog — the
named categories (PII, financial, PHI, credentials, and the rest) that describe
*what kind of data* an asset holds, distinct from *how sensitive* it is (that's a
[sensitivity label](sensitivity-labels.md)). Classifications ground automated
scanning, the governance posture, and Purview alignment.

## What you can do

- **Manage the classification catalog** — add / edit / disable the classification
  categories available to scanners and stewards across the tenant.
- **Align with Purview** — the built-in set mirrors Microsoft Purview's system
  classifications so Loom and Purview speak the same vocabulary; custom entries
  extend it.
- **Drive scanning & posture** — classifications are what automated scans assign
  and what the governance dashboard rolls up.

## Backend

Classifications are stored Azure-natively in Cosmos (tenant-scoped) and are read
by the governance catalog index and the scan pipeline. Where a Microsoft Purview
account is bound, the catalog aligns to Purview's classification rule set; with no
Purview, the Loom-native catalog is fully functional on its own.

## RBAC & honest gates

Tenant-admin / governance-admin. Purview alignment is optional and honest-gated —
absence of a Purview account never blocks the Loom-native catalog.

## Related

- [Sensitivity labels](sensitivity-labels.md) · [Domains](domains.md)
