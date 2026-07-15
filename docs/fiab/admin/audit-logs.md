# Audit logs admin page

> **Surface:** `/admin/audit-logs`
> **BFF:** `apps/fiab-console/app/api/admin/audit-logs/route.ts`

The **Audit logs** page surfaces Microsoft 365 / unified audit-log activity for
Loom and Fabric operations — who did what, when, and to which asset — so an
operator can review administrative and data-plane actions from inside the console
instead of the Purview / Microsoft 365 compliance portal.

## What you can do

- **Browse activity** — filter the unified audit log by date range, actor,
  operation and workspace.
- **Inspect a record** — expand any entry for the full operation detail
  (actor UPN, client, target object, result).
- **Export** — pull the filtered window for offline review / evidence.

## Backend

The route reads the Microsoft 365 unified audit log via the Office 365
Management / Purview audit API as the Console UAMI. Loom's own administrative
actions (env-config changes, RBAC grants, healer runs) are additionally recorded
in the Cosmos `audit-log` container so they appear even before the M365 log
indexes them.

## RBAC & honest gates

Requires the Console UAMI (or the signed-in admin, via OBO) to hold the
**View-Only Audit Logs** / **Audit Logs** role and audit logging to be enabled on
the tenant. When auditing isn't enabled or the role is missing, the page shows an
honest `MessageBar` naming the exact admin action to take, rather than an empty
grid that looks like "no activity".

## Related

- [Security & governance](security/index.md) · [Feature permissions](feature-rbac.md)
