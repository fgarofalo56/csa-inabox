/**
 * Azure Analysis Services (AAS) XMLA client — raw SOAP/HTTP against the AAS
 * XMLA endpoint. Supports:
 *   - TMSL DDL commands  (createOrReplace a measure → upsert)
 *   - DAX query execution (EVALUATE statement → tabular rows)
 *
 * Auth: Console UAMI via ManagedIdentityCredential chained with
 * DefaultAzureCredential (local dev). The UAMI must hold the AAS **server
 * administrator** role (granted out-of-band via
 * `az analysis-services server update --admin-users <principal>`).
 *
 * Token audience: EXACTLY `https://*.asazure.windows.net` (Commercial / GCC)
 * or `https://*.asazure.usgovcloudapi.net` (GCC-High / IL5 / DoD). The `*` is a
 * literal subdomain, not a wildcard — any other audience fails auth.
 *   Ref: https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh#authentication
 *
 * XMLA endpoint: the AAS server URL
 *   https://<region>.asazure.windows.net/servers/<serverName>
 * accepts SOAP XMLA `Execute` messages (the same protocol SSMS / Tabular
 * Editor speak under the hood). `LOOM_AAS_XMLA_URL` overrides the POST target
 * for deployments whose gateway exposes the endpoint at a different path.
 * The SOAP `Execute` method wraps a TMSL JSON command or a DAX `EVALUATE`
 * statement in <Command><Statement>; the response is SOAP XML:
 *   - DDL success : empty <return><root/></return>
 *   - fault       : <soap:Fault><faultstring>…</faultstring></soap:Fault>
 *   - DAX result  : <root> with <row> elements (tabular rowset)
 *
 * AAS is an **Azure-native** service (NOT Fabric / Power BI), so it is the
 * sanctioned optional backend for the semantic-model item type per
 * no-fabric-dependency.md. When LOOM_AAS_SERVER is unset every function throws
 * AasError(501) so the BFF route surfaces an honest infra-gate (no mock data,
 * per no-vaporware.md).
 *
 * The network-free core (config readers, envelope, fault/row parsing, TMSL
 * builder) lives in `./aas-tmsl` and is re-exported here for callers.
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { aasScope } from './cloud-endpoints';
import {
  AasError,
  buildSoapEnvelope,
  extractFault,
  parseXmlaRows,
  buildMeasureUpsertTmsl,
  buildMeasureEvalQuery,
  requireXmlaUrl,
  resolveDatabase,
} from './aas-tmsl';

export {
  AasError,
  isAasConfigured,
  aasDefaultDatabase,
  buildSoapEnvelope,
  extractFault,
  parseXmlaRows,
  buildMeasureUpsertTmsl,
} from './aas-tmsl';

let _credential: ChainedTokenCredential | DefaultAzureCredential | null = null;
function getCredential() {
  if (_credential) return _credential;
  const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  _credential = uamiClientId
    ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
    : new DefaultAzureCredential();
  return _credential;
}

async function getToken(): Promise<string> {
  const t = await getCredential().getToken(aasScope());
  if (!t?.token) throw new AasError('Failed to acquire AAS AAD token', 401);
  return t.token;
}

/**
 * POST a SOAP/XMLA Execute to the AAS endpoint and return the raw response
 * text. Throws AasError(501) when unconfigured, or AasError(status) on HTTP
 * error.
 */
async function postXmla(database: string, statement: string): Promise<string> {
  const url = requireXmlaUrl();
  const token = await getToken();
  const soap = buildSoapEnvelope(database, statement);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: soap,
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new AasError(`AAS XMLA HTTP ${res.status}: ${text.slice(0, 400)}`, res.status, text);
  return text;
}

/**
 * Execute a TMSL DDL command (e.g. createOrReplace for a measure). The TMSL
 * object is serialised to JSON and embedded as the XMLA Statement. On an XMLA
 * fault throws AasError(422) with the engine's real error text.
 *   Refs: https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
 */
export async function executeTmsl(database: string, tmslCommand: object): Promise<void> {
  const xml = await postXmla(database, JSON.stringify(tmslCommand));
  const fault = extractFault(xml);
  if (fault) throw new AasError(`XMLA fault: ${fault}`, 422, xml);
}

/**
 * Execute a DAX statement (typically `EVALUATE …`) against the AAS XMLA
 * endpoint and return a flat array of row objects. Throws AasError on HTTP
 * error or XMLA/DAX fault.
 */
export async function executeDaxQuery(
  database: string,
  daxQuery: string,
): Promise<{ rows: Record<string, unknown>[] }> {
  const xml = await postXmla(resolveDatabase(database), daxQuery);
  const fault = extractFault(xml);
  if (fault) throw new AasError(`DAX fault: ${fault}`, 422, xml);
  return { rows: parseXmlaRows(xml) };
}

/** Upsert a single measure (with optional formatString + displayFolder) via TMSL. */
export async function upsertMeasure(opts: {
  database?: string;
  tableName: string;
  measureName: string;
  expression: string;
  formatString?: string;
  displayFolder?: string;
}): Promise<void> {
  const db = resolveDatabase(opts.database);
  await executeTmsl(db, buildMeasureUpsertTmsl({ ...opts, database: db }));
}

/**
 * Evaluate a single measure and return its raw value — used to confirm a
 * just-saved measure (with its dynamic format string) computes server-side.
 */
export async function evaluateMeasure(opts: {
  database?: string;
  tableName: string;
  measureName: string;
}): Promise<{ value: unknown; rows: Record<string, unknown>[] }> {
  const db = resolveDatabase(opts.database);
  const { rows } = await executeDaxQuery(db, buildMeasureEvalQuery(opts.tableName, opts.measureName));
  const first = rows[0] || {};
  const value = Object.values(first)[0];
  return { value, rows };
}
