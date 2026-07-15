# Usage metrics admin page

> **Surface:** `/admin/usage`
> **BFF:** `apps/fiab-console/app/api/admin/usage/{route.ts,embed}`

The **Usage metrics** page is the feature-usage & adoption report for the tenant:
which features are used, the item inventory, and per-item detail — the operator's
view of how the estate is actually being used, the Azure-native parity of the
Fabric feature-usage / adoption reports.

## What you can do

- **Adoption report** — feature usage and adoption trends across the tenant.
- **Item inventory** — every item by type, workspace and owner, with counts.
- **Item details** — drill into a specific item's usage and metadata.
- **Embed** — `/api/admin/usage/embed` provides a signed, embeddable view of the
  report for sharing.

## Backend

| Control | Backend |
|---|---|
| Adoption + inventory | Aggregations over the Cosmos `items` catalog + activity telemetry |
| Embed | Signed, read-only embed URL (Azure-native, no Fabric workspace) |

Numbers are real reads over the tenant's items and telemetry — no fabricated
adoption figures.

## RBAC & honest gates

Tenant-admin. Telemetry-derived panels honest-gate to "no data in range" rather
than inventing usage when the telemetry source isn't populated.

## Related

- [Workspaces](workspaces.md) · [Copilot usage](copilot-usage.md)
