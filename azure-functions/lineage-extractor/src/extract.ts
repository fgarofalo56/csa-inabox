/**
 * lineage-extractor — pure, SDK-free extraction core (loom-next-level WS-L, L3).
 *
 * Given an ADF / Synapse pipeline definition and the resolved Loom endpoints for
 * each dataset it references, produce the item→item lineage edges (with the L1
 * `columnMappings` facet) that a completed Copy-activity run implies. NO Azure
 * SDK imports here so the whole mapping is unit-tested against golden fixtures;
 * clients.ts does the IO (Cosmos writes + ADF/Synapse run reads).
 *
 * The Copy-activity translator parsing is intentionally the SAME shape the
 * console's lib/azure/copy-column-mappings.ts uses (they are kept in lockstep):
 * this package cannot import the Next.js console lib, so the parser is vendored
 * here. Grounded in Microsoft Learn "Schema and data type mapping in copy
 * activity".
 */

/** One column→column mapping (matches the console L1 `ThreadColumnMapping`). */
export interface ColumnMapping {
  fromColumn: string;
  toColumn: string;
  transform?: string;
  confidence?: 'declared' | 'derived';
}

export interface TabularTranslatorColumn {
  name?: string;
  ordinal?: number;
  path?: string;
  type?: string;
}

export interface CopyActivityTranslator {
  type?: string;
  mappings?: Array<{ source?: TabularTranslatorColumn; sink?: TabularTranslatorColumn }>;
  columnMappings?: string;
  schemaMapping?: Record<string, string>;
  value?: unknown;
}

export type MappingKind = 'declared' | 'derived' | 'none';

export interface CopyColumnLineage {
  activityName: string;
  sourceDataset?: string;
  sinkDataset?: string;
  columnMappings: ColumnMapping[];
  mappingKind: MappingKind;
}

export type DatasetStructures = Record<string, string[]>;

/** The resolved Loom endpoint a dataset reference maps to. */
export interface DatasetEndpoint {
  itemId?: string;
  itemType?: string;
  itemName?: string;
  /** The tenant (oid) that owns the item — the ThreadEdge partition key. */
  tenantId?: string;
  /** Column names for the default-mapping (by-name) auto-map path. */
  columns?: string[];
}

/** An item→item lineage edge ready to persist as a ThreadEdge. */
export interface LineageEdgeInput {
  tenantId: string;
  fromItemId: string;
  fromType: string;
  fromName?: string;
  toItemId: string;
  toType: string;
  toName?: string;
  action: string;
  columnMappings?: ColumnMapping[];
  /** The pipeline run that produced this edge (idempotency + provenance). */
  runId?: string;
  pipelineName?: string;
}

function normStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

function columnId(col: TabularTranslatorColumn | undefined): string | undefined {
  if (!col) return undefined;
  const name = normStr(col.name);
  if (name) return name;
  if (typeof col.ordinal === 'number' && Number.isFinite(col.ordinal)) return `#${col.ordinal}`;
  const path = normStr(col.path);
  if (path) return path;
  return undefined;
}

function transformFor(src?: TabularTranslatorColumn, sink?: TabularTranslatorColumn): string | undefined {
  const st = normStr(src?.type);
  const dt = normStr(sink?.type);
  if (st && dt && st.toLowerCase() !== dt.toLowerCase()) return `CAST(${st}→${dt})`;
  return undefined;
}

function parseLegacyColumnMappings(spec: string): ColumnMapping[] {
  const out: ColumnMapping[] = [];
  for (const pairRaw of spec.split(',')) {
    const pair = pairRaw.trim();
    if (!pair) continue;
    const colon = pair.indexOf(':');
    if (colon < 0) continue;
    const from = pair.slice(0, colon).trim();
    const to = pair.slice(colon + 1).trim();
    if (from && to) out.push({ fromColumn: from, toColumn: to, confidence: 'declared' });
  }
  return out;
}

function mappingsFromTranslator(
  translator: CopyActivityTranslator | undefined,
): { columnMappings: ColumnMapping[]; kind: MappingKind } {
  if (!translator) return { columnMappings: [], kind: 'none' };
  if (translator.value !== undefined && !Array.isArray(translator.mappings)) {
    return { columnMappings: [], kind: 'none' };
  }
  if (Array.isArray(translator.mappings) && translator.mappings.length) {
    const cols: ColumnMapping[] = [];
    for (const m of translator.mappings) {
      const from = columnId(m?.source);
      const to = columnId(m?.sink);
      if (!from || !to) continue;
      const transform = transformFor(m?.source, m?.sink);
      cols.push({ fromColumn: from, toColumn: to, confidence: 'declared', ...(transform ? { transform } : {}) });
    }
    return { columnMappings: cols, kind: cols.length ? 'declared' : 'none' };
  }
  const legacyStr = normStr(translator.columnMappings);
  if (legacyStr) {
    const cols = parseLegacyColumnMappings(legacyStr);
    return { columnMappings: cols, kind: cols.length ? 'declared' : 'none' };
  }
  if (translator.schemaMapping && typeof translator.schemaMapping === 'object') {
    const cols: ColumnMapping[] = [];
    for (const [from, to] of Object.entries(translator.schemaMapping)) {
      const f = normStr(from);
      const t = normStr(to);
      if (f && t) cols.push({ fromColumn: f, toColumn: t, confidence: 'declared' });
    }
    return { columnMappings: cols, kind: cols.length ? 'declared' : 'none' };
  }
  return { columnMappings: [], kind: 'none' };
}

function deriveByName(sourceCols?: string[], sinkCols?: string[]): ColumnMapping[] {
  if (!sourceCols?.length || !sinkCols?.length) return [];
  const sinkSet = new Map(sinkCols.map((c) => [c.toLowerCase(), c]));
  const out: ColumnMapping[] = [];
  for (const s of sourceCols) {
    const hit = sinkSet.get(s.toLowerCase());
    if (hit) out.push({ fromColumn: s, toColumn: hit, confidence: 'derived' });
  }
  return out;
}

interface RawActivity {
  name?: string;
  type?: string;
  inputs?: Array<{ referenceName?: string }>;
  outputs?: Array<{ referenceName?: string }>;
  typeProperties?: { translator?: CopyActivityTranslator };
}
interface RawPipelineDef {
  name?: string;
  properties?: { activities?: RawActivity[] };
  activities?: RawActivity[];
}

/** Walk a pipeline def's Copy activities → per-activity column lineage. */
export function readCopyColumnMappings(
  pipelineDef: unknown,
  datasetStructures?: DatasetStructures,
): CopyColumnLineage[] {
  const def = (pipelineDef || {}) as RawPipelineDef;
  const activities = def.properties?.activities ?? def.activities ?? [];
  if (!Array.isArray(activities)) return [];
  const out: CopyColumnLineage[] = [];
  for (const act of activities) {
    if (!act || act.type !== 'Copy') continue;
    const activityName = normStr(act.name) || 'Copy';
    const sourceDataset = normStr(act.inputs?.[0]?.referenceName);
    const sinkDataset = normStr(act.outputs?.[0]?.referenceName);
    const translator = act.typeProperties?.translator;
    let { columnMappings, kind } = mappingsFromTranslator(translator);
    if (kind === 'none' && datasetStructures && sourceDataset && sinkDataset) {
      const derived = deriveByName(datasetStructures[sourceDataset], datasetStructures[sinkDataset]);
      if (derived.length) {
        columnMappings = derived;
        kind = 'derived';
      }
    }
    out.push({ activityName, sourceDataset, sinkDataset, columnMappings, mappingKind: kind });
  }
  return out;
}

/**
 * Resolve a pipeline def + its dataset endpoints into persistable item→item
 * lineage edges. An edge is produced only when BOTH endpoints resolve to a Loom
 * item id sharing the same tenant (cross-tenant edges are impossible — the
 * ThreadEdge PK is the tenant). Column mappings ride the edge when present;
 * a translator-less Copy still yields a table-grain edge.
 */
export function extractLineageEdges(
  pipelineDef: unknown,
  datasetEndpoints: Record<string, DatasetEndpoint>,
  opts: { action?: string; runId?: string } = {},
): LineageEdgeInput[] {
  const structures: DatasetStructures = {};
  for (const [name, ep] of Object.entries(datasetEndpoints)) {
    if (ep?.columns?.length) structures[name] = ep.columns;
  }
  const def = (pipelineDef || {}) as RawPipelineDef;
  const pipelineName = normStr(def.name);
  const action = opts.action || 'adf-copy';
  const copies = readCopyColumnMappings(pipelineDef, structures);
  const edges: LineageEdgeInput[] = [];
  for (const c of copies) {
    const src = c.sourceDataset ? datasetEndpoints[c.sourceDataset] : undefined;
    const dst = c.sinkDataset ? datasetEndpoints[c.sinkDataset] : undefined;
    if (!src?.itemId || !dst?.itemId) continue;
    // The edge partition key is the SINK item's tenant (the produced asset).
    const tenantId = dst.tenantId || src.tenantId;
    if (!tenantId) continue;
    edges.push({
      tenantId,
      fromItemId: src.itemId,
      fromType: src.itemType || 'dataset',
      fromName: src.itemName,
      toItemId: dst.itemId,
      toType: dst.itemType || 'dataset',
      toName: dst.itemName,
      action,
      ...(c.columnMappings.length ? { columnMappings: c.columnMappings } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(pipelineName ? { pipelineName } : {}),
    });
  }
  return edges;
}

/** Deterministic edge id — the console's recordThreadEdge convention so the
 *  extractor UPSERTS (never duplicates) the same source→sink→action edge. */
export function edgeId(e: Pick<LineageEdgeInput, 'tenantId' | 'fromItemId' | 'toItemId' | 'action'>): string {
  return `edge_${e.tenantId}_${e.fromItemId}_${e.toItemId}_${e.action}`.replace(/[^A-Za-z0-9_-]/g, '_');
}
