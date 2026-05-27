# Global parity gap: Activity feed (Pinned + Recent items, Recommended apps)

**Validated**: 2026-05-26  
**Surfaces**:
1. Home page → "Recent" section (recently opened items)
2. Home page → "Recommended apps" grid (curated CSA apps)
3. Browse page → "Pinned" + "Recent" sections
4. Left rail → "Pinned" empty-state block

**Components**:  
- `apps/fiab-console/lib/components/recent-items.tsx` (per project structure)
- `apps/fiab-console/app/page.tsx` (home page composition)
- `apps/fiab-console/app/browse/page.tsx`

**Backend probed**:  
- `GET /api/items/recent?n=8` returns 200 with real items
- `GET /api/user-prefs?key=pinnedItems` returns 200 with real array
- `GET /api/apps-catalog` returns 200 with seeded apps

## What renders (auth'd home page)

- "Recent" heading + 1 real item card: `azure sql database / uat-sqldb / 5/25/2026, 2:54:37 PM` (a real workspace item) — visible
- "Recommended apps" heading + 8 cards: Casino Analytics, Data Steward Console, Fabric Mirror Onboarding, FedRAMP Compliance Tracker, FinOps Cost Optimizer, Healthcare Population Health, IoT Real-Time Insights, Lakehouse Inspector — all rendered with category badge + name + description, all link to `/apps/{id}`

## What renders (Browse page)

- "Pinned" section → "Nothing pinned yet. Pin a workspace or item to make it stick here and in the left sidebar."
- "Recent" section → one card for `uat-sqldb`

## Functional probes

- Recent items click → routes to `/items/azure-sql-database/{id}` — PASS
- Pinned section reads from user prefs — PASS (empty in this run)
- Recommended apps grid → real catalog from BFF — PASS
- "Pin a workspace or item to see it here" empty-state copy — PASS

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Recent items list | YES | — | Real BFF, real items |
| Pinned items | YES | — | Per-user prefs |
| Recommended apps | YES + EXTENDED | — | 8 curated CSA apps, more than Fabric's static set |
| Activity feed (who edited what) | NO | MINOR | Fabric has "Activity" tab on item pages |
| Notification timeline | NO | MINOR | Distinct from notifications popover |
| Pin/unpin in-place | NO TESTED | — | Code-level exists |

## Grade: **A-**

Real data, real grids, sensible empty-states, more curated content than Fabric's stock home. Only down 1 notch for missing activity feed and inline pin/unpin. This is one of the cleanest surfaces in Loom.
