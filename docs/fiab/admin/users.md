# Users & licenses admin page

> **Surface:** `/admin/users`
> **BFF:** `apps/fiab-console/app/api/admin/users/route.ts`

The **Users & licenses** page is the tenant-wide inventory of people and their
Power BI / Fabric license assignments — who is in the tenant, what license each
holds, and their activity — so an admin can manage entitlements from inside Loom.

## What you can do

- **User inventory** — list tenant users with their UPN, role and license state.
- **License assignments** — see Power BI / Fabric license SKUs per user (Free,
  Pro, PPU, Premium capacity access).
- **Drill in** — open a user for their workspace memberships and recent activity.

## Backend

The route reads users and their license assignments via Microsoft Graph / the
Power BI admin APIs as the Console UAMI (or the signed-in admin via OBO). No
synthetic roster — an empty result means "no users returned by Graph", surfaced
honestly rather than as a fabricated list.

## RBAC & honest gates

Requires the caller to hold a Graph directory-read role (and Power BI Admin for
license detail). Missing rights render the honest remediation text; the page
never invents users or licenses.

## Related

- [Feature permissions](feature-rbac.md) · [Workspaces](workspaces.md) · [Access requests](access-requests.md)
