# Parity-gap — `app-data-steward` (Data Steward Console)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps/app-data-steward`
Validated: 2026-05-26

## What the card claims

Description: "Curate datasets, manage classifications, certify endorsements. Wires
Purview + AI Search + Synapse Serverless for lineage + search."

Designed bundle (from `scripts/csa-loom/seed-catalogs.sh`): `data-product` +
`semantic-model` items.

## What actually happens

- Detail page renders correctly with heading "Data Steward Console"
- Category badge: Governance, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- `POST /api/apps/app-data-steward/install` returns `200 { installed: [] }`

## Verdict

F — same defect as every app in the catalog. Items array empty in production Cosmos.
Description promises Purview+AI Search+Synapse wiring; delivers nothing. See rollup for fix.
