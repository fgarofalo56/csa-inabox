# lakehouse-file-upload-download — parity with Azure Storage Explorer + Fabric Lakehouse explorer (F5)

Source UI:
- Azure portal → Storage account → Storage browser (folder upload, drag-drop)
  https://learn.microsoft.com/azure/storage/blobs/storage-quickstart-blobs-portal
- Fabric Lakehouse explorer → Files (upload file / upload folder, download)
- Microsoft Purview Information Protection — sensitivity label on a file
  https://learn.microsoft.com/purview/encryption-sensitivity-labels

## Azure/Fabric feature inventory

| # | Capability (source UI)                                              | Notes |
|---|---------------------------------------------------------------------|-------|
| 1 | Upload one or more files into the current folder                    | multi-select picker |
| 2 | Upload a whole folder, preserving its sub-directory tree            | webkitdirectory picker |
| 3 | Drag-and-drop files/folders onto the explorer to upload             | tree preserved on folder drop |
| 4 | Upload progress (N of M)                                            | inline progress |
| 5 | New folder                                                          | — |
| 6 | Download a file                                                     | attachment |
| 7 | Apply / view a sensitivity label on a document (Office/PDF)         | MIP label metadata |

## Loom coverage

| # | Status | How |
|---|--------|-----|
| 1 | ✅ built | `Upload file` (multi `<input multiple>`) → `uploadItems` → `POST /api/lakehouse/upload` per file (real ADLS Gen2 `uploadFile`). |
| 2 | ✅ built | `Upload folder` (`<input webkitdirectory>`) → `webkitRelativePath` preserved as the ADLS path; HNS auto-creates parent dirs. |
| 3 | ✅ built | `onDrop` walks `DataTransferItem.webkitGetAsEntry()` recursively (`collectEntries`) so dropped folders keep their tree; loose-file fallback for browsers without the Entries API. |
| 4 | ✅ built | `uploadQueue {done,total}` → info MessageBar "Uploading N / M…". |
| 5 | ✅ built | existing `New folder` (unchanged). |
| 6 | ✅ built | `onDownload` uses `fetch` + blob (was `window.open`) so the `x-loom-mip-status` header is readable. |
| 7 | ✅ built / ⚠️ honest-gate | `Download with label…` picks a tenant MIP label (`/api/admin/security/mip/labels`); the download proxy stamps the bytes — **PDF** via XMP packet edit, **Office Open XML** via `docProps/custom.xml` custom properties — the same `MSIP_Label_<GUID>_*` metadata the native MIP SDK writes. A plain `Download` auto-applies the file's **Purview catalog** label when one exists. Where the label can't be embedded (no Purview, no scanned label, ZIP64 OPC, or a PDF with no/too-small XMP packet) the download **still succeeds** and a precise MessageBar names the gap — never a fake stamp. |

## Backend per control

| Control | Backend (real) |
|---------|----------------|
| Upload file / folder / drop | `POST /api/lakehouse/upload` → `@azure/storage-file-datalake` `DataLakeFileClient.upload` (UAMI → Storage Blob Data Contributor). Path-traversal guard rejects `..` / absolute paths. |
| Download | `GET /api/lakehouse/download` → `readToBuffer` → optional MIP stamp → attachment. |
| MIP catalog label lookup | `getLabelForAdlsPath` → Purview Atlas Data Map `entity/uniqueAttribute/type/azure_datalake_gen2_path` (`LOOM_PURVIEW_ACCOUNT`; Console UAMI Data Reader on the root collection). |
| MIP label list (picker) | `GET /api/admin/security/mip/labels` → Microsoft Graph `sensitivityLabels` (`LOOM_MIP_ENABLED`). |
| Stamp | `lib/azure/mip-file-inject.ts` — pure Node (zlib + crc32), no external deps, fully unit-tested. |

## No-Fabric / no-vaporware

- 100% Azure-native: ADLS Gen2 + Purview Data Map + Microsoft Graph. No Fabric/Power BI host, no `fabricWorkspaceId`. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Honest gates only (MessageBar names the exact env var / role / file-format limitation); the download is never blocked.

## Bicep / bootstrap sync

- `platform/fiab/bicep/modules/admin-plane/catalog.bicep` — `consolePrincipalId` param + `consolePurviewRoleGrant` output documenting the post-deploy Data Reader grant.
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — passes `identity.outputs.uamiConsolePrincipalId` to the catalog module.
- `.github/workflows/csa-loom-post-deploy-bootstrap.yml` — adds `data-reader` to the Console UAMI Purview Data Map role grant loop (for the F5 label lookup).
- `LOOM_PURVIEW_ACCOUNT` / `LOOM_MIP_ENABLED` were already wired into the console app env.

## Verification

- `pnpm vitest run mip-file-inject purview-mip-client` → 21 green (ZIP round-trip + MSIP props present + re-stamp idempotency + PDF length-invariant + honest gates + Purview extraction/GUID-resolution paths).
- `az bicep build` of catalog.bicep + main.bicep → clean.
- Live walk (operator): folder drag-drop preserves tree in ADLS; `Download with label` on a .docx → reopen in Word shows the sensitivity bar; with `LOOM_PURVIEW_ACCOUNT` unset, plain Download succeeds and the "MIP label lookup unavailable" MessageBar names `LOOM_PURVIEW_ACCOUNT` + the grant script.
