# Spark Pools

Azure Synapse Spark Pools provide scalable Apache Spark compute for big data analytics and machine learning workloads.

## Overview

Spark Pools in Azure Synapse Analytics enable you to:

- Process large-scale data using Apache Spark
- Run machine learning workloads with built-in libraries
- Integrate with Delta Lake for ACID transactions
- Scale compute resources on-demand

## Key Features

- __Auto-scaling__: Automatically scale nodes based on workload
- __Built-in Libraries__: Pre-installed Spark, Python, and ML libraries
- __Notebook Integration__: Interactive development with Synapse notebooks
- __Delta Lake Support__: ACID transactions and time travel

## Sections

- [Delta Lakehouse](delta-lakehouse/README.md) - Delta Lake implementation patterns

## Getting Started

To create a Spark Pool:

1. Navigate to your Synapse workspace
2. Select "Apache Spark pools" from the left menu
3. Click "+ New" to create a pool
4. Configure node size and auto-scaling settings
5. Review and create

## Best Practices

- Use auto-pause to save costs when pools are idle
- Right-size your nodes based on workload requirements
- Enable dynamic allocation for variable workloads
- Use Delta Lake for production data pipelines

## Related Documentation

- [Best Practices](../../../../best-practices/spark-performance.md)
- [Troubleshooting](../../../../troubleshooting/spark-troubleshooting.md)
- [Configuration Reference](../../../../reference/spark-configuration.md)

---

Back to Azure Synapse | [Documentation Home](../../../../README.md)
