# Updates & version sync admin page

> **Surface:** `/admin/updates`
> **BFF:** `apps/fiab-console/app/api/admin/updates/{route.ts,apply}`

The **Updates & version sync** page shows your running version against the latest
upstream and lets an operator pull bug fixes and new features — the in-console
path to keep a deployment current without hand-rolling container images.

## What you can do

- **Compare versions** — your running console/app image tags vs. the latest
  published upstream, with the changes in between.
- **Apply an update** — `/api/admin/updates/apply` rolls the Container Apps onto
  the newer image(s) after a preflight check; a `PreflightGate` blocks the apply
  with a precise reason when a prerequisite is missing (registry access, image
  not yet built).

## Backend

| Control | Backend |
|---|---|
| Version compare | Running ACA image tags vs. the published registry tags |
| Apply | ARM `Microsoft.App/containerApps` revision roll onto the new image |
| Preflight | Registry reachability + image-exists checks (honest gate on failure) |

Consistent with the two-phase image path, an apply expects the target image to
already exist in the registry; when it doesn't, the preflight gate says so rather
than rolling onto a missing tag.

## RBAC & honest gates

Tenant-admin, with the Console UAMI holding **Contributor** on the Container Apps
and **AcrPull** on the registry. The preflight gate surfaces the exact missing
prerequisite instead of a failed roll.

## Related

- [Runtime configuration](tenant-settings.md) · [Health & self-audit](health.md)
