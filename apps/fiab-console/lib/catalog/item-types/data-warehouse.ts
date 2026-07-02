import type { FabricItemType } from './types';

/**
 * Data Warehouse — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const dataWarehouseItems: FabricItemType[] = [
  // Data Warehouse
  { slug: 'warehouse', displayName: 'Warehouse', restType: 'Warehouse', category: 'Data Warehouse',
    description: 'Lakehouse-native T-SQL warehouse with separated compute and storage.',
    learnContent: {
      "overview": "A Warehouse is a full T-SQL data warehouse with separated compute and storage. In Loom it is Azure-native by default: a provisioned MPP T-SQL warehouse backed by a Synapse dedicated SQL pool, with data stored as Parquet/Delta in ADLS Gen2; the pool auto-pauses and resumes to control cost. Use it for full T-SQL DDL/DML. (A Fabric Warehouse backend is opt-in only — LOOM_WAREHOUSE_BACKEND=fabric plus a bound workspace — never the default.)",
      "steps": [
        {
          "title": "Create tables in T-SQL",
          "body": "Run CREATE TABLE and INSERT like any T-SQL warehouse against the Synapse dedicated SQL pool."
        },
        {
          "title": "Cross-database query",
          "body": "Query any lakehouse SQL endpoint or mirrored database in the same workspace from one connection."
        },
        {
          "title": "Serve a semantic model",
          "body": "Build a semantic model over the warehouse with Loom's native tabular layer (Azure Analysis Services optional) — no Power BI or Fabric capacity required."
        },
        {
          "title": "Load via pipelines",
          "body": "Land data with a Copy activity or dataflow, then transform with stored procedures."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-overview-what-is"
    } },
  { slug: 'sql-analytics-endpoint', displayName: 'SQL analytics endpoint', restType: 'SQLEndpoint', category: 'Data Warehouse',
    description: 'Read-only T-SQL analyst surface auto-attachable to a lakehouse / warehouse / mirror — Synapse serverless SQL over the Delta in ADLS. SELECT, CREATE VIEW / PROC, and object / row-level grants.',
    learnContent: {
      "overview": "A SQL analytics endpoint is the read-only T-SQL consumption surface that sits over a lakehouse, warehouse, or mirrored database — the analyst's query layer, exactly like Fabric's auto-provisioned SQL analytics endpoint. In CSA Loom it is Azure-native: the endpoint is Azure Synapse serverless SQL querying the Delta / Parquet that lives in ADLS Gen2 (OPENROWSET / external tables), so it needs no Microsoft Fabric or Power BI workspace. The editor is the Synapse Studio-style SQL-script surface: an object explorer (views / procs / TVFs / external tables), a Monaco T-SQL editor with catalog IntelliSense, a connect-to-database dropdown, Run / Run-selection, and a Results | Messages pane. It supports SELECT, CREATE OR ALTER VIEW / PROCEDURE / inline-TVF, and object / row-level security grants (GRANT / DENY, security policies). Backed by the real serverless TDS endpoint (LOOM_SYNAPSE_WORKSPACE); when unset the surface still renders and shows an honest infra-gate.",
      "steps": [
        { "title": "Connect to the endpoint", "body": "The endpoint binds to the deployment Synapse serverless SQL pool over the lake's Delta in ADLS. Pick a database in the Connect-to dropdown (master + user databases created via CREATE DATABASE)." },
        { "title": "Explore + query", "body": "Browse views, stored procedures, table-valued functions, and external tables in the object explorer; write T-SQL in the Monaco editor with catalog-driven IntelliSense and Run (Ctrl+Enter) or Run selection." },
        { "title": "Create consumption objects", "body": "Use the New view / New procedure / New function templates to author CREATE OR ALTER VIEW / PROCEDURE / inline TVF over OPENROWSET (serverless does not support scalar UDFs — the templates emit iTVFs and say so)." },
        { "title": "Grant access", "body": "Apply object-level GRANT / DENY and row-level security (security policies + predicate functions) so analysts get a governed, read-only consumption surface. Export results to CSV / JSON or Open in Excel." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview"
    } },
  // Data Warehouse — DEPRECATED datamart (migration-only; no create path).
  { slug: 'datamart', displayName: 'Datamart (deprecated)', restType: 'Datamart', category: 'Data Warehouse',
    noRestApi: true, deprecated: true,
    description: 'DEPRECATED — migration template. Power BI datamarts migrate to a Synapse Serverless warehouse + Azure Analysis Services semantic model. No new datamarts can be created; use the Migrate action on existing ones.',
    learnContent: {
      "overview": "Power BI datamarts are deprecated, so this is a MIGRATION template — not a create surface. No new datamarts can be authored; the entry exists only to migrate existing ones. The Loom migration path converts a datamart into a Synapse Serverless user database (always-on OPENROWSET / external-table analytics — the warehouse tier) plus an Azure Analysis Services tabular model (Import or DirectQuery over Synapse — the semantic-model tier) — no Fabric or Power BI Premium capacity required. The Migrate action provisions both automatically via /api/items/datamart/migrate and stamps a migration receipt on the original item.",
      "steps": [
        {
          "title": "Review datamart definition",
          "body": "Open the deprecated datamart to see its name and the deprecation banner. No authoring surface is offered — this is a migration template, not a create surface."
        },
        {
          "title": "Migrate",
          "body": "Click Migrate. Loom runs CREATE DATABASE on the Synapse Serverless endpoint and PUTs an Azure Analysis Services server, then records the new database name + AAS connection URI on the item."
        },
        {
          "title": "Deploy the tabular model",
          "body": "Use SSDT or SSMS against the AAS XMLA endpoint (connection URI in the receipt) to deploy the semantic model to the provisioned server."
        },
        {
          "title": "Reconnect reports",
          "body": "Point Power BI / Loom reports at the new AAS server or the Synapse Serverless SQL endpoint instead of the datamart."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/transform-model/datamarts/datamarts-overview"
    } },
];
