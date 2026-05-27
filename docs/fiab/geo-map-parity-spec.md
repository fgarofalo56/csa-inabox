# Loom Geo Map Editor — Azure-native parity spec

> Reference: **Azure Maps Studio** + Azure Maps Web SDK v3 (`atlas.Map`), captured 2026-05-26 by the catalog agent. There is no Fabric equivalent — `geo-map` is a Loom-native item that supersedes the retired Bing Maps Web Control SDK.

## What's there in the Azure-native experience

### Azure Maps Studio (portal blade) chrome
- Account header: `Microsoft.Maps/accounts/<name>` with pricing tier (G1/G2/S0), subscription, region, geographic scope badge (US/EU/Global)
- Left rail: **Authentication** · **Subscription keys** · **Managed identities** · **CORS** · **Creator** (indoor maps) · **Geographic scope**
- **Studio** sub-app launches the Web SDK rendering surface with developer-grade tooling

### Map rendering surface (Web SDK `atlas.Map`)
- **Basemap style selector** — `road`, `road_shaded_relief`, `satellite`, `satellite_road_labels`, `grayscale_dark`, `grayscale_light`, `night`, `high_contrast_dark`, `high_contrast_light`, `blank`, `blank_accessible`
- **View controls** — zoom in/out, compass (rotate), pitch (tilt 0–60°), full-screen toggle, fit-to-bounds
- **Layer panel** — ordered list of `SymbolLayer` / `BubbleLayer` / `LineLayer` / `PolygonLayer` / `HeatMapLayer` / `TileLayer` / `ImageLayer` instances with visibility toggle + opacity slider
- **Data sources** — `DataSource` (in-memory GeoJSON, supports clustering) and `VectorTileSource` (server-driven PBF tiles per Mapbox Vector Tile spec)
- **Drawing tools** — point/line/polygon/circle/rectangle add, edit-mode handles, snap-to-feature, measure tool
- **Popup** — anchor-aware HTML popup on feature click; data-driven content templates
- **Spatial IO module** — read/write KML, KMZ, GeoRSS, GeoJSON, GPX, GML, WKT, CSV, WMS, WMTS, WFS via `atlas.io.read()` / `SimpleDataLayer`
- **Traffic overlay** — `setTraffic({ incidents, flow })` (live tiles from Azure Maps traffic services)
- **Indoor maps** — `atlas.indoor.IndoorManager` for Creator tilesets (facility, floor picker, wayfinding)

### Right-click context menu (observed in Studio sandbox)
- Add point here · Add polygon · Copy lat/lon · Center here · Measure from here · Open in OSM/Bing for cross-check

### Sibling artifacts created in the same account
- **Creator dataset** (`Microsoft.Maps/accounts/creators/datasets`) — indoor map source-of-truth from a converted DWG/IMDF package
- **Creator tileset** — vector tiles rendered from a dataset
- **Map configuration** — default zoom/center/style bundle

## What Loom already has
- ✅ `GeoMapEditor` stub renders Azure Maps account name + style + tile-layer URL fields
- ✅ Honest `MessageBar` warning when `LOOM_AZURE_MAPS_ACCOUNT` env var is not configured (falls back to OSM tiles)
- ✅ Cosmos-backed state save through the generic item shell

## What's missing for parity
1. **Live `atlas.Map` canvas** — embed the Web SDK in the editor body, not just a form. Render with the configured style + the user's saved overlay layers.
2. **Style picker** — dropdown bound to the 11 documented basemap styles (currently free-text)
3. **Layer manager UI** — add/edit/reorder/delete `SymbolLayer` · `BubbleLayer` · `LineLayer` · `PolygonLayer` · `HeatMapLayer` · `TileLayer` · `ImageLayer` with per-layer opacity + visibility
4. **Data source manager** — wire `DataSource` (link to a `geo-dataset` item) and `VectorTileSource` (URL or paired tileset)
5. **Drawing tools palette** — point/line/polygon/circle/rectangle, edit-mode handles, save shapes back to the linked `geo-dataset`
6. **Spatial IO importer** — drag-drop or "import from ADLS path" for KML / GPX / KMZ / Shapefile / GeoJSON; uses `atlas.io.read`
7. **Traffic + weather overlays** — toggle for `incidents` / `flow` tile services + optional NWS / mesonet weather tile URL builders
8. **Geographic scope badge** — surface the account's data residency (US / EU / Global) from ARM and show in the header
9. **Auto-pairing pattern** — when a Loom user creates a `geo-map` item, also offer to auto-create a sibling `geo-dataset` item that the map's primary `DataSource` will read from
10. **Indoor map mode** — separate tab that switches into `atlas.indoor.IndoorManager` when the account has a Creator resource

## Backend mapping
| Loom surface | Real Azure call |
|---|---|
| List Azure Maps accounts | ARM `GET /subscriptions/{sub}/providers/Microsoft.Maps/accounts?api-version=2024-07-01-preview` |
| Get account keys | ARM `POST .../Microsoft.Maps/accounts/{name}/listKeys` |
| Render canvas | Browser Web SDK `atlas.Map` with subscription key or AAD token via `authOptions` |
| Tile layer | `https://atlas.microsoft.com/map/tile?api-version=2024-04-01&tilesetId=microsoft.base.road&x={x}&y={y}&zoom={z}` |
| Traffic tiles | `GET https://atlas.microsoft.com/traffic/incident/tile/png?...` |
| Creator dataset list | ARM `GET .../Microsoft.Maps/accounts/{name}/creators/{creator}/datasets` |
| Import KML/Shapefile | `atlas.io.read(url|blob)` client-side; persist parsed GeoJSON to the linked `geo-dataset` |

## Required Azure resources
- `Microsoft.Maps/accounts` (G2 tier minimum for production; S0 free tier OK for dev)
- (optional) `Microsoft.Maps/accounts/creators` for indoor maps + Creator dataset/tileset/style/map-configuration sub-resources
- ADLS Gen2 container for storing imported KML/Shapefile/GeoJSON sources (already covered by Loom's lakehouse storage)
- Role: `Azure Maps Data Reader` + `Azure Maps Data Contributor` granted to the Loom app's managed identity

## Build plan
| Phase | Work |
|---|---|
| **Backend** | New `/api/items/geo-map/[id]/render-token` → returns SAS-style Azure Maps SAS token (or AAD-issued token) scoped to the linked account. New `/api/items/geo-map/[id]/style` (GET/PUT) → persists style + layer config to Cosmos. New `/api/items/geo-map/[id]/import` (POST blob/url) → calls Spatial IO and writes GeoJSON to ADLS at `geo/maps/<id>/imports/<name>.geojson`. |
| **Frontend** | Replace stub form with full editor: live `atlas.Map` canvas via `azure-maps-control` npm package; right rail with style picker · layer manager · data sources · drawing tools; toolbar with Save · Import · Export · Toggle traffic · Toggle indoor. |
| **Auto-pairing** | On `POST /api/workspaces/[id]/items` with `itemType=geo-map`, offer to create a sibling `geo-dataset` item pre-wired as the map's primary source. |

## Estimated effort
**2–3 focused sessions.** Backend in session 1 (account list + token mint + style persistence), Web SDK canvas + layer manager in session 2, drawing tools + Spatial IO importer + traffic/indoor in session 3.
