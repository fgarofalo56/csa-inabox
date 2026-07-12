# workspace-image — parity with the Power BI / Fabric workspace image

Source UI: Power BI / Fabric **Workspace settings → Image** (a workspace can be
given a custom image that renders on its tile, header, and switcher).
- https://learn.microsoft.com/power-bi/collaborate-share/service-create-the-new-workspaces
- https://learn.microsoft.com/fabric/fundamentals/workspaces

Azure-native, no Fabric dependency: the image is stored in Cosmos (a sidecar doc
in the `tenant-settings` container) and served by a first-party BFF route. There
is **no** Power BI / Fabric / OneLake call on any path — this works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset (see `no-fabric-dependency.md`).

## Power BI / Fabric feature inventory

| # | Capability (source UI) | Notes |
|---|------------------------|-------|
| 1 | Upload a custom image for the workspace | PNG/JPG; small size cap |
| 2 | Pick from built-in / default images | Power BI's picker offers presets |
| 3 | Replace the current image | Re-upload overwrites |
| 4 | Remove the image (revert to default glyph) | Falls back to initials/icon |
| 5 | Image renders on the workspace tile / list | Card + list rows |
| 6 | Image renders in the workspace header | Top of the workspace |
| 7 | Image renders in the workspace switcher | Left-nav / switcher menu |
| 8 | Format + size validation with a clear error | Reject unsupported/oversized |

## Loom coverage

| # | Loom | State | Where |
|---|------|-------|-------|
| 1 | Upload PNG/JPEG/GIF/WebP (≤ 1 MiB) | ✅ | `WorkspaceImageEditor` → `POST /api/workspaces/[id]/image` |
| 2 | 12-tile preset gallery (gradient + motif, rasterised to PNG) | ✅ | `workspace-image-presets.ts` + editor gallery |
| 3 | Replace (re-upload / re-pick overwrites the sidecar doc) | ✅ | `putWorkspaceImage` upsert |
| 4 | Remove image | ✅ | `DELETE /api/workspaces/[id]/image` → strips the doc pointer |
| 5 | Renders on workspace list + cards | ✅ | `app/workspaces/page.tsx` (`WorkspaceAvatar`) |
| 6 | Renders in the workspace header | ✅ | `app/workspaces/[id]/page.tsx` |
| 7 | Renders in the switcher | ✅ | `lib/components/workspace-switcher.tsx` |
| 8 | Renders in the admin workspace list | ✅ | `app/admin/workspaces/page.tsx` (row avatar) |
| 9 | Raster-only + 1 MiB validation, SVG rejected (stored-XSS) | ✅ | `validateWorkspaceImageFile` (client) + store (server) |
| 10 | Reachable from BOTH settings surfaces (header Drawer + admin Pane) | ✅ | `WorkspaceSettingsDrawer` Image tab + `WorkspaceSettingsPane` Image tab |

Zero ❌. The editor is one shared component so the Drawer and the Pane are
byte-identical. Presets go through the same raster-only upload route as a user
file, so there is no second, weaker code path.

## Backend per control

| Control | Backend |
|---------|---------|
| Upload a file | `POST /api/workspaces/[id]/image` (JSON `{dataUri}`) → `putWorkspaceImage` → Cosmos `tenant-settings` sidecar `wsimage:<id>` + `image` pointer stamped on the workspace doc |
| Pick a preset | preset rendered to a 256×256 PNG on a `<canvas>` → same `POST …/image` route |
| Remove | `DELETE /api/workspaces/[id]/image` → `deleteWorkspaceImage` + pointer removed |
| Render anywhere | `GET /api/workspaces/[id]/image` (auth-gated bytes, `?ts=` cache-bust) via `WorkspaceAvatar` |

## Verification

- Unit: `lib/components/__tests__/workspace-image-presets.test.ts` (13) +
  `lib/azure/__tests__/workspace-image-store.test.ts` (6) — 19 green.
- Build gate: `tsc -p tsconfig.build.json` clean for all touched files.
- Live click-walk (human/harness): open a workspace → Settings → **Image** →
  upload a PNG → confirm the header/switcher/list avatars update → pick a preset
  → confirm it replaces → Remove → confirm it reverts to the initials glyph.
