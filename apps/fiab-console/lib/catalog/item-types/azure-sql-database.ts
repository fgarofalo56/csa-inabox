import type { FabricItemType } from './types';

/**
 * Azure SQL Database — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const azureSqlDatabaseItems: FabricItemType[] = [
  // --- v3 — Azure SQL family (Microsoft.Sql/servers + databases + MI + SQL Server 2025 features) ---
  { slug: 'azure-sql-server',            displayName: 'Azure SQL server',            restType: 'AzureSqlServer',            category: 'Azure SQL Database',
    description: 'Microsoft.Sql/servers — server-level admin, firewall, AAD admin, list of databases.',
    learnContent: {
      "overview": "An Azure SQL server (Microsoft.Sql/servers) is the logical container for databases — server-level admin, firewall, AAD admin, and the database list. In Loom it is read via ARM REST through the azure-sql-client.",
      "steps": [
        {
          "title": "List servers",
          "body": "The editor lists logical servers via ARM."
        },
        {
          "title": "Manage firewall",
          "body": "Review and manage server firewall rules."
        },
        {
          "title": "Set AAD admin",
          "body": "Configure the Entra (AAD) admin for the server."
        },
        {
          "title": "Drill to databases",
          "body": "Open the database list to manage individual databases."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-sql/database/logical-servers"
    } },
  { slug: 'azure-sql-database',          displayName: 'Azure SQL database',          restType: 'AzureSqlDatabase',          category: 'Azure SQL Database',
    description: 'Per-database T-SQL editor (TDS + AAD), mirroring config, geo-replication, vector index.',
    createConfig: {
      runtimes: [
        { value: 'azure-sql', label: 'Azure SQL Database', desc: 'Azure-native default — fully-managed PaaS database; T-SQL over TDS+AAD, geo-replication, vector index.', default: true, slug: 'azure-sql-database' },
        { value: 'synapse-pool', label: 'Synapse dedicated SQL pool', desc: 'Provisioned MPP T-SQL warehouse (formerly SQL DW); pause/resume + TDS query over the Synapse SQL endpoint.', slug: 'synapse-dedicated-sql-pool' },
        { value: 'postgres', label: 'PostgreSQL Flexible Server', desc: 'Azure Database for PostgreSQL Flexible Server — ARM provision, databases + firewall, schema, catalog registration.', slug: 'postgres-flexible-server' },
        { value: 'sql-mi', label: 'SQL Managed Instance', desc: 'Near-100% SQL Server compatibility for lift-and-shift; instance listing + state (TDS-via-PE execution per the MI editor).', slug: 'azure-sql-managed-instance' },
      ],
    },
    learnContent: {
      "overview": "An Azure SQL database is a fully-managed PaaS database. In Loom you get a per-database T-SQL editor (TDS + AAD), geo-replication, and a native vector index — wired via ARM and TDS through the azure-sql-client. (Mirroring the database into Fabric/OneLake is opt-in only, never the default.)",
      "steps": [
        {
          "title": "Run T-SQL",
          "body": "Query the database over TDS with AAD auth from the editor."
        },
        {
          "title": "Build a vector index",
          "body": "Create a native vector column + index for similarity search over embeddings, all in T-SQL. (Mirroring the database into Fabric/OneLake is available as an opt-in, disclosed if not enabled — not the default.)"
        },
        {
          "title": "Set geo-replication",
          "body": "PUT a geo-replication configuration for resilience."
        },
        {
          "title": "Pick a low-cost tier",
          "body": "Choose the serverless General Purpose tier with auto-pause, billed in vCore-seconds."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-sql/database/sql-database-paas-overview"
    } },
  { slug: 'azure-sql-managed-instance',  displayName: 'SQL Managed Instance',        restType: 'AzureSqlManagedInstance',   category: 'Azure SQL Database', searchOnly: true,
    description: 'Microsoft.Sql/managedInstances — list + state, live sys.* schema navigator, and T-SQL query execution over TDS (via the private endpoint).',
    learnContent: {
      "overview": "An Azure SQL Managed Instance (Microsoft.Sql/managedInstances) gives near-100% SQL Server compatibility for lift-and-shift. In Loom this surface lists instances and state, browses each instance's schema (real sys.* over TDS), and runs live T-SQL against the selected instance — the same AAD-authenticated TDS execution path the Azure SQL Database editor uses, pointed at the instance's private-endpoint FQDN.",
      "steps": [
        {
          "title": "List instances",
          "body": "The editor lists managed instances and their state via ARM."
        },
        {
          "title": "Inspect an instance",
          "body": "Review SKU, vCores, networking, and the private-endpoint FQDN."
        },
        {
          "title": "Browse the schema",
          "body": "Select an instance to load its schemas, tables, views, and stored procedures in the sys.* object navigator."
        },
        {
          "title": "Run T-SQL",
          "body": "Open the Query tab and execute T-SQL over AAD-authenticated TDS. The Console must reach the instance over its private endpoint and the UAMI must be an Entra admin (or have db_datareader + VIEW DEFINITION); the real connection error surfaces if the private endpoint is unreachable."
        },
        {
          "title": "Plan migration",
          "body": "Use MI for lift-and-shift of on-prem SQL with Agent, cross-DB queries, and linked servers."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/azure-sql/managed-instance/sql-managed-instance-paas-overview"
    } },
  { slug: 'sql-server-2025-vector-index',displayName: 'SQL Server 2025 vector index',restType: 'SqlServer2025VectorIndex',  category: 'Azure SQL Database',
    description: 'SQL Server 2025 native vector index — CREATE VECTOR INDEX, JSON_AGG, regex, similarity search.',
    learnContent: {
      "overview": "A SQL Server 2025 vector index is the native VECTOR type and index — CREATE VECTOR INDEX, JSON_AGG, regex, similarity search — for RAG without a separate vector store. In Loom it probes the SQL Server 2025 features against the target database.",
      "steps": [
        {
          "title": "Confirm support",
          "body": "The editor probes the database for SQL Server 2025 vector feature availability."
        },
        {
          "title": "Create a vector index",
          "body": "Run CREATE VECTOR INDEX over a VECTOR column."
        },
        {
          "title": "Store embeddings",
          "body": "Insert embedding vectors alongside your relational data."
        },
        {
          "title": "Similarity search",
          "body": "Query nearest neighbors for RAG grounding without a separate store."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/sql/relational-databases/vectors/vectors-sql-server"
    } },
];
