# Loom Geo Pipeline Editor — Azure-native parity spec

> Reference: Azure Maps REST APIs (`Route Range` / `Get Geocoding Batch` / `Render Map Tile`), ADF / Synapse Pipelines, Synapse Spark with GeoPandas, captured 2026-05-26 by the catalog agent. There is no Fabric equivalent — `geo-pipeline` is a Loom-native item that schedules spatial ETL: projection, tile generation, isochrone calculation, batch geocoding, format conversion, and spatial joins.

## What's there in the Azure-native experience

### Azure Maps batch + render APIs
- **`Get Route Range` (Isochrone)** — `GET /route/range/json?api-version=2023-10-01-preview&query={lat},{lon}&timeBudgetInSec=1800` returns an isochrone polygon (reachable area within a time / fuel / distance budget). Supports vehicle profile (commercial vehicle dims, weight, axles, cargo, max speed) and async mode for long routes.
- **`Get Geocoding Batch`** — `POST /geocode:batch?api-version=2025-01-01` accepts up to 100 queries synchronously / 200 000 async; GeoJSON in/out.
- **`Get Reverse Geocoding Batch`** — `POST /reverseGeocode:batch?...` same envelope.
- **`Render Map Tile`** — `GET /map/tile?tilesetId=microsoft.base.road&zoom={z}&x={x}&y={y}` for raster + vector tile generation.
- **`Get Map Static Image`** — `GET /map/static/png?...` for headless image generation.

### Spark / Databricks spatial ETL primitives
- **GeoPandas in Synapse Spark / Databricks** — `geopandas.read_file()` for Shapefile/GeoJSON/KML, `to_crs(epsg=...)` for reprojection, `to_parquet()` for GeoParquet write
- **Sedona / Apache Sedona** — JVM-side spatial RDD ops, `ST_*` functions in SparkSQL
- **Databricks SQL `st_transform(geom, srid)`** — column-wise CRS transform (DBR 17.1+)

### ADF / Synapse Pipelines patterns
- **Trigger** — schedule / tumbling window / event-grid (new blob in `geo/raw/`)
- **Source dataset** — ADLS Gen2 path with Shapefile/KML/GeoJSON/GPX/CSV
- **Web activity** — call Azure Maps Geocoding Batch REST with the AAD-bearer header
- **Spark activity** — submit a notebook/job-definition for projection / tile generation / spatial join
- **Sink dataset** — ADLS Gen2 path with GeoParquet (default) or Azure Maps Creator dataset upload

### Common pipeline shapes
1. **Geocode pipeline** — CSV of addresses → Azure Maps batch geocode → GeoJSON / GeoParquet → ADLS sink
2. **Reproject pipeline** — Shapefile in EPSG:2272 (state plane) → GeoPandas `to_crs(4326)` → GeoParquet
3. **Tile generation pipeline** — vector dataset → Tippecanoe / Azure Maps Creator tileset conversion → tile cache in CDN
4. **Isochrone enrichment pipeline** — points table → Azure Maps Route Range per point → store polygon back on row
5. **Spatial join pipeline** — points table + polygons table → S2/H3 cell cover join → write enriched output

## What Loom already has
- ✅ `GeoPipelineEditor` stub — Cosmos-backed pointer to an ADF pipeline with a "geo enrichment" flag
- ✅ ADF pipeline editor (`adf-pipeline`) wired to real ARM/REST and can host the underlying activities
- ✅ Synapse Spark pool editor wired to ARM
- ✅ Honest MessageBar noting that ADF integration for geo flows is deferred to v3.x

## What's missing for parity
1. **Pipeline template library** — pre-built JSON definitions for the 5 common shapes above; one-click "Create pipeline from template"
2. **Geocode-batch activity wrapper** — first-class step in the pipeline graph that calls Azure Maps `geocode:batch` (rather than a raw Web activity); handles the async polling for >100-query batches
3. **Isochrone-enrichment activity** — first-class step that calls `Get Route Range` for each row of an input dataset; surfaces vehicle profile + budget params
4. **Reproject activity** — wraps the Synapse Spark notebook that runs `geopandas.to_crs(srid)`; auto-detects source SRID via `geo-dataset` inspect
5. **Tile-generation activity** — for vector dataset → Azure Maps Creator tileset conversion via the Creator Conversion API; or for raster, calls Tippecanoe in a Spark job
6. **Format-conversion activity** — Shapefile↔GeoJSON↔GeoParquet↔KML pairwise conversions
7. **Spatial-join activity** — S2/H3 cell-cover join (writes the optimized KQL or T-SQL pattern from `geo-query`)
8. **Trigger picker** — schedule / event-grid (new blob in `geo/raw/`) / tumbling window / manual
9. **Run history grid** — per pipeline, last 50 runs with status, input row count, output row count, geocoding success rate, duration
10. **Cost guardrails** — Azure Maps transactions cost money. Show estimated transaction count + estimated cost before running a batch geocode or isochrone enrichment (uses pricing tier from the linked `Microsoft.Maps/accounts`).

## Backend mapping
| Loom surface | Real Azure call |
|---|---|
| Pipeline CRUD | ADF/Synapse ARM `PUT/GET /factories/{f}/pipelines/{name}?api-version=2018-06-01` (already wired via `adf-pipeline` editor) |
| Geocode batch | `POST https://atlas.microsoft.com/geocode:batch?api-version=2025-01-01` with AAD bearer; async polling at `Operation-Location` header |
| Isochrone | `GET https://atlas.microsoft.com/route/range/json?api-version=2023-10-01-preview&query={lat},{lon}&timeBudgetInSec=1800` |
| Reproject job submit | Synapse Spark `POST https://{ws}.dev.azuresynapse.net/livyApi/versions/2019-11-01-preview/sparkPools/{pool}/batches` |
| Creator tileset conversion | `POST https://us.atlas.microsoft.com/conversions?api-version=2023-03-01-preview` (long-running) |
| Render tile (cache warm) | Loop `GET /map/tile?tilesetId=...&x={x}&y={y}&zoom={z}` and write into ADLS / CDN |
| Run trigger | ADF `POST .../pipelines/{name}/createRun?api-version=2018-06-01` |

## Required Azure resources
- ADF or Synapse Pipelines (already deployed via Loom's `adf-pipeline` / `synapse-pipeline` editors)
- Synapse Spark pool (already deployed)
- `Microsoft.Maps/accounts` (G2 tier recommended for production batch volumes)
- ADLS Gen2 containers: `geo/raw/` (input), `geo/staging/`, `geo/curated/`, `geo/tilesets/`
- Event Grid system topic on the storage account (for event-driven triggers)
- Roles: managed identity needs `Azure Maps Data Contributor`, `Storage Blob Data Contributor`, `Data Factory Contributor`

## Build plan
| Phase | Work |
|---|---|
| **Backend** | New `/api/items/geo-pipeline/[id]/templates` → returns the 5 starter templates. New `/api/items/geo-pipeline/[id]/instantiate` (POST `{templateId, params}`) → materializes an ADF pipeline JSON and PUTs it through the existing `adf-pipeline` path. New `/api/items/geo-pipeline/[id]/estimate-cost` → multiplies row count by per-call pricing for the chosen pricing tier. New `/api/items/geo-pipeline/[id]/runs` → proxies ADF run history. |
| **Frontend** | Replace stub with: template gallery on first load (5 cards) → form to fill in params (input dataset, output path, vehicle profile / budget for isochrone, target SRID for reproject, etc.) → "Create + run" button that calls instantiate + createRun. Run-history grid below. Pre-run cost estimate banner. |
| **Activity wrappers** | Ship reusable JSON snippets for `azureMapsGeocodeBatch`, `azureMapsRouteRange`, `synapseSparkReproject`, `synapseSparkTileGen`, `synapseSparkSpatialJoin` that the templates compose. |

## Estimated effort
**2–3 focused sessions.** Backend template engine + ADF instantiate + cost estimator (session 1), 5 starter templates as JSON + activity wrappers (session 2), frontend gallery + run history + cost banner + E2E test on a real subscription (session 3).
