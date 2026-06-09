# domains — parity with Fabric Admin Domains

Source UI: Fabric Admin portal → **Domains** tab → **Domain settings** side pane
Reference: <https://learn.microsoft.com/fabric/governance/domains#configure-domain-settings>
Also: <https://learn.microsoft.com/fabric/governance/domain-default-sensitivity-label>
Run date: 2026-06-07

Loom surfaces:

- Admin (management): `/admin/domains` → `app/admin/domains/page.tsx`
- Governance (read-only catalog): `/governance/domains` → `app/governance/domains/page.tsx`
- Settings side pane: `lib/panes/domain-settings-pane.tsx`
- Image gallery: `lib/components/domain-image-gallery.tsx` + `lib/components/domain-image-presets.tsx`
- BFF: `app/api/admin/domains/route.ts` (GET/POST/PATCH/DELETE),
  `app/api/admin/domains/assign-workspaces/route.ts`,
  `app/api/admin/domains/images/route.ts`

This surface has **no dependency on real Microsoft Fabric**. All state lives in
the Cosmos `tenant-settings` container (`domains:<tenantId>` doc) and the
`workspaces` container. The optional Purview mirror and MIP sensitivity-label
sources are honest-gated; the full UI renders and saves without either.

## Fabric/Azure feature inventory (grounded in Learn)

1. Domains tab — list all domains (name, image, workspace count)
2. Create new domain dialog — name (mandatory) + domain admins (optional)
3. Domain settings side pane with 6 tabs:
   1. General settings — edit name + description (domain admins: description only)
   2. Image — photo gallery: pick a color or an image to represent the domain
   3. Admins — specify domain admins (Fabric admin only)
   4. Contributors — Everyone (default) / Admins only / Specific users & groups
   5. Default domain — specify users/groups for auto-assignment
   6. Delegated settings — Information protection (default sensitivity label) +
      Certification (override tenant, enable, certifiers, docs URL)
4. New subdomain — name only; subdomains have general settings only and inherit
   the parent domain's admins
5. Assign workspaces — assign by workspace name (multi-select) with an
   **override warning** when a workspace already belongs to another domain;
   assign by workspace admin
6. Domain roles enforced: Fabric/tenant admin vs domain admin (domain admins
   can't rename, can't change admin list, can't delete)
7. Delete domain (Fabric admin)
8. Domain-level default sensitivity label applied to items in assigned
   workspaces (tenant setting–gated, preview in Fabric)

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Domain list (name, image/color, workspace count, contributor scope, parent) | ✅ Built | `GET /api/admin/domains` → Cosmos + workspace COUNT GROUP BY |
| Create new domain (id, name, admins, description, image) | ✅ Built | `POST /api/admin/domains` (+ PATCH for image) |
| Delete domain | ✅ Built | `DELETE /api/admin/domains?id=` |
| Settings side pane (Drawer, 6 tabs) | ✅ Built | `DomainSettingsPane` |
| General tab — edit name + description | ✅ Built | `PATCH /api/admin/domains?id=` |
| General — domain admins edit description only (name disabled) | ✅ Built | PATCH role check (`isTenantAdmin`) |
| Image tab — color swatches (16) | ✅ Built | `imageKey="color::#hex"` → PATCH |
| Image tab — preset department icons (12) | ✅ Built | `imageKey="icon::<key>"` → PATCH |
| Image tab — custom Blob/ADLS image gallery | ✅ Built (⚠️ honest gate) | `GET /api/admin/domains/images` (ADLS data plane); auto-wired from `catalog.bicep` `domainImagesDfsContainerUrl` when Purview/catalog storage is deployed, else gate names `LOOM_DOMAIN_IMAGE_STORAGE` + Storage Blob Data Reader |
| Admins tab — people picker (TagGroup + add) | ✅ Built | `PATCH → admins[]` |
| Admins tab — Fabric-admin-only enforcement | ✅ Built | PATCH rejects name/admins from domain admins (403) |
| Contributors tab — scope selector + specific users | ✅ Built | `PATCH → contributors.{scope,users}` |
| Default domain tab — auto-assign users/groups | ✅ Built | `PATCH → defaultDomainUsers[]` |
| Delegated — default sensitivity label (MIP) | ✅ Built | `GET /api/admin/security/mip/labels` (Graph) + `PATCH → delegatedSettings` |
| Delegated — MIP not-configured gate | ✅ Honest gate | MessageBar → `LOOM_MIP_ENABLED` + Graph AppRole; Loom-native label fallback offered |
| Delegated — Loom-native label fallback source | ✅ Built | `GET /api/admin/sensitivity-labels` (Cosmos) |
| Delegated — certification (override / enable / URL / certifiers) | ✅ Built | `PATCH → delegatedSettings.certification*` |
| New subdomain (general settings only, inherits parent admins) | ✅ Built | `POST` with `parentId`; pane hides non-general tabs; Purview mirror creates a **child collection** under the parent's collection |
| Assign workspaces (multi-select) | ✅ Built | `POST /api/admin/domains/assign-workspaces` |
| Assign workspaces — override warning when already assigned | ✅ Built | `overrideRequired` + `affected[]` → warn → re-POST `allowOverride` |
| Domain roles (tenant admin vs domain admin) enforced | ✅ Built | `isTenantAdmin()` + `admins[]` membership in PATCH |
| Purview collection mirror on **create** | ✅ Built | `createBusinessDomain` (PUT `/collections/{ref}`); root or child collection per `parentId` (honest-gated) |
| Purview collection mirror on **edit** (name/description) | ✅ Built | `updateBusinessDomain` (idempotent PUT `/collections/{ref}`, re-asserts parent) — fired by PATCH, best-effort |
| Purview collection mirror on **delete** | ✅ Built | `deleteBusinessDomain` (DELETE `/collections/{ref}`), best-effort |
| Read-only governance catalog view | ✅ Built | `/governance/domains` over `GET /api/admin/domains` |

Zero ❌ rows. The two ⚠️ honest gates (custom Blob images, MIP labels) each
keep the full surface rendering and offer a working fallback (preset
swatches/icons; Loom-native labels), per `no-vaporware.md` and
`no-fabric-dependency.md`.

## Backend per control

- **List / counts** — `tenantSettingsContainer()` read of `domains:<tenantId>`;
  `workspacesContainer()` `SELECT c.domain, COUNT(1) … GROUP BY c.domain`.
- **Create / patch / delete** — Cosmos read-modify-write of the domains doc;
  Purview mirror is best-effort and never blocks the Cosmos write.
- **Assign workspaces** — `workspacesContainer()` per-workspace read → set
  `domain` → replace; two-phase to detect already-assigned workspaces before
  any write.
- **Custom images** — `adls-client` `getServiceClientFor(account)` +
  `listPaths(recursive)` filtered to image extensions; honest 503-style JSON
  when `LOOM_DOMAIN_IMAGE_STORAGE` unset.
- **Default label** — Microsoft Graph beta `sensitivityLabels` via
  `mip-graph-client.ts` (sovereign base via `LOOM_MIP_GRAPH_BASE`), or the
  Cosmos-backed Loom-native labels.

## Per-cloud notes

| Cloud | Default label (MIP) | Image gallery | Cosmos store | Purview mirror |
|---|---|---|---|---|
| Commercial | Full when `LOOM_MIP_ENABLED=true` (graph.microsoft.com) | Presets always; blobs auto-wired from catalog storage or `LOOM_DOMAIN_IMAGE_STORAGE` | Always | create/update/delete `.purview.azure.com/collections`; UAMI needs Collection Admin (best-effort) |
| GCC | Same Graph endpoint as Commercial | Same | Always | Same `.purview.azure.com` host (best-effort) |
| GCC-High | `LOOM_MIP_GRAPH_BASE=https://graph.microsoft.us` (wired in bicep for GCC-High/IL5) | Presets always; blobs use a GovCloud `*.dfs.core.usgovcloudapi.net` container (auto-wired) | Always | `.purview.azure.us/collections` (best-effort) |
| IL5 | graph.microsoft.us; labels need FedRAMP-approved policies in-tenant | Presets always; blob container stays inside the IL5 boundary (`usgovcloudapi.net`) | Always | `.purview.azure.us/collections` (best-effort) |

## Bicep sync

- New param `loomDomainImageStorage` (default `''`) +
  `LOOM_DOMAIN_IMAGE_STORAGE` env entry in
  `platform/fiab/bicep/modules/admin-plane/main.bicep`. **Precedence:** the
  operator param wins; otherwise it falls back to `catalog.bicep`'s
  auto-provisioned ADLS (DFS) container URL (`domainImagesDfsContainerUrl`), so
  the custom-image gallery is wired with no manual step whenever Purview/catalog
  storage is deployed. Stays unset (honest gate) only when neither is present.
- New `catalog.bicep` outputs: `domainImagesDfsContainerUrl` (the `.dfs.` host +
  `domain-images` container the images route lists against) and
  `consolePurviewCollectionAdminGrant` (post-deploy reminder).
- **Purview Collection Admin** (data-plane metadata-policy role, NOT ARM RBAC) is
  required on the root collection for the create/update/delete collection mirror.
  Granted post-deploy by `csa-loom-post-deploy-bootstrap.yml`
  (`ROLE=collection-administrator` in the grant loop) via
  `scripts/csa-loom/grant-purview-datamap-role.sh`.
- New `LOOM_MIP_GRAPH_BASE=https://graph.microsoft.us` env entry for
  `boundary == 'GCC-High' || 'IL5'` (already-supported override in
  `mip-graph-client.ts`).
- No new Azure resources beyond the existing `catalog.bicep` domain-image
  Storage account + its Storage Blob Data Reader grant: domains use the existing
  `tenant-settings` Cosmos container; workspaces use the existing `workspaces`
  container.

## Verification

- `npx tsc --noEmit` clean on all touched files.
- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — no
  `api.fabric.microsoft.com` / `onelake` call anywhere in this surface.
- Live walk: open `/admin/domains`, create a domain, open its Settings, save on
  each of the 6 tabs (each issues a real `PATCH` → Cosmos), pick a color/icon in
  the Image tab, assign a workspace (and confirm the override warning when it's
  already assigned elsewhere), and confirm `/governance/domains` reflects the
  same data read-only.
