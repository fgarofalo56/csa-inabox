# power-app — parity with the Power Apps maker

Source UI: Power Apps maker (`make.powerapps.com → Apps`).
Learn: <https://learn.microsoft.com/power-apps/maker/canvas-apps/getting-started>

## Feature inventory

1. List apps in an environment (name, type, owner, modified).
2. Open app detail (metadata, play URL).
3. Play / run the app.
4. Edit in Studio (canvas designer — proprietary portal canvas).
5. Create a new app.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | env-scoped list via PowerApps admin API |
| Detail | built ✅ | metadata grid |
| Play | built ✅ | `appOpenUri` link |
| Edit in Studio | built ✅ (embed/deep-link) | iframe embed of `make.powerapps.com` Studio with honest XFO fallback |
| New app | built ✅ (embed/deep-link) | "New canvas app in Studio" opens the maker canvas |

Authoring canvas is genuinely portal-only → embedded with honest new-tab fallback. List/play/open all work against real REST.

## Backend per control

- List → `GET /api/items/power-app` → `listPowerApps` → PowerApps admin `…/apps`
- Detail → `GET /api/items/power-app/[id]` → `getPowerApp`
- Studio → iframe / deep-link to `make.powerapps.com`
