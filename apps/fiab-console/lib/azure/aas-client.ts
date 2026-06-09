/**
 * aas-client.ts — authenticated Azure Analysis Services (AAS) XMLA execution.
 *
 * Executes DAX (or MDX) against an AAS tabular model over XMLA-over-HTTPS. This
 * is the OPTIONAL DAX backend the paginated-report renderer routes a dataset to
 * when its RDL DataSource ConnectionString is an `asazure://` URI. AAS is an
 * Azure-native PaaS service (NOT Microsoft Fabric / Power BI), so it is a
 * compliant Azure-native backend per no-fabric-dependency.md. When no AAS source
 * is referenced the renderer uses Synapse SQL (the default) and this client is
 * never touched.
 *
 * Pure URL/connection-string/XMLA helpers live in `aas-xmla.ts` (re-exported
 * here) so they are testable without the credential chain. Auth: the Console
 * UAMI via ManagedIdentityCredential chained with DefaultAzureCredential.
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import {
  aasEndpointUrl, aasTokenScope, buildXmlaExecute, parseXmlaRowset, type AasTarget,
} from './aas-xmla';

export {
  parseAasConnectionString, aasEndpointUrl, aasTokenScope, buildXmlaExecute, parseXmlaRowset,
  type AasTarget,
} from './aas-xmla';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class AasError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AasError';
    this.status = status;
  }
}

export interface AasQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
}

/** Execute a DAX/MDX statement against an AAS tabular model via XMLA. */
export async function executeDaxQuery(target: AasTarget, statement: string): Promise<AasQueryResult> {
  const started = Date.now();
  if (!target.database) throw new AasError('AAS target is missing a database/model name', 400);
  const url = aasEndpointUrl(target);
  const tok = await credential.getToken(aasTokenScope(target));
  if (!tok?.token) throw new AasError('Failed to acquire AAD token for Azure Analysis Services', 401);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok.token}`,
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: buildXmlaExecute(target.database, statement),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new AasError(`AAS XMLA ${res.status}: ${text.slice(0, 400)}`, res.status);
  if (/<(\w+:)?Fault[\s>]/.test(text)) {
    const faultMsg = text.match(/<faultstring>([^<]*)<\/faultstring>/i)?.[1]
      || text.match(/<Error[^>]*Description="([^"]*)"/i)?.[1]
      || 'AAS XMLA query fault';
    throw new AasError(`AAS XMLA fault: ${faultMsg}`, 502);
  }
  const parsed = parseXmlaRowset(text);
  return { columns: parsed.columns, rows: parsed.rows, rowCount: parsed.rows.length, executionMs: Date.now() - started };
}
