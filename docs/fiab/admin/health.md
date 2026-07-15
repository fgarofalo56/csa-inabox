# Health & self-audit admin page

> **Surface:** `/admin/health`
> **BFF:** `apps/fiab-console/app/api/admin/health/{route.ts,exercise}` + `/api/health/deep`

The **Health & self-audit** page is the console's self-review: it probes
identity, the data plane, backing Azure services, permissions and security
posture, and offers a **one-click healer** (admin-approved) for the issues it can
safely fix. It answers "is this deployment wired correctly right now" without the
operator hand-checking each service.

## What you can do

- **Run a self-audit** — probes the Console UAMI's identity, Cosmos / Synapse /
  ADX / AOAI reachability, RBAC grants, and the security posture, reporting each
  as pass / warn / fail with the exact remediation.
- **Service exercise** — `/api/admin/health/exercise` drives every backend once
  (a real round-trip per service) so "green" means genuinely working, not merely
  configured.
- **One-click heal** — for fixable findings (a missing role grant, an empty env
  var), the healer applies the fix on explicit admin approval and re-checks.

## Backend

| Control | Backend |
|---|---|
| Reachability | `/api/health/deep` — bounded probes (Cosmos `getDatabaseAccount`, etc.) |
| Service exercise | Real per-service data-plane round-trips |
| Heal actions | Scoped ARM / RBAC / env-config writes as the Console UAMI (admin-gated) |

## RBAC & honest gates

Tenant-admin. Every heal action is admin-approved and audited; a finding the
healer can't safely fix is shown with the manual step rather than auto-applied.

## Related

- [Feature permissions](feature-rbac.md) · [Scale by SKU](scaling.md) · [Runtime configuration](tenant-settings.md)
