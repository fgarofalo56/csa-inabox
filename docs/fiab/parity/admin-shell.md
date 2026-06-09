# admin-shell — parity with Fabric Admin center chrome

Source UI: Fabric **Admin center** left-rail + portal shell
Reference: <https://learn.microsoft.com/fabric/admin/admin-center>
Run date: 2026-06-09

Loom surfaces:

- Shell component: `lib/components/admin-shell.tsx` → `AdminShell`, `SECTIONS[]`
- Page wrapper: `PageShell` (title + subtitle)
- Persistence: `localStorage` key `loom-admin-nav-collapsed`

This is **Loom-native platform chrome** — there is no Azure/Fabric REST behind
the shell itself; it is the navigation frame the admin surfaces mount into. It
has **no dependency on real Microsoft Fabric** and renders identically with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Persistent left navigation rail listing every admin area
2. Collapse / expand the rail to reclaim horizontal space
3. Active-area highlight reflecting the current route
4. Hover affordance (label + description) when collapsed
5. Page title + subtitle header per area

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Collapsible left-rail sidebar (248px ⇄ 52px) with expand/collapse toggle | ✅ Built | `PanelLeftContract24Regular` / `PanelLeftExpand24Regular` Fluent buttons |
| Collapse state persisted across reloads | ✅ Built | `localStorage` key `loom-admin-nav-collapsed` |
| 17-section nav (Health, Tenant settings, Capacity, Scale by SKU, API Management, Domains, Custom attributes, Deployment planner, Security, Permissions, Batch labeling, Audit logs, Usage, Users, Workspaces, Network, Updates) | ✅ Built | `SECTIONS[]` in `admin-shell.tsx` |
| Active-section highlight (exact route match) | ✅ Built | `usePathname()` → `colorBrandBackground2` token |
| Tooltip per nav item (label + description, surfaced in collapsed mode) | ✅ Built | Fluent `Tooltip positioning="after"` |
| Page title + subtitle header | ✅ Built | `PageShell` wrapper |

Zero ❌ rows. No ⚠️ gates — the shell is pure client chrome with no backend
dependency, so there is nothing to gate.

## Backend per control

- **All controls** — client-only React + Fluent v9 + Loom design tokens. No
  network calls originate from the shell; each `SECTIONS[]` entry is a Next.js
  route link, and the mounted page owns its own BFF calls. The shell's only
  persisted state is the boolean collapse flag in `localStorage`.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial | Identical |
| GCC | Identical |
| GCC-High | Identical |
| IL5 | Identical |

The shell is cloud-agnostic. Whether the console runs on Azure Container Apps
(Commercial/GCC) or AKS (`containerPlatform=aks`, GCC-High/IL5) does not affect
the navigation chrome.

## Bicep sync

No Azure resources, env vars, or role grants. The shell is bundled in the
`fiab-console` image and ships with every boundary's deployment.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — no Fabric /
  OneLake call anywhere in this surface.
- Live walk: open any `/admin/*` route, toggle the rail collapse button and
  confirm the 52px collapsed rail shows tooltips on hover and that the
  collapse state survives a page reload; confirm the active section is
  highlighted for each of the 17 entries.

Grade: **A** — full inventory built; no Azure-parity gap because this is
Loom-native chrome, not a mirror of an Azure data surface.
