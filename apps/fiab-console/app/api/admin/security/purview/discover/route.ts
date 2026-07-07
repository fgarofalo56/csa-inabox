/**
 * GET /api/admin/security/purview/discover
 * ----------------------------------------
 * Auto-populate the "Register source" wizard with EVERY Loom / Azure-estate
 * resource that Microsoft Purview can register as a Data Map data source —
 * ADLS Gen2 + Blob storage, Azure SQL servers, Synapse workspaces, Azure Data
 * Explorer (Kusto) clusters, Cosmos DB accounts, and PostgreSQL servers — across
 * every subscription the Loom identity can read, in ONE multi-type Azure
 * Resource Graph query. NO freeform typing: the wizard picks from this list.
 *
 *   POST {ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01
 *
 * Each row is mapped to a ready-to-register {@link DiscoveredPurviewSource} with
 * the correct Purview `kind` + a sovereign-correct `properties` body (endpoint
 * fields built from cloud-endpoints suffix helpers, so GCC / GCC-High / IL5 get
 * the right hostnames). Storage accounts split by `isHnsEnabled`: HNS → AdlsGen2,
 * flat → AzureStorage (blob).
 *
 * Auth: tenant-admin session. ARM token via the ACA-first UAMI credential chain
 * (arm-credential). If the UAMI can't reach ARG / has no Reader, the route
 * returns an HONEST gate (code: 'no_access', 200) naming the exact Reader grant
 * — never a mock list (no-vaporware.md). NO Fabric dependency
 * (no-fabric-dependency.md) — every kind is an Azure-native backend.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiServerError } from '@/lib/api/respond';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  armBase, armScope,
  dfsSuffix, getBlobSuffix, getSqlSuffix, synapseSqlSuffix,
  kustoSuffix, cosmosSuffix,
} from '@/lib/azure/cloud-endpoints';
import {
  PURVIEW_DISCOVERY_ARM_TYPES, toPurviewSourceName,
  type DiscoveredPurviewSource,
} from '@/lib/azure/purview-source-mapping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ARM_SCOPE = armScope();
const ARG_URL = `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`;

interface ArgRow {
  id: string;
  name: string;
  type: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  subName?: string;
  host?: string;
  isHns?: string;
}

function sanitize(s: string): string {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/** Single multi-type ARG query; leftouter-join attaches the subscription name. */
function buildQuery(): string {
  const types = PURVIEW_DISCOVERY_ARM_TYPES.map((t) => `'${t}'`).join(',');
  return [
    'resources',
    `| where type in~ (${types})`,
    // Coalesce the most-specific endpoint field per type (SQL/PG fqdn, Kusto
    // cluster uri, Cosmos documentEndpoint, Storage dfs primaryEndpoint).
    '| extend host = tostring(coalesce(',
    '    properties.fullyQualifiedDomainName,',
    '    properties.uri,',
    '    properties.documentEndpoint,',
    '    properties.primaryEndpoints.dfs,',
    "    ''))",
    '| extend isHns = tostring(properties.isHnsEnabled)',
    '| join kind=leftouter (',
    '    ResourceContainers',
    "    | where type =~ 'microsoft.resources/subscriptions'",
    '    | project subscriptionId, subName = name',
    '  ) on subscriptionId',
    '| project id, name, type, location, resourceGroup, subscriptionId, subName, host, isHns',
    '| order by name asc',
  ].join('\n');
}

async function runArg(
  token: string,
): Promise<{ ok: true; rows: ArgRow[] } | { ok: false; status: number; error: string }> {
  const query = buildQuery();
  const rows: ArgRow[] = [];
  let skipToken: string | undefined;
  let guard = 0;
  do {
    const options: Record<string, unknown> = { resultFormat: 'objectArray', $top: 1000 };
    if (skipToken) options.$skipToken = skipToken;
    let res: Response;
    try {
      res = await fetchWithTimeout(ARG_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, options }),
        cache: 'no-store',
      });
    } catch (e: any) {
      return { ok: false, status: 502, error: sanitize(e?.message || String(e)) };
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j?.error?.message || j?.error?.code || text; } catch { /* non-JSON */ }
      return { ok: false, status: res.status, error: sanitize(msg) };
    }
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { return { ok: false, status: 502, error: 'Resource Graph returned a non-JSON body' }; }
    if (Array.isArray(body?.data)) rows.push(...body.data);
    skipToken = typeof body?.$skipToken === 'string' ? body.$skipToken : undefined;
  } while (skipToken && guard++ < 50);
  return { ok: true, rows };
}

/** Bare host from an ARG endpoint (strip scheme / :443 / trailing slash). */
function bareHost(raw: string | undefined): string {
  return (raw || '')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/:443\/?$/, '')
    .replace(/\/+$/, '')
    .trim();
}

/**
 * Map one ARG row to a ready-to-register Purview source descriptor, building the
 * kind-specific `properties` (endpoint + ARM coordinates) with sovereign-correct
 * suffix helpers. Returns null for a type Purview can't register.
 */
function toDiscovered(row: ArgRow): DiscoveredPurviewSource | null {
  const t = (row.type || '').toLowerCase();
  const name = row.name || '';
  const rg = row.resourceGroup || '';
  const loc = row.location || '';
  const sub = row.subscriptionId || '';
  const coords = { resourceId: row.id, resourceGroup: rg, location: loc, resourceName: name };

  let kind = '';
  let label = '';
  let tileSlug = '';
  let endpoint = '';
  const props: Record<string, unknown> = { ...coords };

  switch (t) {
    case 'microsoft.storage/storageaccounts': {
      const hns = (row.isHns || '').toLowerCase() === 'true';
      if (hns) {
        kind = 'AdlsGen2'; label = 'Azure Data Lake Storage Gen2'; tileSlug = 'storage-adls';
        endpoint = `https://${name}.${dfsSuffix()}/`;
      } else {
        kind = 'AzureStorage'; label = 'Azure Blob Storage'; tileSlug = 'storage-adls';
        endpoint = `https://${name}.${getBlobSuffix()}/`;
      }
      props.endpoint = endpoint;
      break;
    }
    case 'microsoft.sql/servers': {
      kind = 'AzureSqlDatabase'; label = 'Azure SQL Database'; tileSlug = 'azure-sql-database';
      endpoint = bareHost(row.host) || `${name}.${getSqlSuffix()}`;
      props.serverEndpoint = endpoint;
      break;
    }
    case 'microsoft.synapse/workspaces': {
      kind = 'AzureSynapseWorkspace'; label = 'Azure Synapse Analytics'; tileSlug = 'synapse-serverless-sql-pool';
      const serverless = `${name}-ondemand.${synapseSqlSuffix()}`;
      const dedicated = `${name}.${synapseSqlSuffix()}`;
      endpoint = serverless;
      props.serverlessSqlEndpoint = serverless;
      props.dedicatedSqlEndpoint = dedicated;
      break;
    }
    case 'microsoft.kusto/clusters': {
      kind = 'AzureDataExplorer'; label = 'Azure Data Explorer (Kusto)'; tileSlug = 'kql-database';
      const host = bareHost(row.host);
      endpoint = host ? `https://${host}` : `https://${name}.${loc}.${kustoSuffix()}`;
      props.endpoint = endpoint;
      break;
    }
    case 'microsoft.documentdb/databaseaccounts': {
      kind = 'AzureCosmosDb'; label = 'Azure Cosmos DB (NoSQL)'; tileSlug = 'cosmos-account';
      const host = bareHost(row.host) || `${name}.${cosmosSuffix()}`;
      endpoint = `https://${host}:443/`;
      props.accountUri = endpoint;
      break;
    }
    case 'microsoft.dbforpostgresql/flexibleservers':
    case 'microsoft.dbforpostgresql/servers': {
      kind = 'AzurePostgreSql'; label = 'Azure Database for PostgreSQL'; tileSlug = 'postgres';
      // Postgres has no cloud-endpoints suffix helper; rely on the ARG-projected
      // FQDN (present on both Flexible and Single servers). Skip if absent so we
      // never emit a wrong-cloud hostname (honest omission over a bad guess).
      const host = bareHost(row.host);
      if (!host) return null;
      endpoint = host;
      props.serverEndpoint = endpoint;
      break;
    }
    default:
      return null;
  }

  return {
    armResourceId: row.id,
    suggestedName: toPurviewSourceName(name),
    kind,
    label,
    tileSlug,
    endpoint,
    properties: props,
    subscriptionId: sub,
    subscriptionName: row.subName || undefined,
    resourceGroup: rg,
    location: loc,
  };
}

const GATE_MESSAGE =
  'No registerable Azure data sources were returned across the subscriptions visible to Loom. ' +
  'Grant the Loom user-assigned managed identity (LOOM_UAMI_CLIENT_ID) the built-in "Reader" role ' +
  'at the tenant root management group (or on each subscription whose storage / SQL / Synapse / ADX / ' +
  'Cosmos / PostgreSQL resources you want to register), then retry. You can still register a source ' +
  'manually via the "Custom source" path.';

export async function GET() {
  const s = getSession();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  try {
    const tok = await uamiArmCredential().getToken(ARM_SCOPE);
    const token = tok?.token;
    if (!token) {
      return NextResponse.json(
        { ok: false, code: 'no_access', error: GATE_MESSAGE, sources: [] },
        { status: 200 },
      );
    }
    const r = await runArg(token);
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, code: 'no_access', error: `${GATE_MESSAGE} (Resource Graph error: ${r.error})`, sources: [] },
        { status: 200 },
      );
    }
    const sources = r.rows
      .map(toDiscovered)
      .filter((d): d is DiscoveredPurviewSource => d !== null);
    return NextResponse.json({ ok: true, sources, count: sources.length });
  } catch (e) {
    return apiServerError(e, 'Failed to discover data sources', 'discover_failed');
  }
}
