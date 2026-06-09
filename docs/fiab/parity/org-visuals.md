# org-visuals — parity with Power BI Organizational visuals + tenant branding

Source UI: Power BI Admin → **Organizational visuals**; tenant theme / branding
Reference: <https://learn.microsoft.com/power-bi/admin/organizational-visuals>
Run date: 2026-06-09

Loom surfaces:

- Tenant theme BFF: `app/api/tenant-theme/route.ts` (GET/PUT
  `{ accent, brandName, logoUrl }`)
- Theme bridge: `lib/components/tenant-theme-bridge.tsx` → injects CSS vars
  `--loom-tenant-accent`, `--loom-tenant-brand`, `--loom-indigo-700` on `:root`
- Domain imagery: `lib/components/domain-image-gallery.tsx` +
  `lib/components/domain-image-presets.tsx`
- Store: Cosmos `tenant-themes` (PK `/tenantId`)

> **Scope note:** Fabric/Power BI "Organizational visuals" specifically manages
> custom `.pbiviz` visual packages. Loom's built org-branding surface is
> **tenant theme + domain imagery** (Loom-native). Custom `.pbiviz` management is
> a Power-BI-tenant feature and is disclosed as an honest gate.

This surface is **Loom-native** Cosmos state. There is **no dependency on real
Microsoft Fabric** — branding renders and saves with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Apply org-wide branding (accent color, name, logo)
2. Per-domain visual identity (color / icon / image)
3. Upload + manage custom organizational visuals (`.pbiviz`)

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Tenant accent-colour override | ✅ Built | `PUT /api/tenant-theme` body.accent `#RRGGBB` → Cosmos `tenant-themes`; `TenantThemeBridge` injects `--loom-tenant-accent` |
| Tenant brand-name override | ✅ Built | `PUT …` body.brandName → `--loom-tenant-brand` + `document.title` |
| Tenant logo-URL override | ✅ Built | `PUT …` body.logoUrl → Cosmos |
| Domain colour swatches (16 presets) | ✅ Built | `DomainImagePresets` → `PATCH /api/admin/domains?id=` `imageKey="color::#hex"` |
| Domain icon presets (12 department icons) | ✅ Built | `DomainImagePresets` → `imageKey="icon::<key>"` |
| Domain custom blob image upload | ✅ Built (⚠️ honest gate) | `GET /api/admin/domains/images` → ADLS data plane; gate names `LOOM_DOMAIN_IMAGE_STORAGE` + Storage Blob Data Reader |
| Custom org Power BI visuals (`.pbiviz` upload + management) | ⚠️ Honest gate | Not built; Fabric `POST /admin/organizational-visuals` REST not wired. Disclosed as a tracked Power-BI-tenant feature; tenant + domain branding deliver the org-identity parity today. |

Zero ❌ rows. The two ⚠️ gates (custom blob images, custom `.pbiviz`) keep the
full branding surface rendering — preset swatches/icons cover the no-blob case,
and tenant/domain theming covers the org-identity case, per `no-vaporware.md`.

## Backend per control

- **Tenant theme** — `GET/PUT /api/tenant-theme` read-modify-writes the
  `tenant-themes` Cosmos doc; `TenantThemeBridge` reads it on mount and injects
  the accent / brand CSS variables on `:root` plus sets `document.title`.
- **Domain imagery** — preset colours/icons PATCH the domain doc's `imageKey`
  (`color::#hex` / `icon::<key>`); custom images come from the ADLS data plane via
  `GET /api/admin/domains/images`, honest-gated on `LOOM_DOMAIN_IMAGE_STORAGE`.
- **`.pbiviz`** — not wired; honest gate only.

## Per-cloud notes

| Cloud | Domain custom-image storage |
|---|---|
| Commercial / GCC | `*.dfs.core.windows.net` when `LOOM_DOMAIN_IMAGE_STORAGE` set; presets always |
| GCC-High / IL5 | `*.dfs.core.usgovcloudapi.net` container inside the boundary; presets always |

Tenant accent / brand / logo are cloud-agnostic Cosmos state.

## Bicep sync

- No new resource — `tenant-themes` Cosmos container via existing init; domain
  imagery reuses the `loomDomainImageStorage` param + `LOOM_DOMAIN_IMAGE_STORAGE`
  env already wired for the domains surface.
- No new role grant beyond the existing Storage Blob Data Reader for the
  (optional) domain-image storage account.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Live walk: open the tenant-theme settings, change the accent colour + brand
  name + logo URL (real PUT → Cosmos), confirm `--loom-tenant-accent` updates the
  UI and the document title changes; in a domain's settings pick a colour swatch
  and an icon preset (PATCH → domain doc), and confirm the custom-image gallery
  honest-gates when `LOOM_DOMAIN_IMAGE_STORAGE` is unset.

Grade: **B+** — tenant + domain branding fully built on real Cosmos (+ optional
ADLS images); custom `.pbiviz` management is the single honest deferred gate.
