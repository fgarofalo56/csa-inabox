# Parity-gap — Apps catalog — `app-casino-analytics`

**Grade: F (Vaporware)**

Surface: `https://<your-console-hostname>/apps/app-casino-analytics`
Validated: 2026-05-26
Screenshot: `temp/parity/apps/app-casino-analytics.png`

## Verdict summary

The catalog card looks production-grade (badge, by-CSA publisher, polished description).
The detail page renders. The **Install into workspace** button exists.

But:
- `Bundled items (0)` heading + literal "This app doesn't bundle any items yet." message
- Install button is **disabled** (`disabled={!app.items?.length}` in source)
- Forced an install via direct `POST /api/apps/app-casino-analytics/install` — server returned
  `200 OK { installed: [] }`. Zero items created. Endpoint works, catalog is empty.

This is the textbook vaporware pattern called out in `.claude/rules/no-vaporware.md`:
"Pre-configured / hard-coded UI values that look like real data but aren't" +
"buttons with no click handler" (button exists but is unusably disabled).

## What the app *claims* to do

From the description: "Reference architecture: player-grain facts, table games, real-time
win/loss, Activator alerts for high-roller events."

From `scripts/csa-loom/seed-catalogs.sh` (the ORIGINAL design — never deployed):
```json
"items":[
  {"type":"warehouse","template":"casino-dw"},
  {"type":"activator","template":"high-roller-alert"}
]
```

## What it actually installs

Nothing. The `items` array in the live Cosmos doc is `[]`.

```bash
curl /api/apps-catalog | jq '.apps[] | select(.id=="app-casino-analytics") | .items'
# []
```

## Root cause

The catalog was seeded by `POST /api/admin/bootstrap-catalogs` (the in-VNet endpoint at
`apps/fiab-console/app/api/admin/bootstrap-catalogs/route.ts`), which defines APPS without
any `items` arrays. The original `scripts/csa-loom/seed-catalogs.sh` (which DOES define
items) was apparently never run against the live deployment, OR was overwritten by the
items-less bootstrap endpoint.

## Severity matrix

| Element | Severity | Notes |
|---|---|---|
| Card on `/apps` shows name, description, category | OK | Renders |
| Detail page renders | OK | h1=Casino Analytics |
| Install button exists | OK | But disabled |
| Install button does what label says | **BLOCKER** | Disabled because items=[] |
| `POST /api/apps/{id}/install` is wired | OK | Returns 200, but installs nothing |
| Items array seeded with real bundle | **BLOCKER** | Empty in production |
| Description matches actual install behavior | **BLOCKER** | Promises warehouse+activator, delivers nothing |
| Per-rule no-vaporware: real-data E2E receipt | **F** | Install returns `installed:[]` |

## How to fix to A

1. Run `bash scripts/csa-loom/seed-catalogs.sh` against the live Cosmos OR
2. Add the `items` arrays to `app/api/admin/bootstrap-catalogs/route.ts` to match the
   bash script, then re-`POST /api/admin/bootstrap-catalogs`
3. Re-verify that `POST /api/apps/app-casino-analytics/install` returns
   `installed: [{itemType:"warehouse",...,status:"created"}, {itemType:"activator",...,status:"created"}]`
4. Verify items appear in the chosen workspace's item list
5. Repeat per app. ALL 10 apps have items=[] today.
