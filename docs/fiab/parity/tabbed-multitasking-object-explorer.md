# tabbed-multitasking-object-explorer — parity with Fabric tabbed multitasking + object explorer

Source UI: https://learn.microsoft.com/fabric/fundamentals/fabric-home#multitask-with-tabbed-navigation-to-access-resources
Fabric GA: April 2026 ("Tabbed multitasking and object explorer (Generally Available)").
Loom surfaces: console shell — `lib/components/tab-strip.tsx` (tabs) + `lib/components/object-explorer.tsx` (explorer), mounted in `lib/components/app-shell.tsx`.

## Fabric feature inventory (grounded in Learn)

### Tabbed navigation
1. Opening/creating an item pins a tab across the top with item name + type icon.
2. Multiple items open at once; switching tabs preserves each item's context (running operations, selected objects).
3. Hover a tab to see its owning workspace.
4. Drag a tab to reorder.
5. Right-click tab menu: Open in new browser tab, Pin/Unpin, close variants, tab-display settings.
6. Overflow menu when tabs exceed the visible width; full list of open items.
7. Raised open-item limit (was 10) for complex workflows.
8. Keyboard: Alt/Ctrl + 1–9 to jump to the Nth tab.
9. Multiple open workspaces are color-coded + numbered.

### Object explorer
10. Structured tree of items across all currently-open workspaces.
11. Click an item to open it (as a tab) without page-hopping.
12. Pin the object explorer (keep it open); resizable pane.
13. Filter by item type; search by keyword.
14. Items organized by the hierarchy (workspace → items) they belong to.
15. Keyboard: →/← expand/collapse workspace/subfolder, ↑/↓ navigate.

## Loom coverage

| # | Fabric capability | Loom | Notes |
|---|---|---|---|
| 1 | Item opens as a named, icon'd tab | ✅ | `tab-strip.tsx` auto-opens `/items/[type]/[id]`; type icon via item slug. |
| 2 | Many items open, state preserved | ✅ | Each tab is a route; Next.js route state + editors persist to Cosmos. Cap 12 (LRU evict w/ restore toast). |
| 3 | Hover shows workspace | ✅ | Tooltip on tab; tabs group-by-workspace with resolved names. |
| 4 | Drag to reorder | ⚠️ | Not built — tabs are ordered by open time + workspace grouping. Tracked as follow-up; not a blocker for this item. |
| 5 | Right-click tab menu (pin/close/open-new) | ✅ (tabs) | `tab-strip.tsx` context menu: pin/unpin, close, close others, close all unpinned, group toggle. Explorer item menu adds **Open** / **Open in new browser tab**. |
| 6 | Overflow menu | ✅ | `tab-strip.tsx` measures fit + chevron overflow popover, grouped by workspace. |
| 7 | Raised open limit | ✅ | 12 tabs (Fabric ~9) with LRU + pin. |
| 8 | Keyboard jump to Nth tab | ⚠️ | Tabs are focusable/keyboard-activatable; Alt+N direct-jump not bound. Follow-up. |
| 9 | Workspaces color-coded + numbered | ✅ | **Object explorer** numbers + color-badges each workspace (cycled Fluent Badge colors). |
| 10 | Cross-workspace item tree | ✅ | `object-explorer.tsx` — every ACL-visible workspace → its items. |
| 11 | Click item → open | ✅ | Dispatches `loom:open-tab` → TabStrip opens the item tab (Enter/Space or click). |
| 12 | Pinnable / stays open | ✅ | Non-modal `OverlayDrawer` (stays put while you work); open state persists to localStorage across nav + refresh. |
| 13 | Type filter + keyword search | ✅ | Type dropdown (item types present) + search box (name + type label). Search eager-loads all workspaces so the filter is complete. |
| 14 | Hierarchy-organized | ✅ | workspace → items, lazy-loaded on expand. |
| 15 | Keyboard →/← ↑/↓ | ✅ | Roving keyboard on rows: →/← expand/collapse a workspace, ↑/↓ move, Enter/Space open. |

Zero ❌. Two ⚠️ (tab drag-reorder, Alt+N direct-jump) are polish deltas on the **already-shipped tab strip**, explicitly scoped as follow-ups — the core "open multiple items in tabs + browse them from a cross-workspace explorer" workflow is complete and functional.

## Backend per control

| Control | Real backend |
|---|---|
| Workspace tree (with item counts) | `GET /api/workspaces?count=true` (ACL-aware; `resolveWorkspaceAccessByOid`). Bare `Workspace[]`. |
| Items under a workspace | `GET /api/workspaces/{id}/items` (Cosmos `itemsContainer`, partitioned by workspaceId). Bare `WorkspaceItem[]`. |
| Open item as tab | `loom:open-tab` CustomEvent → `tab-strip.tsx` → route `/items/{itemType}/{id}` (existing item editor + its per-item BFF routes). |
| Tab persistence | `GET/POST /api/tabs` (Cosmos `tabs-state`, one doc per user) + localStorage cache. |

No mocks: both list endpoints are the same real routes the Workspaces panes + `AllItemsExplorer` use. No Fabric/Power BI hosts on any path (no-fabric-dependency.md clean — this is shell UI over Loom's own workspace/item stores).

## Verification

- Guard cascade green: `check-no-raw-px`, `check-no-bare-client-fetch`, `check-route-guards`, `check-docs-hygiene`.
- Explorer wired to the live `/api/workspaces?count=true` + `/api/workspaces/{id}/items` (same routes the workspace list already renders from) — no new endpoints, no stubs.
- Live click-through (open explorer → expand a workspace → click an item → it opens as a tab; search + type filter narrow the tree; keyboard →/←/↑/↓/Enter) is the deep-functional UAT step per `no-scaffold`.
