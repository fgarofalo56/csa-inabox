/**
 * aas-client.ts — Azure Analysis Services ARM management + XMLA TMSL execution.
 *
 * This is the OPT-IN persistence backend for calculation groups + field
 * parameters (LOOM_SEMANTIC_BACKEND=aas). The Loom-native default stores those
 * objects in Cosmos and emits them in TMSL at provision time — AAS is never on
 * the default code path (see .claude/rules/no-fabric-dependency.md).
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ChainedTokenCredential.
 *
 *   ARM scope : {armBase()}/.default                       (control plane)
 *   XMLA scope: https://{region}.asazure.windows.net/.default
 *
 * XMLA endpoint (data plane): the AAS server URI is the connection string
 *   asazure://{region}.asazure.windows.net/{serverName}
 * TMSL is executed over the SOAP/XMLA HTTP endpoint:
 *   https://{region}.asazure.windows.net/servers/{serverName}/
 *
 * Cloud boundaries:
 *   Commercial / GCC : AAS available — asazure.windows.net (GCC rides Commercial
 *                      Azure endpoints).
 *   GCC-High / IL5   : AAS is NOT available in AzureUSGovernment — honest gate.
 *   DoD              : AAS is NOT available — honest gate.
 *   In every gated cloud the Loom-native (Cosmos + TMSL builder) path remains
 *   fully functional, so no feature is lost.
 *
 * Env vars (all opt-in, empty by default — no new infra is deployed):
 *   LOOM_AAS_SERVER   asazure://{region}.asazure.windows.net/{serverName}
 *   LOOM_AAS_DATABASE model/database name on the AAS server
 *   LOOM_AAS_RG       resource group hosting the server (ARM listing only)
 */

import { armBase, armScope, isGovCloud, detectLoomCloud } from './cloud-endpoints';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import type { TmslCalcGroup, FieldParamDef } from './powerbi-client';

export class AasError extends Error {
  status: number;
  endpoint?: string;
  constructor(message: string, status: number, endpoint?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/**
 * Returns null when AAS is reachable in the active cloud, or a gate object
 * describing why it is not (GCC-High / IL5 / DoD). The caller surfaces this as
 * an honest MessageBar rather than pretending to write.
 */
export function aasAvailabilityGate(): { unavailable: true; cloud: string; detail: string } | null {
  if (isGovCloud()) {
    const cloud = detectLoomCloud();
    return {
      unavailable: true,
      cloud,
      detail:
        `Azure Analysis Services is not available in ${cloud}. ` +
        'Calculation groups + field parameters are still fully supported on the ' +
        'Loom-native backend (LOOM_SEMANTIC_BACKEND=loom-native, the default): ' +
        'they are stored with this item and emitted in TMSL when the model is ' +
        'provisioned to a tabular engine.',
    };
  }
  return null;
}

/** XMLA endpoint host (no scheme) for an `asazure://host/server` URI. */
export function aasXmlaHost(serverUri: string): string {
  const m = serverUri.match(/^asazure:\/\/([^/]+)\//i);
  if (m) return m[1];
  // Already a bare host or https URL — strip scheme + trailing path.
  return serverUri.replace(/^https?:\/\//i, '').split('/')[0];
}

/** Server (database catalog host) name for an `asazure://host/server` URI. */
export function aasServerName(serverUri: string): string {
  const parts = serverUri.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || serverUri;
}

async function xmlaToken(host: string): Promise<string> {
  const scope = `https://${host}/.default`;
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire XMLA token for ${scope}`, 401);
  return t.token;
}

/** XML-escape text destined for an XML text node / SOAP body. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the SOAP/XMLA Execute envelope that runs a TMSL command against an AAS
 * database. The TMSL JSON goes in <Statement> (escaped); the target database is
 * named in the Catalog property.
 */
export function buildTmslExecuteEnvelope(tmslJson: string, database: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<Body>' +
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    `<Command><Statement>${xmlEscape(tmslJson)}</Statement></Command>` +
    '<Properties><PropertyList>' +
    `<Catalog>${xmlEscape(database)}</Catalog>` +
    '</PropertyList></Properties>' +
    '</Execute>' +
    '</Body>' +
    '</Envelope>'
  );
}

/**
 * Execute a TMSL script (createOrReplace / alter / etc.) against an AAS model
 * over SOAP/XMLA. Returns { ok: true } on success; throws AasError with the
 * engine's <Description> on a TMSL error.
 *
 * @param serverUri asazure://{region}.asazure.windows.net/{serverName}
 * @param database  model (database) name on that server
 * @param tmslJson  TMSL JSON string
 */
export async function executeTmsl(
  serverUri: string,
  database: string,
  tmslJson: string,
): Promise<{ ok: true }> {
  const host = aasXmlaHost(serverUri);
  const serverName = aasServerName(serverUri);
  const token = await xmlaToken(host);
  const url = `https://${host}/servers/${serverName}/`;
  const envelope = buildTmslExecuteEnvelope(tmslJson, database);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: envelope,
    cache: 'no-store',
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new AasError(`AAS XMLA ${res.status}: ${text.slice(0, 400)}`, res.status, url);
  }
  // A SOAP 200 can still carry a TMSL <Error>/<Exception>; surface the message.
  if (/<(Error|Exception)\b/i.test(text)) {
    const desc = text.match(/<Description>([\s\S]*?)<\/Description>/i)?.[1];
    throw new AasError(`TMSL error: ${desc || text.slice(0, 400)}`, 422, url);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// TMSL builders — shared by the AAS XMLA path AND the provisioner.
// ---------------------------------------------------------------------------

/**
 * TMSL `createOrReplace` for a calculation-group table. Mirrors the TOM shape:
 * a calculationGroup with precedence + calculationItems, plus the mandatory
 * Name (string) + Ordinal (int64, hidden) columns and a calculationGroup
 * partition source.
 */
export function buildCalcGroupTmsl(database: string, cg: TmslCalcGroup): string {
  return JSON.stringify({
    createOrReplace: {
      object: { database, table: cg.name },
      table: {
        name: cg.name,
        calculationGroup: {
          precedence: cg.precedence,
          calculationItems: cg.items.map((ci) => ({
            name: ci.name,
            expression: ci.expression,
            ...(ci.formatStringDefinition
              ? { formatStringDefinition: { expression: ci.formatStringDefinition } }
              : {}),
            ...(typeof ci.ordinal === 'number' ? { ordinal: ci.ordinal } : {}),
          })),
        },
        columns: [
          {
            name: cg.name,
            dataType: 'string',
            sourceColumn: 'Name',
            sortByColumn: 'Ordinal',
            summarizeBy: 'none',
            annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }],
          },
          {
            name: 'Ordinal',
            dataType: 'int64',
            isHidden: true,
            sourceColumn: 'Ordinal',
            summarizeBy: 'sum',
            annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }],
          },
        ],
        partitions: [
          { name: 'Partition', mode: 'import', source: { type: 'calculationGroup' } },
        ],
      },
    },
  });
}

/**
 * The DAX calculated-table body for a field parameter, using NAMEOF():
 *   { ("Total Sales", NAMEOF('Sales'[Amount]), 0), ... }
 */
export function buildFieldParamDax(fp: FieldParamDef): string {
  const rows = fp.fields
    .map(
      (f, i) =>
        `\t("${(f.displayName || '').replace(/"/g, '""')}", NAMEOF(${f.fieldRef}), ${
          typeof f.order === 'number' ? f.order : i
        })`,
    )
    .join(',\n');
  return `{\n${rows}\n}`;
}

/**
 * TMSL `createOrReplace` for a field-parameter calculated table. The three
 * positional values map to: the visible label column, the hidden field
 * reference, and the hidden sort order.
 */
export function buildFieldParamTmsl(database: string, fp: FieldParamDef): string {
  return JSON.stringify({
    createOrReplace: {
      object: { database, table: fp.name },
      table: {
        name: fp.name,
        columns: [
          { name: fp.name, dataType: 'string', sourceColumn: '[Value1]', summarizeBy: 'none' },
          {
            name: 'Fields',
            dataType: 'string',
            sourceColumn: '[Value2]',
            summarizeBy: 'none',
            isHidden: true,
          },
          {
            name: 'Order',
            dataType: 'int64',
            sourceColumn: '[Value3]',
            summarizeBy: 'sum',
            isHidden: true,
            sortByColumn: 'Order',
          },
        ],
        partitions: [
          {
            name: 'Partition',
            mode: 'import',
            source: { type: 'calculated', expression: buildFieldParamDax(fp) },
          },
        ],
        annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// ARM control plane — list AAS servers (used to surface a target picker).
// ---------------------------------------------------------------------------

export interface AasServer {
  name: string;
  location?: string;
  sku?: { name?: string; tier?: string; capacity?: number };
  properties?: { state?: string; serverFullName?: string; provisioningState?: string };
}

/** List Microsoft.AnalysisServices/servers in a resource group. */
export async function listAasServers(
  subscriptionId: string,
  resourceGroup: string,
): Promise<AasServer[]> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new AasError('Failed to acquire ARM token', 401);
  const url =
    `${armBase()}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    '/providers/Microsoft.AnalysisServices/servers?api-version=2017-08-01';
  const res = await fetch(url, { headers: { authorization: `Bearer ${t.token}` }, cache: 'no-store' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new AasError(j?.error?.message || `ARM ${res.status}`, res.status, url);
  return (j.value || []) as AasServer[];
}
