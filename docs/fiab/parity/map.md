# map — parity with Azure Maps (render + layers + data overlay)

Source UI: Azure Maps Web SDK / portal map experiences ·
https://learn.microsoft.com/azure/azure-maps/about-azure-maps ·
https://learn.microsoft.com/rest/api/maps/render/get-map-static-image

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Map render | map control |
| 2 | Data layer / GeoJSON overlay | atlas.data.Source + layers |
| 3 | Feature editing (GeoJSON) | data source editor |
| 4 | Basemap style | style picker |
| 5 | Validate GeoJSON | n/a |
| 6 | Save | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | `GeoJsonMap` SVG renderer — renders offline (no key required) |
| 2 | ✅ built | GeoJSON features (Point/Line/Polygon + Multi*) drawn as a real SVG overlay; optional Azure Maps static raster basemap behind it when `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` set |
| 3 | ✅ built | Monaco GeoJSON editor, live re-render |
| 4 | ✅ built | basemap style flows into the static-map URL |
| 5 | ✅ built | Validate ribbon action |
| 6 | ✅ built | SaveBar + Ctrl+S → Cosmos item state |

## Backend per control
- Save → PATCH `/api/items/map/[id]` (Cosmos).
- Render: client-side `GeoJsonMap` (equirectangular projection of lon/lat into SVG viewport). The vector overlay always renders; the Azure Maps raster basemap is an optional layer behind it.
- Honest-gate: an info MessageBar names `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` + `Microsoft.Maps/accounts` for the raster basemap — but no feature is blocked on it.
