import type { FabricItemType } from './types';

/**
 * Azure Data Factory — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const azureDataFactoryItems: FabricItemType[] = [
  // Azure Data Factory (separate from Fabric Data Factory)
  { slug: 'adf-pipeline',                displayName: 'ADF pipeline',                restType: 'AdfPipeline',               category: 'Azure Data Factory',
    aliasOf: 'data-pipeline', runtimePreset: 'adf', searchOnly: true,
    description: 'The ADF-runtime preset of the Data pipeline — classic Azure Data Factory: 90+ activities, IR-aware, on-prem via Self-hosted IR.',
    learnContent: {
      "overview": "An ADF pipeline is the ADF-runtime preset of the unified Data pipeline — a classic Azure Data Factory pipeline with 90+ activities, integration-runtime-aware, and on-prem reach via Self-hosted IR. It opens the same unified pipeline editor as Data pipeline with the runtime locked to Azure Data Factory (the Azure-native default), reusing ADF linked services and integration runtimes. Already-created ADF pipeline items and their existing routes keep working unchanged.",
      "steps": [
        {
          "title": "Add activities",
          "body": "Compose from the 90+ ADF activities (Copy, Lookup, ForEach, Notebook, Web, etc.)."
        },
        {
          "title": "Use integration runtimes",
          "body": "Run via Azure IR, or reach on-prem sources through a Self-hosted IR."
        },
        {
          "title": "Wire control flow",
          "body": "Connect activities with dependency conditions on the canvas."
        },
        {
          "title": "Trigger and monitor",
          "body": "Attach a trigger and review run history from the ADF monitoring API."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities"
    } },
  { slug: 'adf-dataset',                 displayName: 'ADF dataset',                 restType: 'AdfDataset',                category: 'Azure Data Factory',
    description: 'Typed dataset over linked services — JSON, Parquet, Delimited, SQL, REST, etc.',
    learnContent: {
      "overview": "An ADF dataset is a typed pointer over linked services — JSON, Parquet, Delimited, SQL, REST, and more. In Loom it defines the source/sink shape used by Copy Data and Mapping Data Flow activities.",
      "steps": [
        {
          "title": "Pick a linked service",
          "body": "Bind the dataset to a linked service that holds the connection."
        },
        {
          "title": "Choose the format",
          "body": "Select JSON, Parquet, Delimited, SQL table, REST, or another supported type."
        },
        {
          "title": "Define the schema",
          "body": "Set the structure so activities know the source/sink shape."
        },
        {
          "title": "Use in activities",
          "body": "Reference the dataset from Copy Data or Mapping Data Flow source/sink."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-datasets-linked-services"
    } },
  { slug: 'adf-trigger',                 displayName: 'ADF trigger',                 restType: 'AdfTrigger',                category: 'Azure Data Factory',
    description: 'Schedule, tumbling window, storage event, or custom event trigger.',
    learnContent: {
      "overview": "An ADF trigger is a schedule, tumbling window, storage event, or custom event trigger that invokes a pipeline. In Loom you wire one or more pipelines per trigger to automate ADF runs.",
      "steps": [
        {
          "title": "Pick a trigger type",
          "body": "Choose schedule, tumbling window, storage event, or custom event."
        },
        {
          "title": "Configure timing",
          "body": "Set recurrence, window size, or the event source that fires the trigger."
        },
        {
          "title": "Bind pipelines",
          "body": "Attach one or more pipelines that the trigger should invoke."
        },
        {
          "title": "Activate",
          "body": "Start the trigger so runs begin on schedule or on event."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers"
    } },
];
