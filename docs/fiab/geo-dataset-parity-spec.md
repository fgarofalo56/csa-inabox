# Loom Geo Dataset Editor — Azure-native parity spec

> Reference: ADLS Gen2 + GeoJSON (RFC 7946) + Shapefile (ESRI) + GeoParquet 1.0 spec + Azure Maps Creator Dataset, captured 2026-05-26 by the catalog agent. There is no Fabric equivalent — `geo-dataset` is a Loom-native item that backs both `geo-map` rendering and `geo-query` spatial joins.

## What's there in the Azure-native experience

### Storage layouts
- **GeoJSON** — single `FeatureCollection` per file; native to Azure Maps Web SDK `DataSource.importDataFromUrl()`
- **Shapefile** — `.shp` + `.shx` + `.dbf` + `.prj` quad on ADLS; converted to GeoJSON on read via OGR / GeoPandas in Spark
- **GeoParquet 1.0** — columnar Parquet with `geometry` column (WKB) and `geo` metadata block; native read in Databricks 17.1+ ST functions and Synapse Spark via `geopandas` + `pyarrow`
- **KML / KMZ / GPX / GML / WKT / CSV** — supported via `atlas.io.read()` (Spatial IO module) and Spark `sedona` package
- **Azure Maps Creator dataset** — IMDF-converted indoor map, vendor-specific

### Azure Maps Creator dataset blade
- Dataset header: `Microsoft.Maps/accounts/{name}/creators/{creator}/datasets/{datasetId}` + alias
- **Conversion source** — pointer to the uploaded DWG/IMDF zip
- **Feature collections** — WFS-queryable: `unit`, `level`, `facility`, `opening`, `directoryInfo`, `lineElement`, `areaElement`
- **Tileset** — derived vector tile output
- **Style** + **Map configuration** — defaults applied when rendered

### Inspector observed in raw GeoJSON/GeoParquet workflows
- Feature count
- Bounding box `[west, south, east, north]`
- Geometry type histogram (Point / LineString / Polygon / Multi* / GeometryCollection)
- Property schema (column name → type → sample value)
- SRID (default 4326 / WGS84; reproject via `st_transform`)
- Per-feature inspector: properties JSON + geometry preview on a mini-map

## What Loom already has
- ✅ `GeoDatasetEditor` stub captures an ADLS path
- ✅ Honest sample T-SQL `OPENROWSET` over Parquet to inspect via existing `/api/items/synapse-serverless-sql-pool/[id]/query` route
- ✅ Cosmos-backed state save through the generic item shell

## What's missing for parity
1. **Format auto-detect** — sniff the ADLS path (`.geojson` / `.parquet` + `geo` metadata / `.shp` quad / `.kml` / `.kmz` / `.gpx`) and label the dataset accordingly
2. **Feature count + bbox** — backend computes feature count and bbox from a head-scan of the file (GeoJSON streaming parse / Parquet metadata)
3. **Geometry type histogram** — surface "12,431 Point · 84 Polygon · 0 LineString" with badges
4. **Property schema panel** — list properties with type inference + sample values (first 10 features)
5. **Sample feature inspector** — paginated grid of N features with `properties` JSON + a mini Azure Maps preview of the geometry
6. **SRID display + reproject action** — read the SRID from `prj` (Shapefile) or `crs` (GeoJSON) or `geo` block (GeoParquet); offer "Reproject to 4326" that runs `geo-pipeline`
7. **Conversion tool** — convert Shapefile or KML → GeoJSON or GeoParquet via a one-click Synapse Spark job
8. **Validation report** — flag invalid geometries (self-intersection, wrong ring order, NaN coords); offer "Fix with `geo_polygon_simplify`" action
9. **Link to `geo-map`** — quick action "Open in map" creates or attaches to a sibling `geo-map` item
10. **Creator dataset mode** — when the dataset is a Maps Creator IMDF dataset, swap the inspector for the facility/level/unit tree

## Backend mapping
| Loom surface | Real Azure call |
|---|---|
| Sniff format | ADLS REST `HEAD /containers/{c}/path/{p}` + `GET ?range=0-65535` for magic bytes |
| Feature count + bbox (GeoJSON) | Streaming parse via `azure-storage-file-datalake` Python SDK + `ijson` |
| Feature count + bbox (GeoParquet) | `pyarrow.parquet.read_metadata` → `geo` field block + `num_rows` |
| Schema + sample | Synapse Serverless `OPENROWSET BULK '<adls-https>' FORMAT='PARQUET' TOP 10` (Parquet) or Spark `read.json` for GeoJSON |
| Convert Shapefile → GeoJSON | Synapse Spark job using `geopandas` + `fiona`, output written back to ADLS |
| Reproject | Spark `geopandas.to_crs(4326)` or Databricks `st_transform(geom, 4326)` |
| Creator dataset tree | ARM `GET .../creators/{c}/datasets/{d}/featurestatesets` + WFS `GET .../wfs/datasets/{d}/collections` |

## Required Azure resources
- ADLS Gen2 container at `geo/datasets/<id>/` (one folder per dataset; reuses existing Loom lakehouse storage)
- Synapse Serverless SQL pool (already deployed) for OPENROWSET preview
- Synapse Spark pool (already deployed) for conversion + reprojection jobs
- (optional) `Microsoft.Maps/accounts/creators` for Creator dataset mode
- Role: managed identity needs `Storage Blob Data Contributor` on the container

## Build plan
| Phase | Work |
|---|---|
| **Backend** | New `/api/items/geo-dataset/[id]/inspect` → format sniff + feature count + bbox + geometry type histogram. New `/api/items/geo-dataset/[id]/schema` → property schema + sample 10 features. New `/api/items/geo-dataset/[id]/convert` (POST) → submits a Synapse Spark job to convert Shapefile/KML → GeoJSON/GeoParquet. New `/api/items/geo-dataset/[id]/reproject` (POST) → runs `geo-pipeline` instance to reproject. |
| **Frontend** | Replace stub form with: format badge + feature count + bbox map preview at the top; tabs for `Schema` · `Sample features` · `Validation` · `Convert/Reproject`. Each row in the sample-features grid opens a side panel with the full property JSON and a mini Azure Maps preview. |
| **Auto-pairing** | On `geo-dataset` create from a `geo-map` "create new source", auto-set the path under `geo/maps/<mapId>/dataset/<datasetId>/` so the map can read it without extra config. |

## Estimated effort
**1–2 focused sessions.** Backend inspect + schema (session 1, mostly Python + Synapse), conversion/reprojection wiring + frontend grid (session 2).
