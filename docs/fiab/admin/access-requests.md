# Access requests admin page

> **Surface:** `/admin/access-requests`
> **BFF:** `apps/fiab-console/app/api/admin/access-requests/{route.ts,[id]}`
> **Store:** Cosmos `signin-access-requests` (PK `/tenantId`)

The **Access requests** page is the onboarding queue for people who don't yet
have access. When someone hits the sign-in boundary and submits a "Request
access", it lands here; an admin approves it — and sees the exact Entra step to
set the person up — or denies it with a recorded reason.

## What you can do

- **Review the queue** — every sign-in-boundary "Request access" submission with
  the requester's identity and message.
- **Approve** — `/api/admin/access-requests/[id]` marks the request approved and
  surfaces the precise Entra action (invite guest / assign group / license) to
  actually grant access.
- **Deny** — record a reason; the requester's submission is closed with an audit
  trail.

## Backend

| Control | Backend |
|---|---|
| Queue | Cosmos `signin-access-requests` (PK `/tenantId` — the deployment bucket) |
| Approve / deny | State transition + audit; the actual grant is the named Entra step |

This is distinct from the two data-plane access-request systems (marketplace
subscribe and the F16 asset-access workflow) — this queue is specifically the
front-door sign-in boundary.

## RBAC & honest gates

Tenant-admin. Approval does not silently mint access; it records the decision and
tells the admin the exact directory action to perform (honest, no hidden grant).

## Related

- [Users & licenses](users.md) · [Feature permissions](feature-rbac.md)
