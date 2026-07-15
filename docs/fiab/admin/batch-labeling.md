# Batch labeling admin page

> **Surface:** `/admin/batch-labeling`
> **BFF:** `apps/fiab-console/app/api/admin/batch-labeling/route.ts`

The **Batch labeling** page bulk-applies sensitivity labels to many catalog items
at once — and, optionally, propagates them to Microsoft Purview asset
classifications and to Power BI via the Admin `InformationProtection.setLabels`
API. It's the "label the estate in one pass" tool, versus labelling items one at
a time.

## What you can do

- **Select a scope** — filter the catalog (by type, workspace, domain, current
  label) and pick the items to label.
- **Apply a label** — set one sensitivity label across the whole selection in a
  single operation; the change is recorded in the append-only label-assignments
  audit tier.
- **Propagate (optional)** — push the labels to Purview asset classifications and
  to Power BI datasets/reports where those services are wired.

## Backend

| Control | Backend |
|---|---|
| Bulk apply | Writes `item.state.sensitivityLabel` + Cosmos `label-assignments` (PK `/tenantId`) |
| Purview propagation | Purview Data Map classification write (best-effort) |
| Power BI propagation | Admin `InformationProtection.setLabels` (best-effort) |

## RBAC & honest gates

Tenant-admin / security-admin. Propagation to Purview / Power BI is optional and
honest-gated — without those services bound, the Loom-native labels still apply
and the propagation step shows the exact remediation.

## Related

- [Security & governance](security/index.md) — the label + protection surfaces.
