/**
 * ASA SAQL compiler — Eventstream transform nodes → Stream Analytics Query
 * Language (SAQL).
 *
 * Pure, side-effect-free TypeScript. No React, no fetch. The Eventstream
 * visual designer feeds its { sources, transforms[], sinks } topology in and
 * gets a complete SAQL string out, suitable for
 *   PUT /streamingjobs/{name}/transformations  (saveTransformation)
 * and for the ASA compile/test-query ARM actions.
 *
 * Why this exists (no-freeform-config rule): operators build each transform
 * through guided fields (function dropdowns, window pickers, group-by lists).
 * The ONLY freeform slots are the three single-expression boxes (WHERE,
 * HAVING, JOIN ... ON) which are the explicitly-allowed 1:1 builder
 * exception. The whole query is never hand-edited in the builder; it is
 * always generated here so the model stays the source of truth.
 *
 * SAQL semantics grounded in the Stream Analytics Query Language reference
 * (learn.microsoft.com/stream-analytics-query): TIMESTAMP BY, GROUP BY with
 * TumblingWindow / HoppingWindow / SlidingWindow / SessionWindow /
 * SnapshotWindow, System.Timestamp(), HAVING, JOIN ... DATEDIFF, UNION, WITH.
 */

// ============================================================
// Canonical node types (shared with the visual designer, which re-exports
// these so existing importers keep working). Kept here so the compiler has
// zero dependency on the React component file.
// ============================================================

export type SourceKind = 'eventhub' | 'iothub' | 'sample' | 'cdc-mirror' | 'kafka' | 'custom-app';
export type TransformKind = 'filter' | 'aggregate' | 'group-by' | 'project' | 'union' | 'join' | 'window';
export type SinkKind = 'kusto' | 'lakehouse' | 'eventhub' | 'reflex' | 'derivedStream';

export type AsaAggregateFunc = 'AVG' | 'SUM' | 'COUNT' | 'MIN' | 'MAX';
export type AsaWindowType = 'Tumbling' | 'Hopping' | 'Session' | 'Sliding' | 'Snapshot';
export type AsaWindowUnit = 'second' | 'minute' | 'hour' | 'day';
export type AsaJoinType = 'INNER' | 'LEFT OUTER';

export interface AggregateSpec {
  func: AsaAggregateFunc;
  /** column name, or '*' for COUNT */
  field: string;
  alias: string;
}

/** Real ingest endpoint resolved/provisioned by the source BFF route. */
export interface ProvisionedEndpoint {
  fqdn?: string;
  entityPath?: string;
  kafkaBootstrap?: string;
  auth?: 'entra' | 'sas';
  connectionString?: string | null;
  localAuthDisabled?: boolean;
  saslConfig?: string;
}

export interface SourceNode {
  kind: SourceKind;
  name: string;
  namespace?: string;
  consumerGroup?: string;
  iotHub?: string;
  connectionString?: string;
  topic?: string;
  // Event Hubs / custom-app entity name.
  eventHubName?: string;
  // IoT Hub ARM lookup overrides.
  iotHubResourceGroup?: string;
  iotHubSubscriptionId?: string;
  // CDC (ADF) source descriptor.
  cdcDatabaseType?: 'sqlserver' | 'postgresql' | 'mysql' | 'cosmosdb';
  cdcServerHost?: string;
  cdcDatabase?: string;
  cdcTable?: string;
  cdcUsername?: string;
  cdcAdfPipelineName?: string;
  // Filled after provisioning by /api/items/eventstream/[id]/source.
  provisionedEndpoint?: ProvisionedEndpoint;
}

export interface TransformNode {
  kind: TransformKind;
  name: string;
  // Filter ── allowed 1:1 expression slot
  expression?: string; // WHERE condition
  // Projection / aggregate
  selectFields?: string[]; // raw columns to project
  aggregates?: AggregateSpec[];
  groupBy?: string[]; // GROUP BY columns
  timestampBy?: string; // TIMESTAMP BY column (applied at the source read)
  // Window
  windowType?: AsaWindowType;
  windowSize?: number;
  windowUnit?: AsaWindowUnit;
  hopSize?: number; // HoppingWindow hop / SessionWindow max-duration
  havingExpression?: string; // HAVING ── allowed 1:1 expression slot
  // Join
  joinSource?: string; // right-stream alias (an existing source name)
  joinType?: AsaJoinType;
  joinOn?: string; // ON condition ── allowed 1:1 expression slot
  joinDurationSeconds?: number; // DATEDIFF bound
  // Legacy / misc (kept wire-compatible with pre-existing Cosmos state)
  columns?: string[];
  window?: string;
}

export interface SinkNode {
  kind: SinkKind;
  name: string;
  // kusto / KQL Database (ADX)
  kustoClusterUrl?: string;
  database?: string;
  table?: string;
  // lakehouse / ADLS Gen2 (Azure-native default)
  storageAccount?: string;
  storageAccountKey?: string;
  container?: string;
  pathPattern?: string;
  dateFormat?: string;
  timeFormat?: string;
  // eventhub + activator-via-eventhub
  eventHubName?: string;
  namespace?: string;
  sharedAccessPolicyName?: string;
  sharedAccessPolicyKey?: string;
  // legacy Fabric-only fields (preserved for backward compat; NOT sent to ASA)
  lakehouseId?: string;
  workspaceId?: string;
  reflexId?: string;
}

export interface PipelineConfig {
  sources?: SourceNode[];
  source?: SourceNode; // legacy single-source
  transforms?: TransformNode[];
  sink?: SinkNode;
  sinks?: SinkNode[];
}

export const SAQL_HEADER =
  '-- Generated by CSA Loom ASA Query Builder — edit the transform nodes, not this text.';

// ============================================================
// Helpers
// ============================================================

/** Bracket an alias (strip any pre-existing brackets first). */
function br(name: string | undefined): string {
  const clean = (name || 'input').replace(/[[\]]/g, '').trim();
  return `[${clean || 'input'}]`;
}

function tsBy(ts?: string): string {
  const v = (ts || '').trim();
  return v ? ` TIMESTAMP BY ${v}` : '';
}

/** Build the windowing function call for a GROUP BY clause, or null. */
export function windowClause(t: TransformNode): string | null {
  if (!t.windowType) return null;
  const unit = t.windowUnit || 'second';
  const size = t.windowSize ?? 30;
  switch (t.windowType) {
    case 'Tumbling':
      return `TumblingWindow(${unit}, ${size})`;
    case 'Hopping':
      return `HoppingWindow(${unit}, ${size}, ${t.hopSize ?? size})`;
    case 'Sliding':
      return `SlidingWindow(${unit}, ${size})`;
    case 'Session':
      return `SessionWindow(${unit}, ${size}, ${t.hopSize ?? size})`;
    case 'Snapshot':
      return 'SnapshotWindow()';
    default:
      return null;
  }
}

/** SELECT column list for an aggregate / group-by / window step. */
function aggregateSelectList(t: TransformNode): string {
  const parts: string[] = [];
  (t.groupBy || []).forEach((c) => c && parts.push(c.trim()));
  (t.selectFields || []).forEach((c) => c && parts.push(c.trim()));
  (t.aggregates || []).forEach((a) => {
    if (!a || !a.func) return;
    const field = a.func === 'COUNT' ? (a.field && a.field !== '*' ? a.field : '*') : a.field || '*';
    const alias = (a.alias || `${a.func.toLowerCase()}_${(a.field || 'all').replace(/[^A-Za-z0-9_]/g, '')}`).trim();
    parts.push(`${a.func}(${field}) AS ${alias}`);
  });
  if (windowClause(t)) parts.push('System.Timestamp() AS windowEnd');
  return parts.length ? parts.join(', ') : '*';
}

function groupByClause(t: TransformNode): string {
  const gb: string[] = [...(t.groupBy || []).map((c) => c.trim()).filter(Boolean)];
  const w = windowClause(t);
  if (w) gb.push(w);
  return gb.length ? `\nGROUP BY ${gb.join(', ')}` : '';
}

function havingClause(t: TransformNode): string {
  const h = (t.havingExpression || '').trim();
  return h ? `\nHAVING ${h}` : '';
}

/**
 * The SELECT column list for a transform (without the leading "SELECT").
 */
function selectListFor(t: TransformNode): string {
  switch (t.kind) {
    case 'aggregate':
    case 'group-by':
    case 'window':
      return aggregateSelectList(t);
    case 'project':
      return (t.selectFields && t.selectFields.length)
        ? t.selectFields.map((c) => c.trim()).filter(Boolean).join(', ')
        : '*';
    case 'join':
      return 'L.*, R.*';
    case 'filter':
    case 'union':
    default:
      return '*';
  }
}

/**
 * The clause that follows the SELECT-list (FROM/WHERE/GROUP BY/JOIN/UNION),
 * without the INTO. `fromRef` is the already-bracketed source alias OR a CTE
 * step name. `isSource` is true when fromRef is a real input (TIMESTAMP BY is
 * only valid against an input, not a CTE step).
 */
function tailFor(
  t: TransformNode,
  fromRef: string,
  isSource: boolean,
  sources: SourceNode[],
): string {
  const ts = isSource ? tsBy(t.timestampBy) : '';
  switch (t.kind) {
    case 'filter': {
      const where = (t.expression || '').trim();
      return `FROM ${fromRef}${ts}${where ? `\nWHERE ${where}` : ''}`;
    }
    case 'aggregate':
    case 'group-by':
    case 'window':
      return `FROM ${fromRef}${ts}${groupByClause(t)}${havingClause(t)}`;
    case 'project':
      return `FROM ${fromRef}${ts}`;
    case 'join': {
      const right = br(t.joinSource || sources[1]?.name || 'right');
      const jt = t.joinType || 'INNER';
      const on = (t.joinOn || 'L.id = R.id').trim();
      const dur = t.joinDurationSeconds ?? 60;
      return (
        `FROM ${fromRef} L${ts}\n` +
        `${jt} JOIN ${right} R${tsBy(t.timestampBy)}\n` +
        `ON ${on}\n` +
        `AND DATEDIFF(second, L, R) BETWEEN 0 AND ${dur}`
      );
    }
    case 'union': {
      const aliases = sources.length ? sources.map((s) => br(s.name)) : [fromRef];
      const [first, ...rest] = aliases;
      const head = `FROM ${first}`;
      const tail = rest.map((a) => `UNION\nSELECT *\nFROM ${a}`).join('\n');
      return tail ? `${head}\n${tail}` : head;
    }
    default:
      return `FROM ${fromRef}${ts}`;
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Compile the full topology to a SAQL string.
 *
 * - Zero transforms → pass-through SELECT * per sink.
 * - One transform → a direct SELECT … INTO … FROM … statement per sink.
 * - Multiple transforms → a WITH … chain (each step reads the previous),
 *   final SELECT * INTO each sink.
 * - `union` always materializes through a WITH step so the merged stream has
 *   a single INTO.
 */
export function compileToSaql(
  sources: SourceNode[],
  transforms: TransformNode[],
  sinks: SinkNode[],
): string {
  const srcAlias = br(sources[0]?.name || 'input');
  const sinkList: SinkNode[] = sinks.length ? sinks : [{ kind: 'kusto', name: 'output' }];

  // Pass-through.
  if (!transforms.length) {
    const body = sinkList
      .map((sk) => `SELECT *\nINTO ${br(sk.name)}\nFROM ${srcAlias}`)
      .join(';\n\n');
    return `${SAQL_HEADER}\n\n${body}\n`;
  }

  const hasUnion = transforms.some((t) => t.kind === 'union');

  // Single transform, no union → direct, readable statement(s).
  if (transforms.length === 1 && !hasUnion) {
    const t = transforms[0];
    const selectList = selectListFor(t);
    const body = sinkList
      .map((sk) => {
        const tail = tailFor(t, srcAlias, true, sources);
        // Inject INTO between the SELECT-list and the FROM-clause.
        return `SELECT ${selectList}\nINTO ${br(sk.name)}\n${tail}`;
      })
      .join(';\n\n');
    return `${SAQL_HEADER}\n\n${body}\n`;
  }

  // Multi-transform (or union) → WITH chain.
  const ctes: string[] = [];
  let prev = srcAlias;
  let prevIsSource = true;
  transforms.forEach((t, i) => {
    const stepName = `step${i + 1}`;
    const selectList = selectListFor(t);
    const tail = tailFor(t, prev, prevIsSource, sources);
    const inner = `  SELECT ${selectList}\n  ${tail.replace(/\n/g, '\n  ')}`;
    ctes.push(`${stepName} AS (\n${inner}\n)`);
    prev = stepName;
    prevIsSource = false;
  });

  const finalSelects = sinkList
    .map((sk) => `SELECT *\nINTO ${br(sk.name)}\nFROM ${prev}`)
    .join(';\n\n');

  return `${SAQL_HEADER}\n\nWITH ${ctes.join(',\n')}\n${finalSelects}\n`;
}
