# Parity-gap — `app-fabric-mirror-onboard` (Fabric Mirror Onboarding)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps/app-fabric-mirror-onboard`
Validated: 2026-05-26

## What the card claims

Description: "One-click setup for Fabric Mirroring: Azure SQL Mirror, Snowflake Mirror,
Cosmos Mirror with target workspace + RBAC."

Designed bundle: `mirrored-database` item.

## What actually happens

- Detail page renders, Category=Data, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- Direct API install returns `200 { installed: [] }`

## Verdict

F — name implies "one-click setup", reality is zero clicks possible. Items array is
empty. The promised mirrored-database isn't created.
