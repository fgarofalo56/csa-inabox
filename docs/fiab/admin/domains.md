# Domains admin page

> **Surface:** `/admin/domains`
> **BFF:** `apps/fiab-console/app/api/admin/domains/{route.ts,[id],assign-workspaces,mesh,purview-status,sync}`
> **Store:** Cosmos `governance-domains` (PK `/tenantId`)

The **Domains** page organizes workspaces into business **domains and
subdomains** — the Azure-native parity of Microsoft Fabric domains and the
backbone of data-mesh governance in Loom. Domains drive the `loom-domain` tag used
by [chargeback](chargeback.md), scope governance roles, and (optionally) mirror to
a Microsoft Purview collection.

## What you can do

- **Create domains & subdomains** — a hierarchy of business domains; each becomes
  a governance + chargeback boundary.
- **Assign workspaces** — `/api/admin/domains/assign-workspaces` binds workspaces
  to a domain (and stamps the `loom-domain` tag on their Azure resources).
- **Mesh view** — `/api/admin/domains/mesh` renders the domain graph (the
  federated-mesh topology).
- **Purview sync** — `/api/admin/domains/{sync,purview-status}` mirrors domains to
  a Purview classic collection when Purview is wired; best-effort, and honest-gated
  when it isn't.
- **Branding** — per-domain images (`/api/admin/domains/images`).

## Backend

| Control | Backend |
|---|---|
| Domain hierarchy | Cosmos `governance-domains` (PK `/tenantId`) |
| Workspace binding | Cosmos + ARM resource tag `loom-domain` |
| Purview mirror | Purview classic Data Map collections (opt-in, best-effort) |

## RBAC & honest gates

Tenant-admin / governance-admin. The Purview mirror is optional: with no Purview
account bound, domains still function fully (Cosmos is the source of truth) and the
sync card shows the honest "wire a Purview account" gate.

## Related

- [Chargeback report](chargeback.md) — spend by domain.
- [Classifications](classifications.md) · [Sensitivity labels](sensitivity-labels.md)
