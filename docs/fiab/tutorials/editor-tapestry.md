# Tutorial: Tapestry editor

> CSA Loom `tapestry` editor — an investigative **link-analysis + geospatial +
> timeline** workspace over the ADX graph (`make-graph` / `graph-match`) and
> Azure Maps: the Azure-native equivalent of a Gotham-class investigation
> surface. **No Microsoft Fabric required.**

## What it is

Tapestry is an investigative analysis workspace that composes three coordinated
views over the SAME materialized `Node_*` / `Edge_*` ADX tables the graph
editors already query:

- a **Link** panel — force-directed graph from KQL `make-graph` +
  `graph-match` / `graph-shortest-paths` / `graph-mark-components`,
- a **Geo** panel — a GeoJSON FeatureCollection projected from node lat/lon
  properties, rendered with the keyless SVG GeoJsonMap and an optional live
  Azure Maps raster basemap when a key is configured, and
- a **Timeline** panel — KQL `summarize count() by bin(timestamp, window)` over
  `Edge_*` events.

## When to use it

- Entity-relationship investigations: who knows whom, who attended what, what
  connects two subjects.
- Cases where link, location, and time need to be analyzed together with
  cross-filtering.

## Step-by-step in Loom

1. **Seed an investigative dataset.** Run admin **Load sample data**
   (kind=investigation) once to materialize `Node_Person` / `Node_Org` /
   `Node_Location` / `Node_Event` and `Edge_Knows` / `Edge_LocatedAt` /
   `Edge_Attended` into the default ADX database — people/orgs/events with
   timestamps and lat/lon.
2. **Run link analysis.** On the **Link** tab, pick an analysis (pattern match,
   shortest path, or connected components) and a hop depth; the editor builds
   the `make-graph` prelude over `Node_*` / `Edge_*` and runs `graph-match` —
   results render in the force-directed canvas. Click a node to cross-filter
   the Geo + Timeline panes.
3. **Map the entities.** The **Geo** tab projects every located node into a
   GeoJSON FeatureCollection and renders it; set
   `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` to layer a live Azure Maps basemap behind
   the vector overlay (the panel renders regardless).
4. **Analyze the timeline.** The **Timeline** tab bins `Edge_*` events by a
   chosen window (hour/day/week) and edge label; results render as a
   time-series grid so you can see how relationships evolve over time.

## The Azure backend it rides on

- **Link + timeline engine:** Azure Data Explorer (KQL graph operators +
  summarize) — sovereign across every cloud.
- **Geo:** keyless SVG rendering by default; optional Azure Maps raster
  basemap.

## No Fabric required

The engine is ADX and the geo panel renders without any subscription; no
Fabric capacity or workspace is involved.

## Learn more

- KQL graph semantics:
  <https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-semantics-overview>
