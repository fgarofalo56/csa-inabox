/**
 * aas-client — Analysis Services / Power BI Premium XMLA write client for the
 * Semantic Model editor's authoring surfaces that genuinely require the XMLA
 * endpoint (the Power BI REST push-dataset path can't express them).
 *
 * The first surface built on this is **Automatic aggregations** — a Tabular
 * model aggregation table whose every column carries an `alternateOf`
 * (BaseTable / BaseColumn + Summarization) so the AS engine automatically
 * rewrites matching queries to the (small, Import-mode) agg table and falls
 * through to the (large, DirectQuery) detail table otherwise. Aggregation
 * metadata lives ENTIRELY in the model as `alternateOf`, applied via a TMSL
 * `createOrReplace` command sent over the XMLA endpoint.
 *
 * Backend (Azure-native default, per no-fabric-dependency.md):
 *   - `LOOM_POWERBI_XMLA_ENDPOINT` is an HTTPS XMLA URL. For the Azure-native
 *     default this points at an **Azure Analysis Services** server
 *     (`https://{server}.asazure.windows.net/xmla`, or `.asazure.usgovcloudapi.net`
 *     in Gov). A Power BI Premium / Fabric capacity XMLA endpoint
 *     (`https://api.powerbi.com/xmla` / `https://api.powerbigov.us/xmla`) is an
 *     opt-in alternative selected purely by what URL the operator configures —
 *     this client is endpoint-agnostic and never hard-codes a Fabric host.
 *   - Auth: Console UAMI (`LOOM_UAMI_CLIENT_ID`) via ManagedIdentityCredential,
 *     chained with DefaultAzureCredential for local dev — the SAME identity the
 *     Power BI REST client already uses. The UAMI must be a Member/Contributor
 *     of the workspace (or an AAS administrator) — XMLA enforces that.
 *   - The AAD scope is the Analysis Services audience, which differs by
 *     sovereign boundary (`xmlaScope()` below).
 *
 * No mocks. The TMSL builders are pure (unit-testable with no Azure deps);
 * `executeTmsl` performs a real SOAP `Execute` HTTPS POST and surfaces XMLA
 * faults verbatim as `AasError`.
 *
 * Docs:
 *   - Column.AlternateOf / AlternateOf.Summarization (GroupBy|Sum|Count|Min|Max):
 *     https://learn.microsoft.com/dotnet/api/microsoft.analysisservices.tabular.alternateof
 *   - Aggregations: https://learn.microsoft.com/power-bi/transform-model/aggregations-advanced
 *   - TMSL createOrReplace: https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
 *   - XMLA endpoint: https://learn.microsoft.com/power-bi/enterprise/service-premium-connect-tools
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { isGovCloud } from './cloud-endpoints';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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

/**
 * The configured XMLA endpoint HTTPS URL (no trailing slash), or null when
 * unset. Read at call time (not module load) so a test / runtime that sets the
 * env var late still sees it.
 */
export function xmlaEndpoint(): string | null {
  const v = (process.env.LOOM_POWERBI_XMLA_ENDPOINT || '').trim();
  return v ? v.replace(/\/+$/, '') : null;
}

/**
 * Honest infra-gate for the XMLA write surface. Returns null when an endpoint
 * is configured (the route should attempt the real call); otherwise a
 * structured remediation the editor renders in a MessageBar — NEVER a crash,
 * NEVER a fake success. Per no-vaporware.md.
 */
export function xmlaConfigGate(): { missing: string; detail: string } | null {
  if (xmlaEndpoint()) return null;
  return {
    missing: 'LOOM_POWERBI_XMLA_ENDPOINT',
    detail:
      'No XMLA endpoint is configured, so aggregation tables cannot be written to the model. ' +
      'Set LOOM_POWERBI_XMLA_ENDPOINT to an HTTPS XMLA URL — for the Azure-native default this is an ' +
      'Azure Analysis Services server (https://<server>.asazure.windows.net/xmla, or .asazure.usgovcloudapi.net ' +
      'in Gov); a Power BI Premium / Fabric capacity XMLA endpoint (https://api.powerbi.com/xmla, ' +
      'https://api.powerbigov.us/xmla in Gov) is an opt-in alternative. The Console UAMI must be a ' +
      'Member/Contributor of the workspace (or an AAS administrator) and the model must be at ' +
      'compatibility level 1460 or higher.',
  };
}

/**
 * AAD `.default` scope for Analysis Services / Power BI XMLA tokens. The
 * resource audience is `analysis.windows.net` in Commercial/GCC and
 * `analysis.usgovcloudapi.net` in GCC-High / IL5 / DoD — hard-coding the
 * Commercial scope silently fails XMLA auth in Gov, so it derives from
 * `isGovCloud()` (the same split powerbi-client + the Direct Lake path use).
 */
export function xmlaScope(): string {
  return isGovCloud()
    ? 'https://analysis.usgovcloudapi.net/powerbi/api/.default'
    : 'https://analysis.windows.net/powerbi/api/.default';
}

async function getToken(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for ${scope}`, 401);
  return t.token;
}

// ============================================================
// Aggregation TMSL builder (pure)
// ============================================================

/** AS aggregation summarization types (SummarizationType: GroupBy|Sum|Count|Min|Max). */
export type AggSummarization = 'GroupBy' | 'Sum' | 'Count' | 'Min' | 'Max';

/**
 * One column of the aggregation table, mapped via `alternateOf` to a column
 * (or — for `Count` of rows — a table) in the DirectQuery detail table.
 */
export interface AltMap {
  /** Column name in the (new) aggregation table. */
  aggColumn: string;
  /** TMSL column dataType: string | int64 | double | decimal | dateTime | boolean. */
  dataType: string;
  /** Aggregation summarization. GroupBy = grain key; Sum/Count/Min/Max = measure. */
  summarization: AggSummarization;
  /** Detail (DirectQuery) table the agg column is an alternate source of. */
  detailTable: string;
  /**
   * Detail column the agg column maps to. Required for GroupBy/Sum/Min/Max.
   * Optional for `Count` — when omitted the column counts detail-table ROWS
   * (a table-level `alternateOf` with only `baseTable`).
   */
  detailColumn?: string;
}

export interface AggTableTmslParams {
  /** XMLA catalog / semantic model (database) name. */
  database: string;
  /** Name of the new aggregation table (created hidden, Import mode). */
  aggTableName: string;
  /** Power Query (M) expression for the agg table's single partition. */
  partitionExpression: string;
  /** The per-column aggregation mappings (at least one). */
  altMaps: AltMap[];
}

/**
 * The TMSL `alternateOf` object for one column. Per the TOM/TMSL serialization
 * (verified against the Tabular Editor AlternateOf API + real createOrReplace
 * examples) a column-level mapping emits BOTH `baseTable` (qualifying table)
 * and `baseColumn`; a row-count mapping emits `baseTable` only.
 */
export function altMapToTmsl(m: AltMap): Record<string, unknown> {
  const out: Record<string, unknown> = { summarization: m.summarization, baseTable: m.detailTable };
  if (m.detailColumn && m.detailColumn.trim()) out.baseColumn = m.detailColumn.trim();
  return out;
}

/**
 * Build a TMSL `createOrReplace` command (as a JSON string) that creates the
 * aggregation table: hidden, single M partition, one column per AltMap each
 * carrying its `alternateOf`. The AS engine uses this metadata to
 * automatically route matching queries to this table.
 *
 * Pure function — no Azure dependency — so it is unit-testable directly.
 */
export function buildAggTableTmsl(params: AggTableTmslParams): string {
  const { database, aggTableName, partitionExpression, altMaps } = params;
  const columns = altMaps.map((m) => ({
    name: m.aggColumn,
    dataType: (m.dataType || 'double'),
    // Aggregation columns are not user-visible; the detail columns are.
    isHidden: m.summarization === 'GroupBy' ? false : true,
    alternateOf: altMapToTmsl(m),
  }));
  const command = {
    createOrReplace: {
      object: { database, table: aggTableName },
      table: {
        name: aggTableName,
        // Aggregation tables are hidden from report authors and are Import mode
        // (the small pre-aggregated cache over the DirectQuery detail table).
        isHidden: true,
        partitions: [
          {
            name: `${aggTableName}-partition`,
            mode: 'import',
            source: { type: 'm', expression: partitionExpression },
          },
        ],
        columns,
      },
    },
  };
  return JSON.stringify(command);
}

// ============================================================
// XMLA SOAP Execute
// ============================================================

/**
 * Wrap a TMSL JSON command in the XMLA SOAP `Execute` envelope. The TMSL is
 * sent as the `<Statement>` text; `<Catalog>` selects the model. Pure string
 * builder (exported for the test to assert the body shape).
 */
export function buildSoapExecuteEnvelope(catalog: string, tmslJson: string): string {
  // XML-escape the catalog (the TMSL statement is JSON inside a text node, but
  // we still escape the few XML-significant characters so a stray '&'/'<' in a
  // model name or M expression can't break the envelope).
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<Body>' +
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    `<Command><Statement>${esc(tmslJson)}</Statement></Command>` +
    '<Properties><PropertyList>' +
    `<Catalog>${esc(catalog)}</Catalog>` +
    '</PropertyList></Properties>' +
    '</Execute>' +
    '</Body>' +
    '</Envelope>'
  );
}

/**
 * Extract an XMLA fault / exception message from a SOAP response body. XMLA
 * returns HTTP 200 even for command errors, embedding the error as a SOAP
 * `<faultstring>` or an `<Exception>`/`<Error>` element. Returns null when the
 * response carries no error.
 */
export function parseXmlaFault(xml: string): string | null {
  const fault = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (fault) return fault[1].trim();
  const exc = xml.match(/<Exception[^>]*\bmessage="([^"]*)"/i);
  if (exc) return exc[1].trim();
  const err = xml.match(/<Error[^>]*\bDescription="([^"]*)"/i);
  if (err) return err[1].trim();
  return null;
}

/**
 * Execute a TMSL command against the configured XMLA endpoint via a SOAP
 * `Execute` POST. Resolves `{ ok: true }` on success; throws `AasError` on an
 * HTTP error OR an embedded XMLA fault (HTTP 200 + `<faultstring>`).
 */
export async function executeTmsl(catalog: string, tmslJson: string): Promise<{ ok: true }> {
  const endpoint = xmlaEndpoint();
  if (!endpoint) {
    throw new AasError('LOOM_POWERBI_XMLA_ENDPOINT is not configured', 503);
  }
  const token = await getToken(xmlaScope());
  const envelope = buildSoapExecuteEnvelope(catalog, tmslJson);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'text/xml; charset=utf-8',
      'soapaction': '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: envelope,
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    const fault = parseXmlaFault(text);
    throw new AasError(fault || text || `XMLA Execute failed (${res.status})`, res.status, text, endpoint);
  }
  const fault = parseXmlaFault(text);
  if (fault) throw new AasError(fault, 400, text, endpoint);
  return { ok: true };
}
