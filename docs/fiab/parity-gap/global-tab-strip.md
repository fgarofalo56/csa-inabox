# Global parity gap: Tab strip (open tabs)

**Validated**: 2026-05-26  
**Surface**: Multi-tab strip in top bar (Home + per-item tabs)  
**Component**: `apps/fiab-console/lib/components/tab-strip.tsx`  
**Fabric reference**: Fabric top bar carries 1-3 tabs typically + overflow chevron  
**Backend probed**: `GET /api/tabs` 200 returns user's persisted tab list

## What renders

- `role="tablist"` with each tab as `<a role="tab" aria-selected>` linking to its href
- Home is pinned (no X), other tabs have `Dismiss12Regular` X button per tab
- Persisted to Cosmos `tabs-state` container per user, AND to localStorage `loom.tabs.cache.v1`
- Auto-open policy: lands on `/items/*/*`, `/workspaces/[id]`, `/apps/[id]` → tab added
- Each tab is `max-width: 220px` with text ellipsis

## Functional probes (auth'd, 11 tabs open, viewport 1600px)

- Tab strip renders all 11 tabs — but extends from x=296 to x=2792 (1600px past viewport)
- **BLOCKER**: tab strip overflows horizontally past the global actions toolbar (x=1420 Learn icon, x=1456 Admin icon) — tabs visibly overlap the right-side action icons
- No overflow chevron / scroll-arrow / more-button affordance
- `overflow-x: auto` is set but scrollbar is hidden via `::-webkit-scrollbar { display:none }` — there's no way to scroll horizontally with mouse + no other affordance
- Tabs are NOT draggable / reorderable

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Home tab (pinned) | YES | — | Real, can't be closed |
| Per-item tab | YES | — | Auto-opens on item editor navigation |
| Close X per tab | YES | — | Calls POST /api/tabs with filtered list |
| Tab activation persists across reload | YES | — | Cosmos + localStorage |
| Active tab visual | YES | — | Lighter bg + boxShadow inset |
| Tab strip overflow handling | **NO** | **BLOCKER** | When 5+ tabs, overflows past viewport. Hidden scrollbar. No chevron. Hides global actions. |
| Drag to reorder | NO | MAJOR | Fabric supports drag-reorder |
| Right-click context menu (Close all / Close others) | NO | MAJOR | Fabric has this |
| New-tab indicator (Ctrl+T) | NO | MINOR | Not standard in Fabric either; skip |

## Grade: **C**

Tabs PERSIST (real Cosmos backend), tabs CLOSE, tabs route correctly. But overflow handling is broken — once you have 5+ tabs, the strip spills past viewport and visually obstructs the right-side toolbar. No way to reorder. No context menu. This is the user's #1 daily-pain surface, and the parity gap is BLOCKER-level.
