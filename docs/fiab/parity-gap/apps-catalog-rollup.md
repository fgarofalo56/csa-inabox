# Parity-gap — Apps catalog (all 10 apps) — Rollup

**Grade: F (Vaporware) — applies uniformly to all 10 apps in the live catalog**

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps`
Validated: 2026-05-26
Reference: `temp/parity/apps/app-casino-analytics.png` (representative — every other
app's detail page renders identically with "Bundled items (0)").

## The defect

Every single one of the 10 curated CSA apps in the live deployment has
**`items: []`** in its Cosmos document. The Install button is therefore `disabled`
for every app. The card looks production-grade; clicking through to the detail page
reveals the empty bundle and the disabled action.

Forced an install via the API anyway:

```js
POST /api/apps/app-casino-analytics/install
{ workspaceId: "de489967-b174-45b4-9e7d-1ea0a555db34" }

→ 200 OK { ok: true, app: "app-casino-analytics", workspaceId: "...", installed: [] }
```

The endpoint is real and wired. It just has nothing to install because the catalog is
empty of bundled items.

## What the seed script SAYS each app should install

From `scripts/csa-loom/seed-catalogs.sh` lines 30–39 (the original design):

| App id | Items the catalog WANTS to install | Items in live catalog |
|---|---|---|
| app-fedramp-tracker | scorecard, kql-dashboard | **0** |
| app-data-steward | data-product, semantic-model | **0** |
| app-rag-builder | ai-search-index, prompt-flow, evaluation | **0** |
| app-lakehouse-inspector | lakehouse | **0** |
| app-pipeline-designer | synapse-pipeline, adf-pipeline, databricks-job | **0** |
| app-casino-analytics | warehouse, activator | **0** |
| app-healthcare-popmgt | lakehouse, ml-model | **0** |
| app-iot-realtime | eventstream, kql-database, kql-dashboard | **0** |
| app-finops-cost | semantic-model, report | **0** |
| app-fabric-mirror-onboard | mirrored-database | **0** |

22 items were supposed to ship across these 10 apps. **0** ship in production.

## Root cause

Two seed paths exist:

1. `scripts/csa-loom/seed-catalogs.sh` — has `items: [...]` arrays. Requires direct
   Cosmos data-plane access. Cosmos PE is locked from outside the VNet, so this
   script doesn't work from a workstation.

2. `POST /api/admin/bootstrap-catalogs`
   (`apps/fiab-console/app/api/admin/bootstrap-catalogs/route.ts`) — runs from inside
   the Container App so it CAN reach Cosmos. But its in-code APPS constant
   (lines 25–35) **OMITS** the `items` arrays entirely. It only seeds id/name/
   description/category/publisher.

The deployed env was seeded via #2 (the bash version is documented as
"only works from inside the VNet"). Result: 10 perfectly-styled empty cards.

## Vaporware violations per `.claude/rules/no-vaporware.md`

- "Pre-configured / hard-coded UI values that look like real data but aren't" — YES
- "Buttons with no click handler" — Install button is disabled, effectively a dead
  decorative button
- "Stubbed BFF routes that return `[]` or `{}` instead of calling a real backend" —
  Install returns `installed: []` because the source data is empty
- "Bicep features that aren't tested in the actual deployment" — The catalog seeding
  contract isn't tested; no `assertItemsInstalled` step in the bootstrap workflow
- Apps catalog FAILS the "real data E2E receipt" requirement: receipt would be
  `installed: []` for every app

## Severity per row

| Element | Severity | Notes |
|---|---|---|
| 10 apps visible on /apps (matches memory's "10+") | OK | Count is right |
| Cards render with category badge + description | OK | Visual quality good |
| Per-app description matches actual behavior | **BLOCKER × 10** | Every description lies |
| Install button | **BLOCKER × 10** | Disabled for every app |
| Install API endpoint exists + returns 200 | OK | Wired correctly |
| Install actually creates the documented items | **BLOCKER × 10** | Zero items per app |
| Recommended Apps on Home page | OK | Same source, same defect — same 10 empty cards |
| Idempotency claim ("items with matching name + type are skipped") | UNTESTABLE | No items to dedup |

## How to fix to A

**Single high-leverage fix**: extend `bootstrap-catalogs/route.ts` `APPS` constant to
include the `items: [...]` arrays from `seed-catalogs.sh`, then re-`POST /api/admin/
bootstrap-catalogs` against the live deployment. Run UAT install for every app and
verify `installed: [...]` is non-empty.

Acceptance criteria:
- `GET /api/apps-catalog` returns 10 apps with non-empty `items` arrays totaling 22 items
- `POST /api/apps/app-casino-analytics/install` returns 2 created items
  (warehouse + activator)
- Workspace item list shows the newly-installed items
- All 10 apps' Install buttons are clickable (not disabled)
- Re-install is idempotent (second call returns status:'existed' for all)

## Per-app stub gap docs

Brief stubs exist as `app-<slug>.md` for each app — they all share this rollup's
verdict. See `app-casino-analytics.md` for the full template; others reference back here.
