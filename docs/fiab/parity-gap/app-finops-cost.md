# Parity-gap — `app-finops-cost` (FinOps Cost Optimizer)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps/app-finops-cost`
Validated: 2026-05-26

## What the card claims

Description: "Per-domain chargeback report, Synapse pool auto-pause schedule, idle
workload finder. Cosmos-backed budgets."

Designed bundle: `semantic-model` + `report` items.

## What actually happens

- Detail page renders, Category=Operations, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- Direct API install returns `200 { installed: [] }`

## Verdict

F — promises three FinOps surfaces (chargeback, auto-pause, idle finder) plus
Cosmos-backed budgets; delivers none of them. Items array empty.
