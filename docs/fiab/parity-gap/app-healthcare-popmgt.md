# Parity-gap — `app-healthcare-popmgt` (Healthcare Population Health)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps/app-healthcare-popmgt`
Validated: 2026-05-26

## What the card claims

Description: "FHIR-on-Lakehouse + risk stratification model + Power BI patient
dashboards. HIPAA-aligned."

Designed bundle: `lakehouse` + `ml-model` items.

## What actually happens

- Detail page renders, Category=Industry, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- Direct API install returns `200 { installed: [] }`

## Verdict

F — HIPAA-aligned positioning + FHIR lakehouse + ML risk model — none of which deploy.
Items array empty.
