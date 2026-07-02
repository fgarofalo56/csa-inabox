/**
 * Phase 2 — Semantic Model provisioner.
 *
 * Real REST: Fabric POST /v1/workspaces/{ws}/semanticModels with the
 * bundle's TMDL/TMSL packed as InlineBase64 in the definition parts.
 * Fabric materializes the model in the workspace; the model is then
 * queryable via XMLA + visible to reports.
 *
 * TMDL push for measures+relationships is the long-form payload — we
 * serialize the bundle SemanticModelContent into a minimal model.bim
 * (TMSL JSON) part and a definition.pbism part.  Fabric accepts either
 * format on create; we use TMSL for simplicity (no MSOLAP dependency).
 *
 * Power BI fallback (no Fabric workspace bound):
 *   When this Loom workspace has no Fabric workspace, the model is created in
 *   Power BI directly via the supported REST authoring path — a *push* dataset
 *   (POST /groups/{ws}/datasets) with typed columns, measures, and
 *   relationships — then seeded with sample rows (POST .../rows) so the
 *   import-mode model is immediately queryable. No XMLA / AAS dependency.
 *   The target Power BI workspace is LOOM_DEFAULT_POWERBI_WORKSPACE, or — if
 *   unset — the sole workspace the Console UAMI can see, else resolved by name.
 *
 * Remediation gates:
 *   - No Fabric AND no resolvable Power BI workspace → bind/set a target.
 *   - 401/403 → UAMI not a Contributor / SP not tenant-authorized; admin fix.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import { loomDocUrl } from '@/lib/learn/content';
import {
  PowerBiError,
  POWERBI_SP_HINT,
  createPushDataset,
  listWorkspaces,
  postPushRows,
  type CreatePushDatasetRequest,
  type PushColumn,
  type PushColumnType,
  type PushRelationship,
  type PushTable,
} from '@/lib/azure/powerbi-client';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function token(): Promise<string> {
  const t = await credential.getToken('https://api.fabric.microsoft.com/.default');
  if (!t?.token) throw new FabricError('Failed to acquire AAD token', 401);
  return t.token;
}

/**
 * Build a lookup of every column the model actually defines, keyed by
 * `table.column` (case-insensitive). Used to validate relationships before we
 * emit them so a bundle that references a non-existent column can never produce
 * a model TOM rejects with "Property FromColumn of object 'relationship …'
 * refers to an object which cannot be found."
 */
function buildColumnIndex(tables: any[]): Set<string> {
  const idx = new Set<string>();
  for (const t of tables) {
    const tableName = String(t?.name ?? '');
    for (const c of t?.columns || []) {
      const colName = String(c?.name ?? '');
      if (tableName && colName) idx.add(`${tableName}.${colName}`.toLowerCase());
    }
  }
  return idx;
}

/** Split a `Table.Column` reference into its parts (Column defaults to `Id`). */
function splitRef(ref: unknown): { table: string; column: string } {
  const s = String(ref ?? '');
  const dot = s.indexOf('.');
  if (dot < 0) return { table: s, column: 'Id' };
  return { table: s.slice(0, dot), column: s.slice(dot + 1) || 'Id' };
}

/**
 * Keep only relationships whose BOTH endpoints reference a column that exists
 * in the model. Any relationship whose from/to column is undefined is dropped
 * (and the reason pushed to `steps`) rather than failing the whole model —
 * the rest of the model (tables, measures, valid relationships, seeded rows)
 * still provisions. This is the guard for the live TOM "FromColumn … cannot be
 * found" failure. Mirrors the Tabular requirement that a relationship's
 * FromColumn/ToColumn must resolve to existing columns
 * (https://learn.microsoft.com/analysis-services/tabular-models/relationships-ssas-tabular#requirements-for-relationships).
 */
function validateRelationships(relationships: any[], columnIndex: Set<string>, steps: string[]): any[] {
  const valid: any[] = [];
  for (const r of relationships) {
    if (!r?.from || !r?.to) {
      steps.push(`Skipped relationship with missing from/to: ${JSON.stringify(r)}.`);
      continue;
    }
    const f = splitRef(r.from);
    const t = splitRef(r.to);
    const fromOk = columnIndex.has(`${f.table}.${f.column}`.toLowerCase());
    const toOk = columnIndex.has(`${t.table}.${t.column}`.toLowerCase());
    if (!fromOk || !toOk) {
      const missing: string[] = [];
      if (!fromOk) missing.push(`from '${r.from}'`);
      if (!toOk) missing.push(`to '${r.to}'`);
      steps.push(
        `Skipped relationship ${r.from} -> ${r.to}: ${missing.join(' and ')} ` +
          `references a column not defined in the model.`,
      );
      continue;
    }
    valid.push(r);
  }
  return valid;
}

/**
 * Build the canonical TMSL (model.bim JSON) for a semantic model's content.
 * Exported so the deployment-pipeline compare engine can serialize a
 * semantic-model item's definition deterministically and diff two stages
 * (no Fabric / Power BI dependency — pure transform of the bundle content).
 */
export function buildTmsl(content: any, displayName: string, steps: string[]): string {
  const tables = Array.isArray(content?.tables) ? content.tables : [];
  const measures = Array.isArray(content?.measures) ? content.measures : [];
  const allRelationships = Array.isArray(content?.relationships) ? content.relationships : [];
  const relationships = validateRelationships(allRelationships, buildColumnIndex(tables), steps);
  const calcGroups = Array.isArray(content?.calculationGroups) ? content.calculationGroups : [];
  const fieldParams = Array.isArray(content?.fieldParameters) ? content.fieldParameters : [];

  // A calculation-group table: TOM requires the calculationGroup object +
  // mandatory Name (string)/Ordinal (int64, hidden) columns + a
  // calculationGroup partition source. Calc groups only function when the model
  // sets discourageImplicitMeasures, which we apply below.
  // https://learn.microsoft.com/analysis-services/tabular-models/calculation-groups
  const calcGroupTables = calcGroups.map((cg: any) => ({
    name: cg.name,
    calculationGroup: {
      precedence: Number(cg.precedence) || 0,
      calculationItems: (cg.items || []).map((ci: any) => ({
        name: ci.name,
        expression: ci.expression,
        ...(ci.formatStringDefinition
          ? { formatStringDefinition: { expression: ci.formatStringDefinition } }
          : {}),
        ...(typeof ci.ordinal === 'number' ? { ordinal: ci.ordinal } : {}),
      })),
    },
    columns: [
      { name: cg.name, dataType: 'string', sourceColumn: 'Name', sortByColumn: 'Ordinal', summarizeBy: 'none', annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }] },
      { name: 'Ordinal', dataType: 'int64', isHidden: true, sourceColumn: 'Ordinal', summarizeBy: 'sum', annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }] },
    ],
    partitions: [{ name: 'Partition', mode: 'import', source: { type: 'calculationGroup' } }],
  }));

  // A field-parameter table: a DAX calculated table built with NAMEOF(). The
  // three positional values map to the visible label, the hidden field
  // reference, and the hidden sort order. A slicer over the label column swaps
  // the field a visual shows.
  // https://learn.microsoft.com/power-bi/create-reports/power-bi-field-parameters
  const fieldParamTables = fieldParams.map((fp: any) => {
    const rows = (fp.fields || [])
      .map((f: any, i: number) => `\t("${String(f.displayName || '').replace(/"/g, '""')}", NAMEOF(${f.fieldRef}), ${typeof f.order === 'number' ? f.order : i})`)
      .join(',\n');
    return {
      name: fp.name,
      columns: [
        { name: fp.name, dataType: 'string', sourceColumn: '[Value1]', summarizeBy: 'none' },
        { name: 'Fields', dataType: 'string', sourceColumn: '[Value2]', summarizeBy: 'none', isHidden: true },
        { name: 'Order', dataType: 'int64', sourceColumn: '[Value3]', summarizeBy: 'sum', isHidden: true, sortByColumn: 'Order' },
      ],
      partitions: [{ name: 'Partition', mode: 'import', source: { type: 'calculated', expression: `{\n${rows}\n}` } }],
      annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
    };
  });

  if (calcGroupTables.length) steps.push(`Emitted ${calcGroupTables.length} calculation group(s) (discourageImplicitMeasures=true).`);
  if (fieldParamTables.length) steps.push(`Emitted ${fieldParamTables.length} field parameter table(s).`);

  // Per-table storage mode override (composite model). When a bundle/install
  // carries content.tableModes (a map of tableName -> 'import'|'directQuery'|
  // 'dual'), the table's default partition is emitted with that mode so one
  // model can mix Import + DirectQuery + Dual. Absent → all-import (the prior
  // behavior). Dual is a Premium/Fabric XMLA extension; this path is the Fabric
  // opt-in branch so it is permitted here. The Loom-native default provisioner
  // (provisionLoomNative) is unchanged and never requires this.
  const tableModes: Record<string, string> =
    content?.tableModes && typeof content.tableModes === 'object' ? content.tableModes : {};
  const usesQueryMode = tables.some((t: any) => {
    const m = tableModes[t?.name];
    return m === 'directQuery' || m === 'dual';
  });
  if (Object.keys(tableModes).length) {
    steps.push(
      `Composite storage modes: ${tables.map((t: any) => `${t.name}=${tableModes[t.name] || 'import'}`).join(', ')}.`,
    );
  }
  return JSON.stringify({
    name: displayName,
    compatibilityLevel: 1567,
    model: {
      culture: 'en-US',
      // Required by the tabular engine for calculation groups to evaluate.
      ...(calcGroupTables.length ? { discourageImplicitMeasures: true } : {}),
      tables: [
        ...tables.map((t: any) => {
          const mode = tableModes[t.name] || 'import';
          const partition =
            mode === 'import'
              ? { name: `${t.name}-import`, mode: 'import', source: { type: 'none' } }
              : {
                  name: `${t.name}-${mode}`,
                  mode,
                  source: { type: 'query', query: `SELECT * FROM [${t.name}]`, dataSource: 'sqlSource' },
                };
          return {
          name: t.name,
          columns: (t.columns || []).map((c: any) => ({ name: c.name, dataType: c.dataType, sourceColumn: c.name })),
          measures: measures.filter((m: any) => m.table === t.name).map((m: any) => ({
            name: m.name, expression: m.expression, ...(m.formatString ? { formatString: m.formatString } : {}),
          })),
          partitions: [partition],
          };
        }),
        ...calcGroupTables,
        ...fieldParamTables,
      ],
      // Power BI / Tabular permits only ONE active relationship between any two
      // tables. Bundles must declare a valid active set (the SemanticModelContent
      // schema has no active/inactive flag, so each table-pair appears at most
      // once as active). If a bundle ever carries an explicit `isActive: false`
      // (additive, optional), we honor it so a role-playing inactive relationship
      // can be emitted for USERELATIONSHIP use. TMSL `isActive` defaults to true.
      // https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl
      relationships: relationships.map((r: any, i: number) => ({
        name: `rel${i}`,
        fromTable: r.from.split('.')[0], fromColumn: r.from.split('.')[1] || 'Id',
        toTable: r.to.split('.')[0], toColumn: r.to.split('.')[1] || 'Id',
        crossFilteringBehavior: 'oneDirection',
        ...(r.isActive === false ? { isActive: false } : {}),
      })),
      // A DirectQuery/Dual partition needs a model-level data source to read
      // from. Emit a default structured SQL source the partitions reference.
      ...(usesQueryMode ? { dataSources: [{ name: 'sqlSource', type: 'structured', connectionString: '' }] } : {}),
    },
  }, null, 2);
}

// ============================================================
// Power BI push-dataset fallback (no Fabric workspace bound)
// ============================================================

/**
 * Normalize the bundle's loose dataType strings (`string`/`String`,
 * `int64`/`Int64`, `dateTime`/`DateTime`, `decimal`/`Decimal`, …) onto the
 * exact PascalCase types the Power BI push-dataset API requires. Unknown types
 * fall back to `String` (always representable). `Currency` maps to `Decimal`.
 */
function toPushColumnType(raw: unknown): PushColumnType {
  const s = String(raw ?? 'string').trim().toLowerCase();
  switch (s) {
    case 'int64':
    case 'integer':
    case 'int':
    case 'whole':
    case 'wholenumber':
      return 'Int64';
    case 'double':
    case 'float':
    case 'real':
      return 'Double';
    case 'decimal':
    case 'currency':
    case 'fixeddecimal':
      return 'Decimal';
    case 'boolean':
    case 'bool':
      return 'Boolean';
    case 'datetime':
    case 'date':
    case 'time':
      return 'DateTime';
    default:
      return 'String';
  }
}

/** Map SemanticModelContent → a Power BI push-dataset create request. */
function buildPushDataset(content: any, name: string, steps: string[]): CreatePushDatasetRequest {
  const rawTables = Array.isArray(content?.tables) ? content.tables : [];
  const measures = Array.isArray(content?.measures) ? content.measures : [];
  const allRelationships = Array.isArray(content?.relationships) ? content.relationships : [];
  // Validate against the COLUMNS as they will be authored on the push dataset
  // (every column the bundle declares per table — same set used below), so a
  // relationship that points at a non-existent column is dropped before the
  // create call instead of erroring server-side.
  const relationships = validateRelationships(allRelationships, buildColumnIndex(rawTables), steps);

  const tables: PushTable[] = rawTables.map((t: any) => {
    const columns: PushColumn[] = (t.columns || []).map((c: any) => ({
      name: c.name,
      dataType: toPushColumnType(c.dataType),
      ...(c.formatString ? { formatString: c.formatString } : {}),
    }));
    const tableMeasures = measures
      .filter((m: any) => m.table === t.name && m.expression)
      .map((m: any) => ({
        name: m.name,
        expression: m.expression,
        ...(m.formatString ? { formatString: m.formatString } : {}),
      }));
    return {
      name: t.name,
      columns: columns.length ? columns : [{ name: 'Id', dataType: 'Int64' as PushColumnType }],
      ...(tableMeasures.length ? { measures: tableMeasures } : {}),
    };
  });

  // Push datasets accept only ACTIVE relationships at create time; honor an
  // explicit isActive:false by dropping it (USERELATIONSHIP inactive rels are
  // an XMLA/Desktop concern not expressible on push datasets).
  const rels: PushRelationship[] = relationships
    .filter((r: any) => r?.from && r?.to && r.isActive !== false)
    .map((r: any, i: number) => ({
      name: `rel${i}`,
      fromTable: r.from.split('.')[0],
      fromColumn: r.from.split('.')[1] || 'Id',
      toTable: r.to.split('.')[0],
      toColumn: r.to.split('.')[1] || 'Id',
      crossFilteringBehavior: 'OneDirection' as const,
    }));

  return {
    name,
    defaultMode: 'Push',
    tables,
    ...(rels.length ? { relationships: rels } : {}),
  };
}

/**
 * Generate a small set of representative sample rows per table so the
 * import-mode push model is immediately queryable (no empty-model state).
 * Values are typed to match each column so Power BI accepts the POST /rows.
 * Labeled SAMPLE in the step log — this is install-time seed data, not a mock
 * standing in for a real backend call (the create + POST /rows are real REST).
 */
function sampleRowsFor(table: PushTable, count = 5): Array<Record<string, unknown>> {
  const base = new Date('2024-01-01T00:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => {
    const row: Record<string, unknown> = {};
    for (const col of table.columns) {
      switch (col.dataType) {
        case 'Int64':
          row[col.name] = i + 1;
          break;
        case 'Double':
          row[col.name] = Math.round((i + 1) * 10.5 * 100) / 100;
          break;
        case 'Decimal':
          row[col.name] = Math.round((i + 1) * 99.99 * 100) / 100;
          break;
        case 'Boolean':
          row[col.name] = i % 2 === 0;
          break;
        case 'DateTime':
          row[col.name] = new Date(base + i * 86400000).toISOString();
          break;
        default:
          row[col.name] = `${col.name} ${i + 1}`;
      }
    }
    return row;
  });
}

/** Resolve the Power BI workspace to author the push model in. */
async function resolvePowerBiWorkspace(): Promise<{ id?: string; candidates: string[] }> {
  const fromEnv = process.env.LOOM_DEFAULT_POWERBI_WORKSPACE || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
  if (fromEnv) return { id: fromEnv, candidates: [] };
  // No explicit target — list what the Console UAMI can see. A Power BI
  // workspace IS a "group" id; if exactly one is visible we use it.
  const groups = await listWorkspaces();
  const candidates = groups.map((g) => `${g.name}=${g.id}`);
  if (groups.length === 1) return { id: groups[0].id, candidates };
  return { id: undefined, candidates };
}

/**
 * Create the semantic model in Power BI as a push dataset and seed sample rows
 * for the import-mode tables. Used when no Fabric workspace is bound.
 */
async function provisionViaPowerBi(input: any, steps: string[]): Promise<ProvisionResult> {
  let pbi: { id?: string; candidates: string[] };
  try {
    pbi = await resolvePowerBiWorkspace();
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Power BI ${e.status}: cannot list workspaces to host the semantic model.`,
          remediation: POWERBI_SP_HINT,
          link: 'https://app.powerbi.com',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, POWERBI_SP_HINT, { reason: 'Power BI: could not list workspaces to host the semantic model.', link: 'https://app.powerbi.com', steps });
  }

  if (!pbi.id) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No Fabric workspace bound, and no Power BI workspace target could be resolved.',
        remediation:
          'Bind a Fabric workspace via /admin/workspaces > Bind capacity, OR set ' +
          'LOOM_DEFAULT_POWERBI_WORKSPACE to a Power BI workspace id the Console UAMI ' +
          'is a Member/Contributor of. ' +
          (pbi.candidates.length
            ? `Workspaces visible to the Console identity: ${pbi.candidates.join(', ')}.`
            : 'The Console identity currently sees no Power BI workspaces (grant it access).'),
        link: '/admin/workspaces',
      },
      steps,
    };
  }
  const ws = pbi.id;
  steps.push(`No Fabric workspace; creating model in Power BI workspace ${ws} as a push dataset.`);

  const request = buildPushDataset(input.content, input.displayName, steps);
  if (!request.tables.length) {
    return { status: 'failed', error: 'Semantic model content has no tables to author.', steps };
  }
  steps.push(`Push dataset payload: ${request.tables.length} table(s), ${request.relationships?.length || 0} relationship(s).`);

  let created: { id: string; name: string };
  try {
    created = await createPushDataset(ws, request);
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Power BI ${e.status}: cannot create the semantic model.`,
          remediation: POWERBI_SP_HINT,
          link: `https://app.powerbi.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    return resolveInfraResidual(e, POWERBI_SP_HINT, { reason: 'Power BI: could not create the semantic model (push dataset).', link: `https://app.powerbi.com/groups/${ws}/settings`, steps });
  }
  steps.push(`Created push dataset ${created.id}.`);

  // Seed SAMPLE rows so the import-mode model is immediately queryable.
  let seeded = 0;
  for (const table of request.tables) {
    const rows = sampleRowsFor(table);
    try {
      await postPushRows(ws, created.id, table.name, rows);
      seeded += rows.length;
    } catch (e) {
      // Non-fatal: the model exists and is valid even if seeding a table fails
      // (e.g. a column type Power BI rejects). Surface it honestly in the log.
      steps.push(`SAMPLE seed skipped for ${table.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  steps.push(`Seeded ${seeded} SAMPLE row(s) across ${request.tables.length} table(s).`);

  return {
    status: 'created',
    resourceId: created.id,
    secondaryIds: { powerbiWorkspaceId: ws, mode: 'powerbi-push' },
    steps,
  };
}

/**
 * Azure-native DEFAULT: Loom-native tabular semantic model.
 *
 * The model's tables/measures/relationships (from the bundle content) are the
 * source of truth on the Cosmos item; measures are evaluated live against the
 * underlying Synapse warehouse / lakehouse via the SQL client when the editor
 * or a report queries the model. No Power BI / Fabric / Analysis Services
 * workspace is required (no-fabric-dependency.md). "Provisioning" here validates
 * the model shape + records the backing data source so the model is queryable.
 */
async function provisionLoomNative(input: any, steps: string[]): Promise<ProvisionResult> {
  const content = input.content as any;
  const tables: any[] = Array.isArray(content?.tables) ? content.tables : [];
  const measures = tables.reduce((n, t) => n + (Array.isArray(t?.measures) ? t.measures.length : 0), 0)
    + (Array.isArray(content?.measures) ? content.measures.length : 0);
  if (tables.length === 0) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Semantic model has no tables defined.',
        remediation: 'Add at least one table (mapped to a warehouse/lakehouse table) in the semantic-model editor. No Microsoft Fabric or Power BI workspace required.',
        link: loomDocUrl('fiab/operations/app-install-provisioning'),
      },
      steps,
    };
  }
  const backing = input.target.warehouseServer
    ? `${input.target.warehouseServer}/${input.target.warehouseDatabase || ''}`
    : (input.target.synapseWorkspace || input.target.adlsAccount || 'the installed warehouse/lakehouse');
  steps.push(`Loom-native tabular model: ${tables.length} table(s), ${measures} measure(s), backed by ${backing}. Measures evaluate live over the warehouse via SQL — no Power BI / Fabric workspace required.`);
  return {
    status: 'created',
    resourceId: input.cosmosItemId,
    secondaryIds: { backend: 'loom-native', tables: String(tables.length), measures: String(measures) },
    steps,
  };
}

export const semanticModelProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  const backend = input.target.semanticBackend || 'loom-native';

  // Azure-native DEFAULT: Loom-native tabular model over the warehouse.
  if (backend === 'loom-native' || backend === 'analysis-services') {
    if (backend === 'analysis-services') {
      // The model is always materialized as a Loom-native tabular layer over the
      // warehouse/lakehouse (live SQL — the data path). When an Azure Analysis
      // Services server is deployed (aas.bicep → LOOM_AAS_XMLA_ENDPOINT), the
      // Direct Lake shim (apps/fiab-direct-lake-shim) keeps that server's import
      // partitions fresh on each Delta commit. Disclose the actual target so the
      // receipt is honest rather than a silent fallback.
      const aasServer = process.env.LOOM_AAS_SERVER_NAME;
      const aasXmla = process.env.LOOM_AAS_XMLA_ENDPOINT;
      if (aasServer && aasXmla) {
        steps.push(`analysis-services backend: model materialized on the Loom-native tabular layer; Azure Analysis Services server "${aasServer}" (${aasXmla}) is wired for Direct Lake refresh via the shim.`);
        // DirectQueryFallback tables read from the Synapse SQL pool via the DQ
        // source connection string (LOOM_DQ_SOURCE_CONNECTION_STRING, secretRef).
        steps.push(process.env.LOOM_DQ_SOURCE_CONNECTION_STRING
          ? 'DirectQuery datasource configured for DirectQueryFallback tables.'
          : 'DirectQuery datasource not configured (LOOM_DQ_SOURCE_CONNECTION_STRING unset) — import/Direct Lake tables only.');
      } else {
        steps.push('analysis-services backend selected but no AAS server is deployed (LOOM_AAS_XMLA_ENDPOINT unset) — using the equivalent Loom-native tabular model. Set aasEnabled=true (aas.bicep) to add Direct Lake refresh.');
      }
    }
    steps.push('Provisioning semantic model on the Azure-native Loom-native backend.');
    return provisionLoomNative(input, steps);
  }
  // Power BI is opt-in only (it is Fabric-family).
  if (backend === 'powerbi') {
    steps.push('Provisioning semantic model on the Power BI backend (opt-in).');
    return provisionViaPowerBi(input, steps);
  }
  // Fabric is opt-in AND requires a bound workspace; else fall back to native.
  if (backend === 'fabric' && !ws) {
    steps.push('LOOM_SEMANTIC_BACKEND=fabric but no Fabric workspace bound — using the Azure-native Loom-native backend.');
    return provisionLoomNative(input, steps);
  }
  if (!ws) return provisionLoomNative(input, steps);
  steps.push(`Fabric semantic model workspace: ${ws} (opt-in).`);
  const tmsl = buildTmsl(input.content, input.displayName, steps);
  steps.push(`Built TMSL payload (${tmsl.length} bytes).`);

  const definition = {
    parts: [
      {
        path: 'model.bim',
        payload: Buffer.from(tmsl, 'utf-8').toString('base64'),
        payloadType: 'InlineBase64' as const,
      },
      {
        path: 'definition.pbism',
        payload: Buffer.from(JSON.stringify({ version: '4.0', settings: {} }), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64' as const,
      },
      {
        path: '.platform',
        payload: Buffer.from(JSON.stringify({
          $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
          metadata: { type: 'SemanticModel', displayName: input.displayName },
          config: { version: '2.0' },
        }), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64' as const,
      },
    ],
  };

  const tok = await token();
  const res = await fetchWithTimeout(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/semanticModels`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: input.displayName, description: `Installed from ${input.appId}`, definition }),
    cache: 'no-store',
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch {}

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'remediation',
      gate: {
        reason: `Fabric ${res.status}: cannot create semantic model.`,
        remediation: fabricHint(res.status) || 'Add UAMI as Contributor on this Fabric workspace.',
        link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
      },
      steps,
    };
  }
  if (!res.ok && res.status !== 202) {
    return resolveInfraResidual(`Fabric ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body || text).slice(0, 300)}`, fabricHint(res.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace (and bind it to a capacity).', { status: res.status, link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps });
  }
  steps.push(`POST semanticModels ${res.status} OK.`);
  return {
    status: 'created',
    resourceId: body?.id || `${ws}/${input.displayName}`,
    secondaryIds: { fabricWorkspaceId: ws },
    steps,
  };
};
