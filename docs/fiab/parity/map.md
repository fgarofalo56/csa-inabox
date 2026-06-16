# map — parity with the Fabric IQ Map (dataset binding + layers) and Azure Maps render

Source UI: Microsoft Fabric IQ Map (geospatial visualization over Lakehouse /
KQL / Ontology) · https://learn.microsoft.com/fabric/fundamentals/fabric-iq ·
Azure Maps Web SDK / static render ·
https://learn.microsoft.com/azure/azure-maps/about-azure-maps ·
https://learn.microsoft.com/rest/api/maps/render/get-map-static-image

The Fabric Map binds a geo-dataset and composes heatmap / choropleth /
point-cluster layers over it, embeddable in reports and dashboards. Per
no-fabric-dependency.md the binding is realized with **Azure-native** backends —
Synapse Serverless (Lakehouse), Azure Data Explorer (KQL), Weave/Apache AGE
(Ontology) — not Power BI / Fabric.

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Map render | map control |
| 2 | GeoJSON data overlay | atlas.data.Source + layers |
| 3 | Manual feature editing (GeoJSON) | data source editor |
| 4 | Basemap style / raster | style picker |
| 5 | Validate GeoJSON | n/a |
| 6 | Save | save |
| 7 | **Bind a geo-dataset** (Lakehouse table / KQL query / Ontology entity) | Fabric Map "add data" |
| 8 | **Point layer** | layer types |
| 9 | **Heatmap layer** | layer types |
| 10 | **Cluster layer** | layer types |
| 11 | **Choropleth layer** | layer types |
| 12 | **Value/weight-driven styling** | layer styling |
| 13 | Embeddability (report/dashboard) | embed |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | `GeoJsonMap` SVG renderer — renders offline (no key required) |
| 2 | ✅ built | GeoJSON features (Point/Line/Polygon + Multi*) drawn as a real SVG overlay; optional Azure Maps static raster basemap behind it when `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` set |
| 3 | ✅ built | Monaco GeoJSON editor (GeoJSON tab), live re-render |
| 4 | ✅ built | basemap style flows into the static-map URL |
| 5 | ✅ built | Validate ribbon action |
| 6 | ✅ built | SaveBar + Ctrl+S → Cosmos item state (now persists `binding` + `layers`) |
| 7 | ✅ built | Data binding tab: source = Lakehouse (Synapse SQL) / KQL (ADX) / Ontology (Weave). Map lat/lon (+ value/label) columns or supply a SQL/KQL query; "Run binding" queries the **real** backend and folds rows into the map. Honest-gates name `LOOM_SYNAPSE_WORKSPACE` / the KQL item / `LOOM_WEAVE_PG_FQDN` when unset |
| 8 | ✅ built | Point layer (value-colored markers) |
| 9 | ✅ built | Heatmap layer (radial-gradient intensity, weighted) |
| 10 | ✅ built | Cluster layer (sized + count-labeled bubbles, weighted) |
| 11 | ✅ built | Choropleth layer (polygon shading by weight; non-polygon → colored dot) |
| 12 | ✅ built | each layer takes a `weightProp` (numeric value column/property) + radius; low/high color ramp |
| 13 | ⚠️ honest-gate | the map persists as a Cosmos item with its binding+layers; embedding into report/dashboard surfaces is tracked with the report-render work — the rendered SVG is the embeddable artifact |

## Backend per control
- Save → PATCH `/api/items/map/[id]` (Cosmos); state = `{ geojson, binding, layers }`.
- Run binding → POST `/api/items/map/[id]/data` →
  - `lakehouse`: `executeQuery(serverlessTarget(db), sql)` (Synapse Serverless TDS) — table+lat/lon → generated `SELECT`, or a SQL override aliasing `lat,lon,value,label`.
  - `kql`: `executeQuery(db, kql)` (Azure Data Explorer) — table+lat/lon → generated `project`, or a KQL override.
  - `ontology`: `listObjects(type, top)` over Weave (Apache AGE on PG) — reads lat/lon/value/label properties; type must be a declared ontology class.
- Render: client-side `GeoJsonMap` layers (point/heatmap/cluster/choropleth) over an equirectangular projection. Vector overlay always renders; Azure Maps raster basemap optional behind it.
- Honest-gates (no feature blocked unconditionally): `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` (raster basemap); `LOOM_SYNAPSE_WORKSPACE` (Lakehouse source); a KQL database item (KQL source); `LOOM_WEAVE_PG_FQDN` (Ontology source). A bound source with no numeric geo columns returns a precise `NO_GEO_COLUMNS` message.
