# [Home](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/README.md) > [Notebooks](../README.md) > Bronze Layer

## 🥉 Bronze Layer Notebooks

> **Purpose**: Raw data ingestion from casino source systems with minimal transformation. Append-only landing zone preserving original data fidelity.


The Bronze layer captures raw data from slot machines, player systems, financial transactions, table games, and security systems. Data arrives in its original format with only metadata enrichment (ingestion timestamp, source system, batch ID).

---

## 📚 Notebook Inventory

| Notebook | Purpose | Input | Output |
|----------|---------|-------|--------|
| [`01_bronze_slot_telemetry.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/01_bronze_slot_telemetry.py) | Ingest slot machine events (spins, wins, errors) | Slot machine event streams | `bronze.slot_telemetry` |
| [`02_bronze_player_profile.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/02_bronze_player_profile.py) | Load player registration and demographic data | Player management system | `bronze.player_profile` |
| [`03_bronze_financial_txn.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/03_bronze_financial_txn.py) | Capture all financial transactions | POS, cage, ATM systems | `bronze.financial_transactions` |
| [`04_bronze_compliance.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/04_bronze_compliance.py) | Ingest compliance-related events | Compliance monitoring system | `bronze.compliance_events` |
| [`05_bronze_table_games.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/05_bronze_table_games.py) | Load table game session data | Table management system | `bronze.table_games` |
| [`06_bronze_security_events.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/06_bronze_security_events.py) | Capture security and surveillance events | Security systems, CCTV | `bronze.security_events` |
| [`07_bronze_tribal_health.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/07_bronze_tribal_health.py) | Ingest IHS healthcare encounter data | IHS RPMS, FHIR feeds | `bronze.tribal_health` |
| [`08_bronze_dot_faa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/08_bronze_dot_faa.py) | Load DOT/FAA aviation safety data | FAA ASRS, BTS datasets | `bronze.dot_faa` |
| [`09_bronze_video_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/09_bronze_video_analytics.py) | Capture video analytics events | AI video pipeline | `bronze.video_analytics` |
| [`10_bronze_people_movement.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/10_bronze_people_movement.py) | Load people movement/foot traffic data | IoT sensors, cameras | `bronze.people_movement` |
| [`11_bronze_geolocation.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/11_bronze_geolocation.py) | Ingest geolocation tracking data | Mobile, beacons, GPS | `bronze.geolocation` |
| [`12_bronze_usda.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/12_bronze_usda.py) | Ingest USDA crop production & food safety data | NASS API, FSIS downloads, generator | `bronze.usda_crop_production`, `bronze.usda_food_safety` |
| [`13_bronze_sba.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/13_bronze_sba.py) | Ingest SBA loan program data | PPP/7a/504 datasets, generator | `bronze.sba_ppp_loans`, `bronze.sba_7a_504_loans` |
| [`14_bronze_noaa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/14_bronze_noaa.py) | Ingest NOAA weather, storms, climate data | Weather API, storm DB, CDO | `bronze.noaa_weather`, `bronze.noaa_storm_events`, `bronze.noaa_climate` |
| [`15_bronze_epa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/15_bronze_epa.py) | Ingest EPA environmental monitoring data | AQS API, TRI, SDWIS | `bronze.epa_air_quality`, `bronze.epa_toxic_releases`, `bronze.epa_water_quality` |
| [`16_bronze_doi.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/16_bronze_doi.py) | Ingest DOI natural resources data | USGS, NWIS, NPS | `bronze.doi_earthquakes`, `bronze.doi_water_data`, `bronze.doi_park_visitation` |

---

## ⚡ Execution Order

```mermaid
graph LR
    A[01_bronze_slot_telemetry] --> B[02_bronze_player_profile]
    B --> C[03_bronze_financial_txn]
    C --> D[04_bronze_compliance]
    D --> E[05_bronze_table_games]
    E --> F[06_bronze_security_events]
    
    style A fill:#cd7f32
    style B fill:#cd7f32
    style C fill:#cd7f32
    style D fill:#cd7f32
    style E fill:#cd7f32
    style F fill:#cd7f32
```

> **Note**: Notebooks can run in parallel if source systems are independent. Sequential execution ensures consistent timestamps for lineage tracking.

---

## 🔧 Key Transformations

| Transformation | Description |
|----------------|-------------|
| **Metadata Enrichment** | Add `_ingested_at`, `_source_system`, `_batch_id` columns |
| **Schema Preservation** | Maintain original field names and data types |
| **Append-Only Writes** | Never update/delete; always append new records |
| **Partition Strategy** | Partition by `_ingested_date` for efficient querying |
| **Format Conversion** | Convert source formats (JSON, CSV, XML) to Delta Lake |

### Common Bronze Patterns

```python
# Standard Bronze ingestion pattern
df = (spark.read
    .format("json")
    .load(source_path)
    .withColumn("_ingested_at", current_timestamp())
    .withColumn("_source_system", lit("slot_machines"))
    .withColumn("_batch_id", lit(batch_id))
)

df.write.format("delta").mode("append").saveAsTable("bronze.slot_telemetry")
```

---

## 📋 Dependencies

| Dependency | Type | Description |
|------------|------|-------------|
| **Fabric Lakehouse** | Infrastructure | Bronze lakehouse must be provisioned |
| **Source Connections** | Data | Connections to source systems configured |
| **sample-data/** | Development | Sample data files for testing |
| **Spark Runtime** | Compute | Fabric Spark pool with Delta Lake support |

### Pre-requisites Checklist

- [ ] Fabric workspace created
- [ ] Bronze lakehouse provisioned
- [ ] Source system credentials configured in Key Vault
- [ ] Sample data uploaded to `Files/raw/` folder

---

## ✅ Validation Steps

### Data Quality Checks

| Check | Query | Expected |
|-------|-------|----------|
| **Record Count** | `SELECT COUNT(*) FROM bronze.slot_telemetry` | > 0 records |
| **Null Primary Keys** | `SELECT COUNT(*) WHERE machine_id IS NULL` | 0 |
| **Ingestion Timestamp** | `SELECT MAX(_ingested_at)` | Within last batch window |
| **Schema Drift** | Compare schema to baseline | No unexpected columns |

### Validation Commands

```python
# Verify table exists and has data
display(spark.sql("SELECT COUNT(*) as record_count FROM bronze.slot_telemetry"))

# Check for recent ingestion
display(spark.sql("""
    SELECT 
        DATE(_ingested_at) as ingestion_date,
        COUNT(*) as records
    FROM bronze.slot_telemetry
    GROUP BY DATE(_ingested_at)
    ORDER BY ingestion_date DESC
    LIMIT 7
"""))

# Validate no null keys
assert spark.sql("SELECT COUNT(*) FROM bronze.slot_telemetry WHERE machine_id IS NULL").first()[0] == 0
```

---

## 📖 Related Resources

- **Tutorial**: [Day 1: Bronze Ingestion Tutorial](../../tutorials/01-bronze-layer/README.md)
- **Architecture**: [Medallion Architecture Overview](../../best-practices/medallion-architecture-deep-dive.md)
- **Data Generation**: [Bronze Data Generators](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/tree/main/data_generation/generators)
- **Next Layer**: [Silver Layer Notebooks](../silver/README.md)

---

## 🎰 Casino Domain Context

### Slot Telemetry Data Points

| Field | Description | Compliance Impact |
|-------|-------------|-------------------|
| `machine_id` | Unique slot machine identifier | NIGC MICS requirement |
| `spin_timestamp` | Exact time of each spin | Audit trail |
| `wager_amount` | Amount wagered per spin | Financial reporting |
| `payout_amount` | Amount won (if any) | W-2G threshold tracking |
| `denomination` | Machine denomination ($0.01-$100) | RTP calculations |

### Regulatory Considerations

- **NIGC MICS**: Minimum Internal Control Standards require complete audit trails
- **W-2G Threshold**: Track wins ≥ $1,200 for IRS reporting
- **SAR Patterns**: Preserve raw data for suspicious activity detection
- **Data Retention**: 5+ years for compliance requirements

---

> **Next Steps**: After Bronze layer completes successfully, proceed to [Silver Layer](../silver/README.md) for data cleansing and validation.
