/**
 * model-health.ts — PURE semantic-model health analyzers + fix applier.
 *
 * The graded core of two Wave-9 features:
 *   • FGC-22 Copilot autonomous model-health scan + apply-fix — Best-Practice-
 *     Analyzer-style rules over the Loom-native tabular model (measures +
 *     relationships + date marks) and the item's table/column content.
 *   • FGC-17 Semantic link `.validate_relationships()` — reuses
 *     {@link analyzeRelationships} so the notebook helper and the health scan
 *     flag the same broken/missing relationships.
 *
 * Everything here is a PURE function of its inputs (no I/O, no env, no Azure
 * SDK) so it is exhaustively unit-testable and deterministic. The BFF route
 * (app/api/items/semantic-model/[id]/model-health/route.ts) reads the real
 * model from Cosmos (readModelState) + the item content tables, runs these
 * analyzers, optionally enriches measure descriptions via Azure OpenAI, and
 * applies approved fixes back through writeModelState with a checkpoint first —
 * the SAME checkpoint/approval plumbing the NL-structure Copilot uses.
 *
 * NO Fabric / Power BI dependency: the rules run against the Azure-native model
 * store; there is no api.powerbi.com / api.fabric.microsoft.com call anywhere in
 * this file or its callers' default path.
 */

// ── Input shapes (a minimal projection of the model + content) ──────────────

export interface HealthColumn {
  name: string;
  dataType: string;
}

export interface HealthTable {
  name: string;
  columns: HealthColumn[];
}

export interface HealthRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** 'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many' */
  cardinality?: string;
  active?: boolean;
}

export interface HealthMeasure {
  name: string;
  expression: string;
  description?: string;
  /** Home table (StoredMeasure.schema). */
  schema?: string;
}

export interface HealthDateMark {
  table: string;
  dateColumn: string;
}

export interface HealthInput {
  tables: HealthTable[];
  measures: HealthMeasure[];
  relationships: HealthRelationship[];
  dateTables: HealthDateMark[];
}

// ── Fix ops (applied via the checkpoint/approval flow) ──────────────────────

export type HealthFixOp =
  | { kind: 'add-relationship'; fromTable: string; fromColumn: string; toTable: string; toColumn: string; cardinality: 'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many' }
  | { kind: 'mark-date-table'; table: string; dateColumn: string }
  | { kind: 'set-measure-description'; measure: string; description: string };

export type HealthSeverity = 'info' | 'warning' | 'error';

export type HealthRule =
  | 'missing-relationship'
  | 'ambiguous-relationship'
  | 'unmarked-date-table'
  | 'unused-column'
  | 'measure-no-description'
  | 'measure-anti-pattern'
  | 'measure-error';

export interface HealthFinding {
  rule: HealthRule;
  severity: HealthSeverity;
  /** Stable id so the UI can key rows + the apply request can reference a fix. */
  id: string;
  title: string;
  detail: string;
  /** The applyable fix, when the rule has one (report-only rules omit it). */
  fix?: HealthFixOp;
}

// ── Small pure helpers ──────────────────────────────────────────────────────

const DATE_TYPE = /(^|[^a-z])(date|datetime|datetime2|timestamp|dateTime|smalldatetime)([^a-z]|$)/i;

/** A column name that reads like a key/id (heuristic for relationship inference).
 *  Matches camelCase/PascalCase suffixes (CustomerKey, OrderId, ProductID), a
 *  suffix set off by a non-letter (customer_id), and the bare words key/id — but
 *  NOT incidental endings like "grid" or "valid". */
export function looksLikeKey(col: string): boolean {
  const c = col.trim();
  return /[a-z](?:Key|Id|ID)$/.test(c)              // camelCase boundary: …rKey / …rId / …tID
    || /(?:^|[^A-Za-z])(?:key|id)$/i.test(c)         // separated by start or a non-letter
    || /^(?:key|id)$/i.test(c);                      // the bare word
}

function relKey(r: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }): string {
  // Unordered — a relationship A[x]→B[y] and B[y]→A[x] connect the same columns.
  const a = `${r.fromTable}.${r.fromColumn}`.toLowerCase();
  const b = `${r.toTable}.${r.toColumn}`.toLowerCase();
  return [a, b].sort().join('|');
}

function tablePairKey(a: string, b: string): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join('|');
}

/**
 * Does a measure expression reference `table[column]` or a bare `[column]`?
 * Bracket-scan only (no DAX parse) — deliberately conservative: a match means
 * "referenced somewhere", a miss means "not referenced by name", which is
 * exactly what the unused-column heuristic needs.
 */
export function measureReferencesColumn(expression: string, table: string, column: string): boolean {
  const expr = expression || '';
  const col = column.trim();
  if (!col) return false;
  const esc = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `[Column]` anywhere, or `'Table'[Column]` / `Table[Column]`.
  const bare = new RegExp(`\\[\\s*${esc}\\s*\\]`, 'i');
  return bare.test(expr);
}

const AGG_FN = /\b(SUM|SUMX|COUNT|COUNTX|COUNTA|COUNTROWS|DISTINCTCOUNT|AVERAGE|AVERAGEX|MIN|MINX|MAX|MAXX|CALCULATE|DIVIDE|MEDIAN|PERCENTILE|VAR|STDEV|PRODUCT|GEOMEAN|RANKX|TOPN)\s*\(/i;

// ── Relationship analyzer (shared by FGC-17 + FGC-22) ───────────────────────

export interface RelationshipValidation {
  /** True when every existing relationship references real tables + columns and
   *  no obvious FK is left unconnected. */
  ok: boolean;
  findings: HealthFinding[];
}

/**
 * Validate + discover relationships. Flags:
 *   • a stored relationship pointing at a table/column that is not in the model
 *     (broken relationship — `error`);
 *   • a plausible foreign key (identical key-like column name across two tables)
 *     that has NO relationship (missing — `warning`, with an add-relationship fix);
 *   • more than one ACTIVE relationship between the same table pair (ambiguous —
 *     `warning`).
 */
export function analyzeRelationships(
  tables: HealthTable[],
  relationships: HealthRelationship[],
): RelationshipValidation {
  const findings: HealthFinding[] = [];
  const tableByName = new Map<string, HealthTable>();
  for (const t of tables) tableByName.set(t.name.toLowerCase(), t);
  const hasColumn = (table: string, column: string): boolean => {
    const t = tableByName.get(table.toLowerCase());
    if (!t) return false;
    return t.columns.some((c) => c.name.toLowerCase() === column.toLowerCase());
  };

  // 1) Broken relationships — reference a table/column the model doesn't have.
  for (const r of relationships) {
    const problems: string[] = [];
    if (!tableByName.has(r.fromTable.toLowerCase())) problems.push(`table '${r.fromTable}' is not in the model`);
    else if (!hasColumn(r.fromTable, r.fromColumn)) problems.push(`column '${r.fromTable}[${r.fromColumn}]' does not exist`);
    if (!tableByName.has(r.toTable.toLowerCase())) problems.push(`table '${r.toTable}' is not in the model`);
    else if (!hasColumn(r.toTable, r.toColumn)) problems.push(`column '${r.toTable}[${r.toColumn}]' does not exist`);
    if (problems.length) {
      findings.push({
        rule: 'missing-relationship',
        severity: 'error',
        id: `broken:${relKey(r)}`,
        title: `Broken relationship ${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`,
        detail: `This relationship is invalid: ${problems.join('; ')}. Fix the underlying table/column or remove the relationship.`,
      });
    }
  }

  // 2) Ambiguous — multiple ACTIVE relationships between the same table pair.
  const activeByPair = new Map<string, number>();
  for (const r of relationships) {
    if (r.active === false) continue;
    const k = tablePairKey(r.fromTable, r.toTable);
    activeByPair.set(k, (activeByPair.get(k) || 0) + 1);
  }
  const reportedPair = new Set<string>();
  for (const r of relationships) {
    if (r.active === false) continue;
    const k = tablePairKey(r.fromTable, r.toTable);
    if ((activeByPair.get(k) || 0) > 1 && !reportedPair.has(k)) {
      reportedPair.add(k);
      findings.push({
        rule: 'ambiguous-relationship',
        severity: 'warning',
        id: `ambiguous:${k}`,
        title: `Ambiguous active relationships between ${r.fromTable} and ${r.toTable}`,
        detail: 'More than one ACTIVE relationship connects these tables, so the filter path is ambiguous. Mark all but one inactive (use USERELATIONSHIP in measures that need the others).',
      });
    }
  }

  // 3) Missing FK — an identical key-like column name across two tables with no
  //    relationship connecting those columns. Conservative (avoids false noise):
  //    the shared column must look like a key, and at least one side must have
  //    a same-named column that is a plausible primary key (the column name
  //    equals or ends with the OTHER table's name + Key/Id, OR is identical on
  //    both sides and key-like).
  const existing = new Set(relationships.map(relKey));
  const tablesArr = tables.filter((t) => t.columns.length > 0);
  for (let i = 0; i < tablesArr.length; i++) {
    for (let j = i + 1; j < tablesArr.length; j++) {
      const a = tablesArr[i];
      const b = tablesArr[j];
      for (const ca of a.columns) {
        if (!looksLikeKey(ca.name)) continue;
        const cb = b.columns.find((c) => c.name.toLowerCase() === ca.name.toLowerCase());
        if (!cb) continue;
        const k = relKey({ fromTable: a.name, fromColumn: ca.name, toTable: b.name, toColumn: cb.name });
        if (existing.has(k)) continue;
        // Direction: the table whose NAME the key references is the "one" side
        // (dimension). Default many-to-one from the other table.
        const aIsDim = ca.name.toLowerCase().includes(a.name.toLowerCase());
        const bIsDim = cb.name.toLowerCase().includes(b.name.toLowerCase());
        let fromTable = a.name, fromColumn = ca.name, toTable = b.name, toColumn = cb.name;
        if (bIsDim && !aIsDim) { /* a→b (fact→dim) keep */ }
        else if (aIsDim && !bIsDim) { fromTable = b.name; fromColumn = cb.name; toTable = a.name; toColumn = ca.name; }
        findings.push({
          rule: 'missing-relationship',
          severity: 'warning',
          id: `missing:${k}`,
          title: `Missing relationship on shared key [${ca.name}]`,
          detail: `${a.name} and ${b.name} both have a key-like column [${ca.name}] but no relationship connects them. Add a many-to-one relationship so filters propagate.`,
          fix: { kind: 'add-relationship', fromTable, fromColumn, toTable, toColumn, cardinality: 'many-to-one' },
        });
      }
    }
  }

  return { ok: findings.every((f) => f.severity !== 'error') && findings.length === 0, findings };
}

// ── Full model-health analyzer (FGC-22) ─────────────────────────────────────

/**
 * Run every Best-Practice-Analyzer rule and return findings ordered
 * error → warning → info. `descriptions` may be omitted; the route fills
 * measure descriptions from Azure OpenAI and re-attaches them to the
 * measure-no-description fixes before presenting the diff.
 */
export function analyzeModelHealth(input: HealthInput): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const tables = input.tables || [];
  const measures = input.measures || [];
  const relationships = input.relationships || [];
  const dateTables = input.dateTables || [];

  // Relationships (broken / ambiguous / missing).
  findings.push(...analyzeRelationships(tables, relationships).findings);

  // Unmarked date table — a table with a date/datetime column and no date mark.
  const markedTables = new Set(dateTables.map((d) => d.table.toLowerCase()));
  const anyDateMarked = dateTables.length > 0;
  for (const t of tables) {
    const dateCol = t.columns.find((c) => DATE_TYPE.test(c.dataType) || DATE_TYPE.test(c.name));
    if (!dateCol) continue;
    if (markedTables.has(t.name.toLowerCase())) continue;
    // Only flag when NO table is marked yet (a model needs exactly one marked
    // date table). If one is already marked elsewhere, additional date columns
    // are fine and we stay quiet.
    if (anyDateMarked) continue;
    findings.push({
      rule: 'unmarked-date-table',
      severity: 'warning',
      id: `date:${t.name.toLowerCase()}`,
      title: `Table '${t.name}' looks like a date table but isn't marked`,
      detail: `[${dateCol.name}] is a date column but no table is marked as the model's date table, so time-intelligence (DATEADD, TOTALYTD…) can misbehave. Mark '${t.name}' as the date table on [${dateCol.name}].`,
      fix: { kind: 'mark-date-table', table: t.name, dateColumn: dateCol.name },
    });
  }

  // Measure descriptions + anti-patterns.
  for (const m of measures) {
    if (!m.description || !m.description.trim()) {
      findings.push({
        rule: 'measure-no-description',
        severity: 'info',
        id: `desc:${m.name.toLowerCase()}`,
        title: `Measure [${m.name}] has no description`,
        detail: 'Business descriptions drive Copilot/NL answers and the data catalog. Generate a one-line description.',
        // description filled by the route (AOAI); empty here keeps the analyzer pure.
        fix: { kind: 'set-measure-description', measure: m.name, description: '' },
      });
    }
    // Anti-pattern: a measure whose expression references a column but calls NO
    // aggregation function — a non-additive / context-dependent scalar that
    // usually should be wrapped in an aggregator.
    const refsColumn = /\[[^\]]+\]/.test(m.expression || '');
    if (refsColumn && !AGG_FN.test(m.expression || '')) {
      findings.push({
        rule: 'measure-anti-pattern',
        severity: 'warning',
        id: `antipattern:${m.name.toLowerCase()}`,
        title: `Measure [${m.name}] references a column without an aggregation`,
        detail: `Expression \`${(m.expression || '').slice(0, 120)}\` references a column but calls no aggregation (SUM, COUNT, CALCULATE…). This is usually non-additive and evaluates in an unexpected filter context. Wrap the column in an aggregator.`,
      });
    }
  }

  // Unused columns — not referenced by any measure, relationship, or date mark.
  const usedByRel = new Set<string>();
  for (const r of relationships) {
    usedByRel.add(`${r.fromTable}.${r.fromColumn}`.toLowerCase());
    usedByRel.add(`${r.toTable}.${r.toColumn}`.toLowerCase());
  }
  const usedByDate = new Set(dateTables.map((d) => `${d.table}.${d.dateColumn}`.toLowerCase()));
  for (const t of tables) {
    for (const c of t.columns) {
      const fq = `${t.name}.${c.name}`.toLowerCase();
      if (usedByRel.has(fq) || usedByDate.has(fq)) continue;
      const referenced = measures.some((m) => measureReferencesColumn(m.expression, t.name, c.name));
      if (referenced) continue;
      findings.push({
        rule: 'unused-column',
        severity: 'info',
        id: `unused:${fq}`,
        title: `Column ${t.name}[${c.name}] is unused`,
        detail: 'This column is not referenced by any measure, relationship, or date mark. Consider hiding it to keep the model lean (review before removing — it may be used by a report).',
      });
    }
  }

  return sortFindings(findings);
}

const SEVERITY_ORDER: Record<HealthSeverity, number> = { error: 0, warning: 1, info: 2 };

export function sortFindings(findings: HealthFinding[]): HealthFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ── Fix applier (pure) — mutates a copy of the model sub-state ──────────────

export interface ApplyModelPortion {
  measures: Array<{ id?: string; name: string; expression: string; description?: string; schema?: string; kind?: string; createdAt?: string; updatedAt?: string }>;
  relationships: Array<Record<string, unknown>>;
  dateTables: Array<{ table: string; dateColumn: string; updatedAt?: string }>;
}

export interface ApplyResult {
  next: ApplyModelPortion;
  applied: string[];
  skipped: string[];
}

/**
 * Apply approved fixes to a copy of the model portion. Pure + deterministic
 * (the route passes `now` + `newId` so timestamps/ids are testable). Unknown or
 * already-satisfied fixes are skipped with a reason (never throw).
 */
export function applyHealthFixes(
  model: ApplyModelPortion,
  ops: HealthFixOp[],
  now: string,
  newId: () => string,
): ApplyResult {
  const measures = model.measures.map((m) => ({ ...m }));
  const relationships = model.relationships.map((r) => ({ ...r }));
  const dateTables = model.dateTables.map((d) => ({ ...d }));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const op of ops) {
    if (op.kind === 'add-relationship') {
      const dup = relationships.some((r) =>
        String(r.fromTable).toLowerCase() === op.fromTable.toLowerCase() &&
        String(r.fromColumn).toLowerCase() === op.fromColumn.toLowerCase() &&
        String(r.toTable).toLowerCase() === op.toTable.toLowerCase() &&
        String(r.toColumn).toLowerCase() === op.toColumn.toLowerCase());
      if (dup) { skipped.push(`Relationship ${op.fromTable}[${op.fromColumn}] → ${op.toTable}[${op.toColumn}] already exists.`); continue; }
      relationships.push({
        id: newId(),
        name: `FK_${op.fromTable.split('.').pop()}_${op.toTable.split('.').pop()}`.replace(/[^A-Za-z0-9_]/g, '_'),
        fromTable: op.fromTable, fromColumn: op.fromColumn, toTable: op.toTable, toColumn: op.toColumn,
        cardinality: op.cardinality, crossFilter: 'single', active: true, source: 'cosmos',
        createdAt: now, updatedAt: now,
      });
      applied.push(`Added relationship ${op.fromTable}[${op.fromColumn}] → ${op.toTable}[${op.toColumn}] (${op.cardinality}).`);
    } else if (op.kind === 'mark-date-table') {
      const existing = dateTables.findIndex((d) => d.table.toLowerCase() === op.table.toLowerCase());
      if (existing >= 0) {
        if (dateTables[existing].dateColumn.toLowerCase() === op.dateColumn.toLowerCase()) {
          skipped.push(`'${op.table}' is already marked as the date table on [${op.dateColumn}].`);
          continue;
        }
        dateTables[existing] = { table: op.table, dateColumn: op.dateColumn, updatedAt: now };
      } else {
        dateTables.push({ table: op.table, dateColumn: op.dateColumn, updatedAt: now });
      }
      applied.push(`Marked '${op.table}' as the date table on [${op.dateColumn}].`);
    } else if (op.kind === 'set-measure-description') {
      const idx = measures.findIndex((m) => m.name === op.measure);
      if (idx < 0) { skipped.push(`Description skipped: measure [${op.measure}] not found.`); continue; }
      if (!op.description || !op.description.trim()) { skipped.push(`Description skipped: no description text for [${op.measure}].`); continue; }
      measures[idx] = { ...measures[idx], description: op.description.trim(), updatedAt: now };
      applied.push(`Set description on [${op.measure}].`);
    } else {
      skipped.push(`Unknown fix kind — skipped.`);
    }
  }

  return { next: { measures, relationships, dateTables }, applied, skipped };
}
