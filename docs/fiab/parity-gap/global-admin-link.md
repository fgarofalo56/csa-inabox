# Global parity gap: Admin link (top-right gear)

**Validated**: 2026-05-26  
**Surface**: Gear icon in top-bar actions, links to `/admin`  
**Component**: AnchorButton in `lib/components/app-shell.tsx`; admin pages under `app/admin/*`  
**Fabric reference**: Fabric admin portal — settings, tenant settings, capacity, domains, audit, usage, users, workspaces  
**Backend probed**: Each admin subpage has BFF route; not validated in detail here (separate admin validator owns this)

## What renders

- `Settings24Regular` icon, `aria-label="Admin and settings"`, `<a href="/admin">`
- Routes to `/admin` overview page
- Loom admin has these subpages (per CommandPalette catalog):
  - `/admin/tenant-settings`
  - `/admin/capacity`
  - `/admin/domains`
  - `/admin/security`
  - `/admin/audit-logs`
  - `/admin/usage`
  - `/admin/users`
  - `/admin/workspaces`

## Note

This surface is **already covered by the admin-portal validator** (`docs/fiab/parity-gap/admin-portal-summary.md` + `admin-*.md`). Not re-grading here. Refer to those docs for verdict.

## Grade: **N/A — out of scope** (see admin validator)
