# Parity-gap — `app-pipeline-designer` (Pipeline Designer)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps/app-pipeline-designer`
Validated: 2026-05-26

## What the card claims

Description: "Visual + JSON authoring for Synapse pipelines, ADF, Databricks Jobs.
Common run history + alerting."

Designed bundle: `synapse-pipeline` + `adf-pipeline` + `databricks-job` items.

## What actually happens

- Detail page renders, Category=Data Engineering, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- Direct API install returns `200 { installed: [] }`

## Verdict

F — three pipeline kinds promised, zero installed. Note: the DAG canvas itself (per
existing `csa-loom-parity-reality` memory) is also a separate D-grade (no arrows,
no drag-drop) — even if the bundle worked, the resulting items would be sub-A.
