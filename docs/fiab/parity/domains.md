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

---

## Unified domain mapping + MOVE + Unity Catalog (audit-t140, 2026-06-11)

A Loom domain is now **one concept written through to BOTH Azure-native
governance back-ends in parallel** by `lib/azure/unified-domain-mapper.ts`,
with full CRUD **+ reparent (MOVE)** surfaced on the editable
`/catalog/domains` page (and the Move action on `/admin/domains`). Cosmos
remains authoritative; both mirrors are best-effort and independently optional —
**no Microsoft Fabric / Power BI dependency on any path**.

| Capability | Status | Backend |
|---|---|---|
| Loom domain ⇄ **Purview collection**; subdomain ⇄ **child collection** | ✅ Built | `createBusinessDomain`/`updateBusinessDomain`/`deleteBusinessDomain` (PUT/DELETE `/collections/{ref}`), guarded by `isPurviewConfigured()` |
| Loom root domain ⇄ **Unity Catalog catalog**; subdomain ⇄ **UC schema** | ✅ Built | `createUcCatalog`/`createUcSchema` + `patchUcCatalog`/`patchUcSchema` + `deleteUc*`, guarded by `databricksConfigGate()` |
| **MOVE / reparent** a domain or subdomain | ✅ Built | `PATCH /api/admin/domains?id=` body `{parentId}` → Cosmos reparent + Purview collection reparent. The governance store path (`PATCH /api/governance/domains/[id]` body `{parentDomainId}` → `getDomainsStore().moveDomain`) enforces the **same** invariants via the shared `validateDomainMove` helper (`lib/azure/domain-hierarchy.ts`) |
| **Governance Cosmos store** (`/api/governance/domains`) dual write-through | ✅ Built | `cosmosDomainStore` (`lib/azure/domains-client.ts`) now routes create/update/move/delete through the **same** `unified-domain-mapper` (`mirrorDomainUpsert`/`mirrorDomainMove`/`mirrorDomainDelete`) as `/api/admin/domains` — so it mirrors to **BOTH** Purview AND Unity Catalog and persists `unityCatalogName`/`unitySchemas` (it previously mirrored Purview only, despite `LoomDomain` declaring the UC fields). Reconciliation closed the gap where the type promised a UC mirror the store never wrote |
| MOVE in Unity Catalog | ⚠️ Honest note | UC has **no** move (catalog is top-level; a schema can't change catalogs) — mapper returns `unity.moveSupported=false`, the UC mapping is unchanged (never faked) |
| Edit collections + sub-collections (add / rename / re-describe) | ✅ Built | POST/PATCH route + `/catalog/domains` Add / New subdomain / Edit dialogs |
| UC catalog/schema **rename** through the BFF | ✅ Built | `PATCH /api/databricks/unity-catalog/catalogs` & `…/schemas` now accept `new_name` → `patchUc*` (`UcMetadataPatch.new_name`) |
| Per-domain Purview + Unity link badges | ✅ Built | `GET /api/admin/domains` returns `purviewLinked` + `unityLinked` via `unityLinkStatus(domainCatalogs)` — schema-list fan-out is now scoped to the catalogs the tenant's domains map to (no per-load N+1 against the metastore) |
| Domains **no longer empty** (fresh tenant) | ✅ Built | `loadOrSeed` seeds a starter set (Finance / Sales & Marketing / Operations + People subdomain) — REAL editable Cosmos domains, not placeholders |
| Two-level hierarchy enforced (domain → subdomain) | ✅ Built | Shared `validateDomainMove` — POST + BOTH move paths reject nesting under a subdomain, self-parenting, a non-existent target parent, cycles, and moving a domain that itself has subdomains; DELETE rejects a parent that still has subdomains |
| Move authorization (tenant-admin only) | ✅ Built | BOTH `PATCH /api/admin/domains` and `PATCH /api/governance/domains/[id]` reject `parentId`/`parentDomainId` from non-tenant-admins (403) via the shared `isDomainTenantAdmin` |

### Move depth/cycle rules (grounded)

Unity Catalog is a fixed three-level namespace `catalog.schema.table`; a catalog
has no parent and a schema cannot change catalogs (Learn: UC securable-objects).
Fabric "subdomains have general settings only" (one level of nesting). So Loom
caps the domain tree at **two levels** and rejects: self-parenting, a parent
that is itself a subdomain, a non-existent target parent, a cycle (moving a
domain under one of its own descendants), moving a domain that has subdomains,
and deleting a domain that still has subdomains. These checks live in ONE shared
helper (`validateDomainMove`) so the admin tenant-settings path and the
governance Cosmos-store path (`cosmosDomainStore.moveDomain`) enforce identical
invariants — neither can corrupt the tree the unified mapper's
root-vs-subdomain (catalog-vs-schema) determination depends on.

### Per-cloud (unified mapper)

| Cloud | Purview collection mirror | Unity Catalog mirror | Move |
|---|---|---|---|
| Commercial / GCC | `.purview.azure.com/collections` (UAMI Collection Admin) | `LOOM_DATABRICKS_HOSTNAME` workspace; UAMI needs CREATE CATALOG on the metastore | Cosmos + Purview reparent; UC `moveSupported=false` |
| GCC-High | `.purview.azure.us/collections` | Same (Gov Databricks workspace) | Same |
| IL5 | `.purview.azure.us/collections` | Same; `LOOM_DOMAINS_BACKEND=fabric` throws `DomainsBackendGateError` (Fabric Admin not IL5) | Cosmos authoritative; never Fabric |

### Bicep sync (audit-t140)

No new env vars or resources. The unified mapper keys entirely off the three
existing gates already wired in `admin-plane/main.bicep`:
`LOOM_PURVIEW_ACCOUNT`, `LOOM_DATABRICKS_HOSTNAME`, `LOOM_DOMAINS_BACKEND`.
UC catalog rename/create additionally needs the console UAMI to hold
`CREATE CATALOG` / `MANAGE` on the Unity Catalog metastore (a Databricks-side
grant, not ARM RBAC) — surfaced as an honest note, never a Fabric requirement.

### Verification (audit-t140)

- `npx tsc --noEmit` clean on all touched files (run in the worktree).
- Vitest: `unified-domain-mapper.test.ts` (7); `domain-hierarchy.test.ts` (10,
  the shared move-guard + tenant-admin invariants); extended
  `domains-client.test.ts` (21 — `moveDomain` Cosmos + Purview reparent, Fabric
  501 gate, self-parent / missing-parent / cycle / nest-under-subdomain /
  parent-with-subdomains rejections, **plus the reconciled dual write-through:
  root → UC catalog, subdomain → UC schema, `unityCatalogName`/`unitySchemas`
  persisted, independent Purview/UC gating, both-unconfigured skip, and
  move = Purview-reparent-only / no UC move**); `admin/domains/route.test.ts`
  (11 — move + cycle/depth/own-parent/parent-with-kids rejections; mirror
  response shape); `governance/domains/[domainId]/route.test.ts` (4 — non-admin
  reparent → 403, admin reparent delegated, guard 400 surfaced, non-move update
  allowed). All green.
- Both back-ends unconfigured → mapper persists to Cosmos and reports
  `skipped:true` for each mirror (never throws) — proven by test on BOTH the
  `/api/admin/domains` path and the reconciled `cosmosDomainStore` path.

