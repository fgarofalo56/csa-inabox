# Azure Synapse Analytics Integration Examples

[Home](../../../README.md) > [Code Examples](../../README.md) > Integration

This section provides code examples and patterns for integrating Azure Synapse Analytics with other Azure services.

## Available Integration Examples

- [Azure Machine Learning Integration](./azure-ml.md): Examples demonstrating how to integrate Azure Synapse Analytics with Azure Machine Learning for model training, deployment, and MLOps.
- [Azure Purview Integration](./azure-purview.md): Examples showing how to integrate Azure Synapse Analytics with Azure Purview for data governance, cataloging, and lineage tracking.
- [Azure Data Factory Integration](./azure-data-factory.md): Examples for orchestrating data pipelines between Azure Synapse Analytics and Azure Data Factory.

## Common Integration Patterns

When integrating Azure Synapse Analytics with other Azure services, consider the following common patterns:

1. __Linked Services__: Creating and managing linked services between Azure Synapse and other Azure services
2. __Service Principal Authentication__: Using service principals for secure, non-interactive authentication
3. __Data Movement Optimization__: Optimizing data movement between services for performance
4. __Metadata Synchronization__: Keeping metadata in sync across services
5. __Monitoring and Alerting__: Setting up comprehensive monitoring across integrated services

## Azure Machine Learning Integration

![Azure Analytics End-to-End Architecture](https://learn.microsoft.com/en-us/azure/architecture/example-scenario/dataplate2e/media/azure-analytics-end-to-end.svg)

Azure Synapse Analytics and Azure Machine Learning integration enables:

- Training machine learning models directly on data in the lake
- Feature engineering at scale using Spark pools
- Model deployment and serving through managed endpoints
- MLOps workflows with CI/CD pipelines

## Azure Purview Integration

Azure Synapse Analytics integrates with Microsoft Purview (formerly Azure Purview) to provide:

- Automated data discovery and classification
- End-to-end data lineage across processing stages
- Centralized data governance and compliance
- Searchable data catalog for all analytics assets

## Azure Data Factory Integration

Azure Data Factory and Azure Synapse Analytics work together to provide:

- Orchestrated data movement and transformation
- Hybrid data integration across on-premises and cloud
- Scheduled and event-triggered pipeline execution
- Monitoring and alerting for pipeline operations

## Code Example: Azure ML Integration

```python
# Connect to an Azure Machine Learning workspace from Synapse
from azureml.core import Workspace

workspace = Workspace.get(
    name="myworkspace",
    subscription_id="<subscription-id>",
    resource_group="myresourcegroup"
)

# Register a Spark table as a dataset in Azure ML
from azureml.core import Dataset

# Get the default datastore
datastore = workspace.get_default_datastore()

# Register a Synapse Spark table as a tabular dataset in Azure ML
dataset = Dataset.Tabular.register_spark_dataframe(
    spark_dataframe=spark.table("customer_profile"), 
    target=datastore, 
    name="customer_profile"
)

# Use the dataset for model training
from azureml.train.estimator import Estimator

estimator = Estimator(
    source_directory="./train-model",
    entry_script="train.py",
    compute_target="aml-compute",
    inputs=[dataset.as_named_input("customer_data")]
)

run = experiment.submit(estimator)
```

## Related Resources

- [Integration Guide](../../integration-guide.md) - Comprehensive integration guide
- [Best Practices for Integration](../../best-practices/implementation-patterns.md) - Best practices
- [Security Guidelines for Integration](../../best-practices/security.md) - Security considerations
