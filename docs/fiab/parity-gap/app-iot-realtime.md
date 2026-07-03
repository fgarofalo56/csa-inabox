# Parity-gap — `app-iot-realtime` (IoT Real-Time Insights)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://<your-console-hostname>/apps/app-iot-realtime`
Validated: 2026-05-26

## What the card claims

Description: "IoT Hub → Event Hubs → ADX → KQL dashboards. Activator alerts on device
anomalies. End-to-end in one workspace."

Designed bundle: `eventstream` + `kql-database` + `kql-dashboard` items.

## What actually happens

- Detail page renders, Category=Real-Time, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- Direct API install returns `200 { installed: [] }`

## Verdict

F — claims "end-to-end in one workspace" but installs zero of the four documented
surfaces (eventstream/KQL DB/dashboard/activator).
