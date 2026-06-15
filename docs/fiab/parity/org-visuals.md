# org-visuals — parity with Fabric / Power BI Admin "Organizational visuals"

Source UI: Power BI / Fabric Admin portal → **Tenant settings → Organizational
visuals** (`https://app.powerbi.com/admin-portal/organizationVisuals`). Microsoft
Learn: [Organizational visuals](https://learn.microsoft.com/power-bi/developer/visuals/power-bi-custom-visuals-organization).

Azure-native backing (no Fabric / Power BI workspace): each `.pbiviz` bundle is
stored as a **real Blob** in the DLZ `org-visuals` Blob container; version +
enabled state live in the Cosmos `org-visuals` container.

## Fabric/Power BI feature inventory

| # | Capability (real Admin UI) | Notes |
|---|----------------------------|-------|
| 1 | **Add / upload** a custom visual (`.pbiviz`) | name + version + file |
| 2 | List organizational visuals | name, version, last updated, status |
| 3 | See / set each visual's **version** | semantic version |
| 4 | **Enable / disable** a visual tenant-wide | toggle |
| 5 | **Delete** a visual | removes it tenant-wide |
| 6 | Search / filter the list | by name |
| 7 | **Description** field on a visual | free text shown with the visual |
| 8 | **Icon** for the visualization pane | small image |

## Loom coverage

| # | Capability | Status | Loom surface |
|---|------------|--------|--------------|
| 1 | Upload `.pbiviz` | ✅ built | hidden file input + name + version + Upload → `POST` multipart |
| 2 | List visuals | ✅ built | `LoomDataTable` from `GET /api/admin/org-visuals` |
| 3 | Version | ✅ built | `Badge` version column |
| 4 | Enable/disable tenant-wide | ✅ built | Fluent `Switch` → `PUT ?id=` `{enabled}` |
| 5 | Delete | ✅ built | `DELETE ?id=` → removes blob + Cosmos doc |
| 6 | Search/filter | ✅ built | `Toolbar` search (name/file/version/description/uploader) + per-column filter |
| 7 | Description | ✅ built | optional `Input` → multipart `description` → Cosmos doc; Description column |
| 8 | Icon | ✅ built | optional image picker (≤256 KB) → multipart `icon` → inline `data:` URI on doc; thumbnail column |
| — | Size column | ✅ built | bundle byte size |
| — | Honest infra gate | ⚠️ gate | `NotConfiguredBar` names `LOOM_ORG_VISUALS_URL` + `org-visuals-rbac.bicep` |

Zero ❌. Zero stub banners.

> Parity note: Loom omits Fabric's **AppSource** import path by design
> (Azure-native, no marketplace dependency — and AppSource visuals are
> unsupported in sovereign clouds anyway). Loom defaults a new upload to
> `enabled:false` (safer posture) vs. Fabric's enabled-by-default; the admin
> flips the Switch to publish tenant-wide.

## Backend per control

| Control | Backend |
|---------|---------|
| Upload | `req.formData()` → `adls-client.uploadBlob` (block blob) → Cosmos upsert (enabled=false, optional description + iconDataUri) |
| List | Cosmos `org-visuals` query (PK /tenantId) |
| Enable/disable | Cosmos replace (enabled + enabledAt/By) |
| Delete | `adls-client.deletePath` (blob) → Cosmos item delete |
| Description / Icon | persisted inline on the Cosmos metadata doc (icon as a small `data:` URI, capped 256 KB by the BFF — no second blob / SAS) |

## Per-cloud

| | Commercial | GCC | GCC-High | IL5/DoD |
|-|-----------|-----|----------|---------|
| Blob suffix | `blob.core.windows.net` | `blob.core.windows.net` | `blob.core.usgovcloudapi.net` | `blob.core.usgovcloudapi.net` |
| Block-blob upload | ✅ | ✅ | ✅ | ✅ |
| Fabric/Power BI dependency | none | none | none | none |

## Verification

`npx vitest run lib/clients/__tests__/embed-codes-org-visuals.test.ts` — upload
stores real bytes + writes `enabled=false`; optional description + icon round-trip
onto the metadata doc (and are omitted when not supplied); toggle flips
tenant-wide; delete removes the blob + metadata. With `LOOM_ORG_VISUALS_URL` unset
the route returns a 503 + hint and the pane renders `NotConfiguredBar`. No
`LOOM_DEFAULT_FABRIC_WORKSPACE` required.

## Deploy wiring (deploy-readiness — ON by default, opt-out)

The `org-visuals` Blob container is always created by
`platform/fiab/bicep/modules/landing-zone/storage.bicep` (it is one of the
foundational medallion-account containers). The **grant + env** are governed by
the `loomOrgVisualsEnabled` flag (`main.bicep`, default `true`), threaded to the
admin plane as `loomBackends.orgVisuals` (`'enabled'` → wired; `'disabled'` →
honest-gate) so the admin-plane module stays under the ARM 256-parameter limit.

| Topology | Container grant | `LOOM_ORG_VISUALS_URL` env | Wired by |
|---|---|---|---|
| single-sub | Storage Blob Data Contributor (container) + Storage Blob Delegator (account) | ✅ at deploy time | `admin-plane/main.bicep` → `org-visuals-rbac.bicep` + env block |
| tenant / dlz-attach | container grant via `dlzAttachOrgVisualsRbac` (`main.bicep`) at deploy; Storage Blob Delegator + env wired post-attach | ✅ post-attach | `.github/workflows/csa-loom-post-deploy-bootstrap.yml` "Wire org-visuals" step (mirrors `scripts/csa-loom/patch-navigator-env.sh`) |
| disabled (`loomOrgVisualsEnabled=false`) | skipped | omitted → `NotConfiguredBar` | — |

**Scan-and-choose** (deploy-readiness): both the CLI
(`scripts/csa-loom/scan/storage.sh` — use-existing / provision-new / disable,
recommendation **provision-new**) and the Setup Wizard (`/setup` review step →
`/api/setup/existing-storage` discovery) offer the same three-way choice. The
medallion lake is always provisioned; only the org-visuals grant + env is
optional. Storage Blob Delegator role = `db58b8e5-c6ad-4a2a-8342-4190687cbf4a`
(validated against `az role definition list`).

