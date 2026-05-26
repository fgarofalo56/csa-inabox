# Loom Map Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Fabric Maps (preview, Real-Time Intelligence workload) = interactive geospatial canvas powered by Azure Maps, with vector + imagery layers sourced from Eventhouses (KQL), Lakehouses (GeoJSON / Parquet / COG), Ontology entity types, and external services. Map items are **semantic visualizations** — layers represent ontology entity types, not raw geometry.

## UI components

### Top ribbon
- **New layer** — picker by source type (Kusto / Lakehouse / Ontology / Imagery / External)
- **Save** · **Refresh** · **Share**
- **Map style** dropdown — Road · Grayscale · Satellite · Hybrid · Night
- **Settings** — center, zoom, pitch, bearing, language, `view` (geopolitical), `renderWorldCopies`
- **Style overrides** — country/region · adminDistrict · adminDistrict2 · roadDetails · buildingFootprint visibility toggles

### Map canvas (Azure Maps web SDK)
- Base map (vector tiles from Azure Maps)
- Layer stack rendered in defined z-order (imagery beneath, vector above)
- Pan / zoom / pitch / bearing controls
- "Zoom to fit" per layer
- Tooltips on hover over geometries
- Auto-refresh ticker (e.g. every 5s) for streaming layers

### Explorer pane (left)
- **Fabric items** tab — add Eventhouse / KQL DB / Lakehouse / Ontology as a data source
- **External sources** tab — WMS, WMTS, COG URL
- Tree of attached sources with KQL functions / lakehouse files / ontology entity types
- Per-entity `…` menu → **Show on map** (instantiates a default layer)

### Data layers pane (right)
- Ordered list of active layers
- Per-layer `…` menu: **Zoom to fit** · **Rename** · **Duplicate** · **Filter** · **Delete**
- Visibility toggle, opacity slider, drag to reorder
- Color swatch + legend (when data-driven styling is on)

### Layer settings (per-layer detail)
- **Geometry type**: Point · Bubble · Marker · Heatmap · Line · Polygon · 3D extrusion
- **Latitude / Longitude / Geometry** column pickers (for tabular sources)
- **General settings**: layer color, tooltips (which properties to show on hover), zoom-level visibility range
- **Data labels**: source field, font, halo
- **Data-driven styling ("Color by")**: categorical (up to 100 categories, then "Other") or numeric ramp; per-category custom colors; auto-collapsed legend after 10 items
- **Clustering** (point layers; shared across duplicated layers — known limitation)
- **Refresh interval** (seconds, for streaming Kusto layers)

### Filter panel (per-layer)
- **Add filter** → **New filter** → **Field name**
- Categorical filter (text fields; multi-select with search box)
- Numeric range filter (slider, min/max abbreviated for readability)
- Boolean filter (toggle)
- Date/time filter (start/end pickers; available only on **Kusto and Ontology** layers)
- Multiple filters combined with **AND** logic
- **Lock filter** toggle to prevent unintended changes

### Imagery layer types
- Built-in Azure Maps basemaps (Satellite, Hybrid)
- Cloud Optimized GeoTIFF (COG) from OneLake (EPSG:3857 only; 3-band RGB or 4-band RGBA only — others rejected with error)
- External WMS / WMTS endpoints
- PMTiles vector tiles (note: zoom-level setting unsupported with PMTiles)

### Ontology layers (preview)
- A point/line/polygon layer that represents an ontology entity type (e.g. point=Customer, line=Route, polygon=ServiceArea)
- Ontology defines the **meaning**; Map defines the **visual expression**
- Reuses entity properties as styling/filter inputs
- Inherits the ontology's display-name property for tooltips

### Map item JSON definition (REST)
- `MapDetails` block: `center`, `zoom`, `pitch`, `bearing`, `style`, `showLabels`, `language`, `renderWorldCopies`, `view`, `styleOverrides`
- `LayerSetting[]`: `id`, `name`, `sourceId`, `latitudeColumnName`, `longitudeColumnName`, `geometryColumnName`, `filters[]`, `options` (full styling config)
- Cluster aggregation expressions: `operator` (`+`, `*`, `max`, `min`, `all`, `any`), `mapExpression`, `initialValue`

## What Loom has

- `MapEditor` in `apps/fiab-console/lib/editors/phase4-editors.tsx` (lines 836-863)
- Cosmos persistence of `state.geojson` (raw GeoJSON text)
- JSON validation + feature count
- Plain textarea editor (no visual renderer at all)
- MessageBar discloses "v2.1: GeoJSON storage only" — explicitly defers the interactive renderer to v2.x
- Separately, `GeoMapEditor` in `geo-editors.tsx` for the `geo-map` item type — lists Azure Maps accounts via ARM and is a real config form, but not the same item type
- Grade: **D (Stubbed)** — honest about being a storage-only stub

## Gaps for parity

1. **No map canvas at all** — no Azure Maps web SDK integration
2. **No layer system** — single GeoJSON blob, no stacking
3. **No layer settings pane** — no styling, no tooltips, no labels
4. **No data-driven styling** — no Color by category / ramp
5. **No filter panel** — no categorical / numeric / boolean / date filters
6. **No Kusto-backed streaming layer** — cannot drive a layer from Eventhouse with auto-refresh
7. **No Lakehouse-file picker** — cannot point a layer at a GeoJSON/COG/PMTiles file in OneLake
8. **No Ontology layer support** — cannot bind a layer to an ontology entity type
9. **No imagery layer support** — no COG, WMS, WMTS, or basemap switcher
10. **No style overrides** — country/region/adminDistrict toggles missing
11. **No clustering** for point layers
12. **No view/center/zoom persistence** beyond what GeoJSON contains
13. **No save-as Fabric Map item** — Cosmos doc isn't a real Fabric item

## Backend mapping

- **Azure Maps account** is a hard requirement. Loom already lists accounts via ARM in `GeoMapEditor`; parity needs to consume an Azure Maps subscription key + the **azure-maps-control** JS SDK in the React shell.
- **Streaming layer**: route through existing `/api/eventhouse/query` to fetch KQL function results on a refresh interval; transform rows to GeoJSON client-side.
- **Lakehouse layer**: use the existing OneLake proxy (`/api/onelake/...`) to fetch GeoJSON / COG bytes; for COG, render with the `azure-maps-tile-layer` plugin (requires EPSG:3857).
- **Ontology layer**: depends on Ontology parity work — once entity-type instances are queryable, treat them as another KQL-style source.
- **Fabric Map item REST**: `POST /v1/workspaces/{ws}/items` with `type: "Map"` and a `definition.parts[]` payload matching the documented `MapDetails` / `LayerSetting` schema. This is the path to a real Fabric Map item.
- **Tenant gates**: "Users can use Azure Maps services" + (if outside EU/US) "Data sent to Azure Maps can be processed outside your capacity's geography" must be enabled by the tenant admin — surface as a MessageBar gate.

## Required Azure resources

- **Azure Maps** account (S0 or G2; Loom can list existing accounts but cannot create one without ARM contributor on the RG)
- **Azure Maps subscription key** OR **Azure AD authentication** for the JS SDK
- **Eventhouse / KQL DB** for streaming layers (already wired in FiaB)
- **Lakehouse / OneLake** for static layers (already wired)
- Fabric capacity with **Users can use Azure Maps services** tenant setting enabled
- For COG / custom imagery: storage account with public-read or SAS-token access to the file

## Estimated effort

**5-7 sessions.** The Azure Maps web SDK integration (canvas + pan/zoom/style switcher) is 1 session. Layer system + per-layer settings pane is 2 sessions. Filter panel is 1 session. Streaming Kusto layer + auto-refresh is 1 session. Ontology layer is gated behind the Ontology parity work — when that's ready, 1 more session. Imagery layers (COG, WMS) are 1 session and depend on Azure Maps SDK plugin selection.

**Preview honesty**: Map item is in public preview as of 2026-Q2; Ontology layers within Map are a sub-preview. Some surfaces (PMTiles zoom limitation, COG band restrictions, the exact Style Overrides UI control surface) are documented but not screenshot-exhaustive on Microsoft Learn; spec captures documented behavior and gates the rest behind preview MessageBars.
