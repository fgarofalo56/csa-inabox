# Azure Maps → OSS MapLibre + self-hosted tiles (GCC-High replacement)

**Status:** IMPLEMENTED (branch `feat/gov-maps-oss`) — owed: browser-E2E receipt (Track-0).
**Gate:** `svc-azure-maps` (`LOOM_MAPS_BACKEND` + `LOOM_AZURE_MAPS_CLIENT_ID` / `LOOM_AZURE_MAPS_KEY`)
**Boundary:** GCC-High / IL5 / DoD — Azure Maps is **not** available.
**Rule basis:** `no-fabric-dependency.md`, `no-vaporware.md`, `ui-parity.md`.

---

## 1. Why this exists

Azure Maps (the `atlas.microsoft.com` data plane) has limited-to-no Government
availability. `params/gcc-high.bicepparam` pins `azureMapsEnabled = false` and
`modules/admin-plane/azure-maps.bicep` already gates on
`boundary == Commercial || GCC`, so in GCC-High every map surface honest-gates.
This replaces the Azure Maps data plane with an **OSS MapLibre GL** front end over
a **self-hosted vector-tile server on Azure Container Apps** — no external map
host, fully sovereign.

### What already exists (grounding)

- `apps/fiab-console/lib/azure/maps-client.ts` — server-side resolver
  `resolveMapsBackend()`. Opt-in via `LOOM_MAPS_BACKEND` (const
  `LOOM_MAPS_ENV = 'LOOM_MAPS_BACKEND'`); returns an **honest verdict** with the
  exact env var when unset. Token scoped to `atlas.microsoft.com` ONLY (never
  Fabric / Power BI). Already contemplates a sovereign scope override
  (`LOOM_AZURE_MAPS_SCOPE`).
- Consumers (all keep the full surface + real aggregate rows on the gate path):
  `lib/components/graph/azure-maps-canvas.tsx`, `lib/editors/report/map-visual.tsx`,
  `lib/editors/report-designer.tsx`, `lib/components/eventstream/geo-operator-config.tsx`,
  `lib/components/admin/azure-maps-card.tsx`, and the token routes
  `app/api/items/{report,map}/[id]/map-token/route.ts`.

The map visuals draw from the SAME real `/query` aggregate rows regardless of
backend — so swapping the tile/render layer does not touch the data path.

---

## 2. Backend selection

Extend `LOOM_MAPS_BACKEND` (already the opt-in selector, matched by the
`/_BACKEND$/` allowlist pattern) with a third value:

| `LOOM_MAPS_BACKEND` | Render layer | Tiles | Boundary |
|---|---|---|---|
| `azure-maps` | Azure Maps Web SDK | atlas.microsoft.com | Commercial / GCC |
| unset | honest gate (default) | — | any |
| **`maplibre`** (new) | **MapLibre GL JS (OSS)** | **self-hosted tile server (ACA)** | **GCC-High / IL5 / DoD** |

`resolveMapsBackend()` gains a `mode: 'maplibre'` verdict returning the
self-hosted style URL (`LOOM_MAPS_TILE_URL`) instead of an AAD token / key. No
credential is needed — the tile server is in-VNet and Entra-gated at ingress.

---

## 3. Self-hosted tile server (ACA)

A stateless **`tileserver-gl`** (OSS, BSD) container serving MBTiles:

- **Image:** `maptiler/tileserver-gl` (or a hardened rebuild in the Loom ACR for
  the sovereign image matrix). Serves vector tiles + a MapLibre style JSON +
  glyphs/sprites — everything the browser SDK needs, no external fetch.
- **Data:** an MBTiles extract (OpenMapTiles schema, ODbL) staged into the DLZ
  storage account (`maps` container) and mounted / downloaded at start. US extract
  is sufficient for federal use; region extracts are a config knob.
- **Ingress:** internal to the Container Apps Env, fronted by the Console (same
  Entra session guard as the `map-token` routes today) — no public map endpoint.
- **Scale:** scale-to-zero; tiles are immutable + cache-friendly.

### Bicep shape

New `platform/fiab/bicep/modules/integration/maps-tileserver.bicep` (mirrors the
existing OSS-app modules `modules/integration/wrangler.bicep` /
`modules/integration/dbt-runner.bicep` — same internal-ingress ACA pattern):

```bicep
param mapsTileServerEnabled bool = false   // opt-in; ON in gcc-high.bicepparam
param location string
param caeId string
param acrLoginServer string
param imageTag string
// → outputs.tileServerInternalEndpoint  (https://loom-maps-tiles.<cae-domain>)
```

Wire in `modules/admin-plane/main.bicep` next to the wrangler/dbt apps
(`wranglerActive`-style `mapsTileServerActive = mapsTileServerEnabled &&
containerPlatform=='containerApps' && deployAppsEnabled`) and emit into the
console `apps[]` env:

```bicep
{ name: 'LOOM_MAPS_BACKEND', value: mapsTileServerActive ? 'maplibre' : loomMapsBackend }
{ name: 'LOOM_MAPS_TILE_URL', value: mapsTileServerActive ? '${mapsTiles.outputs.tileServerInternalEndpoint}/style.json' : '' }
```

`LOOM_MAPS_TILE_URL` is bicep-emitted (not allowlisted) since it ships with the
Gov deployment, keeping `check-env-sync.mjs` green.

---

## 4. Editor integration

MapLibre GL JS (`maplibre-gl`, BSD-3) is a near drop-in for the Azure Maps Web
SDK for the bubble/choropleth layers Loom uses:

- `azure-maps-canvas.tsx` / `map-visual.tsx`: branch on the resolver `mode`.
  `azure-maps` keeps the `atlas` SDK; `maplibre` instantiates `new maplibregl.Map({
  style: LOOM_MAPS_TILE_URL })` and renders the SAME GeoJSON built from the real
  `/query` aggregate rows (bubbles = circle layer, choropleth = fill layer).
- The geo picker in `geo-operator-config.tsx` uses the tile server's search
  glyphs; where geocoding is needed, a self-hosted **Nominatim** (OSS) is the
  follow-on (out of scope here — the aggregate rows already carry lat/lon).
- `azure-maps-card.tsx` (admin): shows the backend + tile-server health instead
  of the Azure Maps account row when `maplibre`.

No surface is removed — parity is preserved per `ui-parity.md`; only the render
engine + tile source change.

---

## 5. Gate wiring

`svc-azure-maps` `anyOf` gains `LOOM_MAPS_TILE_URL` so the MapLibre path satisfies
the gate honestly (real self-hosted tiles), alongside the existing Azure Maps
credentials:

```ts
required: ['LOOM_MAPS_BACKEND'],
anyOf: [['LOOM_AZURE_MAPS_CLIENT_ID', 'LOOM_AZURE_MAPS_KEY', 'LOOM_MAPS_TILE_URL']],
```

Remediation: "Map visuals render on the self-hosted OSS MapLibre tile server in
GCC-High (`LOOM_MAPS_BACKEND=maplibre`); Azure Maps (`LOOM_AZURE_MAPS_CLIENT_ID`)
is the Commercial/GCC path. No Power BI / Fabric required."

---

## 6. Acceptance

On a Gov deployment with `azureMapsEnabled=false` and
`mapsTileServerEnabled=true`, the report Map visual + graph geo canvas render real
bubbles/polygons from live aggregate rows **against the in-VNet tile server, with
no `atlas.microsoft.com` egress** (network trace receipt), per
`no-vaporware.md` + `no-fabric-dependency.md` verification.

## 7. Licensing note

MapLibre GL JS (BSD-3), tileserver-gl (BSD-2), OpenMapTiles schema (BSD) + map
data (OpenStreetMap, ODbL — attribution required in the map footer). All
redistributable in a sovereign image; add the ODbL attribution to the map
canvas footer.

## 8. Implementation (2026-07-20)

Delivered on `feat/gov-maps-oss`. Differs from the design in two respects, both
for sovereignty correctness:

- **Module path:** `platform/fiab/bicep/modules/compute/loom-maps-app.bicep`
  (not `integration/maps-tileserver.bicep`), mirroring the dbt-runner/wrangler
  ACA shape. Wired in `modules/admin-plane/main.bicep` as a `var`-gated app
  (`mapsTileServerEnabled = boundary is GCC-High/IL5`; `mapsTileServerActive`
  also requires containerApps + deployApps) to stay under the 256-param cap.
- **Browser reachability:** the tile server is INTERNAL-ingress, so the browser
  (off-VNet) cannot reach it. The Console fronts it via a new session-guarded
  proxy `GET /api/maps/tiles/[...path]` (`app/api/maps/tiles`), which forwards
  to `LOOM_MAPS_TILE_URL` in-VNet and rewrites style.json sub-resource URLs to
  proxy paths. `resolveMapsBackend()` hands the client only the proxy paths
  (`/api/maps/tiles/style.json`, `…/maplibre-gl.js`, `…/maplibre-gl.css`) — the
  internal host never leaks. No public map endpoint.

Files:
- `lib/azure/maps-client.ts` — `maplibre` verdict + `resolveMapsTileOrigin()` +
  `isMapLibreConfigured()`.
- `app/api/maps/tiles/[...path]/route.ts` — the session-guarded tile proxy.
- `lib/components/graph/maplibre-canvas.tsx` — OSS MapLibre GL renderer (circle /
  heatmap / cluster / fill, popups, legend, auto-fit). Loads maplibre-gl JS/CSS
  from the in-VNet proxy — no CDN.
- Consumers branch on mode: `azure-maps-canvas.tsx` (graph/map editor),
  `report/map-visual.tsx` (report Map visual), plus the `map`/`report` map-token
  routes. `map/[id]/geocode` uses OSS Nominatim (`LOOM_MAPS_GEOCODE_URL`) or an
  honest sub-feature gate; `/api/maps/static` honest-gates on maplibre (the
  atlas Render v2 raster endpoint is atlas-only).
- Gate `svc-azure-maps` (`lib/admin/env-checks.ts`) anyOf gains
  `LOOM_MAPS_TILE_URL` — flips "configured" honestly on a Gov deploy.

**Owed (Track-0):** an in-browser E2E receipt showing a map surface rendering
self-hosted tiles with `LOOM_MAPS_BACKEND=maplibre` set and NO
`atlas.microsoft.com` egress (network trace), per §6.
