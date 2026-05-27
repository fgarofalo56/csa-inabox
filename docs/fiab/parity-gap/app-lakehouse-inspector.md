# Parity-gap — `app-lakehouse-inspector` (Lakehouse Inspector)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps/app-lakehouse-inspector`
Validated: 2026-05-26

## What the card claims

Description: "Browse bronze/silver/gold ADLS containers, preview Parquet/Delta files
via Synapse Serverless, profile data quality."

Designed bundle: `lakehouse` item (medallion template).

## What actually happens

- Detail page renders, Category=Data, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- Direct API install returns `200 { installed: [] }`

## Verdict

F — promised medallion-template lakehouse isn't created. Items array empty.
