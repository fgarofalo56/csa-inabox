/**
 * Azure Analysis Services (AAS) data-plane client — Loom-native default for
 * the Report editor (LOOM_BI_BACKEND unset).
 *
 * This is the Azure-native report renderer backend (no Power BI / Fabric
 * workspace required, per no-fabric-dependency.md). The Report editor queries
 * the bound AAS tabular model with DAX and renders the result rows.
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential,
 * chained with DefaultAzureCredential for local dev — identical to
 * kusto-client / monitor-client.
 *
 * Token scope: `https://*.asazure.windows.net` (Commercial / GCC)
 *              `https://*.asazure.usgovcloudapi.net` (GCC-High / IL5 / DoD)
 * IMPORTANT: the `*` in the scope string is a LITERAL CHARACTER, not a
 * wildcard. Using a real subdomain (e.g. https://eastus2.asazure.windows.net)
 * causes authentication failure. Ref: Microsoft Learn "Asynchronous refresh
 * with the REST API" — Authentication section.
 *
 * Auth requirement: the Console UAMI service principal must be added as a
 * server admin on the AAS instance (ARM `--admin-users` or SSMS/PowerShell).
 * Database-role membership alone is insufficient for the REST query endpoint.
 *
 * Endpoint:
 *   POST https://{region}.asazure.windows.net/servers/{server}/models/{db}/query
 *   Body: { queries: [{ query: string }], serializerSettings: { includeNulls: true } }
 *   Response: { results: [{ tables: [{ rows: [{...}] }] }] }
 *
 * Sovereign cloud support: aasSuffix()/aasScope() derive from isGovCloud(),
 * so Commercial/GCC use asazure.windows.net and GCC-High/IL5/DoD use
 * asazure.usgovcloudapi.net with no extra config.
 *
 * No mocks. All errors surface as AasError with the AAS HTTP status.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { aasScope, aasModelUrl } from './cloud-endpoints';
import {
  type AasRow,
  type AasTable,
  type AasQueryResult,
  resolveAasBinding,
  buildDaxFromVisual,
  flattenAasRows,
} from './aas-dax';

// Re-export the pure helpers so existing call sites can keep importing from
// aas-client. The pure logic lives in aas-dax (no @azure/identity) so it stays
// unit-testable without the credential chain.
export {
  resolveAasBinding,
  buildDaxFromVisual,
  flattenAasRows,
};
export type { AasRow, AasTable, AasQueryResult };

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class AasError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

async function getAasToken(): Promise<string> {
  const scope = aasScope();
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for AAS (scope: ${scope})`, 401);
  return t.token;
}

/**
 * Execute a DAX query against an AAS model and return the raw result envelope.
 *
 * @param region     - Azure region of the AAS server (e.g. "eastus2")
 * @param serverName - Short server name (e.g. "my-server")
 * @param database   - Model / database name (e.g. "AdventureWorks")
 * @param daxQuery   - DAX query string (EVALUATE expression)
 */
export async function executeAasQuery(
  region: string,
  serverName: string,
  database: string,
  daxQuery: string,
): Promise<AasQueryResult> {
  const token = await getAasToken();
  const url = `${aasModelUrl(region, serverName, database)}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      queries: [{ query: daxQuery }],
      serializerSettings: { includeNulls: true },
    }),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (
      json?.error?.message ||
      json?.message ||
      text ||
      'AAS query failed'
    ).toString();
    throw new AasError(msg, res.status, json || text, url);
  }
  return (json as AasQueryResult) ?? { results: [] };
}
