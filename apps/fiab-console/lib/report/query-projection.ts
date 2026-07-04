/**
 * lib/report/query-projection.ts
 *
 * The report renderer's wells → SQL PROJECTION layer, extracted verbatim from
 * app/api/items/report/[id]/query/route.ts (rel-T64) so it is shared by BOTH the
 * report /query route and the /script-visual route (which previously carried a
 * byte-identical private copy of every helper below). Behaviour-preserving: the
 * only signature change is that `referencedTables` / `toSqlSource` /
 * `projectSourceGroups` take `filters` as an OPTIONAL argument — the /query route
 * passes the Filters-pane predicates, the /script-visual route passes nothing
 * (script visuals carry no Filters-pane channel), and an absent `filters` loops
 * over an empty list exactly as the script-visual copy did.
 *
 * This projects the resolver's `ReportSqlSource` (a model-table→base-relation
 * map, or a direct-query derived SELECT, or the Wave-2 per-table source-groups
 * arm) onto the single-FROM `wells-to-sql` compiler. Multi-table honesty
 * (no-vaporware) and the Wave-2 storage-mode cache-vs-live pick are unchanged.
 *
 * SHARED CONTRACT: storage-mode-pane.tsx owns the `StorageMode` union; the
 * resolver owns `SourceGroupSqlSource` / `TableSourceBinding`; wells-to-sql owns
 * the `isAggregateVisual` / `pickRelation` / `groupVisualBindings` helpers. They
 * are consumed here through small string-validated LOCAL MIRRORS — the exact
 * client→server mirror pattern the routes used — so this module compiles
 * standalone and stays robust to the landing order of its sibling modules, while
 * binding to the SAME `resolved.sqlSource` shape at runtime.
 */

import { type DaxVisual } from '@/lib/azure/aas-client';
import { type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import { type FieldTable, type ReportSqlSource } from '@/lib/azure/report-model-resolver';
import {
  type SqlSource,
  type SqlSourceColumn,
  type SqlSourceFrom,
  type ReportFilterInput,
} from '@/lib/azure/wells-to-sql';

/** Collect the model-table names a visual + its filters reference. */
export function referencedTables(visual: DaxVisual, filters?: ReportFilterInput[] | undefined): string[] {
  const out = new Set<string>();
  const wells = visual.wells || {};
  for (const arr of [wells.category, wells.values, wells.legend]) {
    for (const w of arr || []) if (w?.table) out.add(w.table);
  }
  for (const f of filters || []) if (f?.table) out.add(f.table);
  return [...out];
}

/** Map resolved Fields columns of one table to the compiler's column whitelist. */
export function whitelist(table: FieldTable | undefined): SqlSourceColumn[] {
  return (table?.columns || []).map((c) => ({
    table: table?.name,
    name: c.name,
    dataType: c.dataType,
  }));
}

/**
 * Outcome of projecting the resolved model onto the single-FROM SQL compiler:
 *   • `ok`          — a bindable `SqlSource` (one model table or the derived
 *                     SELECT). `target` is set ONLY on the Wave-2 source-groups
 *                     path, where the chosen relation (live pool vs serverless
 *                     Delta cache) runs on its OWN Synapse target; absent ⇒ the
 *                     single-source caller keeps the resolver-pinned target.
 *   • `no-columns`  — nothing bindable resolved (caller → generic 400)
 *   • `multi-table` — the visual binds across >1 model table; the single-FROM
 *                     compiler can't join them, so the caller returns an honest
 *                     400 naming the tables + remediation (never a silent drop).
 *   • `limited`     — Wave-2 cross-storage-group ("limited relationship") visual;
 *                     the caller returns an honest 412 naming the smaller side to
 *                     materialize (never a silent partial join).
 */
export type ToSqlSourceResult =
  | { kind: 'ok'; source: SqlSource; target?: SynapseTarget }
  | { kind: 'no-columns' }
  | { kind: 'multi-table'; tables: string[] }
  | { kind: 'limited'; smaller: string; cacheReady: boolean; groups: string[] };

// ── REPORT-DESIGNER PARITY · WAVE 2 — per-table STORAGE MODES (source groups) ──

/** Local mirror of the storage-mode-pane `StorageMode` union (string-validated). */
export type StorageMode = 'DirectQuery' | 'Import' | 'Dual' | 'DirectLake';

/** Local mirror of the resolver's per-table source-group binding (relation pair
 *  + storage mode). `live` is the DirectQuery / Dual-live relation on its Synapse
 *  pool; `cache` is the Import / Dual-cache / Direct-Lake serverless OPENROWSET
 *  over Delta. `cacheReady` is true once an Import/Dual cache has materialized
 *  (Direct Lake reads its own Delta, so the resolver marks it ready). */
export interface TableSourceBinding {
  group: string;
  storageMode: StorageMode;
  live?: { from: SqlSourceFrom; target: SynapseTarget; kind: 'warehouse' | 'lakehouse' };
  cache?: { from: SqlSourceFrom; target: SynapseTarget; deltaUrl: string };
  cacheReady: boolean;
  rowEstimate?: number;
}

/** Local mirror of the resolver's generalized `source-groups` SQL-source arm. */
export interface SourceGroupSqlSource {
  mode: 'source-groups';
  target: SynapseTarget;
  kind: 'warehouse' | 'lakehouse';
  bindings: Record<string, TableSourceBinding>;
}

/**
 * Structural detection of a `source-groups` ReportSqlSource. Reads the value as
 * `unknown` so it never trips a no-overlap (TS2367) comparison whether or not the
 * resolver's `ReportSqlSource` union has grown to carry the arm yet. Returns the
 * binding map when present, else null (the single-source table-map / derived case).
 */
export function asSourceGroups(ss: unknown): SourceGroupSqlSource | null {
  if (
    ss && typeof ss === 'object' &&
    (ss as { mode?: unknown }).mode === 'source-groups' &&
    (ss as { bindings?: unknown }).bindings &&
    typeof (ss as { bindings?: unknown }).bindings === 'object'
  ) {
    return ss as SourceGroupSqlSource;
  }
  return null;
}

/** Aggregating visuals (card / chart / matrix) vs row visuals (table / slicer).
 *  Mirror of wells-to-sql.isAggregateVisual — drives the Dual cache-vs-live pick. */
export function isAggregateVisual(visual: DaxVisual): boolean {
  const t = (visual.type || '').toLowerCase();
  return t !== 'table' && t !== 'slicer';
}

/**
 * Per-table relation pick (mirror of wells-to-sql.pickRelation):
 *   • Import / DirectLake → `cache`, falling back to `live` when no cache yet;
 *   • Dual                → `cache` when (cacheReady && the visual aggregates),
 *                           else `live` (always a live fallback);
 *   • DirectQuery         → `live`.
 */
export function pickRelation(b: TableSourceBinding, isAggregate: boolean): 'live' | 'cache' {
  switch (b.storageMode) {
    case 'Import':
    case 'DirectLake':
      return b.cacheReady ? 'cache' : 'live';
    case 'Dual':
      return b.cacheReady && isAggregate ? 'cache' : 'live';
    case 'DirectQuery':
    default:
      return 'live';
  }
}

/**
 * Group a visual's referenced model tables by `binding.group` (mirror of
 * wells-to-sql.groupVisualBindings). One group → the representative table to
 * bind (the single-relation pick); many groups → a limited relationship via the
 * materialized SMALLER side (least `rowEstimate`) — the table the caller requires
 * an Import cache for.
 */
export function groupVisualBindings(
  s: SourceGroupSqlSource,
  refs: string[],
): { single: string } | { groups: string[]; smaller: string } {
  const present = refs.filter((r) => s.bindings[r]);
  const groups = Array.from(new Set(present.map((r) => s.bindings[r].group)));
  if (groups.length <= 1) {
    return { single: present[0] || Object.keys(s.bindings)[0] || '' };
  }
  let smaller = present[0];
  let best = Number.POSITIVE_INFINITY;
  for (const r of present) {
    const est = s.bindings[r].rowEstimate ?? Number.MAX_SAFE_INTEGER;
    if (est < best) {
      best = est;
      smaller = r;
    }
  }
  return { groups, smaller };
}

/**
 * Project a `source-groups` SQL source onto the single-FROM wells→SQL compiler
 * for ONE visual: pick the live-vs-cache relation per the table's storage mode
 * and return the bindable `SqlSource` + the Synapse target to run it on. A
 * cross-group visual returns a `limited` gate (no silent partial); a single group
 * that still spans >1 model table returns the existing honest `multi-table` gate
 * (the single-FROM compiler can't join them without relationship keys).
 */
export function projectSourceGroups(
  tables: FieldTable[],
  sg: SourceGroupSqlSource,
  visual: DaxVisual,
  filters?: ReportFilterInput[] | undefined,
): ToSqlSourceResult {
  const refs = Array.from(
    new Set(referencedTables(visual, filters).filter((t) => sg.bindings[t])),
  );
  const grouped = groupVisualBindings(sg, refs);

  // Cross-group → limited relationship via the materialized smaller side.
  if ('groups' in grouped) {
    const b = sg.bindings[grouped.smaller];
    return {
      kind: 'limited',
      smaller: grouped.smaller,
      cacheReady: !!(b && b.cacheReady),
      groups: grouped.groups,
    };
  }

  // Single group but >1 distinct model table → the single-FROM compiler can't
  // join them here (no relationship keys surfaced); honest multi-table gate.
  if (refs.length > 1) return { kind: 'multi-table', tables: refs };

  const key = grouped.single || refs[0] || Object.keys(sg.bindings)[0] || '';
  const b = sg.bindings[key];
  if (!b) return { kind: 'no-columns' };

  const rel = pickRelation(b, isAggregateVisual(visual));
  // Import / Dual without a built cache fall back to live; Direct Lake's "cache"
  // is its own-Delta OPENROWSET. Guard a missing relation either way.
  const chosen = rel === 'cache' ? (b.cache ?? b.live) : (b.live ?? b.cache);
  if (!chosen) return { kind: 'no-columns' };

  const columns = whitelist(tables.find((t) => t.name === key) || tables[0]);
  if (!columns.length) return { kind: 'no-columns' };

  return {
    kind: 'ok',
    source: { from: chosen.from, columns, measures: [] },
    target: chosen.target,
  };
}

/**
 * Build the wells→SQL `SqlSource` (FROM relation + identifier whitelist) for a
 * loom-native report from the resolver's `ReportSqlSource` + Fields `tables`.
 *
 * Returns `{ kind:'no-columns' }` when nothing bindable resolves, and
 * `{ kind:'multi-table' }` when the visual/filters span more than one mapped
 * model table — the single-FROM compiler can only serve a single table, so the
 * caller surfaces an honest gate rather than silently dropping the other table's
 * fields (Power BI parity gap; see the /query route header + bridge comment).
 */
export function toSqlSource(
  tables: FieldTable[],
  sqlSource: ReportSqlSource,
  visual: DaxVisual,
  filters?: ReportFilterInput[] | undefined,
): ToSqlSourceResult {
  // Wave 2 — per-table storage modes. When the resolver emits a `source-groups`
  // arm (only when the report has per-table storage configured), pick the live-
  // vs-cache relation per visual and run it on that relation's own target.
  // Detected structurally so this stays type-safe regardless of whether the
  // resolver's `ReportSqlSource` union has grown to carry the arm yet.
  const sg = asSourceGroups(sqlSource);
  if (sg) return projectSourceGroups(tables, sg, visual, filters);

  // Past here only the original single-source modes are reachable; narrow the
  // (possibly-grown) union so the table-map access below stays type-safe.
  if (sqlSource.mode !== 'derived' && sqlSource.mode !== 'table-map') {
    return { kind: 'no-columns' };
  }

  // direct-query: the resolver already validated the SELECT (and flattened any
  // model into a single derived relation); expose the introspected table's
  // columns as the whitelist.
  if (sqlSource.mode === 'derived') {
    const columns = whitelist(tables.find((t) => t.name === sqlSource.tableName) || tables[0]);
    if (!columns.length) return { kind: 'no-columns' };
    return {
      kind: 'ok',
      source: { from: { kind: 'derived', sql: sqlSource.sql }, columns, measures: [] },
    };
  }

  // table-map: the wells→SQL compiler runs over ONE FROM relation, so this route
  // can only serve a visual whose fields all come from a SINGLE model table.
  const map = sqlSource.tableMap;
  const mapped = Object.keys(map);
  if (!mapped.length) return { kind: 'no-columns' };

  // Honest multi-table gate (no-vaporware): a visual (or its column filters)
  // that binds across >1 mapped model table can't be answered by a single-table
  // SELECT, and no relationship metadata is surfaced here to author a JOIN.
  // Rather than picking one table and silently dropping the other's fields,
  // report the spanned tables so the caller can name the exact remediation.
  const referenced = Array.from(
    new Set(referencedTables(visual, filters).filter((t) => map[t])),
  );
  if (referenced.length > 1) {
    return { kind: 'multi-table', tables: referenced };
  }

  // ≤1 referenced table → bind it; else the only mapped table, else the first
  // mapped table with bindable columns (the single-table scaffold default).
  const chosen: string =
    referenced[0] ||
    (mapped.length === 1 ? mapped[0] : '') ||
    tables.map((t) => t.name).find((n) => map[n]) ||
    mapped[0];

  const relation = map[chosen];
  if (!relation) return { kind: 'no-columns' };
  const columns = whitelist(tables.find((t) => t.name === chosen));
  if (!columns.length) return { kind: 'no-columns' };
  return {
    kind: 'ok',
    source: {
      from: { kind: 'table', schema: relation.schema, table: relation.table },
      columns,
      // Loom-native measures are name-only in the Fields tree (no SQL expression
      // is resolved for them here); value wells aggregate their bound COLUMN via
      // the compiler's default agg, so column-backed visuals render real rows.
      measures: [],
    },
  };
}

/** Zip executeQuery's columnar result into object rows keyed by column alias —
 *  the same row shape the AAS (flattenAasRows) and Power BI paths return, so the
 *  client renders every backend identically. */
export function objectRows(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      o[c] = r[i];
    });
    return o;
  });
}
