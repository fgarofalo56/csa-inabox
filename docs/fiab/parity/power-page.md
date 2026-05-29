# power-page — parity with Power Pages

Source UI: Power Pages design studio (`make.powerpages.microsoft.com`).
Learn: <https://learn.microsoft.com/power-pages/getting-started/getting-started-with-portals>

## Feature inventory

1. List sites (name, domain, status, type, modified).
2. Site detail (website id, domain, URL).
3. Open live site.
4. Edit site (pages/templates/web roles) — proprietary design studio.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | `mspp_websites` (adx_ fallback) |
| Detail | built ✅ | metadata grid |
| Open live site | built ✅ | website URL link |
| Edit site | honest-gate ⚠️ | MessageBar + "Open in Power Platform" deep-link (studio is portal-only) |

## Backend per control

- List → `listPowerPages` → Dataverse `mspp_websites`; Detail → `getPowerPage`.
