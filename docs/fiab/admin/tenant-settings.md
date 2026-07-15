# Tenant settings admin page

> **Surface:** `/admin/tenant-settings`
> **BFF:** `apps/fiab-console/app/api/admin/tenant-settings/{route.ts,groups}`
> **Store:** Cosmos `tenant-settings` (PK `/tenantId`)

The **Tenant settings** page is the master switchboard for the per-area feature
switches that shape the whole deployment — Power BI, Fabric, OneLake, Real-Time,
AI, Mirroring and Git — the Azure-native parity of the Fabric admin tenant
settings.

## What you can do

- **Per-area switches** — enable/disable each capability area for the tenant.
- **Scope to security groups** — `/api/admin/tenant-settings/groups` restricts a
  setting to specific Entra security groups (delegated enablement).
- **Durable desired state** — every change is written to the Cosmos
  `tenant-settings` doc and read by the BFF's feature gates on the next request.

## Backend

| Control | Backend |
|---|---|
| Feature switches | Cosmos `tenant-settings` (PK `/tenantId`) |
| Group scoping | Entra security-group membership check at gate time |

Per the default-ON principle most areas ship enabled with an admin opt-out; there
are no spend gates. Fabric-backed areas are the sole opt-in exception (Loom
defaults to the Azure-native backend).

## RBAC & honest gates

Tenant-admin only. A setting that depends on an unprovisioned service still saves
here; the dependent surface shows its own honest gate until the service is wired.

## Related

- [Feature permissions](feature-rbac.md) · [Health & self-audit](health.md)
