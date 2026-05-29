# geo-map — parity with Azure geospatial map config + data overlay

Source UI: Azure Maps + Synapse/Fabric geospatial map rendering ·
https://learn.microsoft.com/azure/azure-maps/about-azure-maps

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Map account / style config | settings |
| 2 | Tile layer reference | layer config |
| 3 | Data overlay (GeoJSON) | data source |
| 4 | Map render with overlay | map control |
| 5 | Validate overlay | n/a |
| 6 | Save | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | account + style inputs |
| 2 | ✅ built | tile layer URL reference field |
| 3 | ✅ built | GeoJSON overlay Monaco editor (sample seeded) |
| 4 | ✅ built | `GeoJsonMap` renders the overlay live; optional Azure Maps static basemap when key set |
| 5 | ✅ built | Validate overlay ribbon action |
| 6 | ✅ built | GeoSaveBar + Ctrl+S → Cosmos item state |

## Backend per control
- Save → PATCH `/api/cosmos-items/geo-map/[id]` (Cosmos).
- Render: client-side `GeoJsonMap`. Vector overlay always renders; Azure Maps raster basemap is optional (`NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY`).
- Honest-gate: info MessageBar names the Maps env var / `Microsoft.Maps/accounts` — no feature blocked. The previously-disabled "Preview" button is replaced by a working live render + Validate.
