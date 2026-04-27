# PRP: CSA-in-a-Box Platform Expansion — Complete Tutorials, Landing Zones & AI-First Analytics

**PRP ID:** PRP-PLATFORM-EXPANSION  
**Created:** 2026-04-22  
**Updated:** 2026-04-22 (v2 — all decisions resolved)  
**Status:** Ready for Implementation  
**Archon Project:** 145c8d71-7e54-4135-8ec9-d6300caf4517  
**Estimated Effort:** XL (20–40 weeks of engineering across 8 workstreams)

---

## Decisions Log (User Answers)

| # | Decision | Answer |
|---|----------|--------|
| 1 | Data sources | Use **public federal data** for all domains. Build download notebooks/pipelines for each. Add new public data to existing verticals too. |
| 2 | ArcGIS licensing | Assume **BYOL** (Bring Your Own License) |
| 3 | AI models | Use **latest Azure OpenAI models via Foundry** — GPT-5.4, plus any supported Microsoft first-party models. No third-party. |
| 4 | Streaming scale | *(Answered as AI models — streaming uses real-time public feeds)* |
| 5 | GraphRAG scope | **Complete working step-by-step build-out** including: Azure infrastructure deployment, knowledge store creation, document import (PDF, CSV, Word, Markdown), site scanning (GitHub), parsing, and full Knowledge Graph population. Full deployment to Azure. |
| 6 | Semantic Kernel | **Separate tutorial path** for building agents using AI Foundry with Microsoft Python SDK + Semantic Kernel for multi-agent workloads. NOT for the existing CSA Copilot chat wizard — that stays PydanticAI. |
| 7 | Government cloud | **Phase 2** — add MAG (Microsoft Azure Government) support after everything is tested. Mark as "Coming Soon" in docs. |
| 8 | Priority | Claude picks priority (see wave sequencing below) |

---

## 1. Problem Statement

CSA-in-a-Box has a production-ready core (30+ Bicep modules, 9 vertical examples, 4 portal variants, dbt medallion pipelines, governance automation). However, several major gaps exist:

1. **No end-to-end tutorials** — QUICKSTART and GETTING_STARTED exist but no guided "choose-your-path" walkthroughs
2. **No complete Data Marketplace** — deprecated module; portal-based replacement is functional but lacks full product experience
3. **Purview governance is code-only** — automation exists but zero step-by-step documentation for users
4. **GeoAnalytics is a stub** — only a copyright file exists; no code, no Bicep, no docs
5. **Streaming Landing Zone is thin** — Event Hubs/ADX exist in code but no dedicated landing zone or setup guides
6. **AI/Analytics path is incomplete** — RAG works, but no Semantic Kernel, GraphRAG, Knowledge Graphs, or MCP tool invocation
7. **No guided learning paths** — users can't choose "I want streaming" or "I want AI" and follow a complete tutorial
8. **No public data pipelines** — examples use generated data; no pipelines to pull real federal/public data

---

## 2. Workstreams (Priority Order)

### WS-1: Guided Tutorial Paths & Learning System (Priority: P0)

**Goal:** Create a tutorial system with multiple guided paths so users can follow complete end-to-end walkthroughs based on their use case.

#### Deliverables

**1.1 Tutorial Framework**
- `docs/tutorials/README.md` — Tutorial index with path selector (decision tree diagram)
- `docs/tutorials/_template/TUTORIAL_TEMPLATE.md` — Standard template: Prerequisites → Architecture Diagram → Deploy Infrastructure → Configure Services → Ingest Data → Process & Transform → Validate → Extend → Troubleshoot
- Each tutorial is self-contained, 60–120 minutes, with expected outputs at each step
- Every tutorial includes a `validate.sh` script that checks expected state

**1.2 Path A: Foundation Platform (Batch Analytics)**
- `docs/tutorials/01-foundation-platform/`
  - Deploy ALZ + DMLZ + DLZ from scratch (Bicep step-by-step)
  - Configure networking (VNet peering, private endpoints, DNS)
  - Set up RBAC and managed identities
  - Deploy storage accounts with medallion structure
  - Deploy Databricks workspace + Unity Catalog
  - Deploy Synapse workspace (serverless SQL)
  - Configure Data Factory for ingestion
  - Run first dbt pipeline (USDA vertical with real NASS data)
  - Validate end-to-end: raw → bronze → silver → gold → Power BI
  - **Expected time:** 90 minutes (with pre-existing Azure subscription)

**1.3 Path B: Data Governance with Purview** (→ WS-2)
- `docs/tutorials/02-data-governance/`

**1.4 Path C: GeoAnalytics Studio** (→ WS-3)
- `docs/tutorials/03-geoanalytics-azure-oss/`
- `docs/tutorials/04-geoanalytics-arcgis/`

**1.5 Path D: Streaming & Event-Driven** (→ WS-4)
- `docs/tutorials/05-streaming-lambda/`

**1.6 Path E: AI-First Analytics** (→ WS-5)
- `docs/tutorials/06-ai-analytics/`
- `docs/tutorials/07-agents-foundry-sk/`
- `docs/tutorials/08-rag-vectors/`
- `docs/tutorials/09-graphrag-knowledge/`

**1.7 Path F: Data Marketplace** (→ WS-6)
- `docs/tutorials/10-data-marketplace/`

#### Implementation Steps
1. Create `docs/tutorials/` directory structure and README with path diagram
2. Create `docs/tutorials/_template/TUTORIAL_TEMPLATE.md`
3. Author Path A foundation tutorial (references existing Bicep, adds step-by-step narrative)
4. Author remaining paths (each references its workstream deliverables)

---

### WS-2: Purview Data Governance — Complete Documentation & Automation (Priority: P0)

**Goal:** Comprehensive step-by-step documentation for using Microsoft Purview as the central governance tool across the entire CSA-in-a-Box platform.

#### Deliverables

**2.1 Purview Setup Guide**
- `docs/governance/PURVIEW_SETUP.md`
  - Prerequisites (Purview account provisioning via Bicep — already exists in DMLZ)
  - Initial configuration: root collection hierarchy design
  - Register data sources (ADLS, Databricks, Synapse, SQL, Cosmos DB)
  - Configure managed identity permissions for scanning
  - Network configuration (private endpoints, managed VNet)

**2.2 Metadata Management**
- `docs/governance/METADATA_MANAGEMENT.md`
  - Automated scanning setup (schedules, scope, triggers)
  - Custom scan rule sets for CSA-specific file formats (Parquet, Delta, GeoParquet)
  - Schema extraction and technical metadata
  - Business metadata enrichment via glossary terms
  - Custom metadata attributes (data domain, quality tier, SLA)
  - Bulk metadata operations via Purview REST API
  - Integration with `csa_platform/governance/purview/purview_automation.py`

**2.3 Data Cataloging**
- `docs/governance/DATA_CATALOGING.md`
  - Business glossary: creating term hierarchies (domain → subdomain → term)
  - Linking glossary terms to technical assets
  - Custom classifications (create regex/dictionary classifiers for federal data types)
  - Sensitivity labels (MIP integration for PII, PHI, financial data)
  - Asset certification workflows (endorsed, certified, deprecated)
  - Search & discovery best practices

**2.4 Data Lineage**
- `docs/governance/DATA_LINEAGE.md`
  - ADF pipeline lineage (automatic capture)
  - Databricks notebook lineage (OpenLineage integration)
  - Synapse pipeline lineage
  - dbt lineage → Purview (custom integration via `purview_automation.py`)
  - Column-level lineage configuration
  - Cross-domain lineage visualization
  - Lineage for streaming pipelines (Event Hubs → processing → serving)

**2.5 Data Quality**
- `docs/governance/DATA_QUALITY.md`
  - Quality rules engine (Great Expectations integration — already in `csa_platform/governance/`)
  - Purview Data Quality rules (no-code rules in portal)
  - Quality scoring methodology (completeness, accuracy, timeliness, consistency)
  - Quality dashboards and alerting
  - Integration: quality scores → data marketplace trust indicators
  - Automated remediation workflows

**2.6 Data Access Governance**
- `docs/governance/DATA_ACCESS.md`
  - Self-service access policies (Purview access policies for ADLS, SQL)
  - Approval workflows for sensitive data
  - RBAC inheritance through collection hierarchy
  - Integration with data contracts (`contract.yaml`)
  - Audit logging and compliance reporting

**2.7 Automation Scripts & Code**
- `scripts/governance/bootstrap-purview.sh` — Complete Purview bootstrap (collections, glossary seed, scan setup)
- `scripts/governance/register-sources.sh` — Register all DLZ data sources
- `scripts/governance/seed-glossary.py` — Seed business glossary from YAML definitions
- `csa_platform/governance/purview/lineage_publisher.py` — Publish dbt/custom lineage to Purview
- `csa_platform/governance/purview/quality_reporter.py` — Push quality scores to Purview
- `csa_platform/governance/purview/glossary_manager.py` — CRUD operations for glossary terms
- `csa_platform/governance/purview/classification_manager.py` — Manage custom classifiers

#### Implementation Steps
1. Document Purview setup leveraging existing Bicep DMLZ module
2. Extend `purview_automation.py` with glossary, classification, and lineage publishing
3. Create bootstrap and seeding scripts
4. Author all 6 governance docs with step-by-step instructions
5. Create tutorial `docs/tutorials/02-data-governance/` referencing these docs
6. Add tests for new automation code

---

### WS-3: GeoAnalytics Data Landing Zone (Priority: P1)

**Goal:** Two complete GeoAnalytics paths — Azure OSS (Databricks/Synapse/Spark) and ArcGIS Enterprise (BYOL).

#### Public Data Sources for GeoAnalytics

| Dataset | URL | Format | Use Case |
|---------|-----|--------|----------|
| Census TIGER/Line | `https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html` | Shapefile/GeoJSON | Boundaries, roads, water features |
| Natural Earth | `https://www.naturalearthdata.com/downloads/` | Shapefile | Country/state boundaries, coastlines |
| USGS 3DEP Elevation | `https://apps.nationalmap.gov/downloader/` | GeoTIFF | Terrain analysis |
| OpenStreetMap | `https://download.geofabrik.de` | PBF/Shapefile | Points of interest, road network |
| NOAA Weather Stations | `https://www.ncei.noaa.gov/access/homr/` | CSV+lat/lon | Station location mapping |
| EPA FRS Facilities | `https://www.epa.gov/frs` | CSV+coords | Environmental facility mapping |
| DOT National Highway | `https://geodata.bts.gov` | Shapefile | Transportation network |
| USGS PAD-US Protected Areas | `https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-download` | GeoJSON/Shapefile | Conservation analysis |
| USDA CropScape | `https://nassgeodata.gmu.edu/CropScape/` | GeoTIFF/WMS | Agricultural land use |
| Tribal Boundaries (BIA) | `https://biamaps.doi.gov/biamap/` | Shapefile | Tribal land analysis |

#### Deliverables

**3.1 GeoAnalytics Bicep Landing Zone**
- `deploy/bicep/dlz/modules/geoanalytics.bicep`
  - Databricks workspace with geospatial cluster config (Apache Sedona, GeoPandas, H3 pre-installed)
  - ADLS Gen2 with geospatial container structure (vector/, raster/, reference/, output/)
  - Azure Maps account
  - Optional: Azure Database for PostgreSQL with PostGIS extension
  - Optional: ArcGIS Enterprise VM deployment (marketplace image) — BYOL
  - Networking: private endpoints, NSG rules for ArcGIS ports
- `deploy/bicep/dlz/parameters/geoanalytics.dev.bicepparam`
- `deploy/bicep/dlz/parameters/geoanalytics.prod.bicepparam`
- **Note:** Azure Government variant deferred to Phase 2 (Coming Soon)

**3.2 Data Download Pipeline**
- `scripts/data/download-geospatial.py` — Downloads and stages public geospatial data
  - Census TIGER/Line → ADLS Bronze/geo/vector/tiger/
  - Natural Earth → ADLS Bronze/geo/vector/natural-earth/
  - USGS Elevation (sample tile) → ADLS Bronze/geo/raster/elevation/
  - OpenStreetMap (state extract) → ADLS Bronze/geo/vector/osm/
  - EPA FRS facilities → ADLS Bronze/geo/vector/epa-facilities/
  - Auto-converts Shapefiles to GeoParquet where possible
- `notebooks/data-download/01-download-geospatial-data.py` — Databricks notebook version

**3.3 Path A — Azure OSS GeoAnalytics Studio**
- `docs/tutorials/03-geoanalytics-azure-oss/`
  - **Step 1:** Deploy GeoAnalytics landing zone (Bicep)
  - **Step 2:** Configure Databricks with Sedona
    - Cluster init script: Apache Sedona, GeoPandas, H3, Shapely, Rasterio, GDAL
    - Unity Catalog setup for geospatial schemas
  - **Step 3:** Download and ingest public geospatial data
    - Run download pipeline → data lands in ADLS Bronze
    - GeoParquet, GeoJSON, Cloud-Optimized GeoTIFF (COG) formats
    - Sources: Census TIGER/Line, USGS elevation, EPA facilities, DOT highway
  - **Step 4:** Process with Sedona on Spark
    - Spatial SQL queries (ST_Contains, ST_Distance, ST_Buffer)
    - Spatial joins at scale (e.g., EPA facilities within Census tracts)
    - H3 hexagonal indexing for aggregation
    - Raster processing with Rasterio (elevation analysis)
  - **Step 5:** Serve geospatial analytics
    - Synapse Serverless SQL for ad-hoc spatial queries
    - Materialized Gold views with pre-computed spatial aggregations
    - GeoJSON API endpoints for web map consumption
  - **Step 6:** Visualize
    - Power BI with Azure Maps visual
    - Kepler.gl / deck.gl web visualization
    - Jupyter notebook maps (Folium, ipyleaflet)
  - **Step 7:** Validate end-to-end pipeline

- `examples/geoanalytics/` — Complete vertical example
  - `data/download_geospatial.py` — Public data downloader
  - `notebooks/01-sedona-spatial-analysis.py` — Spatial SQL on Census + EPA data
  - `notebooks/02-h3-hexagonal-aggregation.py` — H3 aggregation of DOT highway data
  - `notebooks/03-raster-elevation-analysis.py` — USGS elevation processing
  - `notebooks/04-tribal-boundary-analysis.py` — BIA tribal boundary + health facility overlay
  - `dbt/models/` — Geospatial medallion (bronze_parcels → silver_enriched → gold_spatial_analytics)
  - `deploy/deploy.sh` — End-to-end deployment + data download + processing
  - `deploy/teardown.sh`

**3.4 Path B — ArcGIS Enterprise on Azure (BYOL)**
- `docs/tutorials/04-geoanalytics-arcgis/`
  - **Step 1:** Deploy ArcGIS Enterprise on Azure
    - Bicep template for ArcGIS Enterprise base (Server, Portal, Data Store) — BYOL licensing
    - Sizing guide (VM SKUs for different workloads)
    - SSL/TLS configuration with Azure Key Vault
    - Entra ID integration for SSO
  - **Step 2:** Configure ArcGIS GeoAnalytics Server
    - Enable GeoAnalytics Server role
    - Configure Spark execution environment
    - Register Azure Data Lake as big data file share
  - **Step 3:** Integrate with Azure Data Platform
    - ArcGIS → ADLS: publish analysis results to data lake
    - ADLS → ArcGIS: register lake data as feature layers
    - ArcGIS GeoEvent Server → Event Hubs (real-time geospatial streaming)
    - Databricks ↔ ArcGIS: bi-directional data exchange via arcgis Python API
  - **Step 4:** Build GeoAnalytics workflows
    - Standard tools (aggregate points, find hot spots, trace proximity)
    - Custom GeoAnalytics with Python raster functions
    - Scheduled analysis via ArcGIS Workflow Manager
  - **Step 5:** ArcGIS Insights for self-service analytics
  - **Step 6:** Governance integration
    - Register ArcGIS data in Purview catalog
    - Lineage from ArcGIS processing → data lake → analytics

- `deploy/bicep/dlz/modules/arcgis-enterprise.bicep` — ArcGIS infrastructure module (BYOL)

#### Implementation Steps
1. Create `geoanalytics.bicep` module (Databricks geo-cluster, ADLS geo containers, Azure Maps)
2. Create `arcgis-enterprise.bicep` module (VMs, networking, storage)
3. Build data download pipeline (`scripts/data/download-geospatial.py`)
4. Build `examples/geoanalytics/` vertical with notebooks
5. Author Path A tutorial (OSS)
6. Author Path B tutorial (ArcGIS BYOL)
7. Add Sedona cluster init script to `scripts/databricks/`
8. Create dbt geospatial models
9. Add deployment scripts for both paths

---

### WS-4: Streaming Data Landing Zone — Lambda Architecture (Priority: P1)

**Goal:** Complete streaming landing zone with Lambda architecture for event-driven workloads, using real-time public data feeds.

#### Real-Time Public Data Feeds

| Feed | URL | Format | Update Frequency |
|------|-----|--------|-----------------|
| USGS Earthquakes | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson` | GeoJSON | Every minute |
| NOAA Weather Alerts | `https://api.weather.gov/alerts/active` | JSON/GeoJSON | Real-time |
| OpenSky Aircraft | `https://opensky-network.org/api/states/all` | JSON | 10-sec intervals |
| USGS Water Services | `https://waterservices.usgs.gov/rest/IV/` | JSON | 15-min intervals |
| Wikimedia Recent Changes | `https://stream.wikimedia.org/v2/stream/recentchange` | SSE/JSON | Real-time |
| GDELT Global Events | `https://api.gdeltproject.org/api/v2/doc/doc` | JSON/CSV | 15-min |

#### Deliverables

**4.1 Streaming Landing Zone Bicep**
- `deploy/bicep/dlz/modules/streaming.bicep`
  - Event Hubs namespace (Standard/Premium, partitions, capture to ADLS)
  - Event Hubs Kafka endpoint configuration
  - Azure Stream Analytics (dedicated cluster or shared)
  - Azure Data Explorer (ADX) cluster + databases
  - Cosmos DB (change feed enabled, for serving layer)
  - Azure Functions (event processing)
  - Azure Service Bus (command/query messaging)
  - Storage accounts (checkpoint, DLQ)
  - Monitoring: Log Analytics, Application Insights, ADX dashboards
  - Networking: private endpoints for all services
- `deploy/bicep/dlz/parameters/streaming.dev.bicepparam`
- `deploy/bicep/dlz/parameters/streaming.prod.bicepparam`
- **Note:** Azure Government variant deferred to Phase 2 (Coming Soon)

**4.2 Lambda Architecture Tutorial**
- `docs/tutorials/05-streaming-lambda/`
  - **Architecture overview:** Speed layer (real-time) + Batch layer (historical) + Serving layer (unified view)
  - **Step 1:** Deploy streaming landing zone (Bicep)
  - **Step 2:** Configure Event Hubs
    - Create event hubs (ingestion, processed, alerts, DLQ)
    - Configure consumer groups
    - Enable capture to ADLS (Avro → auto-archive to Bronze)
    - Kafka endpoint setup (for Kafka-compatible producers)
  - **Step 3:** Ingest real-time public data
    - USGS Earthquake feed → Event Hubs (polling producer)
    - NOAA Weather Alerts → Event Hubs
    - Wikimedia SSE stream → Event Hubs (SSE consumer)
    - Data generators for synthetic load testing
  - **Step 4:** Build speed layer
    - Option A: Azure Stream Analytics
      - Windowing queries (tumbling, hopping, sliding, session)
      - Temporal joins and reference data
      - Anomaly detection (built-in ML)
      - Output to ADX, Cosmos DB, Power BI
    - Option B: Databricks Structured Streaming
      - Delta Live Tables for streaming medallion
      - Exactly-once processing with checkpointing
      - Watermark handling for late-arriving data
      - Output to Delta Lake (unified batch + streaming)
    - Option C: Azure Functions
      - Event Hub trigger functions
      - Stateless event processing
      - Fan-out patterns with Service Bus
  - **Step 5:** Build batch layer
    - Event Hubs Capture → ADLS Bronze (automatic)
    - dbt batch models for historical aggregation
    - Databricks scheduled jobs for heavy transformations
  - **Step 6:** Build serving layer
    - ADX for hot analytics (KQL dashboards, sub-second queries)
    - Cosmos DB for application serving (low-latency lookups)
    - Synapse Serverless for ad-hoc historical queries
    - Power BI real-time dashboards
  - **Step 7:** Dead Letter Queue (DLQ) handling
    - Failed event capture and replay
    - Alerting on DLQ depth
    - Manual reprocessing workflows
  - **Step 8:** Monitoring and operations
    - Event Hub metrics (throughput, backlog, errors)
    - Stream Analytics job health
    - End-to-end latency tracking
    - Auto-scaling configuration
  - **Step 9:** Validate end-to-end with live earthquake data

**4.3 Streaming Platform Code**
- Extend `csa_platform/streaming/` (already has contract per CSA-0137)
  - `csa_platform/streaming/producers/` — Event Hub producers
    - `polling_producer.py` — Poll REST APIs (USGS, NOAA) and push to Event Hub
    - `sse_producer.py` — Consume SSE streams (Wikimedia) and push to Event Hub
    - `synthetic_producer.py` — Generate synthetic events for load testing
  - `csa_platform/streaming/consumers/` — Consumer patterns (at-least-once, exactly-once)
  - `csa_platform/streaming/processors/` — Stream Analytics job definitions, Structured Streaming jobs
  - `csa_platform/streaming/dlq/` — DLQ handler with replay capability
- `scripts/streaming/generate-events.py` — Load test event generator
- `scripts/streaming/deploy-stream-analytics.sh` — Deploy ASA jobs

**4.4 Streaming Vertical Examples**
- Rebuild `examples/iot-streaming/` (per AQ-0024)
  - Add `dbt_project.yml` + models
  - Add `data/generators/` for IoT event simulation
  - Add `deploy/deploy.sh`
  - Full Lambda architecture implementation
- Add `examples/earthquake-streaming/` — USGS earthquake real-time analytics
  - Poll earthquake feed → Event Hubs → real-time geo-clustering → ADX KQL dashboards
  - Uses real data, no API key required
- Add `examples/clickstream/` — Web analytics streaming (synthetic data)

#### Implementation Steps
1. Create `streaming.bicep` module
2. Build streaming producers (polling, SSE, synthetic)
3. Extend `csa_platform/streaming/` with consumers, processors, DLQ
4. Rebuild `examples/iot-streaming/` with complete dbt + deployment
5. Create `examples/earthquake-streaming/` with live USGS data
6. Create `examples/clickstream/` vertical
7. Author Lambda architecture tutorial
8. Add ADX KQL query templates
9. Add monitoring dashboards

---

### WS-5: AI-First Analytics Landing Zone (Priority: P0)

**Goal:** Complete AI analytics path using Azure AI Foundry, Microsoft Python SDK, Semantic Kernel for multi-agent workloads, MCP servers, RAG with vector stores, and GraphRAG with full knowledge store deployment.

#### Technology Stack (Confirmed)

| Component | Technology | Version/Model |
|-----------|-----------|---------------|
| LLM | Azure OpenAI via Foundry | GPT-5.4 (latest) |
| Embedding | Azure OpenAI | text-embedding-3-large |
| Agent SDK | `agent-framework-foundry` | Latest |
| Agent Orchestration | Semantic Kernel Agent Framework | `semantic-kernel[azure]` latest |
| Vector Store | Azure AI Search | Standard S1, semantic ranker |
| Knowledge Graph | Microsoft GraphRAG + Cosmos DB Gremlin | `graphrag` latest |
| MCP Support | Azure AI Foundry hosted agents | Native MCP tool connections |

#### Deliverables

**5.1 AI Landing Zone Bicep**
- `deploy/bicep/dlz/modules/ai-analytics.bicep`
  - Azure OpenAI Service (GPT-5.4, text-embedding-3-large deployments)
  - Azure AI Search (Standard S1, semantic ranker enabled, vector index)
  - Azure AI Foundry project + hub
  - Azure Cosmos DB Gremlin API (for knowledge graph)
  - Azure Cosmos DB (for agent memory / chat history)
  - Azure Database for PostgreSQL Flexible (pgvector extension)
  - Azure Container Apps (for hosting AI endpoints and agents)
  - Azure Container Registry (for hosted agent images)
  - Azure Key Vault (API keys, connection strings)
  - Networking: private endpoints, managed VNet
- **Note:** Azure Government variant deferred to Phase 2 (Coming Soon)

**5.2 AI Analytics Tutorial — AI-Enhanced Medallion Architecture**
- `docs/tutorials/06-ai-analytics/`
  - **Step 1:** Deploy AI landing zone (Bicep)
  - **Step 2:** Configure Azure AI Foundry
    - Create Foundry resource and Project
    - Deploy GPT-5.4 model
    - Deploy text-embedding-3-large
    - Set up prompt flow for evaluation
    - Configure Responsible AI dashboard
  - **Step 3:** Build data analytics pipeline with AI enrichment
    - Document Intelligence for PDF/image extraction
    - Text enrichment (entity extraction, summarization, classification) via GPT-5.4
    - Structured data generation from unstructured sources
    - Quality scoring with LLM-as-judge
  - **Step 4:** Integrate AI into the medallion architecture
    - Bronze: raw documents/data
    - Silver: AI-extracted structured data + embeddings
    - Gold: analytics-ready with AI-derived features
  - **Step 5:** Build AI-powered analytics dashboards
    - Natural language query interface
    - Automated insight generation
    - Anomaly explanations via LLM
  - **Notebooks:**
    - `notebooks/ai/01-ai-document-processing.py` — Document Intelligence + GPT-5.4 extraction
    - `notebooks/ai/02-embedding-pipeline.py` — Bulk embedding generation
    - `notebooks/ai/03-ai-enriched-medallion.py` — Full medallion with AI features

**5.3 Building Agents with Azure AI Foundry & Semantic Kernel (NEW — separate from CSA Copilot)**
- `docs/tutorials/07-agents-foundry-sk/`
  - **This is a standalone tutorial path** for users learning to build AI agents. NOT the CSA Copilot.
  
  - **Step 1:** Azure AI Foundry Agent Basics
    - Install `azure-ai-projects>=2.0.0` and `agent-framework-foundry`
    - Create a Foundry agent with GPT-5.4
    - Basic chat interaction with conversation history
    - ```python
      from agent_framework.foundry import FoundryAgent
      agent = FoundryAgent(model="gpt-5.4", name="DataAnalyst", 
                           instructions="You analyze data and provide insights.")
      ```
  
  - **Step 2:** Add Tools to Agents
    - Code Interpreter (built-in)
    - Azure AI Search tool (connect existing search index)
    - Custom function tools (Python functions as agent tools)
    - MCP tool connections (connect MCP servers to Foundry agents)
  
  - **Step 3:** Semantic Kernel — Single Agent with Plugins
    - Install `semantic-kernel[azure]`
    - Create `ChatCompletionAgent` with `AzureChatCompletion` service
    - Build SK plugins for data operations:
      - `DataQueryPlugin` — run SQL/KQL queries
      - `GovernancePlugin` — check data contracts, classifications
      - `StoragePlugin` — list/read ADLS files
    - ```python
      from semantic_kernel.agents import ChatCompletionAgent
      from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion
      
      agent = ChatCompletionAgent(
          name="DataAnalyst",
          instructions="You help users analyze data in the CSA platform.",
          service=AzureChatCompletion(deployment_name="gpt-5.4"),
          plugins=[DataQueryPlugin(), GovernancePlugin()],
      )
      ```
  
  - **Step 4:** Multi-Agent Orchestration with Semantic Kernel
    - `GroupChatOrchestration` — multiple agents collaborating
    - `RoundRobinGroupChatManager` — turn-based agent conversations
    - Example: Data Analyst agent + Data Quality agent + Governance agent
    - ```python
      from semantic_kernel.agents import GroupChatOrchestration, RoundRobinGroupChatManager
      
      orchestration = GroupChatOrchestration(
          members=[analyst_agent, quality_agent, governance_agent],
          manager=RoundRobinGroupChatManager(max_rounds=5),
      )
      result = await orchestration.invoke(
          task="Analyze the sales data product for quality issues and governance compliance.",
          runtime=runtime,
      )
      ```
  
  - **Step 5:** Build an Azure AI Agent (Foundry-hosted)
    - `AzureAIAgent` with client lifecycle management
    - Thread management for persistent conversations
    - Plugin integration with managed agent service
    - ```python
      from semantic_kernel.agents import AzureAIAgent
      
      async with AzureAIAgent.create_client(credential=creds, endpoint=endpoint) as client:
          agent = AzureAIAgent(client=client, definition=agent_def, plugins=[...])
          async for response in agent.invoke(messages="Analyze Q4 revenue trends"):
              print(response)
      ```
  
  - **Step 6:** Deploy Hosted Agents to Azure
    - Containerize agent with Docker
    - Push to Azure Container Registry
    - Deploy via Foundry Agent Service
    - Configure MCP tool connections for production
    - Set up capability host for public hosting
  
  - **Step 7:** Advanced Patterns
    - Agent memory with Azure AI Search as SK memory store
    - Agent-to-agent communication patterns
    - Human-in-the-loop approval workflows
    - Agent observability and tracing
  
  - **Example applications:**
    - `examples/ai-agents/data-analyst-agent/` — Single agent that queries data via plugins
    - `examples/ai-agents/multi-agent-governance/` — 3-agent team for data quality review
    - `examples/ai-agents/hosted-agent/` — Containerized agent deployed to Foundry

**5.4 Build MCP Server for CSA Platform**
- `apps/copilot/mcp/csa-platform-server/` — Complete MCP server
  - **Resources:**
    - `csa://catalog/{domain}` — Data product catalog by domain
    - `csa://governance/glossary` — Business glossary terms
    - `csa://governance/policies` — Active governance policies
    - `csa://quality/{product}` — Quality scores per data product
    - `csa://lineage/{asset}` — Lineage graph for an asset
  - **Tools:**
    - `query_data_product` — Execute SQL against a data product
    - `check_data_quality` — Run quality checks on a dataset
    - `validate_contract` — Validate a data contract YAML
    - `search_catalog` — Search Purview catalog
    - `get_lineage` — Get lineage for an asset
    - `list_pipelines` — List ADF pipeline runs and status
  - **Prompts:**
    - `analyze-data` — Template for data analysis requests
    - `governance-review` — Template for governance compliance review
    - `troubleshoot-pipeline` — Template for pipeline failure diagnosis
  - Transport: stdio + SSE (HTTP)
  - Integration with Azure SDK for live platform interaction
  - Can be connected to Foundry hosted agents via MCP tool connection

**5.5 RAG with Vector Stores**
- `docs/tutorials/08-rag-vectors/`
  - **Step 1:** Concepts — chunking, embedding, indexing, retrieval, generation
  - **Step 2:** Azure AI Search vector index
    - Create index with vector dimensions (3072 for text-embedding-3-large)
    - HNSW vs exhaustive KNN configuration
    - Hybrid search (vector + full-text + semantic reranking)
    - Filtering and faceting with vectors
    - **Notebook:** `notebooks/ai/04-rag-ai-search.py`
  - **Step 3:** Azure Cosmos DB vector search
    - vCore MongoDB API with vector indexing
    - PostgreSQL API with pgvector
    - DiskANN indexing for large-scale
    - **Notebook:** `notebooks/ai/05-rag-cosmos-vector.py`
  - **Step 4:** PostgreSQL with pgvector
    - Azure Database for PostgreSQL Flexible Server setup
    - pgvector extension installation and configuration
    - IVFFlat vs HNSW index types
    - Integration with Semantic Kernel memory
    - **Notebook:** `notebooks/ai/06-rag-pgvector.py`
  - **Step 5:** Comparison guide — when to use which vector store
  - **Step 6:** Production RAG pipeline
    - Document processing pipeline (PDF, DOCX, CSV, Markdown → chunks → embeddings → index)
    - Incremental indexing
    - Evaluation framework (relevance, groundedness, coherence)

**5.6 GraphRAG & Knowledge Graph — Complete Build-Out**
- `docs/tutorials/09-graphrag-knowledge/`
  
  - **Step 1:** Deploy GraphRAG Infrastructure to Azure
    - Deploy via `deploy/bicep/dlz/modules/ai-analytics.bicep` (GraphRAG components)
    - OR deploy via GraphRAG Accelerator (`azure-samples/graphrag-accelerator`)
      - AKS cluster for GraphRAG API
      - Azure Blob Storage for document storage
      - Azure OpenAI for entity extraction
      - API Management for GraphRAG API gateway
    - Create Cosmos DB Gremlin API for knowledge graph persistence
    - Create Azure AI Search index for graph embeddings
    - **Script:** `scripts/ai/deploy-graphrag-infra.sh`
  
  - **Step 2:** Build the Knowledge Store
    - Create Azure Blob Storage container for source documents
    - Configure GraphRAG settings.yaml:
      ```yaml
      input:
        type: blob
        container_name: graphrag-input
        storage_account_name: csagraphrag
      llm:
        type: azure_openai
        model: gpt-5.4
        deployment_name: gpt-5.4
      embeddings:
        type: azure_openai
        model: text-embedding-3-large
      ```
    - **Notebook:** `notebooks/ai/07-graphrag-setup.py`
  
  - **Step 3:** Import Documents into Knowledge Store
    - **PDF import:** Azure Document Intelligence → text extraction → chunking
    - **CSV import:** Row-to-document conversion with column mapping
    - **Word/DOCX import:** python-docx extraction → text chunking
    - **Markdown import:** Direct ingestion (GraphRAG native support)
    - **GitHub site scanning:** Clone repo → extract README/docs → ingest
      ```python
      # Example: Scan a GitHub repo for documentation
      import subprocess, glob
      subprocess.run(["git", "clone", "--depth=1", repo_url, "temp_repo"])
      docs = glob.glob("temp_repo/**/*.md", recursive=True)
      # Upload to blob storage for GraphRAG indexing
      ```
    - **Pipeline:** `csa_platform/ai_integration/graphrag/document_loader.py`
      - `load_pdfs(directory)` — Extract text from PDFs via Document Intelligence
      - `load_csvs(directory, text_columns)` — Convert CSV rows to documents
      - `load_docx(directory)` — Extract from Word documents
      - `load_markdown(directory)` — Direct markdown loading
      - `scan_github(repo_url, patterns=["*.md", "*.txt"])` — Clone and extract
      - `upload_to_blob(documents, container_name)` — Stage for GraphRAG
    - **Notebook:** `notebooks/ai/08-graphrag-import-documents.py`
  
  - **Step 4:** Build the Knowledge Graph Index
    - Run GraphRAG indexing pipeline
      ```bash
      graphrag index --root ./graphrag-workspace
      ```
    - Entity extraction: LLM identifies entities (people, organizations, concepts, data assets)
    - Relationship extraction: LLM identifies connections between entities
    - Community detection: Leiden algorithm groups related entities
    - Community summarization: LLM generates summaries per community
    - Output: Parquet files (entities, relationships, communities, text_units)
    - Persist to Cosmos DB Gremlin for graph queries
    - **Notebook:** `notebooks/ai/09-graphrag-build-index.py`
  
  - **Step 5:** Query the Knowledge Graph
    - **Global search:** Uses community summaries for broad questions
      - "What are the main data governance patterns in this organization?"
    - **Local search:** Uses entity context for specific questions
      - "What data sources feed the sales analytics dashboard?"
    - **DRIFT search:** Dynamic, Reasoning, and Inference-based search
    - API queries via GraphRAG Accelerator endpoints
    - Gremlin queries against Cosmos DB for custom traversals
    - **Notebook:** `notebooks/ai/10-graphrag-query.py`
  
  - **Step 6:** Integrate GraphRAG into Applications
    - Hybrid retrieval: vector search (AI Search) + graph traversal (Cosmos Gremlin)
    - Feed graph context into Semantic Kernel agent memory
    - Build a "data governance brain" — model Purview catalog as a knowledge graph
    - Impact analysis: "If I change schema X, what dashboards break?"
    - **Notebook:** `notebooks/ai/11-graphrag-integration.py`
  
  - **Step 7:** Advanced — Data Governance Knowledge Graph
    - Extract entities from Purview catalog (data assets, owners, classifications)
    - Build relationships (lineage edges, ownership, domain membership)
    - Enable natural language governance queries:
      - "Show me all PII data sources owned by the Finance domain"
      - "What is the lineage path from raw CRM data to the customer 360 dashboard?"
    - **Notebook:** `notebooks/ai/12-governance-knowledge-graph.py`

**5.7 Platform Code**
- `csa_platform/ai_integration/semantic_kernel/` — Semantic Kernel integration
  - `kernel_factory.py` — Configure SK kernel with Azure OpenAI (GPT-5.4)
  - `plugins/data_query.py` — DataQueryPlugin (SQL/KQL execution)
  - `plugins/governance.py` — GovernancePlugin (contract validation, classification check)
  - `plugins/storage.py` — StoragePlugin (ADLS operations)
  - `plugins/purview.py` — PurviewPlugin (catalog search, glossary, lineage)
  - `orchestration/multi_agent.py` — Multi-agent setup helpers
  - `memory/ai_search_memory.py` — SK memory backed by Azure AI Search
- `csa_platform/ai_integration/graphrag/` — GraphRAG module
  - `document_loader.py` — Multi-format document loading (PDF, CSV, DOCX, MD, GitHub)
  - `index_builder.py` — Orchestrate GraphRAG indexing pipeline
  - `graph_store.py` — Persist/query graph in Cosmos DB Gremlin
  - `search.py` — Global, local, and DRIFT search interfaces
  - `governance_graph.py` — Build governance knowledge graph from Purview
- `csa_platform/ai_integration/mcp_server/` — MCP server (as described in 5.4)
- `examples/ai-agents/` — Agent example applications (3 examples as in 5.3)

#### Implementation Steps
1. Create `ai-analytics.bicep` module
2. Author AI analytics tutorial (06) with notebooks
3. Build Semantic Kernel integration module + plugins
4. Author agents tutorial (07) with multi-agent examples
5. Build MCP server for CSA platform
6. Author RAG vectors tutorial (08) with 3 vector store notebooks
7. Build GraphRAG document loader (PDF, CSV, DOCX, MD, GitHub scanning)
8. Build GraphRAG infrastructure deployment script
9. Author GraphRAG tutorial (09) with 6 notebooks
10. Build governance knowledge graph module
11. Create example agent applications (3 examples)
12. Add tests for all new modules (80% coverage gate)

---

### WS-6: Complete Data Marketplace (Priority: P2)

**Goal:** Full-featured internal data marketplace with discovery, access management, quality indicators, and consumption APIs.

#### Deliverables

**6.1 Marketplace Architecture**
- `docs/DATA_MARKETPLACE_ARCHITECTURE.md`
  - Component diagram: Purview catalog → Marketplace API → Portal UI → Consumer SDK
  - Data product lifecycle: register → certify → publish → discover → request → consume
  - Integration points with governance, quality, and streaming

**6.2 Marketplace Backend Enhancement**
- Extend `portal/shared/api/routers/marketplace/`
  - Data product registration with contract validation
  - Access request workflow with approval chain
  - Usage analytics tracking (who queries what, when, how often)
  - Quality indicator aggregation from Great Expectations
  - Cost attribution per data product (consumption-based)
  - Sample/preview endpoint (first N rows with PII masking)
  - Data product versioning and deprecation
  - Search with faceted filtering (domain, quality score, freshness, classification)

**6.3 Marketplace Frontend**
- Extend React portal with marketplace pages
  - Data product catalog with cards (name, domain, quality score, freshness badge)
  - Product detail page (schema, lineage, quality history, access request button)
  - Access request workflow UI
  - Usage dashboard (popular products, trending, recently updated)
  - Admin panel: approve/deny access, manage products, view analytics

**6.4 Marketplace SDK**
- `csa_platform/data_marketplace/sdk/`
  - Python SDK for programmatic data product consumption
  - `MarketplaceClient` — search, request, consume
  - DataFrame integration (return pandas/PySpark DataFrames)
  - Authentication via managed identity or service principal

**6.5 Marketplace Tutorial**
- `docs/tutorials/10-data-marketplace/`
  - Set up marketplace infrastructure
  - Register a data product (from dbt Gold model)
  - Configure quality monitoring
  - Publish to catalog (Purview integration)
  - Consumer workflow: discover → request → consume

---

### WS-7: Deployment Automation & Scripts (Priority: P0)

**Goal:** Every vertical example and landing zone has working deployment scripts. Every domain has a public data download pipeline.

#### Deliverables

**7.1 Public Data Download Pipelines**
For each existing domain, add real public data downloaders:

| Domain | Data Source | Download Method |
|--------|-----------|----------------|
| USDA | NASS QuickStats API | `scripts/data/download-usda.py` (REST API) |
| NOAA | GHCN-Daily + Storm Events | `scripts/data/download-noaa.py` (FTP/HTTP) |
| EPA | Air Quality System (AQS) | `scripts/data/download-epa.py` (HTTP bulk) |
| Census | ACS via Census API | `scripts/data/download-census.py` (REST API) |
| Commerce | Monthly Retail Trade | `scripts/data/download-commerce.py` (HTTP) |
| DOT | FARS crash data + BTS airline | `scripts/data/download-dot.py` (HTTP) |
| Healthcare | CMS Public Use Files + CDC WONDER | `scripts/data/download-health.py` (HTTP) |

Each script:
- Downloads data to `examples/<domain>/data/raw/` or directly to ADLS if connected
- Handles pagination for APIs
- Includes `--year` and `--state` filters for scoping
- Outputs manifest file listing what was downloaded
- Has corresponding Databricks notebook: `notebooks/data-download/<domain>-download.py`

**7.2 Vertical Deployment Scripts**
- For each example: `examples/<vertical>/deploy/deploy.sh`
  - Validate prerequisites
  - Deploy infrastructure (Bicep)
  - Download public data (calls data download pipeline)
  - Configure services (connections, permissions)
  - Run dbt transformations
  - Verify outputs (row counts, quality checks)

**7.3 Landing Zone Deployment Scripts**
- `scripts/deploy/deploy-geoanalytics-lz.sh`
- `scripts/deploy/deploy-streaming-lz.sh`
- `scripts/deploy/deploy-ai-lz.sh`
- Each: parameter validation → Bicep deployment → post-deployment config → validation

**7.4 One-Click Demo Environment**
- `scripts/demo/deploy-full-demo.sh`
  - Foundation (ALZ + DMLZ + DLZ)
  - Choose add-ons: streaming, geoanalytics, AI
  - Deploy 2-3 sample verticals with real public data
  - Configure governance (Purview bootstrap)
  - Set up marketplace
  - Output: URLs, connection info, next steps

---

### WS-8: Open Source Tools & Ecosystem Integration (Priority: P2)

**Goal:** Integrate additional open-source tools that enhance a cloud-scale analytics platform.

#### Deliverables

**8.1 Data Quality — Great Expectations (Enhanced)**
- Pre-built expectation suites for each medallion layer
- Automated profiling on data arrival
- Quality dashboard (Grafana or custom)
- Integration with Purview quality scores

**8.2 Data Orchestration — Apache Airflow Alternative**
- `docs/guides/AIRFLOW_ON_AZURE.md`

**8.3 Data Catalog — OSS Alternatives**
- `docs/guides/OSS_CATALOG_OPTIONS.md` (DataHub, OpenMetadata vs Purview)

**8.4 Observability**
- `docs/guides/OBSERVABILITY_STACK.md` (OpenTelemetry, Grafana, Prometheus)

**8.5 Data Versioning**
- `docs/guides/DATA_VERSIONING.md` (Delta time travel, lakeFS, DVC)

---

## 3. Dependencies & Sequencing

```
Wave 1 (P0 — Foundation):
  WS-7 (Deploy Scripts + Data Pipelines) ──→ All other WS depend on this
  WS-1 (Tutorial Framework) ──→ Provides structure for all tutorials
  WS-2 (Purview Governance) ──→ Referenced by WS-3, WS-4, WS-5, WS-6
  WS-5 Phase 1 (AI Bicep + Foundry + SK basics) ──→ AI is core priority

Wave 2 (P1 — Landing Zones + AI Depth):
  WS-3 (GeoAnalytics) ──→ Independent; uses WS-7 data pipelines
  WS-4 (Streaming Lambda) ──→ Independent; uses real-time feeds
  WS-5 Phase 2 (GraphRAG + MCP + Multi-Agent) ──→ Builds on Phase 1

Wave 3 (P2 — Marketplace + Polish):
  WS-6 (Data Marketplace) ──→ Depends on WS-2 (governance) + WS-5 (AI)
  WS-8 (OSS Ecosystem) ──→ Independent; enhances platform

Wave 4 (Phase 2 — Government):
  Azure Government variants for all new Bicep modules
  MAG-specific testing and documentation
  Marked "Coming Soon" in Phase 1 docs
```

**Why AI (WS-5) is elevated to P0:** AI Foundry agents, Semantic Kernel, and GraphRAG are the highest-value differentiation for CSA-in-a-Box. Users are most likely to seek these tutorials. Starting AI in Wave 1 allows Phase 2 (advanced patterns) to ship in Wave 2 alongside GeoAnalytics and Streaming.

---

## 4. Relationship to Existing Approved Work

| This PRP | Existing AQ | Relationship |
|----------|-------------|-------------|
| WS-2 (Purview) | AQ-0027 (data mesh federation) | WS-2 docs; AQ-0027 code pipeline |
| WS-4 (Streaming) | AQ-0032 (streaming spine) | WS-4 Bicep + tutorials; AQ-0032 platform code |
| WS-5 (AI) | AQ-0001 (Copilot MVP) | WS-5 is **separate** agent tutorials; AQ-0001 is CSA Copilot |
| WS-5 (AI) | AQ-0020 (RAG refactor) | AQ-0020 refactors existing RAG; WS-5 adds new capabilities |
| WS-6 (Marketplace) | AQ-0030 (CLI promotion) | WS-6 builds marketplace; AQ-0030 provides CLI |
| WS-7 (Scripts) | AQ-0024 (iot-streaming rebuild) | WS-7 generalizes deploy scripts; AQ-0024 fixes one vertical |

**Important distinction:** WS-5 agent tutorials are a **new, separate learning path** teaching users how to build their own agents with Foundry + SK. The CSA Copilot (AQ-0001) is the platform's built-in assistant and stays on PydanticAI.

---

## 5. New Files Summary

| Workstream | New Files (approx) | New Lines (approx) |
|------------|-------------------|-------------------|
| WS-1 Tutorial Framework | 15–20 docs | 8,000–12,000 |
| WS-2 Purview Governance | 8 docs + 7 scripts/modules | 5,000–7,000 |
| WS-3 GeoAnalytics | 2 Bicep + 6 notebooks + 2 tutorials + 1 example | 7,000–11,000 |
| WS-4 Streaming | 1 Bicep + 5 scripts + 1 tutorial + 3 examples | 6,000–9,000 |
| WS-5 AI Analytics | 4 tutorials + 12 notebooks + 4 modules + 1 MCP server + 3 example apps | 18,000–25,000 |
| WS-6 Data Marketplace | 5 API routes + 4 UI pages + 1 SDK + 1 tutorial | 5,000–8,000 |
| WS-7 Deploy Scripts | 20+ scripts + 7 data downloaders + 7 notebooks | 5,000–8,000 |
| WS-8 OSS Ecosystem | 5 guides + dashboard templates | 3,000–5,000 |
| **Total** | **~100–130 files** | **~57,000–85,000 lines** |

---

## 6. Success Criteria

1. **Tutorial completeness:** A new user can follow any of the 6 paths end-to-end without getting stuck
2. **Public data:** Every domain has a working data download pipeline with real federal/public data
3. **Deployment automation:** `make deploy-demo` creates a working environment in < 2 hours
4. **Governance documentation:** Every Purview capability has step-by-step instructions
5. **GeoAnalytics:** Both OSS and ArcGIS (BYOL) paths produce working geospatial analytics from real public data
6. **Streaming:** Lambda architecture processes real USGS earthquake data end-to-end
7. **AI Agents:** User can build and deploy a multi-agent system using Foundry + Semantic Kernel
8. **GraphRAG:** Complete knowledge store built from imported documents (PDF, CSV, DOCX, MD, GitHub) with working queries
9. **MCP Server:** CSA platform MCP server works with Foundry hosted agents
10. **Marketplace:** End-to-end data product lifecycle works
11. **Test coverage:** All new code meets existing 80% coverage gate
12. **Government:** All new Bicep modules have "Coming Soon — Azure Government" docs for Phase 2

---

## 7. Azure Government (Phase 2 — Coming Soon)

All new Bicep modules (`geoanalytics.bicep`, `streaming.bicep`, `ai-analytics.bicep`, `arcgis-enterprise.bicep`) will receive Azure Government variants in Phase 2 after the commercial versions are tested and validated. Each tutorial will include a note:

> **Azure Government:** This tutorial targets Azure Commercial. Azure Government deployment is coming in Phase 2. See Government Cloud Roadmap (planned) for status.

Phase 2 work includes:
- MAG-specific Bicep parameter files
- Service availability validation (some AI services may have limited MAG availability)
- FedRAMP compliance mapping for new services
- IL4/IL5 configuration guidance
