/**
 * L4 — Purview classic Data Map column-level lineage: pure helpers + types
 * (loom-next-level WS-L). Extracted from purview-client.ts (extend-then-decompose
 * — that module is ratchet-frozen) so the SDK-free column-map serialization /
 * parsing is independently unit-testable. The network functions
 * (createAtlasColumnLineage / ensureColumnEntities / getProcessColumnMappings)
 * stay in purview-client where the private data-plane fetch lives, and re-export
 * these types.
 *
 * The Atlas Process `columnMapping` attribute is a JSON string of DatasetMapping
 * + ColumnMapping blocks (the ADF-emitted convention) that classic Purview
 * renders as per-column arrows in a process node's Columns panel.
 *   https://learn.microsoft.com/purview/data-gov-classic-lineage-user-guide#process-column-lineage
 */

/** One source→sink column pair within a dataset→dataset mapping. */
export interface AtlasColumnMap { source: string; sink: string }

/** A per-dataset column mapping block for a Process `columnMapping` attribute. */
export interface DatasetColumnMapping {
  /** qualifiedName of the source (input) dataset. */
  sourceDatasetQualifiedName: string;
  /** qualifiedName of the sink (output) dataset. */
  sinkDatasetQualifiedName: string;
  columns: AtlasColumnMap[];
}

/**
 * A single column→column mapping parsed from a Process entity's `columnMapping`
 * attribute. Mirrors the L1 column facet so unified-lineage merges Purview-native
 * column edges into the same `col:` identity model.
 */
export interface PurviewColumnEdge {
  /** The Process (copy activity) entity carrying this mapping, when known. */
  processGuid?: string;
  /** qualifiedName of the source dataset the column belongs to. */
  sourceDatasetQualifiedName: string;
  /** qualifiedName of the sink dataset the column belongs to. */
  sinkDatasetQualifiedName: string;
  fromColumn: string;
  toColumn: string;
}

/**
 * Serialize dataset column mappings into the Atlas `columnMapping` attribute
 * string — the ADF-standard shape Purview parses for process column lineage:
 *   `[{ "DatasetMapping": { "Source": <srcQN>, "Sink": <sinkQN> },
 *       "ColumnMapping": [ { "Source": "col_a", "Sink": "ColA" } ] }]`
 * Empty/mapping-less blocks are dropped (an empty `"[]"` must never clobber a
 * prior column map on re-upsert).
 */
export function buildColumnMappingAttribute(mappings: DatasetColumnMapping[]): string {
  const blocks = (mappings || [])
    .filter((m) => m && m.sourceDatasetQualifiedName && m.sinkDatasetQualifiedName && m.columns?.length)
    .map((m) => ({
      DatasetMapping: { Source: m.sourceDatasetQualifiedName, Sink: m.sinkDatasetQualifiedName },
      ColumnMapping: m.columns
        .filter((c) => c && c.source && c.sink)
        .map((c) => ({ Source: c.source, Sink: c.sink })),
    }))
    .filter((b) => b.ColumnMapping.length);
  return JSON.stringify(blocks);
}

/**
 * Parse a Process entity's `columnMapping` attribute (JSON string OR the
 * already-parsed array) into flat {@link PurviewColumnEdge}s. Tolerant of
 * malformed input (returns []). The READ side of L4.
 */
export function parseAtlasColumnMapping(raw: unknown, processGuid?: string): PurviewColumnEdge[] {
  let arr: any = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out: PurviewColumnEdge[] = [];
  for (const block of arr) {
    const src = block?.DatasetMapping?.Source;
    const sink = block?.DatasetMapping?.Sink;
    const cols = block?.ColumnMapping;
    if (typeof src !== 'string' || typeof sink !== 'string' || !Array.isArray(cols)) continue;
    for (const c of cols) {
      const from = c?.Source;
      const to = c?.Sink;
      if (typeof from === 'string' && typeof to === 'string' && from && to) {
        out.push({ processGuid, sourceDatasetQualifiedName: src, sinkDatasetQualifiedName: sink, fromColumn: from, toColumn: to });
      }
    }
  }
  return out;
}
