/**
 * connector-catalog — the data-driven inventory of Azure Data Factory / Synapse
 * "linked service" connectors and their full config metadata.
 *
 * WHY THIS EXISTS
 * ---------------
 * ADF/Synapse expose 90+ connectors. Each connector is created as a
 * `Microsoft.DataFactory/factories/linkedservices` resource (api 2018-06-01)
 * whose `properties.type` is the connector type (e.g. 'AzureBlobFS',
 * 'AzureSqlDatabase', 'Snowflake') and whose `properties.typeProperties` carries
 * the connector-specific fields (auth + endpoint). Datasets that read/write
 * through a linked service have their own `type` (e.g. 'AzureSqlTable',
 * 'DelimitedText') and `typeProperties.location`.
 *
 * The Loom linked-service / Get-data UI renders STRUCTURED FORMS from this
 * catalog — never a freeform JSON textarea (per loom-no-freeform-config). A
 * connector's `commonFields` + the selected auth option's `fields` describe
 * exactly which `typeProperties` keys to collect; the editor assembles the
 * payload and POSTs it to the real ADF/Synapse linked-service BFF route
 * (`/api/adf/linked-services`, `/api/synapse/linkedservices`), which calls the
 * real ARM REST `upsertLinkedService` in `lib/azure/adf-client.ts` /
 * `lib/azure/synapse-dev-client.ts`. No mocks (per no-vaporware.md).
 *
 * Every `key` here is the EXACT linked-service / dataset typeProperties key
 * from the ADF connector docs + the ARM `factories/linkedservices` schema +
 * the `@azure/arm-datafactory` model, grounded in Microsoft Learn:
 *   - connector overview (supported data stores / categories):
 *       https://learn.microsoft.com/azure/data-factory/connector-overview
 *   - per-connector "Linked service properties" + "Dataset properties" pages
 *       (e.g. /connector-azure-data-lake-storage, /connector-azure-sql-database,
 *       /connector-snowflake, /connector-rest, …)
 *   - ARM template reference:
 *       https://learn.microsoft.com/azure/templates/microsoft.datafactory/factories/linkedservices
 *
 * EXTENSIBILITY
 * -------------
 * This file implements the ~30 most-used connectors with full auth + field
 * metadata. The remaining 60+ ADF connectors (Db2, Greenplum, Hive, Impala,
 * Netezza, Presto, Spark, Sybase, Vertica, Cassandra, Couchbase, ServiceNow,
 * Jira, HubSpot, Marketo, Magento, Square, Xero, Zoho, SAP BW/ECC/Table,
 * Google Cloud Storage, HDFS, Office 365, Azure Table Storage, Azure Cosmos DB
 * for PostgreSQL, Azure Search, etc.) follow the SAME `ConnectorDef` shape and
 * can be appended to `CONNECTORS` without any code change — the form renderer,
 * the BFF route, and the ARM client are all connector-agnostic. Adding one is
 * pure data: copy its "Linked service properties" / "Dataset properties" rows
 * from Microsoft Learn into a new `ConnectorDef`.
 */

// =============================================================================
// Shared contract (imported by the linked-service editor / Get-data wizard).
// =============================================================================

export type AuthKind =
  | 'connectionString'
  | 'accountKey'
  | 'sasUri'
  | 'servicePrincipal'
  | 'managedIdentity'
  | 'sqlAuth'
  | 'aadSqlAuth'
  | 'basic'
  | 'anonymous'
  | 'oauth2'
  | 'accessKey'
  | 'token'
  | 'key';

export interface ConfigField {
  /** The linked-service / dataset typeProperties key (e.g. 'connectionString','url','server','database'). */
  key: string;
  label: string;
  kind: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'multiline';
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  /** Store via Key Vault / secureString (the editor never keeps it in plaintext state). */
  secret?: boolean;
  /** Conditional render (e.g. only for a given auth or a chosen sub-mode). */
  showIf?: { key: string; equals: string };
  /** Allows an @{...} ADF expression (wave 3 wires the dynamic-content builder). */
  supportsDynamic?: boolean;
}

export interface ConnectorAuthOption {
  auth: AuthKind;
  label: string;
  fields: ConfigField[];
}

export interface ConnectorDef {
  /** ADF linkedService type, e.g. 'AzureBlobFS','AzureSqlDatabase','Snowflake','RestService','Oracle'. */
  type: string;
  /** Display name, e.g. 'Azure Data Lake Storage Gen2'. */
  name: string;
  category: 'azure' | 'database' | 'file' | 'nosql' | 'generic-protocol' | 'services-and-apps';
  /** A Fluent icon name (best-effort; the editor maps it to a `@fluentui/react-icons` glyph). */
  icon?: string;
  description: string;
  /** Fields shown regardless of auth (endpoint, db name, etc.). */
  commonFields: ConfigField[];
  authOptions: ConnectorAuthOption[];
  /** Dataset shapes this connector exposes (Copy/DataFlow source & sink). */
  datasetTypes: { type: string; name: string; locationFields: ConfigField[] }[];
  supportsSource: boolean;
  supportsSink: boolean;
  /**
   * Whether this connector exposes a live (DirectQuery) execution path for the
   * report storage-mode picker — i.e. a relational / analytics engine the
   * report-model resolver can issue live SQL or KQL against (SQL-family, Azure
   * Data Explorer, Databricks Delta Lake). When falsey (File / NoSQL /
   * generic-protocol / SaaS connectors) the picker offers Import-only — plus
   * Direct Lake when the selected object is Delta-backed — matching the Power BI
   * convention. Additive + optional: existing linked-service / Get-data
   * consumers ignore it.
   *
   * This flag encodes the SAME "can it serve a live query?" signal the report
   * storage-mode picker enforces — but the picker does NOT read this flag.
   * `lib/editors/report/storage-mode-pane.tsx` is a `'use client'` module, so it
   * derives `directQueryCapable` client-side (in `sourceCapability`) from the
   * report's `ReportConnType` ('azure-sql', 'synapse-dedicated', 'adx', …) via
   * its own `DIRECT_QUERY_CONN_TYPES` set, then feeds that boolean to
   * `allowedStorageModes`. That is a different id space than this catalog's ADF
   * connector `type` ('AzureSqlDatabase', …). `connectorDirectQueryCapable()`
   * below is the server-side reading of THIS flag over the ADF connector-type id
   * space, for callers that already hold an ADF `type` (the linked-service /
   * Get-data path); the pane is not one of those callers.
   */
  directQueryCapable?: boolean;
}

// =============================================================================
// Reusable field fragments (kept DRY; every key is verbatim from ADF docs).
// =============================================================================

/** ADF azureCloudType — sovereign-cloud selector on service-principal auth. */
const AZURE_CLOUD_TYPE: ConfigField = {
  key: 'azureCloudType',
  label: 'Azure cloud',
  kind: 'select',
  hint: 'Sovereign cloud the Entra app is registered in. Defaults to the factory region cloud.',
  options: [
    { value: 'AzurePublic', label: 'Azure Public' },
    { value: 'AzureUsGovernment', label: 'Azure US Government' },
    { value: 'AzureChina', label: 'Azure China' },
    { value: 'AzureGermany', label: 'Azure Germany' },
  ],
};

const SP_TENANT: ConfigField = {
  key: 'tenant',
  label: 'Tenant (directory) ID',
  kind: 'text',
  required: true,
  placeholder: 'contoso.onmicrosoft.com or a tenant GUID',
  hint: 'Domain name or tenant ID the Entra app resides in.',
  supportsDynamic: true,
};
const SP_ID: ConfigField = {
  key: 'servicePrincipalId',
  label: 'Service principal (client) ID',
  kind: 'text',
  required: true,
  placeholder: 'application (client) ID',
  supportsDynamic: true,
};

/** SQL-family server/database/authenticationType common block (recommended version). */
const SQL_SERVER: ConfigField = {
  key: 'server',
  label: 'Server',
  kind: 'text',
  required: true,
  placeholder: 'myserver.database.windows.net',
  hint: 'Fully-qualified server name or network address.',
  supportsDynamic: true,
};
const SQL_DATABASE: ConfigField = {
  key: 'database',
  label: 'Database',
  kind: 'text',
  required: true,
  placeholder: 'mydb',
  supportsDynamic: true,
};

/** Azure SQL / SQL MI / Synapse SQL DW dataset (schema + table). */
const SQL_TABLE_LOCATION: ConfigField[] = [
  { key: 'schema', label: 'Schema', kind: 'text', placeholder: 'dbo', supportsDynamic: true },
  { key: 'table', label: 'Table / view', kind: 'text', placeholder: 'SalesOrders', supportsDynamic: true },
];

/** SQL-family auth options shared by AzureSqlDatabase / AzureSqlMI / AzureSqlDW. */
function sqlFamilyAuthOptions(): ConnectorAuthOption[] {
  return [
    {
      auth: 'sqlAuth',
      label: 'SQL authentication',
      fields: [
        { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
        { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
      ],
    },
    {
      auth: 'managedIdentity',
      label: 'System-assigned managed identity',
      fields: [],
    },
    {
      auth: 'managedIdentity',
      label: 'User-assigned managed identity',
      fields: [
        {
          key: 'credential',
          label: 'Credential (user-assigned identity)',
          kind: 'text',
          required: true,
          hint: 'Name of the factory credential bound to the user-assigned managed identity.',
        },
      ],
    },
    {
      auth: 'servicePrincipal',
      label: 'Service principal',
      fields: [
        SP_ID,
        {
          key: 'servicePrincipalCredential',
          label: 'Service principal key',
          kind: 'password',
          required: true,
          secret: true,
          hint: "Application key (servicePrincipalCredentialType 'ServicePrincipalKey').",
        },
        SP_TENANT,
        AZURE_CLOUD_TYPE,
      ],
    },
  ];
}

// =============================================================================
// The connector inventory (top ~30 by usage; extensible to all 90+).
// =============================================================================

export const CONNECTORS: ConnectorDef[] = [
  // ---------------------------------------------------------------- Azure ----
  {
    type: 'AzureBlobFS',
    name: 'Azure Data Lake Storage Gen2',
    category: 'azure',
    icon: 'CloudDatabase',
    description: 'Hierarchical-namespace storage (ADLS Gen2) over the dfs endpoint. The Loom-default lakehouse / medallion backend.',
    commonFields: [
      {
        key: 'url',
        label: 'URL (dfs endpoint)',
        kind: 'text',
        required: true,
        placeholder: 'https://myaccount.dfs.core.windows.net',
        hint: 'ADLS Gen2 dfs service endpoint.',
        supportsDynamic: true,
      },
    ],
    authOptions: [
      { auth: 'managedIdentity', label: 'System-assigned managed identity', fields: [] },
      {
        auth: 'managedIdentity',
        label: 'User-assigned managed identity',
        fields: [
          { key: 'credential', label: 'Credential (user-assigned identity)', kind: 'text', required: true, hint: 'Factory credential bound to the user-assigned managed identity.' },
        ],
      },
      {
        auth: 'accountKey',
        label: 'Account key',
        fields: [
          { key: 'accountKey', label: 'Account key', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'sasUri',
        label: 'Shared access signature (SAS)',
        fields: [
          { key: 'sasUri', label: 'SAS URI', kind: 'password', required: true, secret: true, hint: 'Mutually exclusive with account key.' },
        ],
      },
      {
        auth: 'servicePrincipal',
        label: 'Service principal',
        fields: [
          SP_ID,
          { key: 'servicePrincipalKey', label: 'Service principal key', kind: 'password', required: true, secret: true },
          SP_TENANT,
          AZURE_CLOUD_TYPE,
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'DelimitedText',
        name: 'Delimited text (CSV)',
        locationFields: [
          { key: 'fileSystem', label: 'File system (container)', kind: 'text', required: true, supportsDynamic: true },
          { key: 'folderPath', label: 'Directory', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Parquet',
        name: 'Parquet',
        locationFields: [
          { key: 'fileSystem', label: 'File system (container)', kind: 'text', required: true, supportsDynamic: true },
          { key: 'folderPath', label: 'Directory', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Json',
        name: 'JSON',
        locationFields: [
          { key: 'fileSystem', label: 'File system (container)', kind: 'text', required: true, supportsDynamic: true },
          { key: 'folderPath', label: 'Directory', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzureBlobStorage',
    name: 'Azure Blob Storage',
    category: 'azure',
    icon: 'StorageRegular',
    description: 'Flat-namespace block-blob storage. Use ADLS Gen2 for hierarchical lake layouts.',
    commonFields: [
      {
        key: 'serviceEndpoint',
        label: 'Blob service endpoint',
        kind: 'text',
        placeholder: 'https://myaccount.blob.core.windows.net/',
        hint: 'Required for MI / service-principal auth. Mutually exclusive with connection string / SAS URI.',
        supportsDynamic: true,
      },
      {
        key: 'accountKind',
        label: 'Account kind',
        kind: 'select',
        hint: 'MI / service-principal in Data Flow require StorageV2 or BlockBlobStorage.',
        options: [
          { value: 'StorageV2', label: 'General purpose v2' },
          { value: 'Storage', label: 'General purpose v1' },
          { value: 'BlobStorage', label: 'Blob storage' },
          { value: 'BlockBlobStorage', label: 'Block blob storage' },
        ],
      },
    ],
    authOptions: [
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          { key: 'connectionString', label: 'Connection string', kind: 'password', required: true, secret: true, hint: 'Mutually exclusive with SAS URI / service endpoint.' },
        ],
      },
      {
        auth: 'accountKey',
        label: 'Account key',
        fields: [
          { key: 'accountKey', label: 'Account key', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'sasUri',
        label: 'Shared access signature (SAS)',
        fields: [
          { key: 'sasUri', label: 'SAS URI', kind: 'password', required: true, secret: true },
        ],
      },
      { auth: 'managedIdentity', label: 'Managed identity', fields: [] },
      {
        auth: 'servicePrincipal',
        label: 'Service principal',
        fields: [
          SP_ID,
          {
            key: 'servicePrincipalCredentialType',
            label: 'Credential type',
            kind: 'select',
            required: true,
            options: [
              { value: 'ServicePrincipalKey', label: 'Key / secret' },
              { value: 'ServicePrincipalCert', label: 'Certificate (Key Vault)' },
            ],
          },
          { key: 'servicePrincipalCredential', label: 'Service principal credential', kind: 'password', required: true, secret: true },
          SP_TENANT,
          AZURE_CLOUD_TYPE,
        ],
      },
      {
        auth: 'anonymous',
        label: 'Anonymous (public read)',
        fields: [
          { key: 'containerUri', label: 'Container URI', kind: 'text', required: true, hint: 'Only valid for anonymous public-read access.', supportsDynamic: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'DelimitedText',
        name: 'Delimited text (CSV)',
        locationFields: [
          { key: 'container', label: 'Container', kind: 'text', required: true, supportsDynamic: true },
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Parquet',
        name: 'Parquet',
        locationFields: [
          { key: 'container', label: 'Container', kind: 'text', required: true, supportsDynamic: true },
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Binary',
        name: 'Binary',
        locationFields: [
          { key: 'container', label: 'Container', kind: 'text', required: true, supportsDynamic: true },
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzureFileStorage',
    name: 'Azure Files',
    category: 'azure',
    icon: 'FolderRegular',
    description: 'Azure Files SMB share over the file service endpoint.',
    commonFields: [
      { key: 'host', label: 'Host (file endpoint)', kind: 'text', placeholder: '\\\\myaccount.file.core.windows.net\\myshare', supportsDynamic: true },
      { key: 'fileShare', label: 'File share', kind: 'text', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          { key: 'connectionString', label: 'Connection string', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'accountKey',
        label: 'Account key',
        fields: [
          { key: 'accountKey', label: 'Account key', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'sasUri',
        label: 'Shared access signature (SAS)',
        fields: [
          { key: 'sasUri', label: 'SAS URI', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'basic',
        label: 'User name + password',
        fields: [
          { key: 'userId', label: 'User ID', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'DelimitedText',
        name: 'Delimited text (CSV)',
        locationFields: [
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Binary',
        name: 'Binary',
        locationFields: [
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzureSqlDatabase',
    name: 'Azure SQL Database',
    directQueryCapable: true,
    category: 'azure',
    icon: 'DatabaseRegular',
    description: 'Azure SQL Database (recommended-version connector: server/database/authenticationType).',
    commonFields: [
      SQL_SERVER,
      SQL_DATABASE,
      {
        key: 'encrypt',
        label: 'Encrypt',
        kind: 'select',
        options: [
          { value: 'mandatory', label: 'Mandatory (true, default)' },
          { value: 'optional', label: 'Optional (false)' },
          { value: 'strict', label: 'Strict' },
        ],
      },
      { key: 'trustServerCertificate', label: 'Trust server certificate', kind: 'boolean' },
    ],
    authOptions: sqlFamilyAuthOptions(),
    datasetTypes: [
      { type: 'AzureSqlTable', name: 'Azure SQL table', locationFields: SQL_TABLE_LOCATION },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzureSqlMI',
    name: 'Azure SQL Managed Instance',
    directQueryCapable: true,
    category: 'azure',
    icon: 'DatabaseRegular',
    description: 'Azure SQL Managed Instance (recommended version). Public endpoint uses port 3342.',
    commonFields: [
      { ...SQL_SERVER, placeholder: 'myinstance.public.xxxx.database.windows.net,3342' },
      SQL_DATABASE,
      {
        key: 'encrypt',
        label: 'Encrypt',
        kind: 'select',
        options: [
          { value: 'mandatory', label: 'Mandatory (true, default)' },
          { value: 'optional', label: 'Optional (false)' },
          { value: 'strict', label: 'Strict' },
        ],
      },
      { key: 'trustServerCertificate', label: 'Trust server certificate', kind: 'boolean' },
    ],
    authOptions: sqlFamilyAuthOptions(),
    datasetTypes: [
      { type: 'AzureSqlMITable', name: 'Azure SQL MI table', locationFields: SQL_TABLE_LOCATION },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzureSqlDW',
    name: 'Azure Synapse Analytics (dedicated SQL pool)',
    directQueryCapable: true,
    category: 'azure',
    icon: 'DataWarehouseRegular',
    description: 'Synapse dedicated SQL pool (formerly SQL Data Warehouse). The Loom Azure-native warehouse backend.',
    commonFields: [
      { ...SQL_SERVER, placeholder: 'myworkspace.sql.azuresynapse.net' },
      SQL_DATABASE,
    ],
    authOptions: sqlFamilyAuthOptions(),
    datasetTypes: [
      { type: 'AzureSqlDWTable', name: 'Synapse SQL DW table', locationFields: SQL_TABLE_LOCATION },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzureDataExplorer',
    name: 'Azure Data Explorer (Kusto)',
    directQueryCapable: true,
    category: 'azure',
    icon: 'DataTrendingRegular',
    description: 'Azure Data Explorer cluster. The Loom Azure-native eventhouse / KQL backend.',
    commonFields: [
      {
        key: 'endpoint',
        label: 'Cluster endpoint',
        kind: 'text',
        required: true,
        placeholder: 'https://mycluster.westus.kusto.windows.net',
        supportsDynamic: true,
      },
      { key: 'database', label: 'Database', kind: 'text', required: true, supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'servicePrincipal',
        label: 'Service principal',
        fields: [
          SP_ID,
          { key: 'servicePrincipalKey', label: 'Service principal key', kind: 'password', required: true, secret: true },
          SP_TENANT,
        ],
      },
      { auth: 'managedIdentity', label: 'System-assigned managed identity', fields: [] },
      {
        auth: 'managedIdentity',
        label: 'User-assigned managed identity',
        fields: [
          { key: 'credential', label: 'Credential (user-assigned identity)', kind: 'text', required: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'AzureDataExplorerTable',
        name: 'Azure Data Explorer table',
        locationFields: [
          { key: 'table', label: 'Table', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzurePostgreSql',
    name: 'Azure Database for PostgreSQL',
    directQueryCapable: true,
    category: 'azure',
    icon: 'DatabaseRegular',
    description: 'Azure Database for PostgreSQL (flexible server). v2.0 adds TLS 1.3 + SSL modes + MI / service principal.',
    commonFields: [
      { key: 'server', label: 'Server', kind: 'text', required: true, placeholder: 'myserver.postgres.database.azure.com', supportsDynamic: true },
      { key: 'port', label: 'Port', kind: 'number', placeholder: '5432' },
      { key: 'database', label: 'Database', kind: 'text', required: true, supportsDynamic: true },
      {
        key: 'sslMode',
        label: 'SSL mode',
        kind: 'select',
        options: [
          { value: '0', label: 'Disabled' },
          { value: '1', label: 'Allow' },
          { value: '2', label: 'Prefer (default)' },
          { value: '3', label: 'Require' },
          { value: '4', label: 'VerifyCA' },
          { value: '5', label: 'VerifyFull' },
        ],
      },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'Basic (user name + password)',
        fields: [
          { key: 'username', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      { auth: 'managedIdentity', label: 'System-assigned managed identity', fields: [] },
      {
        auth: 'managedIdentity',
        label: 'User-assigned managed identity',
        fields: [
          { key: 'username', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'credential', label: 'Credential (user-assigned identity)', kind: 'text', required: true },
        ],
      },
      {
        auth: 'servicePrincipal',
        label: 'Service principal',
        fields: [
          { key: 'username', label: 'Service principal name', kind: 'text', required: true, supportsDynamic: true },
          SP_ID,
          {
            key: 'servicePrincipalCredentialType',
            label: 'Credential type',
            kind: 'select',
            required: true,
            options: [
              { value: 'ServicePrincipalKey', label: 'Key / secret' },
              { value: 'ServicePrincipalCert', label: 'Certificate' },
            ],
          },
          { key: 'servicePrincipalKey', label: 'Service principal key', kind: 'password', secret: true, showIf: { key: 'servicePrincipalCredentialType', equals: 'ServicePrincipalKey' } },
          { key: 'servicePrincipalEmbeddedCert', label: 'Service principal certificate', kind: 'password', secret: true, showIf: { key: 'servicePrincipalCredentialType', equals: 'ServicePrincipalCert' } },
          SP_TENANT,
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'AzurePostgreSqlTable',
        name: 'Azure PostgreSQL table',
        locationFields: [
          { key: 'schema', label: 'Schema', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Table / view', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzureMySql',
    name: 'Azure Database for MySQL',
    directQueryCapable: true,
    category: 'azure',
    icon: 'DatabaseRegular',
    description: 'Azure Database for MySQL via an ADO.NET connection string.',
    commonFields: [],
    authOptions: [
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          {
            key: 'connectionString',
            label: 'Connection string',
            kind: 'password',
            required: true,
            secret: true,
            hint: 'e.g. server=<server>.mysql.database.azure.com;port=3306;database=<db>;uid=<user>;pwd=<pwd>;sslmode=…',
          },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'AzureMySqlTable',
        name: 'Azure MySQL table',
        locationFields: [
          { key: 'tableName', label: 'Table name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AzureDatabricksDeltaLake',
    name: 'Azure Databricks Delta Lake',
    directQueryCapable: true,
    category: 'azure',
    icon: 'DatabaseLightningRegular',
    description: 'Read/write Delta tables through an interactive Databricks cluster.',
    commonFields: [
      { key: 'domain', label: 'Workspace URL', kind: 'text', required: true, placeholder: 'https://adb-xxxxxxxxx.xx.azuredatabricks.net', supportsDynamic: true },
      { key: 'clusterId', label: 'Cluster ID', kind: 'text', required: true, hint: 'An existing interactive cluster ID.', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'token',
        label: 'Access token',
        fields: [
          { key: 'accessToken', label: 'Access token', kind: 'password', required: true, secret: true, hint: 'Databricks workspace PAT.' },
        ],
      },
      {
        auth: 'managedIdentity',
        label: 'System-assigned managed identity',
        fields: [
          { key: 'workspaceResourceId', label: 'Workspace resource ID', kind: 'text', required: true, supportsDynamic: true },
        ],
      },
      {
        auth: 'managedIdentity',
        label: 'User-assigned managed identity',
        fields: [
          { key: 'workspaceResourceId', label: 'Workspace resource ID', kind: 'text', required: true, supportsDynamic: true },
          { key: 'credentials', label: 'Credential (user-assigned identity)', kind: 'text', required: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'AzureDatabricksDeltaLakeDataset',
        name: 'Databricks Delta table',
        locationFields: [
          { key: 'database', label: 'Database', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Delta table', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'CosmosDb',
    name: 'Azure Cosmos DB for NoSQL',
    category: 'nosql',
    icon: 'DatabaseRegular',
    description: 'Azure Cosmos DB SQL (NoSQL) API. Connection string, account key, or service principal / managed identity.',
    commonFields: [],
    authOptions: [
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          { key: 'connectionString', label: 'Connection string', kind: 'password', required: true, secret: true, hint: 'AccountEndpoint=…;AccountKey=…;Database=…' },
        ],
      },
      {
        auth: 'accountKey',
        label: 'Account endpoint + key',
        fields: [
          { key: 'accountEndpoint', label: 'Account endpoint', kind: 'text', required: true, placeholder: 'https://myacct.documents.azure.com:443/', supportsDynamic: true },
          { key: 'database', label: 'Database', kind: 'text', required: true, supportsDynamic: true },
          { key: 'accountKey', label: 'Account key', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'servicePrincipal',
        label: 'Service principal',
        fields: [
          { key: 'accountEndpoint', label: 'Account endpoint', kind: 'text', required: true, placeholder: 'https://myacct.documents.azure.com:443/', supportsDynamic: true },
          { key: 'database', label: 'Database', kind: 'text', required: true, supportsDynamic: true },
          SP_ID,
          {
            key: 'servicePrincipalCredentialType',
            label: 'Credential type',
            kind: 'select',
            required: true,
            options: [
              { value: 'ServicePrincipalKey', label: 'Key / secret' },
              { value: 'ServicePrincipalCert', label: 'Certificate' },
            ],
          },
          { key: 'servicePrincipalCredential', label: 'Service principal credential', kind: 'password', required: true, secret: true },
          SP_TENANT,
          AZURE_CLOUD_TYPE,
        ],
      },
      {
        auth: 'managedIdentity',
        label: 'Managed identity',
        fields: [
          { key: 'accountEndpoint', label: 'Account endpoint', kind: 'text', required: true, placeholder: 'https://myacct.documents.azure.com:443/', supportsDynamic: true },
          { key: 'database', label: 'Database', kind: 'text', required: true, supportsDynamic: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'CosmosDbSqlApiCollection',
        name: 'Cosmos DB (SQL API) collection',
        locationFields: [
          { key: 'collectionName', label: 'Collection (container)', kind: 'text', required: true, supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'CosmosDbMongoDbApi',
    name: 'Azure Cosmos DB for MongoDB',
    category: 'nosql',
    icon: 'DatabaseRegular',
    description: 'Azure Cosmos DB for MongoDB API via a Mongo connection string + database name.',
    commonFields: [
      { key: 'database', label: 'Database', kind: 'text', required: true, supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          { key: 'connectionString', label: 'Connection string', kind: 'password', required: true, secret: true, hint: 'mongodb://… Mongo API connection string.' },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'CosmosDbMongoDbApiCollection',
        name: 'Cosmos DB (MongoDB API) collection',
        locationFields: [
          { key: 'collectionName', label: 'Collection', kind: 'text', required: true, supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },

  // ------------------------------------------------------------- Database ----
  {
    type: 'SqlServer',
    name: 'SQL Server',
    directQueryCapable: true,
    category: 'database',
    icon: 'DatabaseRegular',
    description: 'On-premises / IaaS SQL Server (recommended version). Often runs through a self-hosted IR.',
    commonFields: [
      { ...SQL_SERVER, placeholder: 'sql01.contoso.local' },
      SQL_DATABASE,
      {
        key: 'encrypt',
        label: 'Encrypt',
        kind: 'select',
        options: [
          { value: 'mandatory', label: 'Mandatory' },
          { value: 'optional', label: 'Optional' },
          { value: 'strict', label: 'Strict' },
        ],
      },
      { key: 'trustServerCertificate', label: 'Trust server certificate', kind: 'boolean' },
    ],
    authOptions: [
      {
        auth: 'sqlAuth',
        label: 'SQL authentication',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'basic',
        label: 'Windows authentication',
        fields: [
          { key: 'userName', label: 'User name (DOMAIN\\user)', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
    ],
    datasetTypes: [
      { type: 'SqlServerTable', name: 'SQL Server table', locationFields: SQL_TABLE_LOCATION },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'Oracle',
    name: 'Oracle',
    directQueryCapable: true,
    category: 'database',
    icon: 'DatabaseRegular',
    description: 'Oracle Database. v1.0 uses a connection string; v2.0 uses server + basic auth (TLS 1.3).',
    commonFields: [],
    authOptions: [
      {
        auth: 'connectionString',
        label: 'Connection string (v1.0)',
        fields: [
          {
            key: 'connectionString',
            label: 'Connection string',
            kind: 'password',
            required: true,
            secret: true,
            hint: 'Host=<host>;Port=<port>;Sid=<sid>;User Id=<user>;Password=<pwd>; — or ServiceName=<svc>.',
          },
        ],
      },
      {
        auth: 'basic',
        label: 'Server + basic auth (v2.0)',
        fields: [
          { key: 'server', label: 'Server', kind: 'text', required: true, placeholder: 'host:port/servicename', supportsDynamic: true },
          { key: 'username', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'OracleTable',
        name: 'Oracle table',
        locationFields: [
          { key: 'schema', label: 'Schema', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Table', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'Snowflake',
    name: 'Snowflake',
    directQueryCapable: true,
    category: 'database',
    icon: 'SnowflakeRegular',
    description: 'Snowflake V2 connector (type SnowflakeV2): account identifier + warehouse + database with basic or key-pair auth.',
    commonFields: [
      { key: 'accountIdentifier', label: 'Account identifier', kind: 'text', required: true, placeholder: 'myorg-account123', supportsDynamic: true },
      { key: 'warehouse', label: 'Warehouse', kind: 'text', required: true, supportsDynamic: true },
      { key: 'database', label: 'Database', kind: 'text', required: true, supportsDynamic: true },
      { key: 'schema', label: 'Schema', kind: 'text', supportsDynamic: true },
      { key: 'role', label: 'Role', kind: 'text', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'Basic (user + password)',
        fields: [
          { key: 'user', label: 'User', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'key',
        label: 'Key pair',
        fields: [
          { key: 'user', label: 'User', kind: 'text', required: true, supportsDynamic: true },
          { key: 'privateKey', label: 'Private key (PEM)', kind: 'multiline', required: true, secret: true, hint: 'PKCS#8 PEM with \\n-escaped newlines.' },
          { key: 'privateKeyPassphrase', label: 'Private key passphrase', kind: 'password', secret: true, hint: 'Only if the private key is encrypted.' },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'SnowflakeV2Table',
        name: 'Snowflake table',
        locationFields: [
          { key: 'schema', label: 'Schema (case-sensitive)', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Table / view (case-sensitive)', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'AmazonRedshift',
    name: 'Amazon Redshift',
    directQueryCapable: true,
    category: 'database',
    icon: 'DataWarehouseRegular',
    description: 'Amazon Redshift cluster. Copy source only (use UNLOAD-to-S3 for large extracts).',
    commonFields: [
      { key: 'server', label: 'Server', kind: 'text', required: true, placeholder: 'mycluster.xxxx.us-east-1.redshift.amazonaws.com', supportsDynamic: true },
      { key: 'port', label: 'Port', kind: 'number', placeholder: '5439' },
      { key: 'database', label: 'Database', kind: 'text', required: true, supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'User name + password',
        fields: [
          { key: 'username', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'AmazonRedshiftTable',
        name: 'Amazon Redshift table',
        locationFields: [
          { key: 'schema', label: 'Schema', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Table', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
  {
    type: 'PostgreSql',
    name: 'PostgreSQL (generic)',
    directQueryCapable: true,
    category: 'database',
    icon: 'DatabaseRegular',
    description: 'Generic PostgreSQL via an ODBC/Npgsql connection string. Copy source only.',
    commonFields: [],
    authOptions: [
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          { key: 'connectionString', label: 'Connection string', kind: 'password', required: true, secret: true, hint: 'host=<host>;port=<port>;database=<db>;uid=<user>;pwd=<pwd>;' },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'PostgreSqlTable',
        name: 'PostgreSQL table',
        locationFields: [
          { key: 'schema', label: 'Schema', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Table / view', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
  {
    type: 'MySql',
    name: 'MySQL (generic)',
    directQueryCapable: true,
    category: 'database',
    icon: 'DatabaseRegular',
    description: 'Generic MySQL / MariaDB via a connection string. Copy source only.',
    commonFields: [],
    authOptions: [
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          { key: 'connectionString', label: 'Connection string', kind: 'password', required: true, secret: true, hint: 'server=<host>;port=3306;database=<db>;user=<user>;password=<pwd>;sslmode=…' },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'MySqlTable',
        name: 'MySQL table',
        locationFields: [
          { key: 'tableName', label: 'Table name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
  {
    type: 'Teradata',
    name: 'Teradata',
    directQueryCapable: true,
    category: 'database',
    icon: 'DatabaseRegular',
    description: 'Teradata Vantage. Copy source only. Basic / Windows auth, usually through a self-hosted IR.',
    commonFields: [
      { key: 'server', label: 'Server', kind: 'text', required: true, placeholder: 'teradata.contoso.local', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'Basic (user + password)',
        fields: [
          { key: 'username', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          { key: 'connectionString', label: 'Connection string', kind: 'password', required: true, secret: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'TeradataTable',
        name: 'Teradata table',
        locationFields: [
          { key: 'database', label: 'Database', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Table', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
  {
    type: 'SapHana',
    name: 'SAP HANA',
    directQueryCapable: true,
    category: 'database',
    icon: 'DatabaseRegular',
    description: 'SAP HANA database. Copy source only, through a self-hosted IR.',
    commonFields: [
      { key: 'server', label: 'Server', kind: 'text', required: true, placeholder: 'hana.contoso.local:30015', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'Basic (user + password)',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'connectionString',
        label: 'Connection string',
        fields: [
          { key: 'connectionString', label: 'Connection string', kind: 'password', required: true, secret: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'SapHanaTable',
        name: 'SAP HANA table',
        locationFields: [
          { key: 'schema', label: 'Schema', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Table', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
  {
    type: 'GoogleBigQueryV2',
    name: 'Google BigQuery',
    directQueryCapable: true,
    category: 'database',
    icon: 'DataTrendingRegular',
    description: 'Google BigQuery V2 connector. User (OAuth refresh token) or service-account (key file) auth.',
    commonFields: [
      { key: 'projectId', label: 'Project ID', kind: 'text', required: true, supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'oauth2',
        label: 'User authentication (OAuth)',
        fields: [
          { key: 'clientId', label: 'Client ID', kind: 'text', required: true, supportsDynamic: true },
          { key: 'clientSecret', label: 'Client secret', kind: 'password', required: true, secret: true },
          { key: 'refreshToken', label: 'Refresh token', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'key',
        label: 'Service authentication (key file)',
        fields: [
          { key: 'keyFileContent', label: 'Key file (JSON)', kind: 'multiline', required: true, secret: true, hint: 'The service-account .json key file content.' },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'GoogleBigQueryV2Object',
        name: 'BigQuery object',
        locationFields: [
          { key: 'dataset', label: 'Dataset', kind: 'text', supportsDynamic: true },
          { key: 'table', label: 'Table', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },

  // ----------------------------------------------------------------- File ----
  {
    type: 'AmazonS3',
    name: 'Amazon S3',
    category: 'file',
    icon: 'CloudRegular',
    description: 'Amazon Simple Storage Service. Access-key or temporary-security-credentials auth.',
    commonFields: [
      { key: 'serviceUrl', label: 'Service URL', kind: 'text', placeholder: 'https://s3.amazonaws.com', hint: 'Override only for a custom endpoint / http.', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'accessKey',
        label: 'Access key',
        fields: [
          { key: 'accessKeyId', label: 'Access key ID', kind: 'text', required: true, supportsDynamic: true },
          { key: 'secretAccessKey', label: 'Secret access key', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'accessKey',
        label: 'Temporary security credentials',
        fields: [
          { key: 'accessKeyId', label: 'Access key ID', kind: 'text', required: true, supportsDynamic: true },
          { key: 'secretAccessKey', label: 'Secret access key', kind: 'password', required: true, secret: true },
          { key: 'sessionToken', label: 'Session token', kind: 'password', required: true, secret: true, hint: 'AWS STS temporary token.' },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'DelimitedText',
        name: 'Delimited text (CSV)',
        locationFields: [
          { key: 'bucketName', label: 'Bucket', kind: 'text', required: true, supportsDynamic: true },
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Parquet',
        name: 'Parquet',
        locationFields: [
          { key: 'bucketName', label: 'Bucket', kind: 'text', required: true, supportsDynamic: true },
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
  {
    type: 'FileServer',
    name: 'File system',
    category: 'file',
    icon: 'FolderRegular',
    description: 'On-premises / network file system (UNC). Runs through a self-hosted IR.',
    commonFields: [
      { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: '\\\\fileserver\\share', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'User name + password',
        fields: [
          { key: 'userId', label: 'User ID', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      { auth: 'anonymous', label: 'Anonymous', fields: [] },
    ],
    datasetTypes: [
      {
        type: 'DelimitedText',
        name: 'Delimited text (CSV)',
        locationFields: [
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Binary',
        name: 'Binary',
        locationFields: [
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'Ftp',
    name: 'FTP',
    category: 'file',
    icon: 'FolderRegular',
    description: 'FTP server. Copy source only. Basic or anonymous auth.',
    commonFields: [
      { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'ftp.contoso.com', supportsDynamic: true },
      { key: 'port', label: 'Port', kind: 'number', placeholder: '21' },
      { key: 'enableSsl', label: 'Enable SSL (FTPS)', kind: 'boolean' },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'Basic (user + password)',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      { auth: 'anonymous', label: 'Anonymous', fields: [] },
    ],
    datasetTypes: [
      {
        type: 'DelimitedText',
        name: 'Delimited text (CSV)',
        locationFields: [
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Binary',
        name: 'Binary',
        locationFields: [
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
  {
    type: 'Sftp',
    name: 'SFTP',
    category: 'file',
    icon: 'FolderRegular',
    description: 'SSH File Transfer Protocol server. Basic, SSH public-key, or multi-factor auth.',
    commonFields: [
      { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'sftp.contoso.com', supportsDynamic: true },
      { key: 'port', label: 'Port', kind: 'number', placeholder: '22' },
      { key: 'skipHostKeyValidation', label: 'Skip host-key validation', kind: 'boolean' },
      { key: 'hostKeyFingerprint', label: 'Host key fingerprint', kind: 'text', hint: 'Required unless host-key validation is skipped.', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'Basic (user + password)',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'key',
        label: 'SSH public key',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'privateKeyContent', label: 'Private key (base64 OpenSSH)', kind: 'multiline', required: true, secret: true },
          { key: 'passPhrase', label: 'Pass phrase', kind: 'password', secret: true, hint: 'Only if the private key is encrypted.' },
        ],
      },
      {
        auth: 'key',
        label: 'Multi-factor (password + key)',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
          { key: 'privateKeyContent', label: 'Private key (base64 OpenSSH)', kind: 'multiline', required: true, secret: true },
          { key: 'passPhrase', label: 'Pass phrase', kind: 'password', secret: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'DelimitedText',
        name: 'Delimited text (CSV)',
        locationFields: [
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Binary',
        name: 'Binary',
        locationFields: [
          { key: 'folderPath', label: 'Folder path', kind: 'text', supportsDynamic: true },
          { key: 'fileName', label: 'File name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },

  // --------------------------------------------------- Generic protocol ----
  {
    type: 'RestService',
    name: 'REST',
    category: 'generic-protocol',
    icon: 'GlobeRegular',
    description: 'Generic REST endpoint. Anonymous, Basic, AAD service principal, OAuth2 client credential, or managed identity.',
    commonFields: [
      { key: 'url', label: 'Base URL', kind: 'text', required: true, placeholder: 'https://api.contoso.com/v1', supportsDynamic: true },
      { key: 'enableServerCertificateValidation', label: 'Validate server certificate', kind: 'boolean', hint: 'Default true.' },
    ],
    authOptions: [
      { auth: 'anonymous', label: 'Anonymous', fields: [] },
      {
        auth: 'basic',
        label: 'Basic',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'servicePrincipal',
        label: 'AAD service principal',
        fields: [
          { key: 'servicePrincipalId', label: 'Service principal ID (clientId)', kind: 'text', required: true, supportsDynamic: true },
          { key: 'servicePrincipalKey', label: 'Service principal key (clientSecret)', kind: 'password', required: true, secret: true },
          { key: 'tenant', label: 'Tenant', kind: 'text', required: true, supportsDynamic: true },
          { key: 'aadResourceId', label: 'AAD resource ID', kind: 'text', required: true, placeholder: 'https://management.core.windows.net', supportsDynamic: true },
          AZURE_CLOUD_TYPE,
        ],
      },
      {
        auth: 'oauth2',
        label: 'OAuth2 client credential',
        fields: [
          { key: 'tokenEndpoint', label: 'Token endpoint', kind: 'text', required: true, supportsDynamic: true },
          { key: 'clientId', label: 'Client ID', kind: 'text', required: true, supportsDynamic: true },
          { key: 'clientSecret', label: 'Client secret', kind: 'password', required: true, secret: true },
          { key: 'scope', label: 'Scope', kind: 'text', supportsDynamic: true },
          { key: 'resource', label: 'Resource', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        auth: 'managedIdentity',
        label: 'Managed identity',
        fields: [
          { key: 'aadResourceId', label: 'AAD resource ID', kind: 'text', required: true, placeholder: 'https://management.core.windows.net', supportsDynamic: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'RestResource',
        name: 'REST resource',
        locationFields: [
          { key: 'relativeUrl', label: 'Relative URL', kind: 'text', hint: 'Appended to the linked-service base URL.', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'OData',
    name: 'OData',
    category: 'generic-protocol',
    icon: 'GlobeRegular',
    description: 'Generic OData service. Anonymous, Basic, Windows, AAD service principal, or managed identity.',
    commonFields: [
      { key: 'url', label: 'Service URL', kind: 'text', required: true, placeholder: 'https://services.odata.org/v4/Northwind', supportsDynamic: true },
    ],
    authOptions: [
      { auth: 'anonymous', label: 'Anonymous', fields: [] },
      {
        auth: 'basic',
        label: 'Basic',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'basic',
        label: 'Windows',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'servicePrincipal',
        label: 'AAD service principal',
        fields: [
          SP_ID,
          {
            key: 'aadServicePrincipalCredentialType',
            label: 'Credential type',
            kind: 'select',
            required: true,
            options: [
              { value: 'ServicePrincipalKey', label: 'Key / secret' },
              { value: 'ServicePrincipalCert', label: 'Certificate' },
            ],
          },
          { key: 'servicePrincipalKey', label: 'Service principal key', kind: 'password', secret: true, showIf: { key: 'aadServicePrincipalCredentialType', equals: 'ServicePrincipalKey' } },
          { key: 'servicePrincipalEmbeddedCert', label: 'Service principal certificate', kind: 'password', secret: true, showIf: { key: 'aadServicePrincipalCredentialType', equals: 'ServicePrincipalCert' } },
          SP_TENANT,
          { key: 'aadResourceId', label: 'AAD resource ID', kind: 'text', required: true, supportsDynamic: true },
          AZURE_CLOUD_TYPE,
        ],
      },
      { auth: 'managedIdentity', label: 'Managed identity', fields: [] },
    ],
    datasetTypes: [
      {
        type: 'ODataResource',
        name: 'OData resource',
        locationFields: [
          { key: 'path', label: 'Entity path', kind: 'text', hint: 'OData entity set / path.', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
  {
    type: 'HttpServer',
    name: 'HTTP',
    category: 'generic-protocol',
    icon: 'GlobeRegular',
    description: 'Generic HTTP endpoint (file/page download). Anonymous, Basic, Digest, Windows, or client-certificate auth.',
    commonFields: [
      { key: 'url', label: 'Base URL', kind: 'text', required: true, placeholder: 'https://contoso.com/files', supportsDynamic: true },
      { key: 'enableServerCertificateValidation', label: 'Validate server certificate', kind: 'boolean' },
    ],
    authOptions: [
      { auth: 'anonymous', label: 'Anonymous', fields: [] },
      {
        auth: 'basic',
        label: 'Basic',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'basic',
        label: 'Digest',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'basic',
        label: 'Windows',
        fields: [
          { key: 'userName', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'key',
        label: 'Client certificate',
        fields: [
          { key: 'embeddedCertData', label: 'Certificate (base64 PFX)', kind: 'multiline', required: true, secret: true },
          { key: 'password', label: 'Certificate password', kind: 'password', secret: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'DelimitedText',
        name: 'Delimited text (CSV) over HTTP',
        locationFields: [
          { key: 'relativeUrl', label: 'Relative URL', kind: 'text', supportsDynamic: true },
        ],
      },
      {
        type: 'Binary',
        name: 'Binary over HTTP',
        locationFields: [
          { key: 'relativeUrl', label: 'Relative URL', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },

  // ------------------------------------------------------ Services & apps ----
  {
    type: 'Salesforce',
    name: 'Salesforce',
    category: 'services-and-apps',
    icon: 'CloudRegular',
    description: 'Salesforce (SOAP/Bulk API). User name + password + security token.',
    commonFields: [
      { key: 'environmentUrl', label: 'Environment URL', kind: 'text', placeholder: 'https://login.salesforce.com (or test.salesforce.com for sandbox)', supportsDynamic: true },
      { key: 'apiVersion', label: 'API version', kind: 'text', placeholder: '53.0', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'User name + password + token',
        fields: [
          { key: 'username', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
          { key: 'securityToken', label: 'Security token', kind: 'password', secret: true, hint: 'Salesforce security token appended to the password.' },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'SalesforceObject',
        name: 'Salesforce object',
        locationFields: [
          { key: 'objectApiName', label: 'Object API name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'CommonDataServiceForApps',
    name: 'Dynamics 365 / Dataverse',
    category: 'services-and-apps',
    icon: 'AppsRegular',
    description: 'Microsoft Dataverse (Common Data Service) / Dynamics 365. Office365 user or AAD service-principal / managed-identity auth.',
    commonFields: [
      {
        key: 'deploymentType',
        label: 'Deployment type',
        kind: 'select',
        required: true,
        options: [
          { value: 'Online', label: 'Online' },
          { value: 'OnPremisesWithIfd', label: 'On-premises (IFD)' },
        ],
      },
      { key: 'serviceUri', label: 'Service URL', kind: 'text', placeholder: 'https://org.crm.dynamics.com', hint: 'Required for Online.', showIf: { key: 'deploymentType', equals: 'Online' }, supportsDynamic: true },
      { key: 'organizationName', label: 'Organization name', kind: 'text', supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'basic',
        label: 'Office 365 (user)',
        fields: [
          { key: 'username', label: 'User name', kind: 'text', required: true, supportsDynamic: true },
          { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        ],
      },
      {
        auth: 'servicePrincipal',
        label: 'AAD service principal',
        fields: [
          SP_ID,
          {
            key: 'servicePrincipalCredentialType',
            label: 'Credential type',
            kind: 'select',
            required: true,
            options: [
              { value: 'ServicePrincipalKey', label: 'Key / secret' },
              { value: 'ServicePrincipalCert', label: 'Certificate (Key Vault)' },
            ],
          },
          { key: 'servicePrincipalCredential', label: 'Service principal credential', kind: 'password', required: true, secret: true },
        ],
      },
      { auth: 'managedIdentity', label: 'Managed identity', fields: [] },
    ],
    datasetTypes: [
      {
        type: 'CommonDataServiceForAppsEntity',
        name: 'Dataverse table (entity)',
        locationFields: [
          { key: 'entityName', label: 'Entity (table) logical name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: true,
  },
  {
    type: 'SharePointOnlineList',
    name: 'SharePoint Online list',
    category: 'services-and-apps',
    icon: 'DocumentRegular',
    description: 'SharePoint Online list via an AAD service principal granted Sites.Read.All. Copy source only.',
    commonFields: [
      { key: 'siteUrl', label: 'Site URL', kind: 'text', required: true, placeholder: 'https://contoso.sharepoint.com/sites/Team', supportsDynamic: true },
      { key: 'tenantId', label: 'Tenant ID', kind: 'text', required: true, supportsDynamic: true },
    ],
    authOptions: [
      {
        auth: 'servicePrincipal',
        label: 'AAD service principal',
        fields: [
          { key: 'servicePrincipalId', label: 'Service principal ID', kind: 'text', required: true, supportsDynamic: true },
          { key: 'servicePrincipalKey', label: 'Service principal key', kind: 'password', required: true, secret: true },
        ],
      },
    ],
    datasetTypes: [
      {
        type: 'SharePointOnlineListResource',
        name: 'SharePoint list',
        locationFields: [
          { key: 'listName', label: 'List name', kind: 'text', supportsDynamic: true },
        ],
      },
    ],
    supportsSource: true,
    supportsSink: false,
  },
];

// =============================================================================
// Lookup helper.
// =============================================================================

/** Look up a connector definition by its ADF linkedService `type`. */
export function connectorByType(type: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.type === type);
}

/**
 * Whether a connector type supports a live DirectQuery execution path in the
 * report storage-mode picker. Backed by `ConnectorDef.directQueryCapable` (the
 * single source of truth set on each connector — no divergent list to keep in
 * sync). SQL-family / Azure Data Explorer / Databricks Delta Lake → `true`
 * (DirectQuery + Import + Dual, and Direct Lake when the object is Delta-backed);
 * File / Blob / Cosmos / generic-protocol / SaaS → `false` (Import-only, plus
 * Direct Lake for Delta objects). Unknown / unregistered types → `false`.
 *
 * Keyed on the ADF connector `type` ('AzureSqlDatabase', …). NOTE: the report
 * storage-mode pane does NOT call this — `lib/editors/report/storage-mode-pane.tsx`
 * is a `'use client'` module that derives the same `directQueryCapable` signal
 * from the report's `ReportConnType` ('azure-sql', 'synapse-dedicated', 'adx', …)
 * via its own `DIRECT_QUERY_CONN_TYPES` set, a different id space than this ADF
 * `type`. This function is the server-side reading of the flag for callers that
 * already hold an ADF connector `type` (the linked-service / Get-data path);
 * both paths ultimately feed `allowedStorageModes` the same capability boolean.
 */
export function connectorDirectQueryCapable(type: string): boolean {
  return connectorByType(type)?.directQueryCapable === true;
}

/** All connectors in a category (for the catalog's category groupings). */
export function connectorsByCategory(category: ConnectorDef['category']): ConnectorDef[] {
  return CONNECTORS.filter((c) => c.category === category);
}

/** Total number of connectors implemented with full config metadata. */
export const CONNECTOR_COUNT = CONNECTORS.length;
