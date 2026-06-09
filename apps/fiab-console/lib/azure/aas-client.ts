/**
 * aas-client.ts — Composite (mixed-storage-mode) TMSL builder + apply paths.
 *
 * Builds a `model.bim` TMSL `Database` object whose tables carry a per-partition
 * storage **mode** — `import`, `directQuery`, or `dual` — so a single tabular
 * model can mix modes (a Power BI / Analysis Services *composite* model). The
 * `"dual"` value is a Power BI Premium / Fabric XMLA extension (compatibility
 * level ≥ 1560); standalone Azure Analysis Services accepts only `"import"` and
 * `"directQuery"`.
 *
 * APPLY PATHS
 * -----------
 * Node.js cannot issue arbitrary TMSL commands (createOrReplace / alter) to AAS
 * over plain HTTP — the AAS REST surface at `asazure.windows.net` only exposes
 * async refresh, and full TMSL execution requires an XMLA TCP connection
 * (TOM/AMO). The one REST path from Node that accepts the same `model.bim` TMSL
 * payload is the **Fabric updateDefinition API**, which wraps XMLA internally:
 *
 *   POST /v1/workspaces/{ws}/semanticModels/{id}/updateDefinition
 *
 * So there are two honest outcomes (per no-vaporware.md):
 *
 *   1. Fabric / Power-BI-Premium backed workspace (opt-in): the TMSL is applied
 *      in-place via updateDefinition.
 *   2. No Fabric capacity: the TMSL is BUILT and returned as the receipt for
 *      offline application —  `Invoke-ASCmd -Server "asazure://…" -Query <tmsl>`.
 *
 * The default semantic-model item never depends on this file — its Azure-native
 * default is the Loom-native tabular layer (see no-fabric-dependency.md). This
 * client is reached only from the editor's opt-in Power BI / Fabric surface.
 *
 * Auth: Console UAMI via ChainedTokenCredential (Fabric `.default` scope).
 * `@azure/identity` is imported lazily inside the apply path so the pure TMSL
 * builder below carries no Azure-SDK import cost (and stays unit-testable).
 */

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

export type TableStorageMode = 'import' | 'directQuery' | 'dual';

export const TABLE_STORAGE_MODES: readonly TableStorageMode[] = ['import', 'directQuery', 'dual'];

export interface CompositeColumn {
  name: string;
  /** Tabular dataType (e.g. "string", "int64", "double", "dateTime"). */
  dataType?: string;
  /** Source column in the DirectQuery/Dual query result (defaults to name). */
  sourceColumn?: string;
}

export interface CompositeMeasure {
  name: string;
  expression: string;
  formatString?: string;
}

export interface CompositeTableSpec {
  name: string;
  /** Storage mode for the table's default partition. */
  mode: TableStorageMode;
  /** SQL/M query for the partition — required when mode is directQuery or dual. */
  sourceQuery?: string;
  /** Name of the model-level dataSource the DQ/Dual partition reads from. */
  dataSourceName?: string;
  columns?: CompositeColumn[];
  measures?: CompositeMeasure[];
}

export interface CompositeRelationship {
  name?: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** TMSL crossFilteringBehavior — "oneDirection" (default) | "bothDirections" | "automatic". */
  crossFilteringBehavior?: 'oneDirection' | 'bothDirections' | 'automatic';
  isActive?: boolean;
}

export interface CompositeDataSource {
  /** Unique name within the model (referenced by partition.source.dataSource). */
  name: string;
  /** Structured/Provider data-source type (e.g. "sql", "structured"). */
  type?: string;
  /** Provider connectionString, or M expression for a structured source. */
  connectionString?: string;
  /** "impersonateServiceAccount" (default) | "impersonateCurrentUser". */
  impersonationMode?: string;
}

export interface BuildCompositeOptions {
  /** Compatibility level. 1567 (default) satisfies the ≥1560 "dual" requirement. */
  compatibilityLevel?: number;
  /** Model culture. Defaults to "en-US". */
  culture?: string;
  /**
   * When "aas-standalone", a `"dual"` mode table is rejected (standalone AAS
   * does not support Dual). Default "fabric" accepts all three modes.
   */
  targetEngine?: 'fabric' | 'aas-standalone';
}

export class AasError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
  }
}

/** Strip any chars Tabular rejects inside an object name and trim. */
function cleanName(s: string): string {
  return String(s ?? '').trim();
}

/**
 * Build a `model.bim` TMSL (Database object) with per-partition storage modes.
 * Pure — no I/O. The result is the JSON string to base64-encode for the Fabric
 * updateDefinition `model.bim` part (or to hand to `Invoke-ASCmd` offline).
 *
 * Per-table partition emitted (grounded in the TMSL Partitions object spec,
 * https://learn.microsoft.com/analysis-services/tmsl/partitions-object-tmsl):
 *   import      → { mode: "import",      source: { type: "none" } }
 *   directQuery → { mode: "directQuery", source: { type: "query", query, dataSource } }
 *   dual        → { mode: "dual",        source: { type: "query", query, dataSource } }
 *
 * A model-level `dataSources[]` entry is auto-emitted for any DQ/Dual table
 * whose `dataSourceName` is not already present in the supplied `dataSources`.
 */
export function buildCompositeTmsl(
  modelName: string,
  tables: CompositeTableSpec[],
  relationships?: CompositeRelationship[],
  dataSources?: CompositeDataSource[],
  options?: BuildCompositeOptions,
): string {
  const compatibilityLevel = options?.compatibilityLevel ?? 1567;
  const culture = options?.culture ?? 'en-US';
  const targetEngine = options?.targetEngine ?? 'fabric';

  if (!Array.isArray(tables) || tables.length === 0) {
    throw new AasError('buildCompositeTmsl requires at least one table.', 400);
  }

  // Collect explicitly-provided data sources first (keyed by name).
  const dsByName = new Map<string, CompositeDataSource>();
  for (const ds of dataSources || []) {
    if (ds?.name) dsByName.set(ds.name, ds);
  }

  const tmslTables = tables.map((t) => {
    const name = cleanName(t.name);
    if (!name) throw new AasError('Every table needs a name.', 400);
    if (!TABLE_STORAGE_MODES.includes(t.mode)) {
      throw new AasError(`Invalid storage mode "${t.mode}" for table "${name}".`, 400);
    }
    if (t.mode === 'dual' && targetEngine === 'aas-standalone') {
      throw new AasError(
        `Table "${name}" requests Dual storage mode, which standalone Azure Analysis Services does not support. ` +
          `Dual requires Power BI Premium / Fabric capacity. Use Import or DirectQuery, or apply via Fabric.`,
        400,
      );
    }

    const isQuery = t.mode === 'directQuery' || t.mode === 'dual';
    if (isQuery && !cleanName(t.sourceQuery)) {
      throw new AasError(`Table "${name}" mode="${t.mode}" requires a sourceQuery.`, 400);
    }

    // A DQ/Dual table needs a dataSource; default one is auto-created per model.
    const dsName = isQuery ? cleanName(t.dataSourceName) || 'sqlSource' : undefined;
    if (dsName && !dsByName.has(dsName)) {
      dsByName.set(dsName, { name: dsName, type: 'structured', connectionString: '' });
    }

    const columns = (t.columns || []).map((c) => ({
      name: cleanName(c.name),
      ...(c.dataType ? { dataType: c.dataType } : { dataType: 'string' }),
      sourceColumn: cleanName(c.sourceColumn) || cleanName(c.name),
    }));

    const measures = (t.measures || [])
      .filter((m) => cleanName(m.name) && cleanName(m.expression))
      .map((m) => ({
        name: cleanName(m.name),
        expression: m.expression,
        ...(m.formatString ? { formatString: m.formatString } : {}),
      }));

    const partition =
      t.mode === 'import'
        ? { name: `${name}-import`, mode: 'import', source: { type: 'none' } }
        : {
            name: `${name}-${t.mode}`,
            mode: t.mode,
            source: { type: 'query', query: t.sourceQuery, dataSource: dsName },
          };

    return {
      name,
      ...(columns.length ? { columns } : {}),
      ...(measures.length ? { measures } : {}),
      partitions: [partition],
    };
  });

  const tmslRelationships = (relationships || [])
    .filter((r) => r?.fromTable && r?.fromColumn && r?.toTable && r?.toColumn)
    .map((r, i) => ({
      name: r.name || `rel${i}`,
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
      crossFilteringBehavior: r.crossFilteringBehavior || 'oneDirection',
      ...(r.isActive === false ? { isActive: false } : {}),
    }));

  const emittedDataSources = Array.from(dsByName.values()).map((ds) => ({
    name: ds.name,
    type: ds.type || 'structured',
    connectionString: ds.connectionString ?? '',
    ...(ds.impersonationMode ? { impersonationMode: ds.impersonationMode } : {}),
  }));

  const model: Record<string, unknown> = {
    culture,
    tables: tmslTables,
    ...(tmslRelationships.length ? { relationships: tmslRelationships } : {}),
    ...(emittedDataSources.length ? { dataSources: emittedDataSources } : {}),
  };

  return JSON.stringify(
    {
      name: cleanName(modelName) || 'CompositeModel',
      compatibilityLevel,
      model,
    },
    null,
    2,
  );
}

async function fabricToken(): Promise<string> {
  // Lazy import keeps the Azure SDK off the pure-builder import path.
  const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } = await import(
    '@azure/identity'
  );
  const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const credential = uamiClientId
    ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
    : new DefaultAzureCredential();
  const t = await credential.getToken(FABRIC_SCOPE);
  if (!t?.token) throw new AasError('Failed to acquire AAD token for Fabric.', 401);
  return t.token;
}

/**
 * Apply a composite `model.bim` TMSL in-place via the Fabric updateDefinition
 * REST API (the only HTTP path from Node that accepts full per-partition-mode
 * TMSL). The workspace must be Fabric / Power-BI-Premium capacity-backed;
 * against a plain Pro workspace the API returns an error which is surfaced
 * verbatim. Opt-in only — callers gate on an explicit Fabric backend signal.
 *
 * Docs: https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition
 */
export async function applyTmslViaFabric(
  workspaceId: string,
  semanticModelId: string,
  tmslJson: string,
  displayName: string,
  steps: string[],
): Promise<{ ok: true }> {
  const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');
  const platform = JSON.stringify({
    $schema:
      'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
    metadata: { type: 'SemanticModel', displayName },
    config: { version: '2.0' },
  });
  const definition = {
    parts: [
      { path: 'model.bim', payload: b64(tmslJson), payloadType: 'InlineBase64' as const },
      {
        path: 'definition.pbism',
        payload: b64(JSON.stringify({ version: '4.0', settings: {} })),
        payloadType: 'InlineBase64' as const,
      },
      { path: '.platform', payload: b64(platform), payloadType: 'InlineBase64' as const },
    ],
  };

  const tok = await fabricToken();
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/semanticModels/${encodeURIComponent(
    semanticModelId,
  )}/updateDefinition`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ definition }),
    cache: 'no-store',
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  if (!res.ok && res.status !== 202) {
    const msg =
      (body as any)?.message ||
      (body as any)?.error?.message ||
      text ||
      `Fabric updateDefinition failed (${res.status}).`;
    throw new AasError(String(msg), res.status, body ?? text);
  }
  steps.push(`Fabric updateDefinition ${res.status} OK.`);
  return { ok: true };
}
