# lakehouse-shortcuts-sharepoint — parity with Microsoft Fabric OneLake "OneDrive / SharePoint" shortcut

Source UI: Fabric Lakehouse → Get data → New shortcut → **OneDrive / SharePoint**
- Learn: https://learn.microsoft.com/fabric/onelake/onelake-shortcuts
- Graph data plane: https://learn.microsoft.com/graph/api/resources/onedrive
- Graph DriveItem children: https://learn.microsoft.com/graph/api/driveitem-list-children

CSA Loom surface: Lakehouse editor → **Shortcuts** tab → New shortcut → **SharePoint / OneDrive**
(`apps/fiab-console/lib/components/onelake/shortcut-wizard.tsx` `SharePointBrowser`
+ `apps/fiab-console/lib/editors/lakehouse-editor.tsx` wizard step 2).

## Azure/Fabric feature inventory

In Fabric, a OneDrive/SharePoint OneLake shortcut surfaces a SharePoint document
library folder/file (or a OneDrive item) zero-copy under the lakehouse **Files**
section. Fabric resolves it through **Microsoft Graph**. Capabilities exposed:

1. Choose a **SharePoint site** (search by name) — pick the site that holds the
   document library.
2. Choose the **document library (drive)** on that site.
3. Alternatively browse **your OneDrive**.
4. **Browse the folder tree** inside the drive and select a folder/file.
5. Create the shortcut by **pasting a sharing link** to a folder/file.
6. Name + place the shortcut under Files; it appears in the Explorer.
7. The shortcut is a **zero-copy pointer** (no bytes copied); reads are resolved
   live via Graph on the connection identity.
8. **Test / refresh** reachability (Fabric shows broken shortcuts when the source
   moves or access is lost).
9. SharePoint/OneDrive shortcuts are **Files-only** (document/file content, not a
   tabular external table).

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | SharePoint site search | ✅ built | `GET /sites?search=` via `searchSites()` |
| 2 | Pick document library (drive) | ✅ built | `GET /sites/{id}/drives` via `listSiteDrives()` |
| 3 | Browse OneDrive | ✅ built | `GET /users/{me}/drives` via `listUserDrives()` |
| 4 | Folder-tree browse + select | ✅ built | `GET /drives/{id}/root[:/path:]/children` via `listDriveChildren()` |
| 5 | Create from a pasted link | ✅ built | `GET /shares/{enc}/driveItem` via `resolveSharingUrl()` |
| 6 | Name + place under Files | ✅ built | wizard step 3 (Section locked to Files) |
| 7 | Zero-copy pointer | ✅ built | registry row `targetType:'sharepoint'`, `targetUri sharepoint://<driveId>/<path>`; Graph read-through, no copy |
| 8 | Test / refresh | ✅ built | `POST /api/lakehouse/shortcuts/test` → `headDriveItem()` re-read |
| 9 | Files-only enforcement | ✅ built | `createTablesShortcut` honest-gates `sharepoint_files_only`; UI locks Section=Files |
| — | No-Fabric default | ✅ built | Microsoft Graph on the Console UAMI; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET |
| — | Honest infra gate | ⚠️ honest-gate | when `LOOM_SHAREPOINT_SHORTCUTS_ENABLED` unset / AppRoles unconsented → 503 with exact remediation (no mock data) |
| — | Sovereign clouds | ✅ built | Graph base + token scope derive from `LOOM_GRAPH_BASE` (graph.microsoft.us / dod-graph.microsoft.us) |

Zero ❌. The only non-functional state is the documented honest gate.

## Backend per control

| Control | Backend call |
|---------|--------------|
| Site search | `GET {graph}/v1.0/sites?search=<q>` (app-only, `Sites.Read.All`) |
| Site drives | `GET {graph}/v1.0/sites/{siteId}/drives` |
| OneDrive | `GET {graph}/v1.0/users/{upn}/drives` |
| Folder browse | `GET {graph}/v1.0/drives/{id}/root/children` and `…/root:/{path}:/children` |
| Resolve link | `GET {graph}/v1.0/shares/{u!base64url}/driveItem` |
| Create | `POST /api/lakehouse/shortcuts` → `bindExternalSource()` (Graph `headDriveItem` reachability) → Cosmos registry upsert |
| Test | `POST /api/lakehouse/shortcuts/test` → `headDriveItem(driveId, path)` |

All Graph calls use the Console UAMI → DefaultAzureCredential chain with the
`Sites.Read.All` + `Files.Read.All` application AppRoles (granted by
`scripts/csa-loom/grant-shortcut-graph-approles.sh` + admin consent;
bicep flag `loomSharepointShortcutsEnabled` / env `LOOM_SHAREPOINT_SHORTCUTS_ENABLED`).
No Fabric, no Power BI, no abfss — exactly how Fabric resolves these shortcuts.
