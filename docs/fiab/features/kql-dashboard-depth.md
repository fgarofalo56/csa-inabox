# Real-Time Dashboard pages, text tiles and drill-through

> **Surface:** Real-Time Dashboard editor (`/items/kql-dashboard/<id>`)
> **Backend:** the dashboard model persisted to Cosmos via `PUT /api/items/kql-dashboard/<id>`; tiles execute real KQL against your Azure Data Explorer cluster
> **Kill-switch flag:** `u8-kql-dashboard-depth` (default ON)
> **Honest gate:** none beyond the ADX cluster the tiles query

Three depth features that turn a single tile grid into a real multi-page
dashboard: **pages**, **markdown text tiles**, and **drill-through** that
navigates to a target page after injecting the value you clicked.

This is Fabric Real-Time Dashboard parity on the Azure-native ADX cluster — no
Fabric capacity required.

## Why it exists

A dashboard that has to fit on one canvas either stays trivial or becomes
unreadable. Pages let a dashboard tell a story — an overview page, a per-region
page, an incident-detail page — and drill-through is what connects them: click a
value on the overview, land on the detail page already filtered to it.

Text tiles cover the other half of storytelling. A dashboard that is nothing but
charts makes the reader guess at the narrative.

## How to use it end to end

### Pages

1. **Open the dashboard.** A dashboard with no authored pages shows the
   back-compat single-page canvas: one implicit **Page 1** tab plus **Add page**.
2. **Add a page.** Adding the first extra page materializes real page records.
   Existing tiles stay on page 1 — a tile with no page assignment maps to the
   first page, so nothing moves under you.
3. **Rename** inline: click rename, type in place of the tab, and Enter or blur
   commits.
4. **Delete** a page and its tiles **move to the first remaining page**. Nothing
   is destroyed.
5. **Save** persists pages and the active page to the dashboard model in Cosmos.

### Text tiles

1. **Add text tile** from the ribbon or the add-tile menu.
2. **Write markdown** in the tile's editor; a live preview renders alongside.
3. The rendered tile uses the product's own typography, so a text tile reads like
   the rest of Loom rather than like a raw markdown dump.
4. **Text tiles never execute a query.** They are exempt from the run and refresh
   paths entirely.

### Drill-through

Drill-through targets a **dashboard parameter**, so define one first — the editor
tells you so explicitly rather than offering a control that cannot work.

1. **Add at least one dashboard Parameter.**
2. **Select a tile** and open its **Drill-through** section (Fabric's equivalent
   is Visual interactions -> Drill-through).
3. **Pick the column** whose value should be captured on click, the **target
   parameter** it sets, and optionally a **target page**.
4. **Click a value** on the rendered tile at runtime. Loom sets the parameter to
   the clicked value; every tile bound to that parameter re-queries with it, and
   when a target page is configured the dashboard navigates there.
5. With no target page configured, the injection cross-filters the current page.

## What the backend actually does

| Control | Backend |
|---|---|
| Pages, text tiles, drill-through config | The dashboard model, persisted by `PUT /api/items/kql-dashboard/<id>` to Cosmos |
| Tile queries | Real KQL against the bound ADX data source; the results render through the shared tile visual layer |
| Parameters | Substituted into each tile's KQL before execution |
| Refresh | Auto or manual, per the dashboard's setting |

The page strip is pure presentation plus callbacks: the editor owns the page and
active-page state, which keeps the strip unit-testable and the persistence in
one place.

## Honest gates

None specific to these three features. The dashboard as a whole requires an ADX
cluster and a bound data source; without one the editor renders and the tiles
report the honest data-source gate rather than showing invented numbers.

## Kill-switch

`u8-kql-dashboard-depth` — default ON. Flipping it OFF reverts the editor to the
pre-U8 single-page canvas on the next load. Nothing is deleted:

- **Saved pages are preserved** — every tile simply renders on one canvas.
- **Text tiles keep rendering their content.**
- **Drill-through falls back to same-page cross-filtering** (the parameter is
  still injected; the navigation is not).

## Related

- Editor guide — [KQL dashboard](../tutorials/editor-kql-dashboard.md)
- [Real-Time Dashboard parity spec](../kql-dashboard-parity-spec.md) · [KQL dashboard workload](../workloads/kql-dashboard.md)
- [KQL / Real-time intelligence](../learn/kql-real-time-intelligence.md)
