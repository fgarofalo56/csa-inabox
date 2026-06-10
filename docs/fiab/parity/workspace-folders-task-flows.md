# workspace-folders-task-flows — parity with the Fabric workspace (Folders + Task flows)

Source UI:
- Fabric workspace **folders**: https://learn.microsoft.com/fabric/fundamentals/workspaces-folders
- Fabric workspace **task flow**: https://learn.microsoft.com/fabric/fundamentals/task-flow-overview

Loom surface: `app/workspaces/[id]/page.tsx` (TabList: **Items** + **Task flows**)
→ `lib/panes/folders.tsx` (F10) and `lib/panes/task-flows.tsx` (F11).

These are Fabric-native organizational features (NOT a data backend), so the
Azure-native default is a Loom-native model persisted in **Cosmos DB** — no
Fabric capacity, workspace, or OneLake dependency. Works fully with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric feature inventory — Folders (grounded in Learn)

| # | Fabric capability | Loom coverage | Backend per control |
|---|---|---|---|
| 1 | Create folder in a workspace | ✅ FoldersPane "New folder" | POST `/api/workspaces/[id]/folders` → Cosmos `folders` |
| 2 | Create nested subfolder (up to 10 deep) | ✅ context-menu "New subfolder…" (parent set) | POST with `parent` → Cosmos |
| 3 | Rename folder | ✅ context-menu "Rename" | PATCH `/folders` `{id,name}` → Cosmos replace |
| 4 | Delete folder (contents reparent) | ✅ context-menu "Delete" + confirm | DELETE `/folders?id=` → cascade reparent → Cosmos |
| 5 | Move item into folder | ✅ context-menu "Move to folder…" + drag-and-drop | PATCH `/items/[itemId]` `{folderId}` → Cosmos |
| 6 | Move item back to workspace root | ✅ "/ Workspace root" + root drop-zone | PATCH `{folderId:null}` → Cosmos |
| 7 | Drag-and-drop items between folders | ✅ HTML5 DnD on the tree | PATCH `/items/[itemId]` → Cosmos |
| 8 | Expand/collapse folder tree (state remembered) | ✅ controlled Tree + localStorage persist | client-only |
| 9 | Folder shows descendant count | ✅ Badge per folder | derived |
| 10 | Bulk select + bulk move/delete/open | ✅ checkbox multi-select toolbar | PATCH/DELETE per item → Cosmos |
| 11 | Admin manage folders in any workspace | ✅ admin BFF routes | `/api/admin/workspaces/[id]/folders` (tenant-admin guard) |

## Fabric feature inventory — Task flow (grounded in Learn)

| # | Fabric capability | Loom coverage | Backend per control |
|---|---|---|---|
| 1 | Create a task flow in a workspace | ✅ TaskFlowsPane "New task flow" | POST `/api/workspaces/[id]/task-flows` → Cosmos `task-flows` |
| 2 | List task flows | ✅ DataGrid (Name / Steps / Updated) | GET `/task-flows` → Cosmos |
| 3 | Add a task (step) to the canvas | ✅ "Add step" → dialog | PUT `/task-flows/[flowId]` (steps) → Cosmos |
| 4 | Connect tasks with directed edges | ✅ React Flow connect (handles) | PUT (edges) → Cosmos |
| 5 | Drag tasks to arrange the canvas | ✅ React Flow node drag → debounced autosave | PUT (steps x/y) → Cosmos |
| 6 | Attach a real workspace item to a task | ✅ step dialog "Linked item" Dropdown of live items | PUT (step.itemId/itemType) → Cosmos |
| 7 | Edit a task (label / item / note) | ✅ double-click node → edit dialog | PUT → Cosmos |
| 8 | Remove a task | ✅ edit dialog "Remove step" (+ prunes edges) | PUT → Cosmos |
| 9 | Delete a task flow | ✅ list "Delete" + confirm | DELETE `/task-flows/[flowId]` → Cosmos |
| 10 | Canvas navigation (zoom / fit / minimap) | ✅ React Flow Controls + MiniMap + fitView | client-only |
| 11 | Admin manage task flows in any workspace | ✅ admin BFF routes | `/api/admin/workspaces/[id]/task-flows` (tenant-admin guard) |

Zero ❌ — every inventory row is built ✅. No stub banners; the only
non-functional state is the honest empty-state when a workspace has no folders
/ no task flows yet.

## Per-cloud notes

`@xyflow/react` is pure browser-side (no cloud dependency). Cosmos endpoint is
carried by `LOOM_COSMOS_ENDPOINT` (Commercial `*.documents.azure.com`, Gov
`*.documents.azure.us`) so `cosmos-client.ts` is endpoint-agnostic across
Commercial / GCC / GCC-High / IL5. The `task-flows` + `folders` containers are
created lazily via `ensure()` (`createIfNotExists`) — no pre-deploy ARM step
beyond the account + database; the Console UAMI already holds Cosmos DB
Built-in Data Contributor at account scope.

## Verification

- `lib/clients/__tests__/folders-client.test.ts` — 11 tests (list scope, create
  defaults, rename, delete cascade, move-item validation).
- `lib/clients/__tests__/taskflow-client.test.ts` — 8 tests (create defaults,
  list order, get/404, upsert merge, idempotent delete).
- `npx tsc --noEmit` — 0 errors across the project.
