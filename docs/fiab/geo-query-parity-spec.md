# Loom Geo Query Editor — Azure-native parity spec

> Reference: Azure Data Explorer KQL geospatial functions (`geo_*` + S2/H3/Geohash cell systems) + Synapse Serverless `geography`/`geometry` SQL CLR types + SQL Server 2025 spatial indexes, captured 2026-05-26 by the catalog agent. There is no Fabric equivalent — `geo-query` is a Loom-native item that targets either an ADX/KQL backend or a Synapse Serverless backend depending on the linked `geo-dataset`.

## What's there in the Azure-native experience

### Kusto / ADX query surface
- **Built-in geo functions** (all `✅ Microsoft Fabric ✅ Azure Data Explorer ✅ Azure Monitor ✅ Microsoft Sentinel`):
  - Distance: `geo_distance_2points`, `geo_distance_point_to_line`, `geo_distance_point_to_polygon`
  - Containment: `geo_point_in_polygon`, `geo_point_in_circle`
  - Cell systems: `geo_point_to_s2cell` / `geo_point_to_h3cell` / `geo_point_to_geohash` + their `*_to_polygon` and `*_to_central_point` inverses
  - Covering: `geo_polygon_to_s2cells`, `geo_line_to_s2cells`, `geo_polygon_to_h3cells`
  - Buffers: `geo_point_buffer`, `geo_line_buffer`, `geo_polygon_buffer`
  - Lookup plugins: `geo_polygon_lookup`, `geo_line_lookup` (efficient classify-many-points-into-many-polygons join)
  - Densify / simplify: `geo_polygon_densify`, `geo_polygon_simplify`
- **Spatial joins via cell tokens** — documented pattern: cover polygons + points with the same S2/H3 cell level, join on the cell, then filter with `geo_point_in_polygon` for exact membership. Recommended level: 5 for countries, 11 for suburbs, 16 for dense neighborhoods.

### Synapse Serverless / SQL spatial surface
- T-SQL `geometry` and `geography` CLR types with `STWithin`, `STIntersects`, `STContains`, `STDistance`, `STOverlaps`, `STTouches`, `STEquals`, `STBuffer`, `STCentroid`, `STArea`, `STLength`
- Spatial index support on geometry methods within `WHERE` / `JOIN ON` predicates of the form `geom1.STMethod(geom2) = 1` or `geom1.STDistance(geom2) < N`
- SRID enforcement: two geometries with different SRIDs return `NULL` — must `STSrid` match or `STTransform`

### Azure Maps query support
- **Search Inside Geometry** REST `POST /search/inside/json` — find POIs inside an arbitrary polygon
- **Search Along Route** REST `POST /search/alongRoute/json` — find POIs within a corridor of a polyline

### Databricks SQL geospatial (Public Preview, DBR 17.1+)
- 30+ `st_*` functions including `st_within`, `st_intersects`, `st_dwithin`, `st_buffer`, `st_distance`, `st_transform`, `st_setsrid`, `st_estimatesrid`

## What Loom already has
- ✅ `GeoQueryEditor` stub with KQL / T-SQL toggle
- ✅ Sample KQL query pre-populated with `geo_distance_2points` + `geo_point_to_h3cell`
- ✅ Sample T-SQL query pre-populated with `OPENROWSET` against ADLS Parquet + `GEOGRAPHY::STGeomFromText` + `STDistance`
- ✅ Submit path connects to existing `/api/items/synapse-serverless-sql-pool/[id]/query` and Kusto routes
- ✅ Honest MessageBar noting that H3 SQL UDFs aren't deployed in Serverless by default

## What's missing for parity
1. **Backend auto-select** — based on the linked `geo-dataset`, automatically pick KQL (when source is ADX/Eventhouse) or T-SQL (when source is ADLS Parquet/GeoParquet)
2. **Spatial function autocomplete** — Monaco editor with a curated KQL `geo_*` and T-SQL `ST*` snippet library + parameter hints
3. **Visual query builder** — form mode for the common patterns: "find features within radius of point", "find features intersecting polygon", "classify points into polygons", "compute distance between two columns"
4. **Result map preview** — when result has a `geometry` column, render results on an inline Azure Maps preview (uses `geo-map` rendering helper)
5. **Geometry input picker** — instead of typing GeoJSON inline, draw a polygon/point on a mini-map and bind it to a `@geomParam` parameter
6. **H3 / S2 UDF install action** — one-click "Install H3 UDFs into Synapse Serverless" button that runs the CREATE FUNCTION script pointing at the H3 wheel in the lake
7. **Cell-cover join optimizer** — when the user writes a `JOIN ... ON ST_Within(point, poly)` pattern, surface a "Convert to S2 cell join" rewrite suggestion (matches the Kusto docs' recommended performance pattern)
8. **Saved-query library** — Cosmos-backed list of saved geo queries per workspace; "Open in `geo-pipeline`" promotes a saved query into a scheduled job
9. **Spatial index hints** — when targeting Azure SQL/MI, surface `WITH(INDEX(spatial_idx))` hint controls
10. **Result export to `geo-dataset`** — "Save result as new dataset" writes the result back to ADLS as GeoJSON/GeoParquet

## Backend mapping
| Loom surface | Real Azure call |
|---|---|
| KQL submit | Existing Kusto `POST https://{cluster}.{region}.kusto.windows.net/v2/rest/query` via Loom's Eventhouse editor route |
| T-SQL submit | Existing Synapse Serverless TDS path via `/api/items/synapse-serverless-sql-pool/[id]/query` |
| Azure SQL/MI submit | `/api/items/azure-sql-database/[id]/query` |
| Search Inside Geometry | `POST https://atlas.microsoft.com/search/inside/json?api-version=1.0&query=<poi>` |
| Install H3 UDF | Spawn Synapse Serverless `CREATE FUNCTION dbo.H3_LATLON_TO_CELL(...) RETURNS bigint AS EXTERNAL NAME ...` pointing at the H3 .NET assembly in the lake |
| Map preview of result | Reuse `geo-map` Azure Maps Web SDK canvas in a side panel |

## Required Azure resources
- One or more of: Azure Data Explorer cluster / Synapse Serverless SQL pool / Azure SQL DB / SQL MI (Loom has wiring for all of them)
- ADLS Gen2 container for GeoParquet inputs (existing)
- (optional) `Microsoft.Maps/accounts` for `Search Inside Geometry` + `Search Along Route` REST calls
- (optional) H3 .NET assembly published to ADLS for the Serverless H3 UDF install path
- Role: managed identity needs `Database Reader` on Kusto, `db_datareader` on Serverless, `Storage Blob Data Reader` on ADLS

## Build plan
| Phase | Work |
|---|---|
| **Backend** | New `/api/items/geo-query/[id]/run` → routes to the correct backend (Kusto / Serverless / SQL DB) based on linked dataset; returns rows + `geometry` GeoJSON. New `/api/items/geo-query/[id]/install-h3-udfs` (POST) → emits the CREATE FUNCTION script. New `/api/items/geo-query/[id]/save-as-dataset` (POST) → writes result back as GeoParquet. |
| **Frontend** | Monaco editor with `geo_*` and `ST*` IntelliSense; tab switcher Code / Builder; side panel "Map preview"; toolbar with Run · Save · Save as dataset · Install H3 UDFs · Convert to S2-join. |
| **Templates** | Ship a starter library of 10 saved queries: point-in-polygon · radius search · H3 hotspot · S2 join · polygon area · centroid · buffer · route corridor search · isochrone reachability · multi-polygon classify. |

## Estimated effort
**2 focused sessions.** Backend routing + result map preview in session 1, Monaco IntelliSense + visual builder + H3 install action in session 2.
