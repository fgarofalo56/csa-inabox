/**
 * purview-source-map — the pure mapping layer that turns a Loom Connection /
 * "Add existing" ARG-discovered resource into a Microsoft Purview CLASSIC Data
 * Map **scan source** (kind + properties + display endpoint).
 *
 * This mirrors the resource→ConnectionType mapping in `connectable-types.ts`
 * (which powers /connections "Add existing"), but targets the Purview scanning
 * data plane instead of a Loom Connection. Both the cross-subscription register
 * route (`app/api/governance/scans/register-existing`) and the Connections →
 * Purview best-effort hook (`connections-store.ts`) consume it, so the
 * abfss/ADLS→AdlsGen2, Azure-SQL-FQDN→AzureSqlDatabase, Synapse, Cosmos,
 * PostgreSQL, ADX, Databricks/UC mapping lives in exactly ONE place.
 *
 * Source kinds are grounded in the Purview "Register sources" gallery + the
 * scanning data-plane REST shape (PUT /scan/datasources/{name} with
 * { kind, properties }) — see
 * https://learn.microsoft.com/rest/api/purview/scanningdataplane/data-sources.
 *
 * Server-only: it imports `cloud-endpoints` to derive sovereign-correct
 * endpoints (dfs / documents / database / synapse suffixes), so it must NOT be
 * imported by a client component.
 */
import type { ConnectionType } from './connections-store';
import {
  dfsUrl, cosmosEndpointFromName, getSqlSuffix, synapseSqlSuffix,
} from './cloud-endpoints';

/** Non-secret coordinates we can pin onto a Purview source registration. */
export interface PurviewSourceInput {
  /** Loom connection type (drives the kind mapping). */
  connType: ConnectionType;
  /** Bare host FQDN or storage account NAME (as connectables/connections store it). */
  host?: string;
  database?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  location?: string;
  /** Short resource name (account / server / workspace) when known. */
  resourceName?: string;
  /** Databricks UC metastore id — REQUIRED for the AzureDatabricksUnityCatalog kind. */
  metastoreId?: string;
}

/** A successful mapping → a Purview scan source registration body. */
export interface PurviewSourceMapped {
  kind: string;
  /** Human/display endpoint (also stored on the Loom source row). */
  endpoint: string;
  /** properties bag passed verbatim to registerDataSource(). */
  properties: Record<string, unknown>;
  /** Default System scan ruleset name for this kind (== kind for built-ins). */
  scanRulesetName: string;
}

/** A connection type Purview's Data Map cannot scan (EH / SB / Key Vault). */
export interface PurviewSourceUnsupported {
  unsupported: true;
  reason: string;
}

export function isUnsupportedPurviewSource(
  x: PurviewSourceMapped | PurviewSourceUnsupported,
): x is PurviewSourceUnsupported {
  return (x as PurviewSourceUnsupported).unsupported === true;
}

/** Strip scheme / trailing slash so we can re-wrap a host consistently. */
function bareHost(raw: string | undefined | null): string {
  return (raw || '').replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').trim();
}

/** Wrap a bare host as an https URL (idempotent if already a URL). */
function asHttps(raw: string | undefined | null): string {
  const h = (raw || '').trim();
  if (!h) return '';
  return /^[a-z]+:\/\//i.test(h) ? h : `https://${h}`;
}

/** Leading dns label of an FQDN (e.g. `srv.database.windows.net` → `srv`). */
function firstLabel(fqdn: string): string {
  return bareHost(fqdn).split('.')[0] || '';
}

/**
 * Map a connectable resource / connection to a Purview scan source. Returns
 * either a `{ kind, endpoint, properties, scanRulesetName }` registration body
 * or `{ unsupported, reason }` for connection types Purview's Data Map does not
 * scan (Event Hubs, Service Bus, Key Vault — messaging / secret stores).
 */
export function purviewSourceForConnectable(
  input: PurviewSourceInput,
): PurviewSourceMapped | PurviewSourceUnsupported {
  const arm: Record<string, unknown> = {};
  if (input.subscriptionId) arm.subscriptionId = input.subscriptionId;
  if (input.resourceGroup) arm.resourceGroup = input.resourceGroup;
  if (input.location) arm.location = input.location;

  switch (input.connType) {
    case 'storage-adls': {
      // connectables store storage as the bare ACCOUNT name; reconstruct the
      // sovereign dfs endpoint Purview wants (or honour a full URL if passed).
      const acct = input.resourceName || firstLabel(input.host || '') || bareHost(input.host);
      const endpoint = bareHost(input.host).includes('.') ? asHttps(input.host) : dfsUrl(acct);
      return {
        kind: 'AdlsGen2',
        endpoint,
        properties: { endpoint, resourceName: acct, ...arm },
        scanRulesetName: 'AdlsGen2',
      };
    }

    case 'azure-sql':
    case 'generic-sql': {
      // host = <server>.<sqlSuffix>; SQL DB sources register at server grain.
      const serverEndpoint = bareHost(input.host) || `${input.resourceName || ''}.${getSqlSuffix()}`;
      const serverName = input.resourceName || firstLabel(serverEndpoint);
      return {
        kind: 'AzureSqlDatabase',
        endpoint: serverEndpoint,
        properties: { serverEndpoint, resourceName: serverName, ...arm },
        scanRulesetName: 'AzureSqlDatabase',
      };
    }

    case 'synapse-serverless':
    case 'synapse-dedicated': {
      // host = <ws>-ondemand.<synapseSqlSuffix> (serverless) — derive the
      // workspace name + both SQL endpoints Purview's Synapse connector expects.
      const serverless = bareHost(input.host);
      const ws = input.resourceName || serverless.replace(/-ondemand\..*$/i, '').replace(/\..*$/, '');
      const serverlessSqlEndpoint = serverless || `${ws}-ondemand.${synapseSqlSuffix()}`;
      const dedicatedSqlEndpoint = `${ws}.${synapseSqlSuffix()}`;
      return {
        kind: 'AzureSynapseWorkspace',
        endpoint: serverlessSqlEndpoint,
        properties: { serverlessSqlEndpoint, dedicatedSqlEndpoint, resourceName: ws, ...arm },
        scanRulesetName: 'AzureSynapseWorkspace',
      };
    }

    case 'cosmos': {
      const accountUri = bareHost(input.host).includes('.')
        ? asHttps(input.host)
        : cosmosEndpointFromName(input.resourceName || bareHost(input.host));
      return {
        kind: 'AzureCosmosDb',
        endpoint: accountUri,
        properties: { accountUri, resourceName: input.resourceName || firstLabel(accountUri), ...arm },
        scanRulesetName: 'AzureCosmosDb',
      };
    }

    case 'postgres': {
      const serverEndpoint = bareHost(input.host);
      return {
        kind: 'AzurePostgreSql',
        endpoint: serverEndpoint,
        properties: { serverEndpoint, resourceName: input.resourceName || firstLabel(serverEndpoint), ...arm },
        scanRulesetName: 'AzurePostgreSql',
      };
    }

    case 'adx': {
      const endpoint = asHttps(input.host);
      return {
        kind: 'AzureDataExplorer',
        endpoint,
        properties: { endpoint, resourceName: input.resourceName || firstLabel(endpoint), ...arm },
        scanRulesetName: 'AzureDataExplorer',
      };
    }

    case 'databricks-sql': {
      // The UC connector keys off the metastore id (not the workspace URL).
      // Without it we cannot form a valid source — honest, actionable gate.
      if (!input.metastoreId) {
        return {
          unsupported: true,
          reason:
            'Registering an Azure Databricks Unity Catalog source in Purview needs the workspace’s UC ' +
            'metastore id. Register it from Catalog → Metastores (which discovers the metastore id and ' +
            'wires the MI-first scan), not from this cross-subscription browser.',
        };
      }
      const properties: Record<string, unknown> = { metastoreId: input.metastoreId, ...arm };
      return {
        kind: 'AzureDatabricksUnityCatalog',
        endpoint: asHttps(input.host),
        properties,
        scanRulesetName: 'AzureDatabricksUnityCatalog',
      };
    }

    case 'event-hub':
    case 'service-bus':
    case 'key-vault':
    default:
      return {
        unsupported: true,
        reason:
          `“${input.connType}” is not a Microsoft Purview Data Map scannable data store. Purview scans ` +
          'data stores (ADLS Gen2, Azure SQL, Synapse, Cosmos DB, PostgreSQL, Azure Data Explorer, and ' +
          'Databricks Unity Catalog) — not messaging namespaces or secret vaults. ' +
          'Import it as a Loom Connection instead.',
      };
  }
}
