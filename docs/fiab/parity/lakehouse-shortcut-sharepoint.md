# lakehouse-shortcut-sharepoint — parity with Fabric OneLake SharePoint / OneDrive shortcuts

Source UI: Microsoft Fabric — Lakehouse Explorer → **New shortcut → SharePoint /
OneDrive** (Microsoft Graph–backed). Learn:
- https://learn.microsoft.com/fabric/onelake/onelake-shortcuts
- https://learn.microsoft.com/graph/api/resources/onedrive (drives API)
- https://learn.microsoft.com/graph/api/drive-list (sites/drives/items)

CSA Loom delivers this **Azure-native, with NO Fabric dependency** — the
shortcut resolves through the **Microsoft Graph drives API on the Console
UAMI's application token** (Sites.Read.All + Files.Read.All). It never calls
`api.fabric.microsoft.com` / OneLake. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET.

## Fabric feature inventory (every capability)

| # | Fabric capability | Notes |
|---|-------------------|-------|
| 1 | Pick **SharePoint** or **OneDrive** as a shortcut source | Two source cards |
| 2 | **Search / pick a SharePoint site** | Site picker |
| 3 | **Pick a document library (drive)** within the site | Drive list |
| 4 | **Browse the library folders** and select one | Folder tree |
| 5 | **OneDrive**: target a user's drive folder | User + folder |
| 6 | **Name** the shortcut + choose placement (Files section) | Files-only |
| 7 | Shortcut appears under **Files**, zero-copy (no bytes moved) | Registry pointer |
| 8 | **Validate / test** the target is reachable | Live Graph read |
| 9 | **Rename / delete** the shortcut (never deletes source) | Reuses existing grid |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | SharePoint + OneDrive source cards (brand SVG logos) | ✅ built | `SHORTCUT_SOURCE_CARDS`, `ShortcutSourceLogo` |
| 2 | SharePoint site search | ✅ built | `SharePointPicker` → `GET /api/lakehouse/shortcuts/sharepoint?action=sites` |
| 3 | Document-library (drive) picker | ✅ built | `SharePointPicker` → `action=drives` |
| 4 | SharePoint folder tree (lazy, per-level) | ✅ built | `GraphBrowseTree` → `action=items` |
| 5 | OneDrive user + folder tree | ✅ built | `OneDrivePicker` → `action=onedrive` |
| 6 | Name + Files placement | ✅ built | wizard step 3 (Tables disabled — Files-only) |
| 7 | Zero-copy registry pointer (`sharepoint://`/`onedrive://`) | ✅ built | `POST /api/lakehouse/shortcuts` → `bindGraphSource` |
| 8 | Test / reachability | ✅ built | `POST /api/lakehouse/shortcuts/test` → `testGraphTarget` |
| 9 | Rename / delete | ✅ built | existing `ShortcutListGrid` (target-type-agnostic) |
| — | Tables shortcut over a Graph drive | ⚠️ honest-gate | `bindGraphSource` returns `graph_tables_unsupported` (drive content is documents, not a SQL lake — mirror into ADLS first). Matches Fabric, which also exposes SharePoint shortcuts under **Files** only. |
| — | Deployment not wired | ⚠️ honest-gate | 503 naming `LOOM_SHAREPOINT_SHORTCUTS_ENABLED` + the two AppRole grants + consent step |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Site search | `searchSites()` → `GET /v1.0/sites?search=<q>` (Graph) |
| Drive list | `listSiteDrives()` → `GET /v1.0/sites/{id}/drives` |
| SharePoint folder browse | `browseSharePoint()` → `GET /v1.0/drives/{id}/root:/<path>:/children` |
| OneDrive folder browse | `browseOneDrive()` → `GET /v1.0/users/{id}/drive/root:/<path>:/children` |
| Create | `createShortcut()` (Cosmos `lakehouse-shortcuts`) after `testGraphTarget()` live read |
| Test | `testGraphTarget()` → Graph `…/children?$top=1` (401/403 → Broken, 404 → Broken) |
| Delete / rename | existing registry CRUD — never touches the SharePoint/OneDrive source |

Auth: Console UAMI application token, sovereign-correct Graph host
(`getGraphHost()` — Commercial/GCC `graph.microsoft.com`, GCC-High
`graph.microsoft.us`, IL5 `dod-graph.microsoft.us`). AppRoles granted by
`scripts/csa-loom/grant-sharepoint-graph-approles.sh` + tenant admin consent;
documented in bicep by `platform/fiab/bicep/modules/admin-plane/sharepoint-graph-rbac.bicep`.
