import type { FabricItemType } from './types';

/**
 * Azure Geoanalytics — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const azureGeoanalyticsItems: FabricItemType[] = [
  // --- v3 — Geoanalytics platform (Azure Maps + lakehouse geometry + spatial T-SQL/KQL + H3/S2) ---
  { slug: 'geo-map',                     displayName: 'Geo map',                     restType: 'GeoMap',                    category: 'Azure Geoanalytics',
    description: 'Azure Maps account + style + tile layer config. OSM fallback when no Maps account is deployed.',
    learnContent: {
      "overview": "A Geo map composes an Azure Maps account, style, and tile layer. In Loom it lists Azure Maps accounts via ARM when available and falls back to OSM tiles with a MessageBar when no Maps account is deployed. Map config is saved to item state.",
      "steps": [
        {
          "title": "Pick a Maps account",
          "body": "Loom lists Azure Maps accounts via ARM; if none exist it falls back to OSM tiles and says so."
        },
        {
          "title": "Choose a style",
          "body": "Select the base map style and tile layer."
        },
        {
          "title": "Save the config",
          "body": "Save persists the map configuration to item state."
        },
        {
          "title": "Layer your data",
          "body": "Compose the map over a geo-dataset for heatmaps and choropleths."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-maps/about-azure-maps"
    } },
  { slug: 'geo-dataset',                 displayName: 'Geo dataset',                 restType: 'GeoDataset',                category: 'Azure Geoanalytics',
    description: 'GeoJSON / Parquet+geometry dataset in ADLS Gen2. Geometry-column inspector + sample preview.',
    learnContent: {
      "overview": "A Geo dataset is a GeoJSON or Parquet+geometry dataset in ADLS Gen2. In Loom the geometry-column inspector runs a sample T-SQL OPENROWSET against Synapse Serverless via the existing query route so you can preview the data.",
      "steps": [
        {
          "title": "Point at an ADLS path",
          "body": "Set the ADLS Gen2 path to your GeoJSON or Parquet+geometry data."
        },
        {
          "title": "Inspect geometry",
          "body": "The inspector runs a sample OPENROWSET to Synapse Serverless to surface the geometry column."
        },
        {
          "title": "Preview rows",
          "body": "Review a sample to confirm the geometry type (point/polygon/H3 cell)."
        },
        {
          "title": "Use downstream",
          "body": "Reference the dataset from geo maps, queries, and pipelines."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/sql/query-parquet-files"
    } },
  { slug: 'geo-query',                   displayName: 'Geo query',                   restType: 'GeoQuery',                  category: 'Azure Geoanalytics',
    description: 'Spatial query against Synapse Serverless / Kusto — H3, S2, ST_DISTANCE, ST_WITHIN.',
    learnContent: {
      "overview": "A Geo query is a spatial query against Synapse Serverless or Kusto — H3, S2, ST_DISTANCE, ST_WITHIN. In Loom a KQL-or-TSQL toggle pre-populates H3 and ST examples and submits to Kusto or Synapse Serverless.",
      "steps": [
        {
          "title": "Toggle KQL or T-SQL",
          "body": "Pick the backend; the editor pre-populates H3 and ST examples for that dialect."
        },
        {
          "title": "Write the spatial query",
          "body": "Use ST_DISTANCE, ST_WITHIN, or H3/S2 functions over your geo-dataset."
        },
        {
          "title": "Submit",
          "body": "Run against Kusto or Synapse Serverless via the existing query route."
        },
        {
          "title": "Pin results",
          "body": "Pin a saved query to a geo-map layer for visualization."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/sql/query-parquet-files"
    } },
  { slug: 'geo-pipeline',                displayName: 'Geo pipeline',                restType: 'GeoPipeline',               category: 'Azure Geoanalytics',
    templateOf: 'data-pipeline', templateId: 'geo-enrich', runtimePreset: 'adf', searchOnly: true,
    description: 'A Data-pipeline template that builds a real geo-enrichment pipeline (H3 index, reverse geocode, buffer) pre-wired against Azure Maps + ADF.',
    learnContent: {
      "overview": "A Geo pipeline is a Data-pipeline TEMPLATE for geo enrichment. On instantiate it builds a REAL Azure Data Factory pipeline whose activities are already wired — H3 indexing, reverse geocode against Azure Maps, and buffer generation — with parameters (enrichH3, reverseGeocode, bufferMeters) you can tune; it runs as-is on the Azure-native ADF runtime, no empty seeded pipeline. Newly created geo pipelines instantiate the geo-enrich template into a Data pipeline (runtime ADF) and run via the unified run path; already-created geo items keep their existing route and run unchanged.",
      "steps": [
        {
          "title": "Tune the enrichment parameters",
          "body": "Set the template parameters: enrichH3 (add an H3 spatial index), reverseGeocode (resolve coordinates to addresses via Azure Maps), and bufferMeters (generate a buffer polygon)."
        },
        {
          "title": "Instantiate the template",
          "body": "Creating a Geo pipeline materializes the geo-enrich template into a real Data pipeline (ADF runtime) with the H3, reverse-geocode, and buffer activities already wired — no empty seeded pipeline."
        },
        {
          "title": "Run it",
          "body": "Trigger run fires a real ADF createRun on the instantiated pipeline via the unified run path and returns a live run id; the wired enrichment activities execute against ADF + Azure Maps."
        },
        {
          "title": "Output a geo-dataset",
          "body": "The pipeline writes an enriched, queryable geo-dataset."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities"
    } },
];
