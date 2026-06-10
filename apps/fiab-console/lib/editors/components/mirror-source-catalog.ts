/**
 * mirror-source-catalog — the pure (no-React) data behind the mirror-source
 * wizard's Step 1 source picker + Step 2 credential surface. Kept in a plain
 * `.ts` module so it is unit-testable in the Node (non-jsdom) vitest env without
 * importing the client component's Fluent/React chain.
 *
 * Each source maps to the Loom Connection type(s) that can back it (the auth
 * shape the source accepts). Azure SQL family + Cosmos + PostgreSQL authenticate
 * with the Console managed identity or a SQL/PG connection; the cross-cloud
 * sources (Google BigQuery, Oracle) authenticate with their OWN credential —
 * BigQuery a service-account JSON key (`bigquery` conn type), Oracle basic auth
 * username/password through a data gateway (`oracle` conn type) — per
 * https://learn.microsoft.com/fabric/mirroring/google-bigquery-tutorial and
 * https://learn.microsoft.com/fabric/mirroring/oracle-tutorial.
 */

/** A mirroring source card: id (the engine `sourceType`), display name, accent,
 *  and the Loom Connection types that can back it. */
export interface MirrorSourceDef { id: string; name: string; accent: string; connTypes: string[] }

export const MIRROR_SOURCES: MirrorSourceDef[] = [
  { id: 'AzureSqlDatabase', name: 'Azure SQL Database', accent: '#0078d4', connTypes: ['azure-sql', 'generic-sql'] },
  { id: 'AzureSqlMI', name: 'Azure SQL Managed Instance', accent: '#0063b1', connTypes: ['azure-sql', 'generic-sql'] },
  { id: 'AzurePostgreSql', name: 'Azure Database for PostgreSQL', accent: '#336791', connTypes: ['postgres'] },
  { id: 'CosmosDb', name: 'Azure Cosmos DB', accent: '#3999c6', connTypes: ['cosmos'] },
  { id: 'Snowflake', name: 'Snowflake', accent: '#29b5e8', connTypes: ['generic-sql', 'connection-string' as string] },
  { id: 'GoogleBigQuery', name: 'Google BigQuery', accent: '#4285f4', connTypes: ['bigquery'] },
  { id: 'Oracle', name: 'Oracle Database', accent: '#c74634', connTypes: ['oracle'] },
  { id: 'SqlServer2025', name: 'SQL Server 2025', accent: '#a4262c', connTypes: ['generic-sql'] },
  { id: 'MSSQL', name: 'SQL Server 2016-2022', accent: '#a4262c', connTypes: ['generic-sql'] },
  { id: 'GenericMirror', name: 'Open mirroring', accent: '#5c2d91', connTypes: ['azure-sql', 'postgres', 'cosmos', 'storage-adls', 'generic-sql'] },
];

/**
 * Source types that authenticate with their own per-source credential (BigQuery
 * service-account key, Oracle basic auth, Snowflake) rather than the Console
 * managed identity. The wizard surfaces a credential-required hint + the
 * source-specific field labels for these.
 */
export const CREDENTIALED_SOURCES = new Set(['GoogleBigQuery', 'Oracle', 'Snowflake']);

/** Per-source field labels + helper text so Step 2 mirrors the real source's
 *  connection dialog (BigQuery = project/dataset; Oracle = TNS/connect-descriptor). */
export const SOURCE_FIELD_HINTS: Record<string, { serverLabel: string; serverPlaceholder: string; dbLabel: string; dbPlaceholder: string; note?: string }> = {
  GoogleBigQuery: {
    serverLabel: 'Project id', serverPlaceholder: 'my-gcp-project',
    dbLabel: 'Dataset', dbPlaceholder: 'analytics',
    note: 'BigQuery uses service-account-key authentication — create a "Google BigQuery" connection with the service-account email + JSON key. The project id and dataset map to the server/database fields below.',
  },
  Oracle: {
    serverLabel: 'Server (TNS / connect descriptor / Easy Connect)', serverPlaceholder: 'dbhost:1521/ORCLPDB1',
    dbLabel: 'Service / schema', dbPlaceholder: 'ORCLPDB1',
    note: 'Oracle uses basic authentication via an On-Premises Data Gateway. Create an "Oracle Database" connection with the username/password + gateway. The Oracle DB must run ARCHIVELOG + supplemental logging for change capture.',
  },
};
