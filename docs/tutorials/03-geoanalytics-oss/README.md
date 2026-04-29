# Tutorial 03: GeoAnalytics with Open-Source Tools

> **Estimated Time:** 4-5 hours
> **Difficulty:** Intermediate-Advanced

Build a complete geospatial analytics pipeline using open-source tools on your CSA-in-a-Box platform. You will deploy PostgreSQL with PostGIS, ingest geospatial data, run spatial queries, process GeoParquet with geopandas, apply H3 hexagonal indexing, and execute distributed spatial analysis with Apache Sedona on Databricks.

---

## Prerequisites

Before starting, ensure you have:

- [ ] **Tutorial 01 completed** — Foundation Platform deployed and operational
- [ ] **Databricks cluster running** — from Tutorial 01, Step 8
- [ ] **Python 3.11+** with the virtual environment from Tutorial 01 active
- [ ] **Azure CLI** authenticated (`az account show` returns your subscription)
- [ ] **Storage account** with Bronze / Silver / Gold containers populated

Verify your environment:

```bash
az account show --query "{Name:name, ID:id}" --output table
python --version
pip list | grep -E "dbt|azure"
```

Install the geospatial Python packages:

```bash
pip install geopandas shapely pyproj h3 matplotlib pyarrow
pip install psycopg2-binary sqlalchemy geoalchemy2
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Successfully installed geopandas-0.14.x shapely-2.x pyproj-3.x h3-4.x matplotlib-3.x ...
Successfully installed psycopg2-binary-2.9.x sqlalchemy-2.x geoalchemy2-0.15.x
```

</details>

### Troubleshooting

| Symptom                           | Cause                      | Fix                                                                       |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `pip install` fails for geopandas | Missing C libraries        | On Windows, use `conda install geopandas` or install via pre-built wheels |
| `h3` installation error           | Requires C compiler        | Install Microsoft C++ Build Tools or use `conda install h3-py`            |
| `psycopg2-binary` fails           | Missing PostgreSQL headers | Use the `-binary` variant (included above) which bundles libpq            |

---

## Architecture Diagram

```mermaid
graph TB
    subgraph Sources["Data Sources"]
        USGS[USGS Earthquake Feed]
        CENSUS[Census TIGER/Line]
        OSM[OpenStreetMap Extracts]
    end

    subgraph DLZ["Data Landing Zone"]
        subgraph Storage["ADLS Gen2"]
            BRONZE_GEO[Bronze / geospatial /]
            SILVER_GEO[Silver / geospatial /]
            GOLD_GEO[Gold / geospatial /]
        end

        subgraph Compute["Compute"]
            PG[(PostgreSQL + PostGIS)]
            DBX_GEO[Databricks + Apache Sedona]
        end
    end

    subgraph Processing["Processing Pipeline"]
        INGEST[1. Ingest Raw Data]
        POSTGIS_Q[2. PostGIS Spatial Queries]
        GEOPANDAS[3. GeoPandas Processing]
        H3_IDX[4. H3 Hexagonal Indexing]
        SEDONA[5. Distributed Sedona Analysis]
        VIZ[6. Visualization]
    end

    Sources --> INGEST --> BRONZE_GEO
    BRONZE_GEO --> POSTGIS_Q --> SILVER_GEO
    BRONZE_GEO --> GEOPANDAS --> SILVER_GEO
    SILVER_GEO --> H3_IDX --> GOLD_GEO
    SILVER_GEO --> SEDONA --> GOLD_GEO
    GOLD_GEO --> VIZ
    PG --- POSTGIS_Q
    DBX_GEO --- SEDONA

    style Sources fill:#fff3e0,stroke:#e65100
    style DLZ fill:#e6ffe6,stroke:#107c10
    style Processing fill:#e6f0ff,stroke:#0078d4
```

---

## Step 1: Deploy GeoAnalytics Infrastructure

Deploy the GeoAnalytics module which provisions a PostgreSQL Flexible Server with PostGIS extensions and supporting network resources.

```bash
cd deploy/bicep/dlz/modules

# Review the geoanalytics Bicep module
cat geoanalytics.bicep
```

Deploy the module into your existing DLZ resource group:

```bash
export CSA_PREFIX="csa"
export CSA_ENV="dev"
export CSA_RG_DLZ="${CSA_PREFIX}-rg-dlz-${CSA_ENV}"

az deployment group create \
  --resource-group "$CSA_RG_DLZ" \
  --template-file geoanalytics.bicep \
  --parameters \
    prefix="$CSA_PREFIX" \
    environment="$CSA_ENV" \
    postgresAdminPassword="YourStr0ng_P@ssw0rd!" \
  --name "geoanalytics-$(date +%Y%m%d%H%M)" \
  --verbose
```

This deployment takes 5-10 minutes and creates:

- **Azure Database for PostgreSQL Flexible Server** with PostGIS extension enabled
- **Private endpoint** connecting PostgreSQL to the DLZ spoke VNet
- **Firewall rules** allowing access from Azure services

```bash
cd ../../../..
```

<details>
<summary><strong>Expected Output</strong></summary>

```json
{
    "properties": {
        "provisioningState": "Succeeded",
        "outputs": {
            "postgresServerName": { "value": "csa-pg-geo-dev" },
            "postgresServerFqdn": {
                "value": "csa-pg-geo-dev.postgres.database.azure.com"
            },
            "postgisDatabaseName": { "value": "geodb" }
        }
    }
}
```

</details>

### Troubleshooting

| Symptom                        | Cause                         | Fix                                                          |
| ------------------------------ | ----------------------------- | ------------------------------------------------------------ |
| `PasswordNotComplex`           | Admin password too simple     | Use 12+ chars with uppercase, lowercase, numbers, symbols    |
| `QuotaExceeded` for PostgreSQL | Region vCPU limit reached     | Request quota increase or use a smaller SKU (Burstable B1ms) |
| Deployment hangs > 15 min      | PostgreSQL provisioning delay | Wait up to 20 minutes; check portal for status               |

---

## Step 2: Set Up PostgreSQL with PostGIS Extension

Connect to the PostgreSQL server and enable PostGIS.

### 2a. Get Connection Details

```bash
PG_SERVER=$(az postgres flexible-server list \
  --resource-group "$CSA_RG_DLZ" \
  --query "[0].fullyQualifiedDomainName" -o tsv)

PG_ADMIN="csaadmin"
PG_DB="geodb"

echo "PostgreSQL Server: $PG_SERVER"
echo "Database: $PG_DB"
```

### 2b. Allow Your Client IP

```bash
MY_IP=$(curl -s https://ifconfig.me)

az postgres flexible-server firewall-rule create \
  --resource-group "$CSA_RG_DLZ" \
  --name "csa-pg-geo-dev" \
  --rule-name "AllowMyIP" \
  --start-ip-address "$MY_IP" \
  --end-ip-address "$MY_IP"
```

### 2c. Enable PostGIS Extensions

Connect using `psql` and enable the required extensions:

```bash
# Install psql if not available
# Ubuntu/Debian: sudo apt install postgresql-client
# macOS: brew install libpq
# Windows: included with PostgreSQL installer

psql "host=$PG_SERVER dbname=$PG_DB user=$PG_ADMIN sslmode=require" << 'SQL'
-- Enable PostGIS and related extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS postgis_tiger_geocoder;

-- Verify installation
SELECT postgis_full_version();
SQL
```

<details>
<summary><strong>Expected Output</strong></summary>

```
                                    postgis_full_version
------------------------------------------------------------------------------------------
 POSTGIS="3.4.0" [EXTENSION] PGSQL="160" GEOS="3.12.0" PROJ="9.3.0" LIBXML="2.10.3" ...
(1 row)
```

</details>

### 2d. Create the Geospatial Schema

```bash
psql "host=$PG_SERVER dbname=$PG_DB user=$PG_ADMIN sslmode=require" << 'SQL'
-- Create schema for geospatial data
CREATE SCHEMA IF NOT EXISTS geo;

-- Table for point-based features (e.g., earthquake epicenters)
CREATE TABLE IF NOT EXISTS geo.earthquake_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(50) UNIQUE NOT NULL,
    magnitude DECIMAL(4,2),
    depth_km DECIMAL(8,2),
    event_time TIMESTAMP WITH TIME ZONE,
    place VARCHAR(255),
    event_type VARCHAR(50),
    geom GEOMETRY(Point, 4326),
    ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table for polygon features (e.g., county boundaries)
CREATE TABLE IF NOT EXISTS geo.county_boundaries (
    id SERIAL PRIMARY KEY,
    state_fips VARCHAR(2),
    county_fips VARCHAR(3),
    geoid VARCHAR(5),
    name VARCHAR(100),
    state_name VARCHAR(50),
    aland BIGINT,
    awater BIGINT,
    geom GEOMETRY(MultiPolygon, 4326),
    ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create spatial indexes
CREATE INDEX IF NOT EXISTS idx_earthquake_geom ON geo.earthquake_events USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_county_geom ON geo.county_boundaries USING GIST(geom);

-- Verify tables
SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'geo';
SQL
```

<details>
<summary><strong>Expected Output</strong></summary>

```
 table_schema |    table_name
--------------+-------------------
 geo          | earthquake_events
 geo          | county_boundaries
(2 rows)
```

</details>

### Troubleshooting

| Symptom                                | Cause                           | Fix                                                                                     |
| -------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `connection refused`                   | Firewall rule not set           | Verify your IP with `curl ifconfig.me` and re-create the rule                           |
| `extension "postgis" is not available` | PostGIS not enabled on server   | Run `az postgres flexible-server parameter set --name azure.extensions --value postgis` |
| `psql: command not found`              | PostgreSQL client not installed | Install `postgresql-client` package for your OS                                         |

---

## Step 3: Download Geospatial Data

Download earthquake data from USGS and county boundaries from Census TIGER/Line.

### 3a. Run the Download Script

```bash
# Use the provided download script
python scripts/data/download-geospatial.py \
  --output-dir data/geospatial \
  --datasets earthquakes counties
```

If the script is not available, download manually:

```bash
mkdir -p data/geospatial

# USGS Earthquake data (last 30 days, magnitude 2.5+)
curl -o data/geospatial/earthquakes_30day.geojson \
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson"

# Census TIGER/Line county boundaries (shapefile)
curl -o data/geospatial/tl_2023_us_county.zip \
  "https://www2.census.gov/geo/tiger/TIGER2023/COUNTY/tl_2023_us_county.zip"

unzip -o data/geospatial/tl_2023_us_county.zip -d data/geospatial/counties/
```

### 3b. Verify Downloads

```bash
# Check earthquake data
python -c "
import json
with open('data/geospatial/earthquakes_30day.geojson') as f:
    data = json.load(f)
print(f'Earthquake features: {len(data[\"features\"])}')
print(f'Sample: {data[\"features\"][0][\"properties\"][\"place\"]}')
"

# Check county boundaries
python -c "
import geopandas as gpd
counties = gpd.read_file('data/geospatial/counties/')
print(f'County records: {len(counties)}')
print(f'CRS: {counties.crs}')
print(counties.head(3)[['GEOID', 'NAME', 'STATEFP']])
"
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Earthquake features: 847
Sample: 15 km SSW of Ridgecrest, CA

County records: 3234
CRS: EPSG:4269
  GEOID         NAME STATEFP
0  31039    Cuming      31
1  53069  Wahkiakum    53
2  35011   De Baca     35
```

</details>

### 3c. Upload to Bronze Layer

```bash
STORAGE_ACCT=$(az storage account list \
  --resource-group "$CSA_RG_DLZ" \
  --query "[0].name" -o tsv)

az storage blob upload-batch \
  --destination bronze \
  --source data/geospatial/ \
  --account-name "$STORAGE_ACCT" \
  --auth-mode login \
  --destination-path "geospatial/" \
  --overwrite
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Finished[#############################################################]  100.0000%
[
  { "Blob": "geospatial/earthquakes_30day.geojson", ... },
  { "Blob": "geospatial/counties/tl_2023_us_county.shp", ... },
  ...
]
```

</details>

### Troubleshooting

| Symptom                                | Cause                    | Fix                                                                               |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `curl` returns HTML instead of GeoJSON | USGS API changed or down | Check [USGS API docs](https://earthquake.usgs.gov/fdsnws/event/1/) and update URL |
| Shapefile read error                   | Incomplete download      | Re-download and verify zip integrity with `unzip -t`                              |
| Upload fails with auth error           | RBAC not assigned        | Verify Storage Blob Data Contributor role from Tutorial 01 Step 7                 |

---

## Step 4: Load Data into PostGIS

Load the downloaded geospatial data into your PostgreSQL/PostGIS database.

### 4a. Load Earthquake Data

```python
# save as: scripts/geo/load_earthquakes.py
import json
import psycopg2
from psycopg2.extras import execute_values

# Connection parameters
conn = psycopg2.connect(
    host="csa-pg-geo-dev.postgres.database.azure.com",
    dbname="geodb",
    user="csaadmin",
    password="YourStr0ng_P@ssw0rd!",
    sslmode="require"
)

with open("data/geospatial/earthquakes_30day.geojson") as f:
    data = json.load(f)

rows = []
for feature in data["features"]:
    props = feature["properties"]
    coords = feature["geometry"]["coordinates"]  # [lon, lat, depth]
    rows.append((
        props["ids"].strip(",").split(",")[0] if props.get("ids") else props["code"],
        props.get("mag"),
        coords[2] if len(coords) > 2 else None,
        props.get("time"),
        props.get("place"),
        props.get("type"),
        coords[0],  # longitude
        coords[1],  # latitude
    ))

cur = conn.cursor()
execute_values(cur, """
    INSERT INTO geo.earthquake_events (event_id, magnitude, depth_km, event_time, place, event_type, geom)
    VALUES %s
    ON CONFLICT (event_id) DO NOTHING
""", rows, template="""(
    %s, %s, %s,
    TO_TIMESTAMP(%s / 1000.0),
    %s, %s,
    ST_SetSRID(ST_MakePoint(%s, %s), 4326)
)""")

conn.commit()
cur.execute("SELECT count(*) FROM geo.earthquake_events;")
print(f"Loaded {cur.fetchone()[0]} earthquake events")

cur.close()
conn.close()
```

Run the script:

```bash
python scripts/geo/load_earthquakes.py
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Loaded 847 earthquake events
```

</details>

### 4b. Load County Boundaries

```python
# save as: scripts/geo/load_counties.py
import geopandas as gpd
from sqlalchemy import create_engine

engine = create_engine(
    "postgresql://csaadmin:YourStr0ng_P@ssw0rd!@"
    "csa-pg-geo-dev.postgres.database.azure.com:5432/geodb",
    connect_args={"sslmode": "require"}
)

counties = gpd.read_file("data/geospatial/counties/")
counties = counties.to_crs(epsg=4326)

# Select and rename columns
counties_clean = counties[["GEOID", "NAME", "STATEFP", "COUNTYFP", "ALAND", "AWATER", "geometry"]].copy()
counties_clean.columns = ["geoid", "name", "state_fips", "county_fips", "aland", "awater", "geom"]

# Add state names
import json
state_fips_map = {
    "01": "Alabama", "02": "Alaska", "04": "Arizona", "05": "Arkansas",
    "06": "California", "08": "Colorado", "09": "Connecticut", "10": "Delaware",
    "12": "Florida", "13": "Georgia", "15": "Hawaii", "16": "Idaho",
    "17": "Illinois", "18": "Indiana", "19": "Iowa", "20": "Kansas",
    # ... (abbreviated for tutorial, full map in the script)
}
counties_clean["state_name"] = counties_clean["state_fips"].map(state_fips_map).fillna("Other")

counties_clean.to_postgis("county_boundaries", engine, schema="geo", if_exists="replace", index=False)

print(f"Loaded {len(counties_clean)} county boundaries")
```

Run it:

```bash
python scripts/geo/load_counties.py
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Loaded 3234 county boundaries
```

</details>

### Troubleshooting

| Symptom                                | Cause                    | Fix                                                  |
| -------------------------------------- | ------------------------ | ---------------------------------------------------- |
| `OperationalError: connection refused` | Firewall or wrong host   | Re-check `$PG_SERVER` and firewall rules             |
| `UndefinedTable`                       | Schema/table not created | Re-run Step 2d to create the schema                  |
| `to_postgis` fails with geometry error | CRS mismatch             | Ensure `.to_crs(epsg=4326)` is called before loading |

---

## Step 5: Spatial Queries in PostGIS

Run spatial analysis queries using PostGIS functions.

### 5a. Buffer Analysis — Find Counties Near Earthquake Clusters

```sql
-- Connect via psql
-- Find counties within 50km of any M5.0+ earthquake
SELECT DISTINCT
    c.name AS county,
    c.state_name AS state,
    e.magnitude,
    e.place AS earthquake_location,
    ROUND(ST_Distance(
        c.geom::geography,
        e.geom::geography
    ) / 1000) AS distance_km
FROM geo.county_boundaries c
JOIN geo.earthquake_events e
    ON ST_DWithin(
        c.geom::geography,
        e.geom::geography,
        50000  -- 50km in meters
    )
WHERE e.magnitude >= 5.0
ORDER BY e.magnitude DESC, distance_km ASC
LIMIT 20;
```

<details>
<summary><strong>Expected Output</strong></summary>

```
   county    |   state    | magnitude |     earthquake_location      | distance_km
-------------+------------+-----------+------------------------------+-------------
 Kern        | California |      5.80 | 15 km SSW of Ridgecrest, CA  |          12
 San Bern... | California |      5.80 | 15 km SSW of Ridgecrest, CA  |          38
 Inyo        | California |      5.80 | 15 km SSW of Ridgecrest, CA  |          45
 ...
```

</details>

### 5b. Intersection — Earthquakes per County

```sql
-- Count earthquakes that fall within each county
SELECT
    c.name AS county,
    c.state_name AS state,
    COUNT(e.id) AS earthquake_count,
    ROUND(AVG(e.magnitude)::numeric, 2) AS avg_magnitude,
    MAX(e.magnitude) AS max_magnitude
FROM geo.county_boundaries c
JOIN geo.earthquake_events e
    ON ST_Intersects(c.geom, e.geom)
GROUP BY c.name, c.state_name
HAVING COUNT(e.id) >= 3
ORDER BY earthquake_count DESC
LIMIT 15;
```

<details>
<summary><strong>Expected Output</strong></summary>

```
    county     |   state    | earthquake_count | avg_magnitude | max_magnitude
---------------+------------+------------------+---------------+---------------
 Hawaii        | Hawaii     |               42 |          3.12 |          4.80
 Kern          | California |               28 |          2.89 |          5.80
 Imperial      | California |               15 |          3.01 |          4.20
 ...
```

</details>

### 5c. Distance Analysis — Nearest Earthquakes to Major Cities

```sql
-- Find the 5 nearest earthquakes to a given point (e.g., Los Angeles)
SELECT
    e.event_id,
    e.magnitude,
    e.place,
    e.event_time,
    ROUND(ST_Distance(
        e.geom::geography,
        ST_SetSRID(ST_MakePoint(-118.2437, 34.0522), 4326)::geography
    ) / 1000) AS distance_km
FROM geo.earthquake_events e
ORDER BY e.geom <-> ST_SetSRID(ST_MakePoint(-118.2437, 34.0522), 4326)
LIMIT 5;
```

<details>
<summary><strong>Expected Output</strong></summary>

```
 event_id |  magnitude |          place           |      event_time       | distance_km
----------+------------+--------------------------+-----------------------+-------------
 ci40123  |       2.80 | 8 km NW of Inglewood, CA | 2026-04-20 14:23:00+00|          15
 ci40124  |       3.10 | 5 km E of Pasadena, CA   | 2026-04-19 08:45:00+00|          18
 ...
```

</details>

### 5d. Export Results to Silver Layer

```sql
-- Create a materialized view for the county earthquake summary
CREATE MATERIALIZED VIEW IF NOT EXISTS geo.mv_county_earthquake_summary AS
SELECT
    c.geoid,
    c.name AS county,
    c.state_name AS state,
    c.geom,
    COUNT(e.id) AS earthquake_count,
    COALESCE(ROUND(AVG(e.magnitude)::numeric, 2), 0) AS avg_magnitude,
    COALESCE(MAX(e.magnitude), 0) AS max_magnitude,
    COALESCE(MIN(e.event_time), '1970-01-01'::timestamptz) AS earliest_event,
    COALESCE(MAX(e.event_time), '1970-01-01'::timestamptz) AS latest_event
FROM geo.county_boundaries c
LEFT JOIN geo.earthquake_events e
    ON ST_Intersects(c.geom, e.geom)
GROUP BY c.geoid, c.name, c.state_name, c.geom;
```

### Troubleshooting

| Symptom                                          | Cause                                  | Fix                                            |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------------- |
| `ST_DWithin` returns no results                  | Units mismatch — geometry vs geography | Cast to `::geography` for meter-based distance |
| Query very slow                                  | Missing spatial index                  | Verify indexes exist with `\di geo.*`          |
| `operator does not exist: geometry <-> geometry` | PostGIS KNN operator requires index    | Create GIST index on geometry column           |

---

## Step 6: Process GeoParquet with geopandas

Convert spatial data to the cloud-native GeoParquet format for efficient storage and processing.

### 6a. Read PostGIS Data and Write GeoParquet

```python
# save as: scripts/geo/postgis_to_geoparquet.py
import geopandas as gpd
from sqlalchemy import create_engine
import os

engine = create_engine(
    "postgresql://csaadmin:YourStr0ng_P@ssw0rd!@"
    "csa-pg-geo-dev.postgres.database.azure.com:5432/geodb",
    connect_args={"sslmode": "require"}
)

# Read the materialized view
print("Reading county earthquake summary from PostGIS...")
gdf = gpd.read_postgis(
    "SELECT * FROM geo.mv_county_earthquake_summary",
    engine,
    geom_col="geom"
)

print(f"Records: {len(gdf)}")
print(f"CRS: {gdf.crs}")
print(f"Columns: {list(gdf.columns)}")

# Write to GeoParquet (Silver layer)
os.makedirs("data/geospatial/silver", exist_ok=True)
output_path = "data/geospatial/silver/county_earthquake_summary.parquet"

gdf.to_parquet(output_path, engine="pyarrow", index=False)
print(f"\nWrote GeoParquet: {output_path}")
print(f"File size: {os.path.getsize(output_path) / 1024 / 1024:.2f} MB")

# Verify by reading back
gdf_verify = gpd.read_parquet(output_path)
print(f"Verified: {len(gdf_verify)} records, CRS={gdf_verify.crs}")
```

```bash
python scripts/geo/postgis_to_geoparquet.py
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Reading county earthquake summary from PostGIS...
Records: 3234
CRS: EPSG:4326
Columns: ['geoid', 'county', 'state', 'geom', 'earthquake_count', 'avg_magnitude', 'max_magnitude', 'earliest_event', 'latest_event']

Wrote GeoParquet: data/geospatial/silver/county_earthquake_summary.parquet
File size: 12.45 MB
Verified: 3234 records, CRS=EPSG:4326
```

</details>

### 6b. Spatial Analysis with geopandas

```python
# save as: scripts/geo/geopandas_analysis.py
import geopandas as gpd
import pandas as pd

gdf = gpd.read_parquet("data/geospatial/silver/county_earthquake_summary.parquet")

# Top earthquake-prone states
state_summary = gdf.groupby("state").agg(
    total_earthquakes=("earthquake_count", "sum"),
    max_magnitude=("max_magnitude", "max"),
    counties_affected=("earthquake_count", lambda x: (x > 0).sum()),
    total_counties=("earthquake_count", "count"),
).sort_values("total_earthquakes", ascending=False)

print("Top 10 Earthquake-Prone States:")
print(state_summary.head(10).to_string())

# Calculate area-based density (earthquakes per 1000 sq km)
gdf["area_sqkm"] = gdf.to_crs(epsg=5070).geometry.area / 1e6
gdf["eq_density"] = gdf["earthquake_count"] / (gdf["area_sqkm"] / 1000)

# Counties with highest earthquake density
high_density = gdf[gdf["earthquake_count"] > 0].nlargest(10, "eq_density")
print("\nHighest Earthquake Density (per 1000 sq km):")
print(high_density[["county", "state", "earthquake_count", "area_sqkm", "eq_density"]].to_string())
```

```bash
python scripts/geo/geopandas_analysis.py
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Top 10 Earthquake-Prone States:
               total_earthquakes  max_magnitude  counties_affected  total_counties
state
California                   156           5.80                 28              58
Alaska                       134           6.20                 12              30
Hawaii                        52           4.80                  3               5
Oklahoma                      38           4.50                 15              77
...

Highest Earthquake Density (per 1000 sq km):
        county       state  earthquake_count  area_sqkm  eq_density
  San Francisco  California              8      121.47       65.86
       Honolulu      Hawaii             18      600.21       29.99
...
```

</details>

### 6c. Upload Silver GeoParquet to ADLS

```bash
az storage blob upload-batch \
  --destination silver \
  --source data/geospatial/silver/ \
  --account-name "$STORAGE_ACCT" \
  --auth-mode login \
  --destination-path "geospatial/" \
  --overwrite
```

### Troubleshooting

| Symptom                                | Cause                        | Fix                                                   |
| -------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| `to_parquet` fails with geometry error | Shapely version mismatch     | Update: `pip install --upgrade shapely pyarrow`       |
| GeoParquet not preserving CRS          | Old geopandas version        | Requires geopandas >= 0.14 for GeoParquet CRS support |
| Memory error on large datasets         | Dataset too large for memory | Process in chunks with `chunksize` parameter          |

---

## Step 7: H3 Hexagonal Indexing for Spatial Aggregation

Use Uber's H3 hierarchical hexagonal grid to create uniform spatial aggregations.

### 7a. Index Earthquake Points to H3 Cells

```python
# save as: scripts/geo/h3_indexing.py
import geopandas as gpd
import pandas as pd
import h3
import json

# Read earthquake data
with open("data/geospatial/earthquakes_30day.geojson") as f:
    eq_data = json.load(f)

records = []
for feature in eq_data["features"]:
    coords = feature["geometry"]["coordinates"]
    props = feature["properties"]
    lat, lon = coords[1], coords[0]

    # Generate H3 indexes at multiple resolutions
    h3_res4 = h3.latlng_to_cell(lat, lon, 4)   # ~1,770 km2
    h3_res6 = h3.latlng_to_cell(lat, lon, 6)   # ~36 km2
    h3_res8 = h3.latlng_to_cell(lat, lon, 8)   # ~0.74 km2

    records.append({
        "event_id": props.get("code", ""),
        "magnitude": props.get("mag"),
        "latitude": lat,
        "longitude": lon,
        "place": props.get("place"),
        "h3_res4": h3_res4,
        "h3_res6": h3_res6,
        "h3_res8": h3_res8,
    })

df = pd.DataFrame(records)
print(f"Total events: {len(df)}")
print(f"Unique H3 cells (res4): {df['h3_res4'].nunique()}")
print(f"Unique H3 cells (res6): {df['h3_res6'].nunique()}")
print(f"Unique H3 cells (res8): {df['h3_res8'].nunique()}")

# Aggregate by H3 resolution 4
h3_agg = df.groupby("h3_res4").agg(
    earthquake_count=("event_id", "count"),
    avg_magnitude=("magnitude", "mean"),
    max_magnitude=("magnitude", "max"),
).reset_index()

# Convert H3 cells to polygons for visualization
def h3_to_polygon(h3_index):
    from shapely.geometry import Polygon
    boundary = h3.cell_to_boundary(h3_index)
    # h3 returns (lat, lng) pairs, Shapely needs (lng, lat)
    return Polygon([(lng, lat) for lat, lng in boundary])

h3_agg["geometry"] = h3_agg["h3_res4"].apply(h3_to_polygon)
h3_gdf = gpd.GeoDataFrame(h3_agg, geometry="geometry", crs="EPSG:4326")

# Save H3 aggregation as GeoParquet
import os
os.makedirs("data/geospatial/gold", exist_ok=True)
h3_gdf.to_parquet("data/geospatial/gold/earthquake_h3_res4.parquet", index=False)

print(f"\nH3 Aggregation (Resolution 4):")
print(h3_gdf.nlargest(10, "earthquake_count")[
    ["h3_res4", "earthquake_count", "avg_magnitude", "max_magnitude"]
].to_string(index=False))
```

```bash
python scripts/geo/h3_indexing.py
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Total events: 847
Unique H3 cells (res4): 89
Unique H3 cells (res6): 412
Unique H3 cells (res8): 798

H3 Aggregation (Resolution 4):
           h3_res4  earthquake_count  avg_magnitude  max_magnitude
 842d117ffffffff                 45           3.12            5.8
 8429a1bffffffff                 38           2.95            4.2
 8428309ffffffff                 22           3.45            6.2
...
```

</details>

### Troubleshooting

| Symptom                        | Cause                                      | Fix                                                                 |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------- |
| `h3.latlng_to_cell` not found  | Old h3 version (v3 API)                    | Upgrade: `pip install h3>=4.0` (v4 API changed function names)      |
| H3 cells crossing antimeridian | Expected for Pacific data                  | Use `h3.cell_to_boundary(h, geo_json=True)` for GeoJSON-safe output |
| Memory error with res10+       | Very fine resolution creates huge datasets | Use resolution 4-8 for aggregation                                  |

---

## Step 8: Run Databricks Notebook with Apache Sedona

Execute distributed spatial analysis on large datasets using Apache Sedona on Databricks.

### 8a. Install Sedona on Your Cluster

In your Databricks workspace, navigate to your cluster and add the following Maven library:

- **Coordinates:** `org.apache.sedona:sedona-spark-shaded-3.5_2.12:1.6.0`
- **Also add:** `org.datasyslab:geotools-wrapper:1.6.0-28.2`

Or configure via cluster init script:

```python
# Databricks notebook cell
%pip install apache-sedona geopandas h3

from sedona.spark import SedonaContext

sedona = SedonaContext.builder().getOrCreate()
print(f"Sedona version: {sedona.version}")
```

### 8b. Load GeoParquet in Sedona

Upload the Silver GeoParquet files to ADLS (done in Step 6c), then read in Databricks:

```python
# Databricks notebook: notebooks/geoanalytics/01_spatial_analysis.py

from sedona.spark import SedonaContext
from pyspark.sql.functions import col, count, avg, max as spark_max

sedona = SedonaContext.builder().getOrCreate()

# Read county boundaries from GeoParquet
counties_df = sedona.read.format("geoparquet").load(
    "abfss://silver@csadlsdev.dfs.core.windows.net/geospatial/county_earthquake_summary.parquet"
)

counties_df.printSchema()
counties_df.show(5, truncate=False)
print(f"Total counties: {counties_df.count()}")
```

<details>
<summary><strong>Expected Output</strong></summary>

```
root
 |-- geoid: string
 |-- county: string
 |-- state: string
 |-- geom: geometry
 |-- earthquake_count: long
 |-- avg_magnitude: double
 |-- max_magnitude: double
 |-- earliest_event: timestamp
 |-- latest_event: timestamp

+------+-----------+----------+----+----------------+
|geoid |county     |state     |geom|earthquake_count|
+------+-----------+----------+----+----------------+
|06037 |Los Angeles|California|... |              12|
...

Total counties: 3234
```

</details>

### 8c. Distributed Spatial Join

```python
from sedona.sql.st_functions import ST_Buffer, ST_Intersects, ST_Area
from pyspark.sql import functions as F

# Read raw earthquake points
earthquakes_df = sedona.read.format("geojson").load(
    "abfss://bronze@csadlsdev.dfs.core.windows.net/geospatial/earthquakes_30day.geojson"
)

# Register as temp views
counties_df.createOrReplaceTempView("counties")
earthquakes_df.createOrReplaceTempView("earthquakes")

# Spatial join: earthquakes within 100km buffer of each county centroid
result = sedona.sql("""
    SELECT
        c.county,
        c.state,
        COUNT(e.*) AS nearby_earthquakes,
        AVG(e.properties.mag) AS avg_magnitude,
        MAX(e.properties.mag) AS max_magnitude,
        ST_Area(ST_Transform(c.geom, 'EPSG:4326', 'EPSG:5070')) / 1e6 AS area_sqkm
    FROM counties c
    JOIN earthquakes e
    ON ST_Intersects(
        ST_Buffer(ST_Transform(c.geom, 'EPSG:4326', 'EPSG:5070'), 100000),
        ST_Transform(e.geometry, 'EPSG:4326', 'EPSG:5070')
    )
    GROUP BY c.county, c.state, c.geom
    HAVING COUNT(e.*) >= 5
    ORDER BY nearby_earthquakes DESC
""")

result.show(20, truncate=False)
```

<details>
<summary><strong>Expected Output</strong></summary>

```
+---------------+----------+-------------------+--------------+--------------+---------+
|county         |state     |nearby_earthquakes |avg_magnitude |max_magnitude |area_sqkm|
+---------------+----------+-------------------+--------------+--------------+---------+
|Kern           |California|                 85|          3.14|          5.80| 21088.34|
|San Bernardino |California|                 62|          2.98|          5.80| 51960.47|
|Hawaii         |Hawaii    |                 52|          3.12|          4.80|  4028.02|
...
```

</details>

### 8d. H3 Aggregation in Sedona

```python
# Use Sedona's built-in H3 support (Sedona 1.6+)
h3_result = sedona.sql("""
    SELECT
        ST_H3CellIDs(geometry, 4, false)[0] AS h3_index,
        COUNT(*) AS event_count,
        AVG(properties.mag) AS avg_mag,
        MAX(properties.mag) AS max_mag
    FROM earthquakes
    GROUP BY ST_H3CellIDs(geometry, 4, false)[0]
    ORDER BY event_count DESC
    LIMIT 20
""")

h3_result.show(truncate=False)
```

### Troubleshooting

| Symptom                                     | Cause                             | Fix                                                |
| ------------------------------------------- | --------------------------------- | -------------------------------------------------- |
| `ClassNotFoundException: org.apache.sedona` | Sedona library not installed      | Add Maven coordinates to cluster libraries         |
| `AnalysisException: GeoParquet`             | Sedona too old for GeoParquet     | Requires Sedona >= 1.5; update Maven coordinates   |
| OOM on spatial join                         | Buffer too large, too many points | Reduce buffer distance or partition data by region |

---

## Step 9: Visualize Results with matplotlib

Create publication-quality maps from your geospatial analysis.

### 9a. County Earthquake Choropleth

```python
# save as: scripts/geo/visualize_results.py
import geopandas as gpd
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import numpy as np

# Read Gold-layer data
counties = gpd.read_parquet("data/geospatial/silver/county_earthquake_summary.parquet")
h3_hexes = gpd.read_parquet("data/geospatial/gold/earthquake_h3_res4.parquet")

# Filter to continental US for cleaner visualization
continental = counties[
    ~counties["state"].isin(["Alaska", "Hawaii", "Puerto Rico", "Other"])
].copy()

fig, axes = plt.subplots(1, 2, figsize=(20, 8))

# Plot 1: Earthquake count by county
ax1 = axes[0]
continental.plot(
    column="earthquake_count",
    cmap="YlOrRd",
    legend=True,
    legend_kwds={"label": "Earthquake Count", "shrink": 0.6},
    edgecolor="gray",
    linewidth=0.1,
    ax=ax1,
    missing_kwds={"color": "lightgrey"},
)
ax1.set_title("Earthquakes by County (Last 30 Days)", fontsize=14, fontweight="bold")
ax1.set_xlim(-130, -65)
ax1.set_ylim(24, 50)
ax1.set_axis_off()

# Plot 2: H3 hexagonal aggregation
ax2 = axes[1]
continental.plot(ax=ax2, color="lightgrey", edgecolor="white", linewidth=0.1)
h3_us = h3_hexes[
    (h3_hexes.geometry.centroid.x > -130) & (h3_hexes.geometry.centroid.x < -65) &
    (h3_hexes.geometry.centroid.y > 24) & (h3_hexes.geometry.centroid.y < 50)
]
h3_us.plot(
    column="earthquake_count",
    cmap="plasma",
    legend=True,
    legend_kwds={"label": "Events per H3 Cell", "shrink": 0.6},
    alpha=0.7,
    edgecolor="black",
    linewidth=0.3,
    ax=ax2,
)
ax2.set_title("H3 Hexagonal Aggregation (Resolution 4)", fontsize=14, fontweight="bold")
ax2.set_xlim(-130, -65)
ax2.set_ylim(24, 50)
ax2.set_axis_off()

plt.tight_layout()
plt.savefig("data/geospatial/gold/earthquake_analysis.png", dpi=150, bbox_inches="tight")
plt.show()
print("Saved visualization to data/geospatial/gold/earthquake_analysis.png")
```

```bash
python scripts/geo/visualize_results.py
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Saved visualization to data/geospatial/gold/earthquake_analysis.png
```

A figure window opens showing two maps side-by-side:

- Left: Choropleth map with counties colored by earthquake count
- Right: H3 hexagonal grid overlaid on county boundaries

</details>

### Troubleshooting

| Symptom                  | Cause                      | Fix                                                 |
| ------------------------ | -------------------------- | --------------------------------------------------- |
| `matplotlib` no display  | Running headless (SSH/WSL) | Use `matplotlib.use('Agg')` before importing pyplot |
| Map looks squished       | Aspect ratio not set       | Add `ax.set_aspect('equal')` or use projected CRS   |
| Missing counties in plot | NaN values in geometry     | Filter with `gdf = gdf[gdf.geometry.notna()]`       |

---

## Step 10: Save to Gold Layer as GeoParquet

Publish finalized analytical datasets to the Gold layer.

### 10a. Prepare Gold-Layer Datasets

```python
# save as: scripts/geo/publish_gold.py
import geopandas as gpd
import os

# Read Silver data
counties = gpd.read_parquet("data/geospatial/silver/county_earthquake_summary.parquet")
h3_hexes = gpd.read_parquet("data/geospatial/gold/earthquake_h3_res4.parquet")

gold_dir = "data/geospatial/gold"
os.makedirs(gold_dir, exist_ok=True)

# Gold dataset 1: County earthquake risk profile
risk_profile = counties[counties["earthquake_count"] > 0].copy()
risk_profile["risk_category"] = risk_profile["max_magnitude"].apply(
    lambda m: "High" if m >= 5.0 else ("Medium" if m >= 3.5 else "Low")
)
risk_profile.to_parquet(f"{gold_dir}/county_earthquake_risk.parquet", index=False)
print(f"Gold - County Risk: {len(risk_profile)} records")

# Gold dataset 2: H3 aggregation (already created)
print(f"Gold - H3 Hexagons: {len(h3_hexes)} records")

# Gold dataset 3: State-level summary (non-spatial)
import pandas as pd
state_summary = counties.groupby("state").agg(
    total_earthquakes=("earthquake_count", "sum"),
    max_magnitude=("max_magnitude", "max"),
    counties_affected=("earthquake_count", lambda x: (x > 0).sum()),
    total_counties=("earthquake_count", "count"),
).reset_index()
state_summary.to_parquet(f"{gold_dir}/state_earthquake_summary.parquet", index=False)
print(f"Gold - State Summary: {len(state_summary)} records")
```

```bash
python scripts/geo/publish_gold.py
```

### 10b. Upload Gold Data to ADLS

```bash
az storage blob upload-batch \
  --destination gold \
  --source data/geospatial/gold/ \
  --account-name "$STORAGE_ACCT" \
  --auth-mode login \
  --destination-path "geospatial/" \
  --overwrite
```

### 10c. Verify Gold Layer

```bash
az storage blob list \
  --container-name gold \
  --account-name "$STORAGE_ACCT" \
  --auth-mode login \
  --prefix "geospatial/" \
  --query "[].{Name:name, Size:properties.contentLength}" \
  --output table
```

<details>
<summary><strong>Expected Output</strong></summary>

```
Name                                               Size
-------------------------------------------------  ---------
geospatial/county_earthquake_risk.parquet          8523456
geospatial/earthquake_h3_res4.parquet              1245678
geospatial/state_earthquake_summary.parquet          45678
geospatial/earthquake_analysis.png                 2345678
```

</details>

### Troubleshooting

| Symptom                  | Cause                   | Fix                                                        |
| ------------------------ | ----------------------- | ---------------------------------------------------------- |
| Upload fails with 403    | Token expired           | Re-run `az login`                                          |
| Parquet file corrupt     | Write interrupted       | Delete and re-create from source                           |
| Missing geometry in Gold | Geometry column dropped | Verify using `gpd.read_parquet()` that geometry is present |

---

## Completion Checklist

- [ ] GeoAnalytics infrastructure deployed (PostgreSQL with PostGIS)
- [ ] PostGIS extensions enabled and schema created
- [ ] Geospatial data downloaded (earthquakes + counties)
- [ ] Data loaded into PostGIS
- [ ] Spatial queries executed (buffer, intersect, ST_Distance)
- [ ] GeoParquet files created with geopandas
- [ ] H3 hexagonal indexing applied
- [ ] Databricks notebook ran with Apache Sedona
- [ ] Visualizations generated with matplotlib
- [ ] Gold-layer GeoParquet published to ADLS

---

## What's Next

Your GeoAnalytics pipeline is operational. Choose your next path:

- **[Tutorial 04: GeoAnalytics with ArcGIS Enterprise](../04-geoanalytics-arcgis/)** — Add ArcGIS Enterprise for advanced cartography and web maps (BYOL)
- **[Tutorial 05: Real-Time Streaming](../05-streaming-lambda/)** — Stream earthquake data in real time with Lambda Architecture
- **[Tutorial 06: AI Analytics](../06-ai-analytics/)** — Apply ML models to predict seismic risk

See the [Tutorial Index](../README.md) for all available paths.

---

## Clean Up

To remove only the GeoAnalytics resources:

```bash
# Delete PostgreSQL server
az postgres flexible-server delete \
  --name "csa-pg-geo-dev" \
  --resource-group "$CSA_RG_DLZ" \
  --yes

# Remove local data
rm -rf data/geospatial/
```

> **Note:** This only removes GeoAnalytics resources. The Foundation Platform from Tutorial 01 remains intact.

---

## Reference

- [PostGIS Documentation](https://postgis.net/docs/)
- [GeoParquet Specification](https://geoparquet.org/)
- [H3: Uber's Hexagonal Hierarchical Spatial Index](https://h3geo.org/)
- [Apache Sedona Documentation](https://sedona.apache.org/latest/)
- [geopandas Documentation](https://geopandas.org/)
- [USGS Earthquake API](https://earthquake.usgs.gov/fdsnws/event/1/)
- [Census TIGER/Line Shapefiles](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html)
- [CSA-in-a-Box Architecture](../../ARCHITECTURE.md)
