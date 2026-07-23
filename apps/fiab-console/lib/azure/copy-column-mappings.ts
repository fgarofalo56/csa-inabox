/**
 * L3 — Copy-activity column-lineage extraction (loom-next-level WS-L).
 *
 * Pure, SDK-free parser that derives column-level lineage from an ADF / Synapse
 * pipeline definition's Copy activities. It reads the Copy activity
 * `typeProperties.translator` (the source→sink column map that ADF authoring
 * writes) and the activity's `inputs[]`/`outputs[]` dataset references, and
 * emits the canonical `ThreadColumnMapping` shape (L1) so every column-lineage
 * source writes ONE model.
 *
 * Grounded in Microsoft Learn — "Schema and data type mapping in copy activity"
 * (learn.microsoft.com/azure/data-factory/copy-activity-schema-and-type-mapping):
 *   - New model:  translator.type = 'TabularTranslator',
 *                 translator.mappings[] = { source: {name|ordinal|path,type?},
 *                                           sink:   {name|ordinal|path,type?} }
 *   - Default mapping (NO translator) = map by column name — columns are not
 *     enumerable from the pipeline def alone, so we auto-map by name ONLY when
 *     caller-supplied dataset structures are available (confidence 'derived').
 *   - Legacy: translator.columnMappings = "src: dst, src2: dst2"  (string)
 *   - Legacy: translator.schemaMapping   = { "src": "dst", ... }   (object)
 *
 * This module has NO Azure SDK imports: it is shared verbatim in intent by the
 * out-of-band lineage-extractor job (azure-functions/lineage-extractor/src/
 * extract.ts) and re-exported from adf-client.ts / synapse-dev-client.ts for any
 * in-console backfill route. Azure-native, no Fabric dependency.
 */

import type { ThreadColumnMapping } from '@/lib/thread/thread-edges';

/** One `translator.mappings[]` endpoint (source or sink column reference). */
export interface TabularTranslatorColumn {
  /** Column name (tabular source/sink). */
  name?: string;
  /** 1-based column index (delimited text without a header line). */
  ordinal?: number;
  /** JSON path (hierarchical source/sink). */
  path?: string;
  /** Interim data type — a source≠sink type is surfaced as a cast transform. */
  type?: string;
}

/** The Copy activity `typeProperties.translator` shape (new + both legacy). */
export interface CopyActivityTranslator {
  type?: string;
  /** New model: explicit per-column source→sink mappings. */
  mappings?: Array<{ source?: TabularTranslatorColumn; sink?: TabularTranslatorColumn }>;
  /** Legacy string model: "srcCol: sinkCol, srcCol2: sinkCol2". */
  columnMappings?: string;
  /** Legacy object model: { srcCol: sinkCol, ... } (source→sink). */
  schemaMapping?: Record<string, string>;
  /** A parameterized/expression translator (@pipeline().parameters.x) — unknowable statically. */
  value?: unknown;
}

/** How confidently the column map was derived (drives L1 `confidence`). */
export type MappingKind = 'declared' | 'derived' | 'none';

/** One Copy activity's resolved column lineage (may be table-grain only). */
export interface CopyColumnLineage {
  /** The Copy activity name. */
  activityName: string;
  /** `inputs[0].referenceName` — the source dataset (undefined if absent). */
  sourceDataset?: string;
  /** `outputs[0].referenceName` — the sink dataset (undefined if absent). */
  sinkDataset?: string;
  /**
   * Canonical L1 column mappings. Empty ⇒ table-grain edge only (the caller
   * records the item→item edge without a `columnMappings` facet).
   */
  columnMappings: ThreadColumnMapping[];
  /** 'declared' explicit translator, 'derived' name auto-map, 'none' table-grain. */
  mappingKind: MappingKind;
}

/** Optional per-dataset column lists (dataset `structure[].name`) for the
 *  default-mapping (no-translator) auto-map path. Keyed by dataset name. */
export type DatasetStructures = Record<string, string[]>;

interface RawActivity {
  name?: string;
  type?: string;
  inputs?: Array<{ referenceName?: string; type?: string }>;
  outputs?: Array<{ referenceName?: string; type?: string }>;
  typeProperties?: { translator?: CopyActivityTranslator | { type?: string; value?: unknown } };
}

interface RawPipelineDef {
  name?: string;
  properties?: { activities?: RawActivity[] };
  // Some ADF GET shapes nest activities directly (Synapse artifact list).
  activities?: RawActivity[];
}

function normStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** A usable column identifier for a translator endpoint — name wins, else an
 *  ordinal token, else a JSON path. Returns undefined when none is present. */
function columnId(col: TabularTranslatorColumn | undefined): string | undefined {
  if (!col) return undefined;
  const name = normStr(col.name);
  if (name) return name;
  if (typeof col.ordinal === 'number' && Number.isFinite(col.ordinal)) return `#${col.ordinal}`;
  const path = normStr(col.path);
  if (path) return path;
  return undefined;
}

/** A source→sink type change is surfaced as a CAST transform; identical (or
 *  unknown) types are a straight 1:1 copy. */
function transformFor(src?: TabularTranslatorColumn, sink?: TabularTranslatorColumn): string | undefined {
  const st = normStr(src?.type);
  const dt = normStr(sink?.type);
  if (st && dt && st.toLowerCase() !== dt.toLowerCase()) return `CAST(${st}→${dt})`;
  return undefined;
}

/** Parse the legacy `columnMappings` string ("a: b, c: d") into pairs. */
function parseLegacyColumnMappings(spec: string): ThreadColumnMapping[] {
  const out: ThreadColumnMapping[] = [];
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

/** Resolve one Copy activity's column mappings from its translator. */
function mappingsFromTranslator(
  translator: CopyActivityTranslator | undefined,
): { columnMappings: ThreadColumnMapping[]; kind: MappingKind } {
  if (!translator) return { columnMappings: [], kind: 'none' };

  // A parameterized/expression translator resolves only at run time — we cannot
  // know its columns from the static def; treat as table-grain (honest).
  if (translator.value !== undefined && !Array.isArray(translator.mappings)) {
    return { columnMappings: [], kind: 'none' };
  }

  // New model — translator.mappings[]
  if (Array.isArray(translator.mappings) && translator.mappings.length) {
    const cols: ThreadColumnMapping[] = [];
    for (const m of translator.mappings) {
      const from = columnId(m?.source);
      const to = columnId(m?.sink);
      if (!from || !to) continue; // partial/ordinal-only pair → not resolvable
      const transform = transformFor(m?.source, m?.sink);
      cols.push({ fromColumn: from, toColumn: to, confidence: 'declared', ...(transform ? { transform } : {}) });
    }
    return { columnMappings: cols, kind: cols.length ? 'declared' : 'none' };
  }

  // Legacy string model — translator.columnMappings
  const legacyStr = normStr(translator.columnMappings);
  if (legacyStr) {
    const cols = parseLegacyColumnMappings(legacyStr);
    return { columnMappings: cols, kind: cols.length ? 'declared' : 'none' };
  }

  // Legacy object model — translator.schemaMapping { src: dst }
  if (translator.schemaMapping && typeof translator.schemaMapping === 'object') {
    const cols: ThreadColumnMapping[] = [];
    for (const [from, to] of Object.entries(translator.schemaMapping)) {
      const f = normStr(from);
      const t = normStr(to);
      if (f && t) cols.push({ fromColumn: f, toColumn: t, confidence: 'declared' });
    }
    return { columnMappings: cols, kind: cols.length ? 'declared' : 'none' };
  }

  return { columnMappings: [], kind: 'none' };
}

/**
 * Default-mapping (no explicit translator) auto-map by column name — ADF's
 * documented default behavior. Only possible when the caller supplies the
 * source AND sink dataset structures; matched-by-name columns are 'derived'
 * (we inferred them from schema, not an authored translator).
 */
function deriveByName(
  sourceCols: string[] | undefined,
  sinkCols: string[] | undefined,
): ThreadColumnMapping[] {
  if (!sourceCols?.length || !sinkCols?.length) return [];
  const sinkSet = new Map(sinkCols.map((c) => [c.toLowerCase(), c]));
  const out: ThreadColumnMapping[] = [];
  for (const s of sourceCols) {
    const hit = sinkSet.get(s.toLowerCase());
    if (hit) out.push({ fromColumn: s, toColumn: hit, confidence: 'derived' });
  }
  return out;
}

/**
 * Walk a pipeline definition's Copy activities and return the column lineage per
 * activity. `datasetStructures` (optional) enables the default-mapping auto-map
 * path for Copy activities that carry no explicit translator.
 *
 * Returns ONE {@link CopyColumnLineage} per `type==='Copy'` activity — including
 * table-grain-only ones (`columnMappings: []`, `mappingKind: 'none'`) so the
 * caller can still record the item→item edge. Non-Copy activities are ignored.
 */
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
    const translator = act.typeProperties?.translator as CopyActivityTranslator | undefined;

    let { columnMappings, kind } = mappingsFromTranslator(translator);

    // No explicit translator → attempt the documented default (by-name) auto-map
    // from supplied dataset structures (confidence 'derived').
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
