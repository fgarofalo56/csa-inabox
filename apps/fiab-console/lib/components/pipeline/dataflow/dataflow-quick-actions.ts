/**
 * dataflow-quick-actions — the pure mapping behind the U7 debug-preview grid's
 * column context menu. A quick-action (Typecast / Modify / Remove) on a preview
 * column generates a REAL mapping-dataflow transform (Cast / Derived Column /
 * Select) that the designer wires off the previewed stream — draft only,
 * published on Save (never mutating the live flow). The generated `settings`
 * are the exact catalog keys the DFS builder consumes, so the projection is
 * faithful (not best-effort). Side-effect-free + unit-tested.
 */

/**
 * U7 quick-action from the debug preview grid's column context menu:
 *   - typecast → a Cast transform (`col as <toType>`)
 *   - modify   → a Derived Column transform (`col = col`, ready to edit)
 *   - remove   → a Select (rule mode) dropping the column (`name != 'col'`)
 */
export interface DataflowQuickAction {
  action: 'typecast' | 'modify' | 'remove';
  /** The upstream stream (the previewed transform) to wire the new node off. */
  fromStream: string;
  /** The preview column the action targets. */
  column: string;
  /** Target DFS type for a typecast (default 'string'). */
  toType?: string;
}

/** Imperative handle the host (editor) uses to apply debug-grid quick-actions. */
export interface MappingDataFlowDesignerHandle {
  /** Insert the transform for a quick-action; returns the new node name (or null). */
  insertQuickAction: (spec: DataflowQuickAction) => string | null;
}

/** The generated transform for a quick-action: catalog `type` + prefilled settings. */
export interface QuickActionTransform {
  type: string;
  settings: Record<string, unknown>;
}

/**
 * Map a quick-action spec to the transform to insert. Returns null when the spec
 * is missing its stream / column. The `settings` are the catalog keys the DFS
 * `transformBody` builder reads:
 *   - cast   → `casts` (`col->type`, rendered `cast(output(col as type), …)`)
 *   - derive → `columns` (`col = col`, rendered `derive(col = col)`)
 *   - select → rule mode (`select(mapColumn(each(match(name != 'col'), $$ = $$)))`)
 */
export function buildQuickActionTransform(spec: DataflowQuickAction): QuickActionTransform | null {
  const col = (spec.column || '').trim();
  if (!spec.fromStream || !col) return null;

  switch (spec.action) {
    case 'typecast':
      return { type: 'cast', settings: { casts: `${col}->${spec.toType || 'string'}`, errorHandling: 'fail' } };
    case 'modify':
      return { type: 'derive', settings: { columns: `${col} = ${col}` } };
    case 'remove':
      // Select in rule mode that keeps every column whose name differs from `col`.
      return { type: 'select', settings: { mappingMode: 'rule', matchCondition: `name != '${col}'`, nameAs: '$$' } };
    default:
      return null;
  }
}
