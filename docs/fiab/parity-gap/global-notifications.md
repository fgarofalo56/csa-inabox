# Global parity gap: Notifications (bell)

**Validated**: 2026-05-26  
**Surface**: Bell icon in top-bar actions  
**Component**: `apps/fiab-console/lib/components/notifications-button.tsx`  
**Fabric reference**: Fabric notification bell, unread badge, popover list with severity icons + click-to-mark-read  
**Backend probed**: `GET /api/notifications` 200, returns `{notifications:[], unreadCount:0}` (real BFF, currently empty)

## What renders

- `Alert24Regular` bell icon, `aria-label="Notifications"` (or `"Notifications (N unread)"` when N > 0)
- Red badge top-right of bell when unread > 0
- Click → Fluent Popover opens with header "Notifications" + "Mark all read" button + scrollable list

## Functional probes (auth'd)

- Click bell → Popover opens — PASS
- Popover content: "Notifications | Mark all read | You're all caught up." — PASS
- Empty state when 0 notifications — PASS
- Polls every 60 seconds (per code line 88) — code-level, not verified live
- "Mark all read" → PATCH `/api/notifications` with ids array — code-level

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Bell icon | YES | — | |
| Unread badge | YES | — | Red dot with count, hidden when 0 |
| Popover on click | YES | — | Fluent Popover |
| Title bar with Mark-all-read | YES | — | Disabled when unread=0 |
| Empty state copy | YES | — | "You're all caught up." |
| Item list | YES | — | Code renders title/body/createdAt per item |
| Click item → navigate | YES (code) | — | `href={n.link \|\| '#'}` |
| Severity icon per item | NO | MINOR | Fabric color-codes info/warning/error |
| Filter / clear all | NO | MINOR | |
| Poll interval | 60s | — | OK |

## Grade: **B**

Real BFF wiring, real popover, honest empty state, mark-all-read PATCH. No severity icons / no filter — minor. Looks polished.
