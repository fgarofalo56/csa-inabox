# Sensitivity labels admin page

> **Surface:** `/admin/sensitivity-labels`
> **BFF:** `apps/fiab-console/app/api/admin/sensitivity-labels/route.ts`

The **Sensitivity labels** page defines the Loom-native classification tags that
mark catalog assets by sensitivity level — the default set being **Restricted**,
**Confidential**, **Internal** and **Public**. Labels drive downstream protection:
they appear in the Create wizard and item Edit dialogs, feed the governance
posture, and can propagate to Microsoft Purview and Power BI.

## What you can do

- **Manage the label taxonomy** — add, rename, reorder, enable/disable the labels
  available across the tenant.
- **Set defaults & order** — control which label is offered first and the
  precedence used when propagating.
- **Connect protection** — labels are the input to DLP, MIP protection, and the
  DSPM-for-AI posture; this page is where the vocabulary is owned.

## Backend

Labels are stored Azure-natively in Cosmos (`tenant-settings` / label
assignments) and applied to items via `item.state.sensitivityLabel`, with an
append-only `label-assignments` audit tier (PK `/tenantId`). Propagation to
Purview asset classifications and to Power BI (Admin `InformationProtection.setLabels`)
is best-effort and honest-gated when those services aren't wired.

## RBAC & honest gates

Tenant-admin / security-admin. Purview / Power BI propagation requires the
respective service to be bound; without it, labels still function inside Loom and
the propagation card shows the exact remediation.

## Related

- [Classifications](classifications.md) · [Domains](domains.md)
- [Security & governance](security/index.md)
