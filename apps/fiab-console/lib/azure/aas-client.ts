/**
 * AAS client — Azure Analysis Services / Power BI VertiPaq DAX scalar runner.
 *
 * Used by the Scorecard editor's "connected metric" binder: a goal can be
 * bound to a DAX measure/expression living in a Power BI semantic model (or an
 * Azure Analysis Services tabular model surfaced through Power BI), and the
 * goal's *current value* is then pulled live from that model.
 *
 * Execution path (default — Azure-native, NO real Fabric dependency):
 *   Power BI REST `executeQueries`
 *     POST /v1.0/myorg/groups/{ws}/datasets/{id}/executeQueries
 *   This is the only public JSON-over-HTTP DAX *query* path. AAS VertiPaq and
 *   Power BI datasets share the same query engine, so this is the correct
 *   Azure-native runner for both. The endpoint base is cloud-correct via
 *   LOOM_POWERBI_BASE (Commercial: api.powerbi.com, GCC-High/IL5:
 *   api.powerbigov.us) and the AAD scope `analysis.windows.net/powerbi/api`
 *   is cloud-invariant — see powerbi-client.ts.
 *
 * Standalone AAS (opt-in): LOOM_AAS_SERVER, when set, names a dedicated AAS
 *   server (asazure://<region>.asazure.windows.net/<server>). Raw AAS
 *   data-plane DAX execution speaks XMLA (SOAP + native ADOMD.NET binding),
 *   which is not available in the Node.js BFF runtime. That path surfaces an
 *   HONEST structured 503 gate (no vaporware) directing the operator to bind a
 *   Power BI dataset instead, or to run the metric through a Power BI model
 *   built on the same AAS source.
 */

import { executeDatasetQueries, PowerBiError } from './powerbi-client';
import { aasSuffix } from './cloud-endpoints';

/** A goal's binding to a live DAX measure in a Power BI / AAS tabular model. */
export interface ConnectedMetric {
  /** Power BI workspace (group) id that owns the dataset. */
  workspaceId: string;
  /** Power BI dataset / semantic-model id the measure lives in. */
  datasetId: string;
  /**
   * DAX scalar expression to evaluate — either a measure reference
   * (`[Total Revenue]`) or an inline expression (`SUM(Sales[Amount])`).
   */
  daxExpression: string;
}

export class AasError extends Error {
  status: number;
  code?: string;
  remediation?: string;
  constructor(message: string, status: number, code?: string, remediation?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.code = code;
    this.remediation = remediation;
  }
}

/** True when a standalone AAS server is configured (opt-in XMLA path). */
export function hasStandaloneAas(): boolean {
  return !!process.env.LOOM_AAS_SERVER;
}

/**
 * Honest gate for the standalone-AAS XMLA path. XMLA-over-HTTP DAX execution
 * requires native ADOMD.NET bindings not present in the Next.js Node runtime,
 * so rather than pretend, we throw a precise, actionable AasError.
 */
export function aasXmlaGate(): never {
  const server = process.env.LOOM_AAS_SERVER || '';
  throw new AasError(
    `Connected metrics against the standalone Azure Analysis Services server (${server || `*.${aasSuffix()}`}) ` +
      `require the XMLA endpoint, which the Loom BFF cannot reach (XMLA needs native ADOMD.NET bindings). ` +
      `Bind this goal to a Power BI semantic model instead — Power BI's executeQueries REST path evaluates ` +
      `the same DAX over the same VertiPaq engine and is fully supported here.`,
    503,
    'aas_xmla_not_supported',
    'Publish the AAS tabular model as a Power BI semantic model (or import it into one) and bind the goal to that dataset.',
  );
}

/** Result row key produced by `EVALUATE ROW("Value", <expr>)`. */
const VALUE_KEY = '[Value]';

/**
 * Evaluate a DAX scalar expression against the bound dataset and return the
 * single numeric value (or null when the result set is empty / null).
 *
 * Wraps the expression in `EVALUATE ROW("Value", <expr>)` so any scalar DAX —
 * a bare measure reference or an inline aggregation — yields exactly one row
 * with the `[Value]` column.
 */
export async function evaluateDaxScalar(metric: ConnectedMetric): Promise<number | null> {
  if (!metric?.workspaceId || !metric?.datasetId || !metric?.daxExpression) {
    throw new AasError('connected metric is missing workspaceId, datasetId, or daxExpression', 400, 'bad_metric');
  }
  // Standalone AAS server is opt-in and goes through XMLA, which we don't
  // support in-process — gate honestly. (The default Power BI path below needs
  // no AAS server at all.)
  if (hasStandaloneAas() && process.env.LOOM_METRIC_BACKEND === 'aas-xmla') {
    aasXmlaGate();
  }

  const expr = metric.daxExpression.trim();
  const query = `EVALUATE ROW("Value", ${expr})`;
  try {
    const j = await executeDatasetQueries(metric.workspaceId, metric.datasetId, query);
    const row = j?.results?.[0]?.tables?.[0]?.rows?.[0];
    if (!row) return null;
    // Power BI labels the column `[Value]`; fall back to the first column if a
    // future serializer changes the key.
    const raw = (row as Record<string, unknown>)[VALUE_KEY] ?? Object.values(row)[0];
    if (raw === null || raw === undefined) return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      throw new AasError(`DAX expression returned a non-numeric value (${String(raw)})`, 422, 'non_numeric');
    }
    return n;
  } catch (e) {
    if (e instanceof AasError) throw e;
    if (e instanceof PowerBiError) {
      throw new AasError(
        e.message || `DAX execution failed (${e.status})`,
        e.status,
        'dax_exec_failed',
        e.status === 401 || e.status === 403
          ? 'The Console UAMI must be a Member/Contributor on the Power BI workspace and the tenant must allow service principals to use Power BI APIs.'
          : undefined,
      );
    }
    throw new AasError((e as Error)?.message || String(e), 502, 'dax_exec_failed');
  }
}
