# map — parity with Fabric IQ Map / geospatial analytics (Foundry Map / Azure Maps)

Source UI:
- Azure Maps Power BI visual — https://learn.microsoft.com/azure/azure-maps/power-bi-visual-get-started + /power-bi-visual-understanding-layers
- Azure Maps Web SDK (azure-maps-control) — https://learn.microsoft.com/azure/azure-maps/how-to-use-map-control ; drawing tools https://learn.microsoft.com/azure/azure-maps/map-add-drawing-toolbar ; popups https://learn.microsoft.com/azure/azure-maps/map-add-popup
- Palantir Foundry Map / Fabric IQ digital-twin geospatial (layer panel, ontology-bound layers, time, geofence)

Editor under test: `apps/fiab-console/lib/editors/phase4-editors.tsx` → `MapEditor` (registry slug `map`, category "Fabric IQ").
Backend: `app/api/items/map/[id]/route.ts` (CRUD) + `app/api/items/map/[id]/data/route.ts` (binding → Synapse Serverless / ADX / Weave). Renderer: `lib/components/graph/geojson-map.tsx` (static SVG).

> **Key finding (the parity unlock):** a REAL interactive Azure Maps Web SDK surface already exists in
> this codebase — `lib/editors/report/map-visual.tsx` loads `azure-maps-control` from the atlas CDN with
> `BubbleLayer` / `PolygonLayer` / `LineLayer`, hover popups, a legend, basemap styling and camera-fit;
> `lib/azure/maps-client.ts` mints an AAD token (Console UAMI + **Azure Maps Data Reader**) for
> `atlas.microsoft.com`; `/api/items/report/[id]/map-token` serves it; and
> `platform/fiab/bicep/modules/admin-plane/azure-maps.bicep` deploys the `Microsoft.Maps/accounts` Gen2
> account. The Fabric IQ `map` editor ignores all of this and renders a **static SVG** behind an optional
> **non-interactive static raster image**. The biggest win is to retarget the editor onto the interactive
> SDK the report layer already proves works — NO new Azure dependency, NO Fabric.

## Real feature inventory

Every capability the real product (Azure Maps PBI visual + Web SDK + Foundry/Fabric IQ Map) exposes:

### A. Interactive map surface & navigation
- Real interactive map: pan, scroll/box zoom, rotate (bearing), tilt (pitch / 3D), inertial drag.
- Map settings: auto-zoom-to-data, manual center lat/lon, zoom (0–22), heading/bearing (0–360), pitch (0–60).
- Built-in controls: **ZoomControl**, **CompassControl** (rotate/reset north), **PitchControl**, **StyleControl** (basemap picker), fullscreen, scale bar.

### B. Basemap styles
- road, road_shaded_relief, grayscale_light, grayscale_dark, night, high_contrast_light/dark, satellite (aerial), satellite_road_labels, blank/blank_accessible. Live style switch without reload.

### C. Data-rendering layers (each: min/max zoom, layer position, legend)
- **Marker / symbol layer** — icons/SVG, size scaling by metric, per-category icon, rotation by angle field, color, transparency, text labels.
- **Bubble layer** — circles sized & colored by metric.
- **3D column layer** — extruded columns by metric (height + color).
- **Heat-map layer** — weight field, radius, intensity, color gradient, zoom-scaled.
- **Filled map / choropleth** — region polygons shaded by value (gradient or category), border color/width/opacity.
- **Cluster bubbles** — zoom-based aggregation; cluster size/color/text/border; click to expand.
- **Path / line layer** — connect points by path_id + order; stroke color/width/dash.
- **Pie-chart layer** — category pie overlay per location.
- **Reference layer** — overlay an uploaded GeoJSON/KML/Shapefile with conditional formatting.
- **Tile layer** — custom XYZ/WMS raster tiles.
- **Traffic layer** — real-time flow + incidents.

### D. Symbology / data-driven styling
- Color by category (palette) or numeric gradient with stops (conditional formatting).
- Size scaling (min/max px by metric), opacity, border color/width, icon picker, rotation field.
- Per-layer min/max zoom visibility band; position above/below labels/roads.

### E. Interactivity
- Tooltips/popups on hover **and** click, field-driven templates (pick which columns show).
- Selection tools: lasso / box / circle select → cross-filter the bound dataset.
- Legend (size ramp + categorical swatches), drill-down / location hierarchy.

### F. Drawing & measure tools
- Drawing toolbar: point, line, polygon, rectangle, circle; edit + delete shapes.
- Measure distance (line) and area (polygon) with live readout.

### G. Filters & time
- Attribute filters on bound fields (range / category / search).
- **Time slider**: bind a time field, scrub + play/animate; per-frame filter of features.

### H. Spatial analytics
- **Geofencing**: define a fence polygon, point-in-polygon test, inside/outside counts, alert on enter/exit.
- Spatial search (within radius / within polygon), nearest, route overlay.

### I. Data binding
- Lat/lon columns, geometry columns (WKT/WKB/GeoJSON), or **geocoding** of addresses/place names; bind to a table/dataset (Loom: Lakehouse / KQL / Ontology).

## Loom coverage

| # | Real capability | Status | Notes |
|---|---|---|---|
| A | Interactive pan/zoom/rotate/pitch | ✅ built | real Azure Maps Web SDK canvas (`azure-maps-canvas.tsx`); pan/scroll-zoom/right-drag rotate+tilt |
| A | Map settings (center/zoom/heading/pitch, auto-zoom) | ✅ built | `Auto-zoom to data` Switch; off → persisted `state.view` (center/zoom/bearing/pitch) restored on load |
| A | Controls (zoom/compass/pitch/style/fullscreen/scale) | ✅ built | built-in Zoom/Compass/Pitch/Scale toggles + Fullscreen button; style via the basemap picker |
| B | Basemap style picker | ✅ built | Fluent `Dropdown` of the 10 atlas styles; live `map.setStyle` switch, persisted in `state.basemap` |
| C | Marker/symbol layer (icons, rotation, per-category) | ⚠️ partial | bubbles + name labels (`SymbolLayer`); icon picker / rotation field / per-category icon still ❌ |
| C | Bubble layer (size+color by metric) | ✅ built | `BubbleLayer` size-by-metric (min/max px) + value color ramp + hover/click popup |
| C | 3D column layer | ❌ MISSING | — (P2) |
| C | Heat-map layer | ✅ built | real `HeatMapLayer` — weight field, radius, zoom-scaled, color gradient |
| C | Filled map / choropleth | ✅ built | `PolygonLayer` value-shaded (low/high ramp) + border `LineLayer` + opacity + zoom band; per-category palette still ❌ |
| C | Cluster bubbles (zoom aggregation) | ✅ built | real clustered `DataSource`; sized/colored by count, count labels, click-to-expand |
| C | Path / line layer | ❌ MISSING | — (P2) |
| C | Pie-chart layer | ❌ MISSING | — (P2) |
| C | Reference layer (upload GeoJSON) | ⚠️ partial | manual GeoJSON paste tab; no upload, no conditional format |
| C | Tile layer (custom XYZ) | ❌ MISSING | — (P2) |
| C | Traffic layer | ❌ MISSING | — (P2) |
| D | Symbology panel (color/size/opacity/border/icon/rotation/zoom band) | ⚠️ partial | per-layer color (solid + low/high ramp), size-by-metric, opacity, min/max-zoom band, tooltip fields built; icon picker + rotation field still ❌ |
| E | Tooltips / popups (templates) | ✅ built | field-driven `atlas.Popup` on hover **and** click; per-layer "Tooltip fields" multiselect |
| E | Selection tools / cross-filter | ❌ MISSING | — (P1 #7) |
| E | Legend | ✅ built | auto legend (size/color ramp + categorical swatch) Loom-token card pinned bottom-right |
| F | Drawing toolbar | ❌ MISSING | — (P1 #6) |
| F | Measure distance/area | ❌ MISSING | — (P1 #6) |
| G | Attribute filters | ❌ MISSING | — (P1 #7) |
| G | Time slider / animation | ❌ MISSING | — (P2 #9) |
| H | Geofencing + alert | ❌ MISSING | — (P2 #10) |
| H | Spatial search (radius/within) | ❌ MISSING | — (P2) |
| I | Lakehouse / KQL / Ontology binding | ✅ built | real backend (Synapse Serverless / ADX / Weave) — unchanged, strong |
| I | Geometry-column (WKT/WKB) binding | ⚠️ partial | lat/lon only; `geo-editors` detects WKT/WKB but `map` doesn't |
| I | Geocoding (address → lat/lon) | ❌ MISSING | requires raw lat/lon today (P1 #8) |

Score after the interactive-canvas retarget: **12 rows ✅, 4 ⚠️ partial, 11 ❌**. Grade ≈ **B** — a real
interactive Azure Maps surface with live BubbleLayer/HeatMapLayer/PolygonLayer/clusters, basemap switching,
controls, persisted view, field-driven popups and a legend, all over the unchanged real data backend.
Remaining ❌/⚠️ are the analyst/Foundry-class tools (drawing+measure, filters+cross-filter, geocoding,
time slider, geofencing, extra layer types) tracked as P1/P2 below.

> **Status — this PR (interactive-canvas retarget):** P0 1–4 + P1 #5 (legend) landed. The `MapEditor`
> (`phase4-editors.tsx`) now renders on the shared `lib/components/graph/azure-maps-canvas.tsx` (real Azure
> Maps Web SDK) instead of the static `GeoJsonMap`, brokered by the new `GET /api/items/map/[id]/map-token`
> route (`resolveMapsBackend` → Console-UAMI AAD token, or `LOOM_AZURE_MAPS_KEY` /
> `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY`). When no Maps account is configured the canvas shows an honest Fluent
> MessageBar naming the env var + bicep AND still draws the bound features on the offline `GeoJsonMap`
> overlay (never blank). The `…/data` binding path (Lakehouse/KQL/Ontology) is untouched.

## Build plan

Foundation move (do first; unblocks most rows): **lift the interactive Azure Maps SDK harness out of
`report/map-visual.tsx` into a shared `lib/components/graph/azure-maps-canvas.tsx`** — loads
`azure-maps-control` from the atlas CDN, AAD token from a new `/api/items/map/[id]/map-token` mirroring
the report route, and falls back to the existing SVG `GeoJsonMap` when no Maps account is bound (honest
gate, never blank). Every layer/control/tool below mounts on that canvas. No Fabric, no new Azure service
beyond the already-deployed `Microsoft.Maps/accounts`.

### P0 — make it a real map (visible parity uplift)
1. **Interactive Azure Maps canvas** (rows A,B). Retarget `MapEditor` from `GeoJsonMap` to the shared
   `AzureMapsCanvas`; render bound features as real `BubbleLayer`/`SymbolLayer`/`HeatMapLayer`/`PolygonLayer`.
   Backend: `/api/items/map/[id]/map-token` → `maps-client.ts` AAD token (Console UAMI + Azure Maps Data
   Reader). Honest MessageBar + SVG fallback when `LOOM_AZURE_MAPS_ACCOUNT` unset.
2. **Basemap style picker + controls** (rows A,B). Fluent `Dropdown` of the 10 atlas styles + a "Controls"
   `Toolbar` (zoom/compass/pitch/style/fullscreen) toggles; persist `state.view` (center/zoom/bearing/pitch
   + auto-zoom `Switch`). Backend: client `map.setStyle`/`setCamera`; view persisted via PATCH `/api/items/map/[id]`.
3. **Layer panel with symbology** (rows C,D). Replace the flat layer rows with a left **layer panel** (cards,
   drag-reorder, eye toggle, settings drawer): layer type, color (gradient stops + categorical palette via
   Fluent `SwatchPicker`), size-by-metric (min/max px `Slider`), opacity, border, icon picker, min/max-zoom
   band. Backend: client styling against bound GeoJSON; persisted in `state.layers[]` (extend `MapLayer`).
4. **Tooltips / popups** (row E). Per-layer "Tooltip fields" multiselect → `atlas.Popup` on hover+click
   (reuse `attachHoverPopup` from map-visual). Backend: client-only over already-bound rows.

### P1 — analyst tools
5. **Legend** (row E). Auto legend from active layers (size ramp + categorical swatches), Loom-token card
   pinned bottom-right; reuse the report visual's legend markup.
6. **Drawing toolbar + measure** (row F). `azure-maps-drawing-tools` module (same CDN) → DrawingManager with
   point/line/polygon/rectangle/circle; live distance/area readout via `atlas.math`. Persist drawn shapes into
   `state.annotations` (GeoJSON). Client-only.
7. **Attribute filters + selection cross-filter** (rows E,G). Filter rail (range/category/search) over bound
   columns; box/lasso select → highlight + filter. Push predicates into the binding: re-issue
   `/api/items/map/[id]/data` with a WHERE/`where` clause (real Synapse/ADX filter, not client slice).
8. **Geometry-column + geocoding binding** (row I). Add geometry-column mode (WKT/WKB → GeoJSON, reuse
   `geo-editors` detect) and an "address column" mode → Azure Maps **Search/Geocode** REST
   (`atlas.microsoft.com/search/address`) via a new `/api/items/map/[id]/geocode` route (AAD token, batch
   geocode). Honest gate when Maps account absent.

### P2 — advanced / Foundry-class
9. **Time slider / animation** (row G). Bind a time field; Fluent `Slider` + play `Button` scrubs; per-frame
   client filter of features (optional server re-query for large sets). Persist time field + window in `state.time`.
10. **Geofencing + alert** (row H). Draw a fence polygon (reuse #6) → point-in-polygon counts via ADX
    `geo_point_in_polygon` (binding already hits ADX) or Synapse `STIntersects`; wire an enter/exit alert to an
    **Azure Monitor scheduled-query alert** (per no-fabric: activator = Monitor) through a new
    `/api/items/map/[id]/geofence` route. Honest gate naming the Monitor role.
11. **Extra layers**: 3D column (PolygonExtrusion / extruded bubble), path/line by path_id+order, pie overlay,
    custom **Tile layer** (XYZ URL), **Traffic** (`atlas.layer` traffic flow/incidents). All client-side on the
    SDK canvas; config persisted per layer.

## Backend per control (Azure-native, no Fabric on the default path)
- Token: `/api/items/map/[id]/map-token` → `lib/azure/maps-client.ts` AAD (Console UAMI + Azure Maps Data Reader on `Microsoft.Maps/accounts`).
- Binding (existing): POST `/api/items/map/[id]/data` → Synapse Serverless TDS / ADX Kusto / Weave (Apache AGE).
- Geocode: `/api/items/map/[id]/geocode` → Azure Maps Search REST.
- Geofence: `/api/items/map/[id]/geofence` → ADX `geo_point_in_polygon` / Synapse `STIntersects` + Azure Monitor scheduled-query alert.
- Persist: PATCH `/api/items/map/[id]` (Cosmos) — `{ geojson, binding, layers, view, annotations, time }`.
- Honest gates: `LOOM_AZURE_MAPS_ACCOUNT` (interactive map/geocode), `LOOM_SYNAPSE_WORKSPACE` (Lakehouse), KQL item (KQL), `LOOM_WEAVE_PG_FQDN` (Ontology), Monitor role (geofence alert). Each renders the full UI + a Fluent MessageBar naming the exact remediation; SVG overlay always renders.
