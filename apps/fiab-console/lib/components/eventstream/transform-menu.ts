/**
 * Eventstream transform-menu model — Fabric Eventstream "Transform events"
 * menu parity, as PURE data + a pure resolver (unit-tested, no DOM).
 *
 * Fabric's Eventstream editor surfaces the transform picker as a categorized
 * menu: a "Custom code" section (SQL code) and a "Predefined operations"
 * section (Filter, Manage fields, Aggregate, Join, Group by, Union, Expand).
 * Loom already compiles every one of these to a real Azure Stream Analytics
 * transform (see esCompileDefinition / asa-query-compiler + the Wave-7
 * DeltaFlow CDC transform); this module is the single source of truth mapping
 * each menu entry onto the backing Loom action so the UI can render the menu
 * and dispatch clicks without duplicating the mapping.
 *
 * Per no-vaporware.md every menu item maps to a REAL backing operator or the
 * real code-first SQL tab — there are no decorative entries. If a future Fabric
 * operator is added to the menu without a Loom backend it must resolve to a
 * `gate` target (honest "not available" reason), never a silent no-op.
 */

/** The Loom operator kinds the guided builder + SAQL compiler understand. */
export type EsOperatorKind =
  | 'filter'
  | 'manage-fields'
  | 'aggregate'
  | 'group-by'
  | 'expand'
  | 'cdc-flatten'
  | 'union'
  | 'join'
  // Geospatial operators (geo-graph-ml GEO-1) — ASA built-in geospatial fns
  // (CreatePoint / CreatePolygon / ST_WITHIN / ST_DISTANCE), zero gate in
  // Commercial + Gov. SQL builders: lib/editors/eventstream/geo-sql.ts.
  | 'geo-point'
  | 'geo-fence'
  | 'geo-proximity'
  | 'geo-aggregate';

/** What a menu item does when clicked. */
export type TransformMenuTarget =
  | { kind: 'operator'; op: EsOperatorKind }
  | { kind: 'sql-tab' }
  | { kind: 'gate'; reason: string };

export interface TransformMenuItem {
  /** Stable id used by the resolver + as the React key. */
  id: string;
  label: string;
  /** Optional trailing badge (e.g. Fabric's "Code" chip on SQL). */
  badge?: string;
  /** One-line description shown in the menu / tooltip. */
  hint: string;
}

export interface TransformMenuCategory {
  category: string;
  items: TransformMenuItem[];
}

/**
 * The categorized menu, mirroring Fabric's "Transform events" flyout order.
 * Custom code first (the SQL escape hatch), then the predefined operators.
 */
export const TRANSFORM_MENU: TransformMenuCategory[] = [
  {
    category: 'Custom code',
    items: [
      {
        id: 'sql',
        label: 'SQL code',
        badge: 'Code',
        hint: 'Author a multi-output Stream Analytics (SAQL) query by hand on the SQL operator tab.',
      },
    ],
  },
  {
    category: 'Predefined operations',
    items: [
      { id: 'filter', label: 'Filter', hint: 'Keep only events matching a WHERE condition.' },
      { id: 'manage-fields', label: 'Manage fields', hint: 'Add, remove, rename or re-type columns.' },
      { id: 'aggregate', label: 'Aggregate', hint: 'Windowed SUM/COUNT/AVG/MIN/MAX over a time window.' },
      { id: 'join', label: 'Join', hint: 'Temporal JOIN with another source within a time bound.' },
      { id: 'group-by', label: 'Group by', hint: 'Group events by columns + window and aggregate each group.' },
      { id: 'union', label: 'Union', hint: 'Merge all upstream sources into one stream.' },
      { id: 'expand', label: 'Expand', hint: 'Flatten an array column into one row per element.' },
    ],
  },
  {
    // Loom EXCEEDS the Fabric menu here (ux-baseline: our richer bar is the
    // standard): first-class geospatial operators over ASA's built-in
    // geospatial functions — zero gate, Commercial + Gov.
    category: 'Geospatial',
    items: [
      { id: 'geo-point', label: 'Geo point', hint: 'Build a GeoJSON point with CreatePoint(lat, lon) from two stream columns.' },
      { id: 'geo-fence', label: 'Geofence', hint: 'Keep events inside/outside fences via ST_WITHIN(point, fence) — inline polygons or ASA reference data.' },
      { id: 'geo-proximity', label: 'Proximity', hint: 'Keep events within a distance threshold via ST_DISTANCE(a, b) < d.' },
      { id: 'geo-aggregate', label: 'Geo aggregate', hint: 'Aggregate per region over a HoppingWindow (requests-per-region).' },
    ],
  },
];

/** All operator kinds that the predefined-operations section can add. */
const OPERATOR_IDS: ReadonlySet<string> = new Set<EsOperatorKind>([
  'filter', 'manage-fields', 'aggregate', 'group-by', 'expand', 'cdc-flatten', 'union', 'join',
  'geo-point', 'geo-fence', 'geo-proximity', 'geo-aggregate',
]);

/**
 * Resolve a menu-item id to the action the host should take. Pure — the host
 * (editor) owns the side effect (add operator / switch to the SQL tab / show
 * the gate). Unknown ids resolve to an honest gate, never a fake success.
 */
export function resolveTransformMenuItem(id: string): TransformMenuTarget {
  if (id === 'sql') return { kind: 'sql-tab' };
  if (OPERATOR_IDS.has(id)) return { kind: 'operator', op: id as EsOperatorKind };
  return { kind: 'gate', reason: `No Loom backend maps to the transform "${id}".` };
}

/** Flat list of every menu item (handy for tests + palette rendering). */
export function flattenTransformMenu(menu: TransformMenuCategory[] = TRANSFORM_MENU): TransformMenuItem[] {
  return menu.flatMap((c) => c.items);
}
