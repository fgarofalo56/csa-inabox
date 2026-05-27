# Global parity gap: App launcher (waffle)

**Validated**: 2026-05-26  
**Surface**: Waffle icon next to logo in top bar  
**Component**: `apps/fiab-console/lib/components/app-launcher.tsx`  
**Fabric reference**: Office/M365 waffle picker — opens flyout listing Microsoft 365 + Fabric apps  
**Backend probed**: `GET /api/apps-catalog` returns 200 with seeded apps

## What renders

- `Apps24Regular` icon inside transparent button, white tint, `aria-label="App launcher"`, Tooltip "Apps"
- Click → opens Fluent `Drawer` from left (`position="start"`, `size="medium"`)
- Drawer header: "Apps" title + dismiss `X`
- Drawer body fetches `/api/apps-catalog` and renders 2-column grid of app cards (category badge + name + description)
- Click card → routes to `/apps/[id]`

## Functional probes (auth'd)

- Click waffle → drawer opens — PASS
- API call: `GET /api/apps-catalog` — 200, real apps returned (Casino Analytics, Data Steward Console, Fabric Mirror Onboarding, FedRAMP Tracker, FinOps, Healthcare PopHealth, IoT Real-Time, Lakehouse Inspector — 8+ items)
- Card click navigates to `/apps/app-casino-analytics` etc. — PASS
- Empty state (no apps): "No apps installed yet. Curated CSA apps will appear after your tenant is seeded." — PASS

## Functional probes (unauth)

- Drawer opens, but API returns 401 → empty state shows. No MessageBar telling user to sign in.

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Waffle icon top-left | YES | — | Same position |
| Click opens flyout | YES (drawer) | MINOR | Fabric uses a `Popover` anchored to button; Loom uses a Drawer that slides in from left. Slight UX difference. |
| Apps grid | YES | — | 2-col grid with category, name, description |
| App icons | NO | MINOR | Component reads `icon` field but no real icon assets are shipped — cards are text-only |
| Recent / pinned apps split | NO | MINOR | Fabric splits "Apps" vs "Other Microsoft apps"; Loom just lists all |
| Unauth gate | NO MessageBar | MINOR | Empty state when 401 doesn't tell user to sign in |

## Grade: **B**

Real data, real navigation, real BFF. UI uses Drawer instead of Popover (acceptable). Missing: icons on app cards, unauth MessageBar. No vaporware.
