import type { FabricItemType } from './types';

/**
 * Databases — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const databasesItems: FabricItemType[] = [
  // Databases
  { slug: 'sql-database', displayName: 'SQL database', restType: 'AzureDatabase', category: 'Databases', hiddenFromGallery: true,
    description: 'Unified Azure database surface — Azure SQL DB, SQL Managed Instance, or PostgreSQL Flexible Server. Tenant inventory, provision, query, schema, and OneLake/Purview catalog.',
    learnContent: {
      "overview": "In CSA Loom the SQL database surface is backed by real Azure database services — Azure SQL Database, SQL Managed Instance, and Azure Database for PostgreSQL Flexible Server — not Fabric SQL. It lists existing deployments across the subscription via ARM, lets you connect to one, provision new ones (ARM PUT), run SQL over the live TDS path, browse the schema, and register the database as a governed OneLake/Purview catalog asset.",
      "steps": [
        {
          "title": "Connect to existing",
          "body": "Browse the tenant inventory of Azure SQL servers, SQL Managed Instances, and PostgreSQL flexible servers (ARM list) and bind one to this item."
        },
        {
          "title": "Provision new",
          "body": "Create an Azure SQL database on an existing server, or a new PostgreSQL flexible server, via ARM PUT — or get an honest role/quota gate."
        },
        {
          "title": "Run SQL",
          "body": "Execute T-SQL over TDS + AAD against the selected Azure SQL database; PostgreSQL and MI query paths surface honest infra-gates."
        },
        {
          "title": "Register in the catalog",
          "body": "Surface the database as a OneLake/Purview catalog asset so it shows up alongside lakehouses and warehouses."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-sql/database/sql-database-paas-overview"
    } },
  { slug: 'postgres-flexible-server', displayName: 'PostgreSQL Flexible Server', restType: 'PostgresFlexibleServer', category: 'Databases', searchOnly: true,
    description: 'Azure Database for PostgreSQL Flexible Server — list/provision via ARM, databases + firewall, schema browser, catalog registration.',
    learnContent: {
      "overview": "Azure Database for PostgreSQL Flexible Server (Microsoft.DBforPostgreSQL/flexibleServers) is a fully-managed PostgreSQL service. In CSA Loom you list existing servers across the subscription, provision new ones via ARM PUT, manage databases + firewall rules, browse schema, and register the server as a OneLake/Purview catalog asset. In-database query execution is an honest infra-gate until the pg driver + LOOM_POSTGRES_QUERY_LIVE are wired.",
      "steps": [
        { "title": "List servers", "body": "Inventory PostgreSQL flexible servers across the subscription via ARM." },
        { "title": "Provision", "body": "Create a new flexible server (SKU, tier, version, admin) via ARM PUT." },
        { "title": "Manage firewall", "body": "Review and upsert Microsoft.DBforPostgreSQL/flexibleServers/firewallRules." },
        { "title": "Register in the catalog", "body": "Surface the server as a Purview/OneLake catalog asset." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/postgresql/flexible-server/overview"
    } },
  // --- v3 — Azure Cosmos DB account navigator (SQL / NoSQL API — parity wave 7) ---
  { slug: 'azure-cosmos-account',        displayName: 'Azure Cosmos DB account',     restType: 'CosmosDbAccount',           category: 'Databases',
    description: 'Cosmos DB for NoSQL — a live Data Explorer over databases, containers, throughput, and server-side scripts.',
    learnContent: {
      "overview": "An Azure Cosmos DB account (NoSQL / Core SQL API) is a globally-distributed, multi-model database. In Loom the editor is a live Data Explorer over the env-pinned account (LOOM_COSMOS_ACCOUNT) — databases → containers → stored procedures / triggers / UDFs — driven by the real ARM control plane (Microsoft.DocumentDB/databaseAccounts, api-version 2024-11-15). Create/delete databases and containers (with partition key + manual/autoscale RU/s) run real ARM PUT/DELETE calls.",
      "steps": [
        {
          "title": "Configure the navigator account",
          "body": "Set LOOM_COSMOS_ACCOUNT, LOOM_COSMOS_ACCOUNT_RG, and LOOM_SUBSCRIPTION_ID, and grant the Console UAMI the Cosmos DB Operator (or DocumentDB Account Contributor) role at the account scope. This account is distinct from Loom's own internal store."
        },
        {
          "title": "Browse the Data Explorer",
          "body": "Expand Databases → a database → Containers → a container to see its partition key, throughput, and the stored procedures / triggers / UDFs registered on it. Counts come from real ARM list calls."
        },
        {
          "title": "Create a database or container",
          "body": "Use the ＋ New menu to create a database (optional shared throughput) or a container (partition key + manual/autoscale RU/s). The create issues a real ARM PUT and the tree refreshes."
        },
        {
          "title": "Edit policies and author scripts",
          "body": "The item document grid (Monaco SQL + Execute against the real data plane, live RU charge, JSON document CRUD), the indexing-policy editor, and the conflict-resolution policy are all wired — edits save through a real ARM / data-plane PATCH (the Save indexing policy and Save conflict resolution policy buttons). Script authoring is live too: New / existing Stored Procedure, UDF, and Trigger tabs create or replace scripts with a real ARM PUT, delete them, and run stored procedures on the data plane. The only non-functional states are honest infra gates — a read-only UAMI surfaces the ARM 403 as a MessageBar naming the exact role to grant, never faked data."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts"
    } },
];
