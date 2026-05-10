# Kappa Architecture

## Overview

The Kappa Architecture is a simplification of the Lambda Architecture that removes the batch layer, treating all data as streaming data. It uses a single unified processing layer built on an immutable, replayable event log.

## Core Principles

- **Single Processing Layer**: All data is processed as streams, eliminating the batch/speed layer distinction
- **Immutable Log**: A durable, replayable event log (e.g., Azure Event Hubs, Apache Kafka) stores all data
- **Reprocessing**: Historical data can be reprocessed by replaying the log with updated processing logic
- **Simplicity**: Fewer moving parts compared to Lambda Architecture

## Architecture Components

### Event Log

- Stores all events durably and in order
- Enables replay for reprocessing
- Typically uses Azure Event Hubs or Apache Kafka

### Stream Processing Layer

- Processes all incoming data as streams
- Handles both real-time and historical data
- Uses Azure Stream Analytics, Apache Spark Structured Streaming, or Azure Databricks

### Serving Layer

- Stores processed results for query serving
- Supports both real-time and historical queries
- Uses Azure Synapse Analytics, Azure Cosmos DB, or Azure Data Lake Storage

## Implementation on Azure

| Component | Azure Services |
|-----------|----------------|
| Event Log | Azure Event Hubs (with retention), Apache Kafka on HDInsight |
| Stream Processing | Azure Databricks Structured Streaming, Azure Stream Analytics |
| Serving | Azure Synapse Serverless SQL, Azure Cosmos DB, Azure Data Lake Storage Gen2 |

## Related Resources

- [Lambda Architecture](./lambda-architecture.md)
- [Lambda-Kappa Hybrid](./lambda-kappa-hybrid.md)
- [Streaming Architectures](../streaming-architectures/README.md)
