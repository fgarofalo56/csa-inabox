# Parity-gap — `app-fabric-mirror-onboard` (Fabric Mirror Onboarding)

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


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
