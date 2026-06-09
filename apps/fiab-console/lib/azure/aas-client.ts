/**
 * Azure Analysis Services (AAS) XMLA data-plane client — the Azure-native DAX
 * execution backend for Loom dashboard "Q&A" / pinned-DAX tiles.
 *
 * Per no-fabric-dependency.md: a Power BI / Fabric semantic model is NOT
 * required to run a DAX tile. When `LOOM_SEMANTIC_BACKEND=analysis-services`
 * the dashboard tile-query route executes DAX against an Azure Analysis
 * Services tabular model over the XMLA HTTP endpoint — a pure-Azure host
 * (`*.asazure.windows.net` / `*.asazure.usgovcloudapi.net`), never a Fabric
 * host. The Console UAMI authenticates with the `aasScope()` bearer token.
 *
 * Per no-vaporware.md: this is a real SOAP/XMLA `Execute` round-trip — no mock
 * rows. The pure XMLA helpers (URL build, envelope, rowset parse, config gate)
 * live in `aas-xmla.ts` (no Azure SDK import, unit-testable); this module adds
 * the credentialed `executeDax`.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { aasScope } from './cloud-endpoints';
import {
  AAS_MAX_ROWS,
  AasError,
  buildAasXmlaUrl,
  buildExecuteEnvelope,
  decodeXmlEntities,
  parseRowset,
  type AasQueryResult,
} from './aas-xmla';

// Re-export the pure surface so existing imports of these from `aas-client`
// keep working.
export {
  AasError,
  aasConfigGate,
  resolveAasTarget,
  buildAasXmlaUrl,
  parseRowset,
  type AasQueryResult,
} from './aas-xmla';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aasToken(): Promise<string> {
  const t = await credential.getToken(aasScope());
  if (!t?.token) throw new AasError('Failed to acquire AAS token', 401);
  return t.token;
}

/**
 * Execute a DAX query (an `EVALUATE` statement) against the AAS tabular model
 * over the XMLA HTTP endpoint and return tabular columns + rows.
 */
export async function executeDax(server: string, model: string, dax: string): Promise<AasQueryResult> {
  const started = Date.now();
  const url = buildAasXmlaUrl(server);
  const token = await aasToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: buildExecuteEnvelope(model, dax),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 600);
    const m = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(text);
    if (m) detail = decodeXmlEntities(m[1]);
    throw new AasError(`AAS XMLA ${res.status}: ${detail}`, res.status, text.slice(0, 600));
  }
  const { columns, rows } = parseRowset(text);
  const truncated = rows.length > AAS_MAX_ROWS;
  return {
    columns,
    rows: truncated ? rows.slice(0, AAS_MAX_ROWS) : rows,
    rowCount: rows.length,
    executionMs: Date.now() - started,
    truncated,
  };
}
