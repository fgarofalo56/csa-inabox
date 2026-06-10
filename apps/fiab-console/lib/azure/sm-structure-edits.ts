/**
 * sm-structure-edits — PURE helpers for the semantic-model "Copilot model-structure"
 * pane (Fabric Build 2026 #26 — Copilot modifies semantic models).
 *
 * Zero runtime imports: these are JSON serializers + a structured-edit applier
 * so the whole surface is trivially unit-testable and carries no
 * @azure/identity / network weight. The credentialed I/O (Azure OpenAI chat +
 * XMLA TMSL writes) lives in the BFF route, which imports these.
 *
 * The Copilot proposes a FIXED, server-validated set of structured edits — it
 * NEVER emits free-form TMSL that gets injected blindly. Each edit kind maps to
 * a pure builder here; the route validates every edit against the live model
 * structure before applying. Three edit kinds (Fabric Build 2026 #26):
 *
 *   rename-measure     — rename a measure (TMSL has no rename verb; the engine
 *                        does it via an Alter that sets the new `name` on the
 *                        measure object addressed by its old name).
 *   set-description    — set / clear the `description` on a measure, column, or
 *                        table (Alter — auto-describe already exists; this lets
 *                        Copilot write the descriptions it suggests).
 *   add-relationship   — create a relationship between two table columns
 *                        (createOrReplace).
 *
 * TMSL refs:
 *   alter command       — https://learn.microsoft.com/analysis-services/tmsl/alter-command-tmsl
 *   createOrReplace     — https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
 *   measure object      — https://learn.microsoft.com/analysis-services/tmsl/measures-object-tmsl
 *   relationship object — https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl
 */

// ── Structure snapshot (the checkpoint payload) ─────────────────────────────

export interface SmMeasure {
  table: string;
  name: string;
  expression?: string;
  description?: string;
  formatString?: string;
  displayFolder?: string;
}

export interface SmColumn {
  name: string;
  dataType?: string;
  description?: string;
}

export interface SmTable {
  name: string;
  description?: string;
  columns: SmColumn[];
}

export interface SmRelationshipEdit {
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** 'many:one' (default) | 'one:one' | 'many:many'. */
  cardinality?: 'many:one' | 'one:one' | 'many:many';
  crossFilter?: 'single' | 'both';
}

/**
 * A point-in-time snapshot of the editable model structure. Persisted to the
 * model's Cosmos content as a CHECKPOINT so a Copilot edit can be rolled back
 * even when no live tabular engine is bound (the no-fabric-dependency default).
 */
export interface SmStructureSnapshot {
  tables: SmTable[];
  measures: SmMeasure[];
  relationships: SmRelationshipEdit[];
}

export interface SmCheckpoint {
  id: string;
  label: string;
  createdAt: string;
  /** What produced it: a Copilot apply, or a manual snapshot. */
  source: 'copilot' | 'manual';
  snapshot: SmStructureSnapshot;
}

// ── Structured edits (the Copilot proposal contract) ────────────────────────

export interface RenameMeasureEdit {
  kind: 'rename-measure';
  table: string;
  from: string;
  to: string;
  reason?: string;
}

export interface SetDescriptionEdit {
  kind: 'set-description';
  /** What the description attaches to. */
  target: 'measure' | 'column' | 'table';
  table: string;
  /** Required for measure/column; ignored for table. */
  name?: string;
  description: string;
  reason?: string;
}

export interface AddRelationshipEdit {
  kind: 'add-relationship';
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality?: 'many:one' | 'one:one' | 'many:many';
  crossFilter?: 'single' | 'both';
  reason?: string;
}

export type SmStructureEdit = RenameMeasureEdit | SetDescriptionEdit | AddRelationshipEdit;

export const SM_EDIT_KINDS: SmStructureEdit['kind'][] = [
  'rename-measure',
  'set-description',
  'add-relationship',
];

// ── Validation against the live snapshot ────────────────────────────────────

function findMeasure(snap: SmStructureSnapshot, table: string, name: string): SmMeasure | undefined {
  return snap.measures.find((m) => m.table === table && m.name === name);
}

function findTable(snap: SmStructureSnapshot, name: string): SmTable | undefined {
  return snap.tables.find((t) => t.name === name);
}

function findColumn(snap: SmStructureSnapshot, table: string, name: string): SmColumn | undefined {
  return findTable(snap, table)?.columns.find((c) => c.name === name);
}

/**
 * Validate one structured edit against the current snapshot. Returns null when
 * valid, else a precise human-readable reason (surfaced to the operator — the
 * edit is NOT applied). This is the server's guard against a Copilot proposal
 * that references objects that don't exist.
 */
export function validateEdit(snap: SmStructureSnapshot, edit: SmStructureEdit): string | null {
  switch (edit.kind) {
    case 'rename-measure': {
      if (!edit.table || !edit.from || !edit.to) return 'rename-measure requires table, from, and to.';
      if (!findMeasure(snap, edit.table, edit.from)) {
        return `Measure '${edit.from}' was not found on table '${edit.table}'.`;
      }
      if (edit.from === edit.to) return 'rename-measure: the new name matches the old name.';
      if (findMeasure(snap, edit.table, edit.to)) {
        return `A measure named '${edit.to}' already exists on table '${edit.table}'.`;
      }
      if (!/^[^\[\]]+$/.test(edit.to)) return `'${edit.to}' is not a valid measure name (no [ or ] characters).`;
      return null;
    }
    case 'set-description': {
      if (!edit.table) return 'set-description requires a table.';
      if (typeof edit.description !== 'string') return 'set-description requires a description string.';
      if (edit.target === 'table') {
        if (!findTable(snap, edit.table)) return `Table '${edit.table}' was not found.`;
        return null;
      }
      if (!edit.name) return `set-description for a ${edit.target} requires a name.`;
      if (edit.target === 'measure') {
        if (!findMeasure(snap, edit.table, edit.name)) return `Measure '${edit.name}' was not found on table '${edit.table}'.`;
        return null;
      }
      // column
      if (!findColumn(snap, edit.table, edit.name)) return `Column '${edit.name}' was not found on table '${edit.table}'.`;
      return null;
    }
    case 'add-relationship': {
      if (!edit.fromTable || !edit.fromColumn || !edit.toTable || !edit.toColumn) {
        return 'add-relationship requires fromTable, fromColumn, toTable, and toColumn.';
      }
      if (!findColumn(snap, edit.fromTable, edit.fromColumn)) {
        return `Column '${edit.fromTable}[${edit.fromColumn}]' was not found.`;
      }
      if (!findColumn(snap, edit.toTable, edit.toColumn)) {
        return `Column '${edit.toTable}[${edit.toColumn}]' was not found.`;
      }
      const dupe = snap.relationships.find(
        (r) =>
          r.fromTable === edit.fromTable && r.fromColumn === edit.fromColumn &&
          r.toTable === edit.toTable && r.toColumn === edit.toColumn,
      );
      if (dupe) return `A relationship from '${edit.fromTable}[${edit.fromColumn}]' to '${edit.toTable}[${edit.toColumn}]' already exists.`;
      return null;
    }
    default:
      return `Unknown edit kind '${(edit as { kind: string }).kind}'.`;
  }
}

// ── Apply edits to the in-memory snapshot (Loom-native source of truth) ──────

function relName(e: AddRelationshipEdit): string {
  return `rel_${e.fromTable}_${e.fromColumn}_${e.toTable}_${e.toColumn}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Apply a validated edit to a COPY of the snapshot, returning the next
 * snapshot. Pure — the caller persists the result to Cosmos. Assumes the edit
 * already passed validateEdit().
 */
export function applyEditToSnapshot(snap: SmStructureSnapshot, edit: SmStructureEdit): SmStructureSnapshot {
  const next: SmStructureSnapshot = {
    tables: snap.tables.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c })) })),
    measures: snap.measures.map((m) => ({ ...m })),
    relationships: snap.relationships.map((r) => ({ ...r })),
  };
  switch (edit.kind) {
    case 'rename-measure': {
      const m = next.measures.find((x) => x.table === edit.table && x.name === edit.from);
      if (m) m.name = edit.to;
      break;
    }
    case 'set-description': {
      if (edit.target === 'table') {
        const t = next.tables.find((x) => x.name === edit.table);
        if (t) t.description = edit.description;
      } else if (edit.target === 'measure') {
        const m = next.measures.find((x) => x.table === edit.table && x.name === edit.name);
        if (m) m.description = edit.description;
      } else {
        const t = next.tables.find((x) => x.name === edit.table);
        const c = t?.columns.find((x) => x.name === edit.name);
        if (c) c.description = edit.description;
      }
      break;
    }
    case 'add-relationship': {
      next.relationships.push({
        name: relName(edit),
        fromTable: edit.fromTable, fromColumn: edit.fromColumn,
        toTable: edit.toTable, toColumn: edit.toColumn,
        cardinality: edit.cardinality || 'many:one',
        crossFilter: edit.crossFilter || 'single',
      });
      break;
    }
  }
  return next;
}

// ── TMSL builders (opt-in live XMLA write) ──────────────────────────────────

/**
 * Alter that renames a measure. TMSL has no rename verb; addressing the measure
 * by its OLD name and setting a new `name` on the body performs the rename
 * (the engine preserves the expression + metadata). The expression must be
 * re-supplied because Alter replaces the measure body.
 */
export function buildRenameMeasureTmsl(opts: {
  database: string;
  table: string;
  from: string;
  to: string;
  expression: string;
  formatString?: string;
  displayFolder?: string;
  description?: string;
}): object {
  const measure: Record<string, unknown> = { name: opts.to, expression: opts.expression };
  if (opts.formatString) measure.formatString = opts.formatString;
  if (opts.displayFolder) measure.displayFolder = opts.displayFolder;
  if (opts.description) measure.description = opts.description;
  return {
    alter: {
      object: { database: opts.database, table: opts.table, measure: opts.from },
      measure,
    },
  };
}

/** Alter that sets a measure's description (preserving its expression). */
export function buildMeasureDescriptionTmsl(opts: {
  database: string;
  table: string;
  measure: string;
  expression: string;
  description: string;
}): object {
  return {
    alter: {
      object: { database: opts.database, table: opts.table, measure: opts.measure },
      measure: { name: opts.measure, expression: opts.expression, description: opts.description },
    },
  };
}

/** Alter that sets a column's description. */
export function buildColumnDescriptionTmsl(opts: {
  database: string;
  table: string;
  column: string;
  dataType: string;
  description: string;
}): object {
  return {
    alter: {
      object: { database: opts.database, table: opts.table, column: opts.column },
      column: { name: opts.column, dataType: opts.dataType, sourceColumn: opts.column, description: opts.description },
    },
  };
}

/** Alter that sets a table's description (only the description property changes). */
export function buildTableDescriptionTmsl(opts: {
  database: string;
  table: string;
  description: string;
}): object {
  return {
    alter: {
      object: { database: opts.database, table: opts.table },
      table: { name: opts.table, description: opts.description },
    },
  };
}

function cardinalityEnds(c: AddRelationshipEdit['cardinality']): { from: string; to: string } {
  switch (c) {
    case 'one:one': return { from: 'one', to: 'one' };
    case 'many:many': return { from: 'many', to: 'many' };
    case 'many:one':
    default: return { from: 'many', to: 'one' };
  }
}

/** createOrReplace that upserts a relationship for the add-relationship edit. */
export function buildAddRelationshipTmsl(database: string, edit: AddRelationshipEdit): object {
  const ends = cardinalityEnds(edit.cardinality);
  const name = relName(edit);
  return {
    createOrReplace: {
      object: { database, relationship: name },
      relationship: {
        name,
        fromTable: edit.fromTable, fromColumn: edit.fromColumn,
        toTable: edit.toTable, toColumn: edit.toColumn,
        fromCardinality: ends.from, toCardinality: ends.to,
        crossFilteringBehavior: edit.crossFilter === 'both' ? 'bothDirections' : 'oneDirection',
      },
    },
  };
}

// ── Copilot prompt grounding ────────────────────────────────────────────────

/**
 * Render a compact text catalog of the model structure for the Copilot system
 * prompt so it references REAL table/column/measure names (never invents any).
 */
export function renderStructureCatalog(snap: SmStructureSnapshot): string {
  const lines: string[] = [];
  for (const t of snap.tables) {
    lines.push(`TABLE ${t.name}${t.description ? ` — ${t.description}` : ''}`);
    for (const c of t.columns) {
      lines.push(`  COLUMN ${t.name}[${c.name}] (${c.dataType || 'string'})${c.description ? ` — ${c.description}` : ''}`);
    }
    for (const m of snap.measures.filter((x) => x.table === t.name)) {
      lines.push(`  MEASURE ${t.name}[${m.name}]${m.description ? ` — ${m.description}` : ''}`);
    }
  }
  if (snap.relationships.length) {
    lines.push('RELATIONSHIPS:');
    for (const r of snap.relationships) {
      lines.push(`  ${r.fromTable}[${r.fromColumn}] -> ${r.toTable}[${r.toColumn}] (${r.cardinality || 'many:one'})`);
    }
  }
  return lines.join('\n');
}

/**
 * Coerce a parsed JSON value (from the Copilot response) into a clean array of
 * structured edits, dropping anything malformed. The route still runs
 * validateEdit() on each survivor.
 */
export function coerceEdits(raw: unknown): SmStructureEdit[] {
  const arr = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { edits?: unknown }).edits))
      ? (raw as { edits: unknown[] }).edits
      : [];
  const out: SmStructureEdit[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const kind = String((e as { kind?: unknown }).kind || '');
    if (!SM_EDIT_KINDS.includes(kind as SmStructureEdit['kind'])) continue;
    const o = e as Record<string, unknown>;
    if (kind === 'rename-measure') {
      out.push({
        kind, table: String(o.table || ''), from: String(o.from || ''), to: String(o.to || ''),
        reason: o.reason ? String(o.reason) : undefined,
      });
    } else if (kind === 'set-description') {
      const target = String(o.target || 'measure');
      out.push({
        kind,
        target: (target === 'column' || target === 'table' ? target : 'measure'),
        table: String(o.table || ''),
        name: o.name !== undefined ? String(o.name) : undefined,
        description: String(o.description || ''),
        reason: o.reason ? String(o.reason) : undefined,
      });
    } else {
      out.push({
        kind: 'add-relationship',
        fromTable: String(o.fromTable || ''), fromColumn: String(o.fromColumn || ''),
        toTable: String(o.toTable || ''), toColumn: String(o.toColumn || ''),
        cardinality: (['many:one', 'one:one', 'many:many'].includes(String(o.cardinality)) ? o.cardinality : 'many:one') as AddRelationshipEdit['cardinality'],
        crossFilter: (String(o.crossFilter) === 'both' ? 'both' : 'single'),
        reason: o.reason ? String(o.reason) : undefined,
      });
    }
  }
  return out;
}

/** Generate a short id for a checkpoint. */
export function newCheckpointId(now = Date.now()): string {
  return `cp-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
