# Loom Eventstream Editor — Fabric-parity spec

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


> Captured 2026-05-26 by catalog agent `a8260c3697beb6c69` from Fabric documentation + `casino-fabric-poc` workspace inspection. No existing Eventstream in workspace, so spec is from Fabric docs + sample exploration.

## Fabric UX

### Visual designer canvas
Three-section layout: ribbon/canvas + configuration pane (right) + test result pane (bottom). Drag-and-drop nodes connect source → transform → destination. Real-time preview + authoring error validation.

### Source picker — types
**External streaming**: Azure Event Hubs · Kafka (Confluent / Apache / Amazon MSK) · Azure IoT Hub · Azure Event Grid · Azure Service Bus · Google Cloud Pub/Sub · Amazon Kinesis Data Streams · MQTT · Solace PubSub+ · Cribl

**Change Data Capture (CDC)**: Azure SQL Database · PostgreSQL · MySQL · Azure Cosmos DB · SQL Server on VM · Azure SQL Managed Instance · MongoDB

**Fabric**: Workspace item events · OneLake events · Job events · Capacity overview events

**Data sources**: Azure Blob Storage events · Azure Data Explorer · Real-time weather · Sample data (Bicycles / Yellow Taxi / Stock Market / Buses / S&P 500 / Semantic Model Logs)

**Custom**: Custom endpoint (HTTP / custom app with connection string)

### Transform nodes (event processor operations)
Filter · Aggregate (sum/min/max/avg over time windows) · Group by (window-based aggregations) · Manage fields (add/remove/rename/change type) · Join · Union · Expand (array → rows) · SQL operator (preview)

### Destination picker
Lakehouse (Delta) · Eventhouse (direct or processed ingestion modes) · Activator (intelligent alerting) · Custom endpoint · Derived stream (intermediate) · Spark Notebook (preview, Spark Structured Streaming)

### Additional features
- Apache Kafka endpoint for native client integration
- Schema management with Fabric Schema Registry
- DeltaFlow (analytics-ready CDC streams)
- Pause/resume controls for derived streams
- Workspace Private Link support

## What Loom needs

| Component | Status | Loom build target |
|---|---|---|
| Visual canvas | ❌ none | New React component with react-flow or similar |
| Source picker | partial (Cosmos persistence) | Wire to Event Hubs / Cosmos CDC / ADX / Blob Storage event registrations |
| Transform nodes | partial (Cosmos persistence) | Implement Filter/Aggregate/GroupBy/Join/Union via Azure Stream Analytics OR Kusto inline ingestion mappings |
| Destination Lakehouse | ❌ | Wire to existing Loom Lakehouse (writes Delta to ADLS) |
| Destination Eventhouse | partial | Wire to existing Loom ADX (Eventhouse equivalent) |
| Destination Activator | ❌ | Wire to existing loom-activator-engine container app |

## Backend mapping
- **Event Hubs** for streaming ingress (need to deploy in bicep — `Microsoft.EventHub/namespaces`)
- **Azure Stream Analytics** OR **ADX inline ingestion mappings** for transforms
- **ADX `.ingest` commands** when destination is Eventhouse
- **Loom Activator engine container** (already deployed) for Activator destination

## Required Azure resources (currently missing)
- Event Hubs namespace + hub
- Azure Stream Analytics job (optional, if not using ADX-only path)
- Kusto ingestion mapping resources

## Estimated effort
3-4 sessions. Stream designer alone is 1-2 sessions of UI work. Backend wiring + bicep is another. Then per-source + per-destination wiring is incremental.
