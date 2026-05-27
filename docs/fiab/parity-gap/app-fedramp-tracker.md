# Parity-gap — `app-fedramp-tracker` (FedRAMP Compliance Tracker)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps/app-fedramp-tracker`
Validated: 2026-05-26

## What the card claims

Description: "Track FedRAMP control implementation across Loom-deployed services. Maps
Synapse, Databricks, ADX, APIM, AI Foundry to NIST 800-53 controls."

Designed bundle: `scorecard` + `kql-dashboard` items.

## What actually happens

- Detail page renders, Category=Compliance, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- Direct API install returns `200 { installed: [] }`

## Verdict

F — federal compliance app that doesn't deploy a single compliance artifact. The
scorecard/KQL dashboard items aren't created. This one is particularly concerning given
the FedRAMP positioning.
