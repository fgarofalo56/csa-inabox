# GeoAnalytics on CSA Loom

Spatial analytics for environmental, civil-engineering, federal
mapping, and emergency-response workloads. Uses ADX geo functions +
Power BI map visuals + (v2) Loom Maps service.

## What you'll build

```
Source: Geospatial data
        - Vector (Esri shapefiles, GeoJSON, GeoParquet)
        - Raster (COG / Cloud-Optimized GeoTIFF)
        - Streaming (GPS pings, mobile devices)
    ↓ Loom Mirroring Engine (for change feed)
       + ADF batch copy (for static spatial datasets)
Bronze: raw_spatial_features (Delta with WKT/WKB geometry)
    ↓ Databricks Spark (Sedona / GeoPandas) — spatial join + analytics
Silver: enriched_spatial (per-feature attributes + spatial relationships)
    ↓ Gold: aggregated spatial metrics
    ↓ Loom Direct-Lake-Shim
Power BI semantic model (with shape map visuals; ESRI ArcGIS visual
in Commercial only)
    ↓ ADX (for KQL geo functions like geo_distance_2points,
            geo_polygon_to_h3cell)
    ↓ Loom Data Agent
NL Q&A: "How many incidents within 5 km of station X?"
        "Show me population density change in county Y"
```

## Components

| Loom capability | Used for |
|---|---|
| Mirroring Engine | CDC for spatial data sources |
| Databricks notebook (Sedona / GeoPandas) | Spatial joins + analytics |
| ADX (KQL geo functions) | Real-time spatial queries |
| Power BI Premium (shape map / map visual) | BI surface |
| Data Agent | NL geo Q&A |
| (v2) Loom Maps service | Native COG/PMTiles support like Fabric Maps |

## Per-boundary notes

| Boundary | Notes |
|---|---|
| Commercial | Azure Maps available (rich basemaps); ESRI ArcGIS visual works |
| GCC | **Azure Maps NOT available**; use shape maps or static images |
| GCC-High / IL4 | Same — Azure Maps not in any Gov boundary |
| IL5 (v1.1) | Same; static maps + custom PMTiles via Loom Maps v2 |

The Azure Maps gap is documented; in Gov, customers either:
- Use Power BI shape maps (no live tiles)
- Use third-party Mapbox / open-source PMTiles
- Wait for Loom Maps v2 service (Azure Maps replacement using OSS
  tile servers)

## Federal applicability

- Civil engineering / infrastructure analytics (DOT, federal works)
- Environmental monitoring (EPA, NOAA, USDA)
- Emergency response (FEMA, state EM offices)
- Defense mapping (NGA — IL5 v1.1)

## Sample KQL geo query (incidents near station)

```kql
let station_lat = 40.7128;
let station_lon = -74.0060;
Incidents
| where ts > ago(7d)
| extend distance_km = geo_distance_2points(longitude, latitude,
                                              station_lon, station_lat) / 1000
| where distance_km <= 5
| project ts, incident_type, severity, distance_km
| order by ts desc
```

## Cost (F8 baseline)

~$3,500/mo:
- Power BI Premium F8: $1,050
- Databricks Premium (Sedona / GeoPandas): $1,200
- ADX cluster (D11_v2): $400
- ADLS Gen2 (large spatial datasets): $400
- AOAI: $200
- Misc: $250

## Source code

[`examples/fiab-geoanalytics/`](https://github.com/fgarofalo56/csa-inabox/tree/csa-loom-pillar/examples/fiab-geoanalytics)

## Forward migration

When Fabric reaches your boundary + Fabric Maps GAs in Gov:
- Loom Maps v2 → Fabric Maps (1:1 if v2 follows Fabric's architecture)
- ADX geo queries → Fabric Eventhouse (same engine)
- Spatial Delta tables → OneLake shortcut

## Related

- Existing source: [`examples/geoanalytics/`](../../examples/geoanalytics.md)
- [Fabric IQ family (v2)](../workloads/fabric-iq-family.md) — includes
  Fabric Maps parity roadmap
- Parent: [GeoAnalytics with ArcGIS Enterprise tutorial](../../tutorials/04-geoanalytics-arcgis/README.md), [GeoAnalytics OSS tutorial](../../tutorials/03-geoanalytics-oss/README.md)
