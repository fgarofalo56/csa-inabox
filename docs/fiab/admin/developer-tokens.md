# API tokens (developer) admin page

> **Surface:** `/admin/developer/tokens`
> **Store:** Cosmos `loom-pat-tokens` (PK `/id`) — stores a **SHA-256 hash** of the secret only

The **API tokens** page is the tenant-wide inventory of scoped API tokens (PATs)
used for non-interactive access to the Loom API — who created each token, its
scope, last-used and expiry — with immediate revocation. (Individual users create
and manage their own tokens under **Settings → Developer**; this admin view is
the tenant-wide governance surface.)

## What you can do

- **Inventory** — every PAT in the tenant with creator, scope
  (read-only / read-write / admin), last-used and expiry.
- **Revoke** — invalidate any token immediately; the next request bearing it is
  rejected.
- **Audit** — see the scope each token was minted with and whether it's expired.

## Backend

| Control | Backend |
|---|---|
| Token registry | Cosmos `loom-pat-tokens` (PK `/id`) — point-read on every non-interactive request |
| Secret storage | **Only a SHA-256 hash** of the secret is stored — never the token itself |
| Enforcement | The API guards downgrade a PAT caller to the token's scope + block token-minting / admin unless admin-scoped |

## RBAC & honest gates

Tenant-admin. Because only a hash is stored, a leaked registry row can't be
replayed as a token; a revoked token is rejected on its next use.

## Related

- [Feature permissions](feature-rbac.md) · [Users & licenses](users.md)
