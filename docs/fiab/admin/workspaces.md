# Workspaces admin page

> **Surface:** `/admin/workspaces`
> **BFF:** `apps/fiab-console/app/api/admin/workspaces/{route.ts,[id]}`
> **Store:** Cosmos `loom-workspaces` (PK `/tenantId`)

The **Workspaces** page is the tenant-wide inventory of every Loom workspace —
owner, bound capacity, state and item counts — the operator's single list for
governing the estate.

## What you can do

- **Inventory** — list every workspace with owner, capacity binding and state.
- **Inspect a workspace** — `/api/admin/workspaces/[id]` opens the details: bound
  storage / capacity, member roles, and the items it holds.
- **Govern** — jump from a workspace to its permissions, domain assignment, and
  landing-zone binding.

## Backend

| Control | Backend |
|---|---|
| Workspace catalog | Cosmos `loom-workspaces` (PK `/tenantId`) |
| Per-workspace detail | Cosmos `workspaces` + `items` + `workspace-roles` |

The list is a real Cosmos read scoped to the tenant; a cross-partition admin read
resolves workspaces the admin doesn't personally own (owner-first, admin
fallback), never a blanket cross-tenant scan.

## RBAC & honest gates

Tenant-admin. Non-admins see only workspaces they own or are shared into (the
`workspace-roles` ACL); existence of others is not leaked.

## Related

- [Feature permissions](feature-rbac.md) · [Users & licenses](users.md) · [Landing zones](landing-zones.md)
