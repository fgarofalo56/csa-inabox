# Notebook Cross-Reference Index

> **[Home](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/README.md)** | **[Tutorials](../tutorials/)** | **[Feature Docs](../features/)** | **[Validation](../validation/)**

Complete cross-reference mapping every notebook to its corresponding tutorial, feature doc, and use-case document. Use this index to navigate between implementation (notebooks), learning (tutorials), and reference (docs).

> **Last Updated**: 2026-04-27 | **Notebooks**: 68 | **Domains**: 9 + ML/AI + Streaming

---

!!! info "Third-party references — publicly sourced, good-faith comparison"
    This index references non-Microsoft products and services (for example, IBM DB2 and Oracle as CDC source systems). That information is drawn from each vendor's **publicly available documentation** and is offered for honest, good-faith comparison only. This is a personal project written from a Microsoft Fabric and Azure perspective; it does **not** claim expertise in, or authority over, any third-party product, and nothing here is an official statement by, or endorsed by, those vendors. Capabilities, pricing, and features change often — always verify against the vendor's current official documentation. Where a third-party offering is the stronger choice, we say so plainly.

---

## Table of Contents

- [Casino/Gaming Domain](#casinogaming-domain)
- [Federal -- Tribal Healthcare](#federal----tribal-healthcare)
- [Federal -- DOT/FAA Transportation](#federal----dotfaa-transportation)
- [Analytics Expansion](#analytics-expansion)
- [Federal -- USDA Agriculture](#federal----usda-agriculture)
- [Federal -- SBA Small Business](#federal----sba-small-business)
- [Federal -- NOAA Weather/Climate](#federal----noaa-weatherclimate)
- [Federal -- EPA Environment](#federal----epa-environment)
- [Federal -- DOI Interior](#federal----doi-interior)
- [Federal -- DOJ Justice](#federal----doj-justice)
- [Cross-Cutting and Special Purpose](#cross-cutting-and-special-purpose)
- [Machine Learning / AI](#machine-learning--ai)
- [Streaming / CDC](#streaming--cdc)
- [Real-Time Analytics](#real-time-analytics)
- [Utilities](#utilities)

---

## Casino/Gaming Domain

Core casino/gaming medallion pipeline -- the foundation of the POC.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 01 | [`bronze/01_bronze_slot_telemetry.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/01_bronze_slot_telemetry.py) | Bronze | [01-bronze-layer](../tutorials/01-bronze-layer/) | -- | Slot telemetry ingestion |
| 02 | [`bronze/02_bronze_player_profile.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/02_bronze_player_profile.py) | Bronze | [01-bronze-layer](../tutorials/01-bronze-layer/) | -- | Player demographics, SSN hashing |
| 03 | [`bronze/03_bronze_financial_txn.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/03_bronze_financial_txn.py) | Bronze | [01-bronze-layer](../tutorials/01-bronze-layer/) | -- | Cage transactions, CTR flagging |
| 04 | [`bronze/04_bronze_compliance.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/04_bronze_compliance.py) | Bronze | [01-bronze-layer](../tutorials/01-bronze-layer/) | -- | CTR/SAR/W-2G regulatory filings |
| 05 | [`bronze/05_bronze_table_games.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/05_bronze_table_games.py) | Bronze | [01-bronze-layer](../tutorials/01-bronze-layer/) | -- | Table game hand results |
| 06 | [`bronze/06_bronze_security_events.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/06_bronze_security_events.py) | Bronze | [01-bronze-layer](../tutorials/01-bronze-layer/) | -- | Surveillance and access logs |
| 01 | [`silver/01_silver_slot_cleansed.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/01_silver_slot_cleansed.py) | Silver | [02-silver-layer](../tutorials/02-silver-layer/) | -- | Deduplication, DQ scoring |
| 02 | [`silver/02_silver_player_master.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/02_silver_player_master.py) | Silver | [02-silver-layer](../tutorials/02-silver-layer/) | -- | SCD Type 2 player master |
| 03 | [`silver/03_silver_table_enriched.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/03_silver_table_enriched.py) | Silver | [02-silver-layer](../tutorials/02-silver-layer/) | -- | Session aggregation, patterns |
| 04 | [`silver/04_silver_financial_reconciled.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/04_silver_financial_reconciled.py) | Silver | [02-silver-layer](../tutorials/02-silver-layer/) | -- | CTR validation, structuring detect |
| 05 | [`silver/05_silver_security_enriched.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/05_silver_security_enriched.py) | Silver | [02-silver-layer](../tutorials/02-silver-layer/) | -- | Threat scoring, correlation |
| 06 | [`silver/06_silver_compliance_validated.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/06_silver_compliance_validated.py) | Silver | [02-silver-layer](../tutorials/02-silver-layer/) | -- | Threshold validation, deadlines |
| 00 | [`gold/00_gold_dim_tables.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/00_gold_dim_tables.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | -- | Shared dimension tables |
| 01 | [`gold/01_gold_slot_performance.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/01_gold_slot_performance.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | [Direct Lake](../features/direct-lake.md) | Coin-in, Theo, Hold%, variance |
| 02 | [`gold/02_gold_player_360.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/02_gold_player_360.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | -- | LTV, churn risk, tier analytics |
| 03 | [`gold/03_gold_compliance_reporting.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/03_gold_compliance_reporting.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | -- | CTR/SAR/W-2G counts and reports |
| 04 | [`gold/04_gold_table_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/04_gold_table_analytics.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | -- | Drop, Win, Hold% by table |
| 05 | [`gold/05_gold_financial_summary.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/05_gold_financial_summary.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | -- | Daily P&L, cash flow summary |
| 06 | [`gold/06_gold_security_dashboard.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/06_gold_security_dashboard.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | -- | Incidents, threats, response KPIs |
| 07 | [`gold/07_gold_player_slot_daily.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/07_gold_player_slot_daily.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | -- | Player-slot daily activity |
| 08 | [`gold/08_gold_player_table_daily.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/08_gold_player_table_daily.py) | Gold | [03-gold-layer](../tutorials/03-gold-layer/) | -- | Player-table daily activity |

---

## Federal -- Tribal Healthcare

HIPAA-compliant health encounter processing with PHI masking and FHIR R4 mapping.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 07 | [`bronze/07_bronze_tribal_health.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/07_bronze_tribal_health.py) | Bronze | [30-tribal-healthcare](../tutorials/30-tribal-healthcare/) | -- | IHS encounter ingestion, HIPAA audit |
| 07 | [`silver/07_silver_tribal_health.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/07_silver_tribal_health.py) | Silver | [30-tribal-healthcare](../tutorials/30-tribal-healthcare/) | -- | PHI masking, FHIR R4, ICD-10 |
| 07 | [`gold/07_gold_tribal_health_360.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/07_gold_tribal_health_360.py) | Gold | [30-tribal-healthcare](../tutorials/30-tribal-healthcare/) | -- | [Tribal Health Analytics](../use-cases/tribal-health-analytics.md) |

---

## Federal -- DOT/FAA Transportation

Multi-domain transportation data: flights, safety incidents, traffic.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 08 | [`bronze/08_bronze_dot_faa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/08_bronze_dot_faa.py) | Bronze | [31-federal-dot-faa](../tutorials/31-federal-dot-faa/) | -- | Multi-domain FAA ingestion |
| 08 | [`silver/08_silver_dot_faa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/08_silver_dot_faa.py) | Silver | [31-federal-dot-faa](../tutorials/31-federal-dot-faa/) | -- | IATA validation, delay categories |
| 08 | [`gold/08_gold_dot_faa_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/08_gold_dot_faa_analytics.py) | Gold | [31-federal-dot-faa](../tutorials/31-federal-dot-faa/) | -- | [Transportation Safety](../use-cases/transportation-safety-analytics.md) |

---

## Analytics Expansion

Video surveillance, people movement tracking, and geolocation analytics.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 09 | [`bronze/09_bronze_video_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/09_bronze_video_analytics.py) | Bronze | [27-video-security](../tutorials/27-video-security-analytics/) | -- | Video event ingestion |
| 09 | [`silver/09_silver_video_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/09_silver_video_analytics.py) | Silver | [27-video-security](../tutorials/27-video-security-analytics/) | -- | Threat classification, anomaly flag |
| 09 | [`gold/09_gold_video_security_kpis.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/09_gold_video_security_kpis.py) | Gold | [27-video-security](../tutorials/27-video-security-analytics/) | -- | Detection rates, response times |
| 10 | [`bronze/10_bronze_people_movement.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/10_bronze_people_movement.py) | Bronze | [28-people-movement](../tutorials/28-people-movement-analytics/) | -- | Movement tracking ingestion |
| 10 | [`silver/10_silver_people_movement.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/10_silver_people_movement.py) | Silver | [28-people-movement](../tutorials/28-people-movement-analytics/) | -- | Dwell time, flow analysis |
| 10 | [`gold/10_gold_movement_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/10_gold_movement_analytics.py) | Gold | [28-people-movement](../tutorials/28-people-movement-analytics/) | -- | Zone occupancy, peak analysis |
| 11 | [`bronze/11_bronze_geolocation.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/11_bronze_geolocation.py) | Bronze | [29-geolocation](../tutorials/29-geolocation-analytics/) | -- | Geolocation event ingestion |
| 11 | [`silver/11_silver_geolocation.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/11_silver_geolocation.py) | Silver | [29-geolocation](../tutorials/29-geolocation-analytics/) | -- | H3 indexing, geofence validation |
| 11 | [`gold/11_gold_geolocation_insights.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/11_gold_geolocation_insights.py) | Gold | [29-geolocation](../tutorials/29-geolocation-analytics/) | -- | Hotspot analysis, geo-attribution |

---

## Federal -- USDA Agriculture

Crop production, food safety, and agricultural economics.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 12 | [`bronze/12_bronze_usda.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/12_bronze_usda.py) | Bronze | [32-usda-agriculture](../tutorials/32-usda-agriculture/) | -- | USDA dataset ingestion |
| 12 | [`silver/12_silver_usda.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/12_silver_usda.py) | Silver | [32-usda-agriculture](../tutorials/32-usda-agriculture/) | -- | Crop data cleansing, validation |
| 12 | [`gold/12_gold_usda_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/12_gold_usda_analytics.py) | Gold | [32-usda-agriculture](../tutorials/32-usda-agriculture/) | -- | [Agricultural Analytics](../use-cases/agricultural-analytics.md) |

---

## Federal -- SBA Small Business

Loan programs, disaster lending, and small business analytics.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 13 | [`bronze/13_bronze_sba.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/13_bronze_sba.py) | Bronze | [33-sba-small-business](../tutorials/33-sba-small-business/) | -- | SBA loan data ingestion |
| 13 | [`silver/13_silver_sba.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/13_silver_sba.py) | Silver | [33-sba-small-business](../tutorials/33-sba-small-business/) | -- | Loan validation, enrichment |
| 13 | [`gold/13_gold_sba_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/13_gold_sba_analytics.py) | Gold | [33-sba-small-business](../tutorials/33-sba-small-business/) | -- | [Small Business Lending](../use-cases/small-business-lending-analytics.md) |

---

## Federal -- NOAA Weather/Climate

Weather observations, climate data, and storm events.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 14 | [`bronze/14_bronze_noaa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/14_bronze_noaa.py) | Bronze | [34-noaa-weather-climate](../tutorials/34-noaa-weather-climate/) | -- | NOAA weather data ingestion |
| 14 | [`silver/14_silver_noaa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/14_silver_noaa.py) | Silver | [34-noaa-weather-climate](../tutorials/34-noaa-weather-climate/) | -- | Station validation, unit conversion |
| 14 | [`gold/14_gold_noaa_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/14_gold_noaa_analytics.py) | Gold | [34-noaa-weather-climate](../tutorials/34-noaa-weather-climate/) | -- | [Weather/Climate Analytics](../use-cases/weather-climate-analytics.md) |

---

## Federal -- EPA Environment

Air quality monitoring, water quality, and emissions tracking.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 15 | [`bronze/15_bronze_epa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/15_bronze_epa.py) | Bronze | [35-epa-environment](../tutorials/35-epa-environment/) | -- | EPA environmental data ingestion |
| 15 | [`silver/15_silver_epa.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/15_silver_epa.py) | Silver | [35-epa-environment](../tutorials/35-epa-environment/) | -- | Compliance threshold checks |
| 15 | [`gold/15_gold_epa_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/15_gold_epa_analytics.py) | Gold | [35-epa-environment](../tutorials/35-epa-environment/) | -- | [Environmental Compliance](../use-cases/environmental-compliance-analytics.md) |

---

## Federal -- DOI Interior

Land management, wildlife tracking, and natural resource analytics.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 16 | [`bronze/16_bronze_doi.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/16_bronze_doi.py) | Bronze | [36-doi-interior](../tutorials/36-doi-interior/) | -- | DOI resource data ingestion |
| 16 | [`silver/16_silver_doi.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/16_silver_doi.py) | Silver | [36-doi-interior](../tutorials/36-doi-interior/) | -- | Geospatial validation, enrichment |
| 16 | [`gold/16_gold_doi_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/16_gold_doi_analytics.py) | Gold | [36-doi-interior](../tutorials/36-doi-interior/) | -- | [Natural Resources Analytics](../use-cases/natural-resources-analytics.md) |

---

## Federal -- DOJ Justice

Case management, antitrust enforcement, and federal justice analytics.

| # | Notebook | Layer | Tutorial | Feature Doc | Use Case |
|---|----------|-------|----------|-------------|----------|
| 18 | [`bronze/18_bronze_doj.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/18_bronze_doj.py) | Bronze | [38-doj-justice](../tutorials/38-doj-justice/) | -- | DOJ case data ingestion |
| 18 | [`silver/18_silver_doj.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/silver/18_silver_doj.py) | Silver | [38-doj-justice](../tutorials/38-doj-justice/) | -- | Case validation, jurisdiction |
| 19 | [`gold/19_gold_doj_analytics.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/19_gold_doj_analytics.py) | Gold | [38-doj-justice](../tutorials/38-doj-justice/) | -- | [Federal Justice Analytics](../use-cases/federal-justice-analytics.md) |

---

## Cross-Cutting and Special Purpose

Notebooks that span domains or implement special features.

| # | Notebook | Layer | Tutorial | Feature Doc |
|---|----------|-------|----------|-------------|
| 17 | [`bronze/17_bronze_shortcut_transformations.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/bronze/17_bronze_shortcut_transformations.py) | Bronze | [08-database-mirroring](../tutorials/08-database-mirroring/) | [Mirroring](../features/mirroring.md) |
| 17 | [`gold/17_gold_ai_functions_compliance.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/17_gold_ai_functions_compliance.py) | Gold | [19-copilot-ai](../tutorials/19-copilot-ai/) | [AI Copilot](../features/ai-copilot-configuration.md) |
| 18 | [`gold/18_gold_digital_twin_demo.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/gold/18_gold_digital_twin_demo.py) | Gold | -- | [Digital Twin Builder](../features/digital-twin-builder.md) |

---

## Machine Learning / AI

Predictive models and AI/ML pipelines using Fabric MLflow.

| # | Notebook | Type | Tutorial | Feature Doc |
|---|----------|------|----------|-------------|
| 01 | [`ml/01_ml_player_churn_prediction.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/ml/01_ml_player_churn_prediction.py) | GBT Classifier | [09-advanced-ai-ml](../tutorials/09-advanced-ai-ml/) | [AutoML](../features/automl-model-endpoints.md) |
| 02 | [`ml/02_ml_fraud_detection.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/ml/02_ml_fraud_detection.py) | Isolation Forest | [09-advanced-ai-ml](../tutorials/09-advanced-ai-ml/) | [AutoML](../features/automl-model-endpoints.md) |
| 03 | [`ml/03_ml_automl_weather_forecasting.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/ml/03_ml_automl_weather_forecasting.py) | AutoML | [09-advanced-ai-ml](../tutorials/09-advanced-ai-ml/) | [AutoML](../features/automl-model-endpoints.md) |

---

## Streaming / CDC

CDC and IoT streaming connectors for real-time data ingestion from diverse sources.

| # | Notebook | Source | Tutorial | Feature Doc |
|---|----------|--------|----------|-------------|
| 01 | [`streaming/01_sql_server_cdc.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/streaming/01_sql_server_cdc.py) | SQL Server (Debezium) | [26-multi-source-streaming](../tutorials/26-multi-source-streaming/) | [Copy Job CDC](../features/copy-job-cdc.md) |
| 02 | [`streaming/02_azure_sql_change_feed.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/streaming/02_azure_sql_change_feed.py) | Azure SQL (Change Tracking) | [26-multi-source-streaming](../tutorials/26-multi-source-streaming/) | [Mirroring](../features/mirroring.md) |
| 03 | [`streaming/03_cosmos_db_change_feed.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/streaming/03_cosmos_db_change_feed.py) | Cosmos DB (Change Feed) | [26-multi-source-streaming](../tutorials/26-multi-source-streaming/) | [Mirroring](../features/mirroring.md) |
| 04 | [`streaming/04_ibm_db2_cdc.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/streaming/04_ibm_db2_cdc.py) | IBM DB2 (ASN Capture) | [25-ibm-db2-source](../tutorials/25-ibm-db2-source/) | [Source Patterns](../best-practices/09_SOURCE_SPECIFIC_PATTERNS.md) |
| 05 | [`streaming/05_oracle_cdc.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/streaming/05_oracle_cdc.py) | Oracle (LogMiner) | [26-multi-source-streaming](../tutorials/26-multi-source-streaming/) | [Source Patterns](../best-practices/09_SOURCE_SPECIFIC_PATTERNS.md) |
| 06 | [`streaming/06_kafka_connector.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/streaming/06_kafka_connector.py) | Apache Kafka (Avro/JSON) | [26-multi-source-streaming](../tutorials/26-multi-source-streaming/) | [RTI](../features/real-time-intelligence.md) |
| 07 | [`streaming/07_iot_hub_ingestion.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/streaming/07_iot_hub_ingestion.py) | Azure IoT Hub | [26-multi-source-streaming](../tutorials/26-multi-source-streaming/) | [RTI](../features/real-time-intelligence.md) |
| 08 | [`streaming/08_slot_machine_iot_simulator.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/streaming/08_slot_machine_iot_simulator.py) | Custom IoT (SAS) | [04-real-time-analytics](../tutorials/04-real-time-analytics/) | [RTI](../features/real-time-intelligence.md) |

---

## Real-Time Analytics

Live streaming and KQL query notebooks.

| # | Notebook | Type | Tutorial | Feature Doc |
|---|----------|------|----------|-------------|
| 01 | [`real-time/01_realtime_slot_streaming.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/real-time/01_realtime_slot_streaming.py) | Spark Structured Streaming | [04-real-time-analytics](../tutorials/04-real-time-analytics/) | [RTI](../features/real-time-intelligence.md) |
| 02 | `real-time/02_kql_casino_floor.kql` | KQL Queries | [04-real-time-analytics](../tutorials/04-real-time-analytics/) | [Eventhouse](../features/eventhouse-vector-database.md) |

---

## Utilities

Shared helper modules used across notebooks.

| File | Purpose | Used By |
|------|---------|---------|
| [`utils/bronze_utils.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/utils/bronze_utils.py) | Common Bronze ingestion helpers (schema, audit columns) | All Bronze notebooks |
| [`utils/lineage_utils.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/utils/lineage_utils.py) | Data lineage tracking utilities | Silver/Gold notebooks |
| [`utils/pipeline_execution_log_setup.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/utils/pipeline_execution_log_setup.py) | Pipeline execution logging setup | Pipeline-orchestrated runs |

---

## Summary Statistics

| Category | Bronze | Silver | Gold | ML | Streaming | Real-Time | Utils | Total |
|----------|--------|--------|------|----|-----------|-----------| ------|-------|
| Casino/Gaming | 6 | 6 | 8 | 2 | -- | 2 | -- | 24 |
| Tribal Health | 1 | 1 | 1 | -- | -- | -- | -- | 3 |
| DOT/FAA | 1 | 1 | 1 | -- | -- | -- | -- | 3 |
| Video/Movement/Geo | 3 | 3 | 3 | -- | -- | -- | -- | 9 |
| USDA | 1 | 1 | 1 | -- | -- | -- | -- | 3 |
| SBA | 1 | 1 | 1 | -- | -- | -- | -- | 3 |
| NOAA | 1 | 1 | 1 | 1 | -- | -- | -- | 4 |
| EPA | 1 | 1 | 1 | -- | -- | -- | -- | 3 |
| DOI | 1 | 1 | 1 | -- | -- | -- | -- | 3 |
| DOJ | 1 | 1 | 1 | -- | -- | -- | -- | 3 |
| Cross-Cutting | 1 | -- | 2 | -- | -- | -- | -- | 3 |
| Streaming/CDC | -- | -- | -- | -- | 8 | -- | -- | 8 |
| Utilities | -- | -- | -- | -- | -- | -- | 3 | 3 |
| **Total** | **18** | **17** | **21** | **3** | **8** | **2** | **3** | **72** |

---

## Related Resources

| Resource | Description |
|----------|-------------|
| [Tutorials](../tutorials/index.md) | Step-by-step implementation guides |
| [Feature Docs](../features/) | Fabric feature reference documentation |
| [Best Practices](../best-practices/) | Architecture and engineering best practices |
| [Use Cases](../use-cases/) | Applied analytics use cases with references |
| [Data Generation](../data_generation/README.md) | Test data generation for notebooks |
| [Validation](../validation/README.md) | Unit tests and data quality suites |

---

[Back to Top](#notebook-cross-reference-index) | [Main README](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/README.md)
