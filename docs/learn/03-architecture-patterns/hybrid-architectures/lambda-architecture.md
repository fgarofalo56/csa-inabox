# Lambda Architecture

## Overview

The Lambda Architecture is a data processing approach that handles both batch and real-time processing by combining a batch layer and a speed layer to provide comprehensive views of online data.

## Architecture Layers

### Batch Layer

The batch layer manages the master dataset and pre-computes batch views:

- Stores the complete, immutable dataset
- Recomputes batch views periodically
- Provides accurate, comprehensive results
- Tolerates high latency in exchange for correctness

### Speed Layer

The speed layer processes recent data to provide low-latency updates:

- Handles real-time data as it arrives
- Compensates for the high latency of batch updates
- Produces real-time views that merge with batch views
- Typically uses Apache Kafka + Azure Stream Analytics

### Serving Layer

The serving layer merges batch and real-time views:

- Combines batch views with real-time views
- Responds to queries with merged results
- Provides a unified view of historical and current data

## Implementation on Azure

| Layer | Azure Services |
|-------|----------------|
| Batch | Azure Data Factory, Azure Synapse Analytics Spark |
| Speed | Azure Event Hubs, Azure Stream Analytics |
| Serving | Azure Synapse Serverless SQL, Azure Cosmos DB |

## Related Resources

- [Lambda-Kappa Hybrid](./lambda-kappa-hybrid.md)
- [Kappa Architecture](./kappa-architecture.md)
- [Streaming Architectures](../streaming-architectures/README.md)
