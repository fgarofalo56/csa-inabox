/**
 * Shared persistence + projection helpers for the Loom Model view across the
 * warehouse / Synapse Dedicated SQL pool / Databricks SQL warehouse engines.
 *
 * The model metadata lives on the existing Cosmos `items` container under
 * `item.state.model = { relationships, measures, whatIfParameters,
 * calculatedTables, dateTables, securityRoles, synonyms }`. NO new Cosmos
 * container, NO new env var, NO Power BI / Fabric dependency: every Model-view
 * object is persisted Azure-native (Cosmos) and — where the engine supports it —
 * materialized as real backend objects:
 *   • relationships → Unity Catalog FK constraints / referential-integrity hints
 *   • measures      → Synapse inline TVFs
 *   • securityRoles → real Synapse `CREATE SECURITY POLICY` + schemabound TVF, or
 *                     Databricks `SET ROW FILTER` / `SET MASK` (see rls-compiler)
 *   • whatIfParameters → GENERATESERIES table + SELECTEDVALUE measure that drive
 *                        the real `/query` DAX path (no-vaporware)
 *
 * Per the no-fabric-dependency rule, an AAS / Power BI XMLA tabular engine is an
 * OPT-IN provision-time target only (see aas-tmsl.ts); it is NEVER required for
 * any of the objects below to persist or function.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { loadOwnedItem, updateOwnedItem } from './item-crud';

export type Cardinality = 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
export type CrossFilter = 'single' | 'both';
export type MeasureKind = 'tvf' | 'scalar' | 'cosmos';
export type WhatIfDataType = 'int64' | 'decimal' | 'double';

export interface StoredRelationship {
  id: string;
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
  crossFilter: CrossFilter;
  active: boolean;
  source: 'cosmos' | 'uc';
  /**
   * "Assume referential integrity" — when true the relationship is treated as a
   * guaranteed FK so the engine can use an INNER join and the model can emit a
   * `relyOnReferentialIntegrity` hint (UC FK `RELY` / TMSL relationship flag).
   * Optional + back-compat: absent / false means the engine assumes nothing.
   */
  assumeReferentialIntegrity?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMeasure {
  id: string;
  name: string;
  schema?: string;
  expression: string;
  kind: MeasureKind;
  /** Business-friendly description. Authored by the DAX Copilot (dax_save_descriptions)
   *  or by hand; persisted Azure-native in Cosmos — no Power BI / Fabric dependency. */
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A "what-if" / numeric-range parameter. The structured 5-field dialog
 * (name + dataType + min/max/increment/default) is the ONLY input; the three
 * DAX strings below are GENERATED server-side by `normalizeWhatIfParameter`
 * (never hand-authored — loom_no_freeform_config honored) and drive the real
 * `/query` DAX path so the parameter immediately changes query results.
 */
export interface WhatIfParameter {
  id: string;
  /** Identifier-safe name reused for the generated table AND its column/measure. */
  name: string;
  min: number;
  max: number;
  increment: number;
  defaultValue: number;
  dataType?: WhatIfDataType;
  /** `GENERATESERIES(min, max, increment)` — the single-column table expression. */
  seriesExpression: string;
  /** `SELECTEDVALUE('<name>'[<name>], <default>)` — the bound value measure. */
  valueMeasure: string;
  /** `'<name>'[<name>]` — the column a slicer binds to. */
  boundSlicerColumn: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A calculated table. The expression box is the ONE sanctioned free-form surface
 * (the explicit 1:1 ADF/Synapse-style expression exception) — a guarded,
 * single-statement DAX table expression or read-only SQL `SELECT`.
 */
export interface CalculatedTable {
  id: string;
  name: string;
  expression: string;
  language: 'dax' | 'sql';
  createdAt: string;
  updatedAt: string;
}

/** Mark-as-date-table: flags one column of one table as the model's date key
 *  (projected as `dataCategory='Time'` when emitting TMSL to a tabular engine). */
export interface DateTableMark {
  table: string;
  dateColumn: string;
  updatedAt: string;
}

/**
 * SOURCE OF TRUTH for the native RLS/OLS compiler (lib/azure/rls-compiler.ts).
 * Persisted Azure-native onto `state.model.securityRoles`; compiled to a real
 * Synapse SECURITY POLICY + schemabound TVF (or Databricks ROW FILTER + COLUMN
 * MASK) by the roles route — NO AAS / Power BI / Fabric engine required.
 */
export interface SecurityRoleDef {
  name: string;
  members: string[];
  tablePermissions: Array<{
    table: string;
    /** DAX boolean row filter (validated by validateRlsDax, lowered by rls-compiler). */
    filterExpression?: string;
    /** OLS whole-table visibility ('none' hides the table). */
    metadataPermission?: 'read' | 'none';
    /** OLS per-column visibility ('none' → DENY SELECT / column MASK). */
    columnPermissions?: Array<{ name: string; metadataPermission: 'read' | 'none' }>;
  }>;
  updatedAt: string;
}

/**
 * A linguistic-schema synonym row. Persisted on `state.model.synonyms` but the
 * read/write/validation helpers live in `lib/azure/linguistic-schema.ts` (its
 * "own slot"); this declaration exists so `LoomModelState` is the single shape
 * the slot belongs to.
 */
export interface SynonymEntry {
  objectType: 'table' | 'column' | 'measure';
  /** Home table for a column/measure (omitted for a table row). */
  table?: string;
  object: string;
  terms: string[];
  /** NL match weight in [0,1]; omitted = engine default. */
  weight?: number;
}

export interface LoomModelState {
  relationships: StoredRelationship[];
  measures: StoredMeasure[];
  // Wave-3 modeling objects — all OPTIONAL + back-compat (Azure-native, Cosmos):
  whatIfParameters?: WhatIfParameter[];
  calculatedTables?: CalculatedTable[];
  dateTables?: DateTableMark[];
  securityRoles?: SecurityRoleDef[];
  /** Linguistic-schema synonyms (written by linguistic-schema.ts; read-through here). */
  synonyms?: SynonymEntry[];
}

const CARDINALITIES: Cardinality[] = ['one-to-many', 'many-to-one', 'one-to-one', 'many-to-many'];
const CROSS_FILTERS: CrossFilter[] = ['single', 'both'];
/** Identifier-safe model object name: starts with a letter/underscore, then
 *  letters/digits/spaces/underscores. Single-quote/bracket-free so it is safe to
 *  interpolate into the generated DAX (`'<name>'[<name>]`). */
const MODEL_OBJECT_NAME = /^[A-Za-z_][A-Za-z0-9_ ]*$/;

/** Read the persisted model sub-state for an owned item (empty when absent). */
export async function readModelState(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<{ state: LoomModelState; itemFound: boolean }> {
  const empty: LoomModelState = {
    relationships: [], measures: [],
    whatIfParameters: [], calculatedTables: [], dateTables: [], securityRoles: [], synonyms: [],
  };
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return { state: empty, itemFound: false };
  const raw = (item.state as Record<string, unknown> | undefined)?.model as Partial<LoomModelState> | undefined;
  return {
    itemFound: true,
    // Every optional Wave-3 array is read THROUGH from the doc (default []), so a
    // read-modify-write by ANY consumer (measures route, dax-tools, the model
    // routes) preserves what-if / calc-tables / date marks / roles / synonyms.
    state: {
      relationships: Array.isArray(raw?.relationships) ? (raw!.relationships as StoredRelationship[]) : [],
      measures: Array.isArray(raw?.measures) ? (raw!.measures as StoredMeasure[]) : [],
      whatIfParameters: Array.isArray(raw?.whatIfParameters) ? (raw!.whatIfParameters as WhatIfParameter[]) : [],
      calculatedTables: Array.isArray(raw?.calculatedTables) ? (raw!.calculatedTables as CalculatedTable[]) : [],
      dateTables: Array.isArray(raw?.dateTables) ? (raw!.dateTables as DateTableMark[]) : [],
      securityRoles: Array.isArray(raw?.securityRoles) ? (raw!.securityRoles as SecurityRoleDef[]) : [],
      synonyms: Array.isArray(raw?.synonyms) ? (raw!.synonyms as SynonymEntry[]) : [],
    },
  };
}

/** Replace the model sub-state on an owned item, preserving the rest of `state`. */
export async function writeModelState(
  itemId: string,
  itemType: string,
  tenantId: string,
  model: LoomModelState,
): Promise<boolean> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return false;
  const nextState = { ...(item.state || {}), model };
  const updated = await updateOwnedItem(itemId, itemType, tenantId, { state: nextState });
  return !!updated;
}

/**
 * Validate + normalize an incoming relationship payload from the canvas. Throws
 * a plain Error (message becomes the 400 body) on invalid input.
 */
export function normalizeRelationship(
  input: unknown,
  source: 'cosmos' | 'uc',
  existing?: StoredRelationship,
): StoredRelationship {
  const r = (input || {}) as Record<string, unknown>;
  const fromTable = String(r.fromTable || '').trim();
  const fromColumn = String(r.fromColumn || '').trim();
  const toTable = String(r.toTable || '').trim();
  const toColumn = String(r.toColumn || '').trim();
  if (!fromTable || !fromColumn || !toTable || !toColumn) {
    throw new Error('fromTable, fromColumn, toTable and toColumn are all required');
  }
  const cardinality = CARDINALITIES.includes(r.cardinality as Cardinality) ? (r.cardinality as Cardinality) : 'many-to-one';
  const crossFilter = CROSS_FILTERS.includes(r.crossFilter as CrossFilter) ? (r.crossFilter as CrossFilter) : 'single';
  const now = new Date().toISOString();
  const name = String(r.name || `FK_${fromTable.split('.').pop()}_${toTable.split('.').pop()}`).replace(/[^A-Za-z0-9_]/g, '_');
  // RI flag flows from the create-relationship dialog Switch through the route to
  // here; preserve the existing flag on edit when the payload omits it.
  const assumeReferentialIntegrity =
    r.assumeReferentialIntegrity === undefined ? existing?.assumeReferentialIntegrity : !!r.assumeReferentialIntegrity;
  return {
    id: existing?.id || (globalThis.crypto?.randomUUID?.() ?? `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name,
    fromTable, fromColumn, toTable, toColumn,
    cardinality, crossFilter,
    active: r.active === undefined ? true : !!r.active,
    assumeReferentialIntegrity,
    source,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

/** Upsert a relationship into a model state by id (mutates a copy, returns it). */
export function upsertRelationship(model: LoomModelState, rel: StoredRelationship): LoomModelState {
  const relationships = model.relationships.filter((x) => x.id !== rel.id);
  relationships.push(rel);
  return { ...model, relationships };
}

/** Remove a relationship by id. */
export function removeRelationship(model: LoomModelState, relId: string): LoomModelState {
  return { ...model, relationships: model.relationships.filter((x) => x.id !== relId) };
}

/** Validate + normalize an incoming measure payload. Throws on invalid input. */
export function normalizeMeasure(input: unknown, defaultKind: MeasureKind): StoredMeasure {
  const m = (input || {}) as Record<string, unknown>;
  const name = String(m.name || '').trim();
  const expression = String(m.expression || '').trim();
  if (!name) throw new Error('measure name is required');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('measure name must be a valid identifier');
  if (!expression) throw new Error('measure expression is required');
  const kind = (['tvf', 'scalar', 'cosmos'] as MeasureKind[]).includes(m.kind as MeasureKind) ? (m.kind as MeasureKind) : defaultKind;
  const now = new Date().toISOString();
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    schema: kind === 'tvf' || kind === 'scalar' ? String(m.schema || 'dbo').trim() || 'dbo' : undefined,
    expression,
    kind,
    createdAt: now,
    updatedAt: now,
  };
}

/** Upsert a measure by (schema,name) identity. */
export function upsertMeasure(model: LoomModelState, measure: StoredMeasure): LoomModelState {
  const measures = model.measures.filter(
    (x) => !(x.name === measure.name && (x.schema || '') === (measure.schema || '')),
  );
  measures.push(measure);
  return { ...model, measures };
}

/**
 * Build the `CREATE OR ALTER FUNCTION … RETURNS TABLE` DDL for a Synapse /
 * Warehouse inline table-valued-function measure. The user's expression is the
 * SELECT body. We do not interpolate untrusted identifiers beyond schema/name,
 * which are validated above.
 */
export function tvfDdl(measure: StoredMeasure): string {
  const schema = (measure.schema || 'dbo').replace(/[[\]]/g, '');
  const name = measure.name.replace(/[[\]]/g, '');
  const body = measure.expression.trim().replace(/;+\s*$/, '');
  return `CREATE OR ALTER FUNCTION [${schema}].[${name}]()\nRETURNS TABLE\nAS RETURN (\n${body}\n);`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Wave-3 modeling objects — normalize (throw plain Error → 400) + upsert/remove.
// All persist Azure-native onto `state.model`; NO Fabric / Power BI dependency.
// ──────────────────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toFiniteNumber(v: unknown, field: string): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isFinite(n)) throw new Error(`what-if ${field} must be a finite number`);
  return n;
}

/** Format a numeric literal for generated DAX, honoring the parameter dataType
 *  (mirrors the dialog's generator so the server-authored DAX matches the preview). */
function fmtWhatIfNum(n: number, dataType: WhatIfDataType): string {
  if (dataType === 'int64') return String(Math.trunc(n));
  return String(n);
}

/**
 * Validate a structured what-if payload and GENERATE its three DAX strings
 * (series table / value measure / bound slicer column). The DAX is authored
 * here, never accepted from the client — loom_no_freeform_config honored.
 * Throws a plain Error (→ 400) on invalid input.
 */
export function normalizeWhatIfParameter(input: unknown): WhatIfParameter {
  const p = (input || {}) as Record<string, unknown>;
  const name = String(p.name ?? '').trim();
  if (!name) throw new Error('what-if parameter name is required');
  if (!MODEL_OBJECT_NAME.test(name)) {
    throw new Error('what-if parameter name must start with a letter or underscore and contain only letters, digits, spaces or underscores');
  }
  const min = toFiniteNumber(p.min, 'min');
  const max = toFiniteNumber(p.max, 'max');
  const increment = toFiniteNumber(p.increment, 'increment');
  if (!(increment > 0)) throw new Error('what-if increment must be greater than zero');
  if (!(min < max)) throw new Error('what-if minimum must be less than maximum');
  const defaultValue =
    p.defaultValue === undefined || p.defaultValue === null ? min : toFiniteNumber(p.defaultValue, 'defaultValue');
  if (!(defaultValue >= min && defaultValue <= max)) {
    throw new Error('what-if default value must be between the minimum and maximum');
  }
  const dataType: WhatIfDataType =
    p.dataType === 'int64' || p.dataType === 'decimal' || p.dataType === 'double'
      ? p.dataType
      : Number.isInteger(min) && Number.isInteger(max) && Number.isInteger(increment) && Number.isInteger(defaultValue)
        ? 'int64'
        : 'double';
  const now = new Date().toISOString();
  const seriesExpression = `GENERATESERIES(${fmtWhatIfNum(min, dataType)}, ${fmtWhatIfNum(max, dataType)}, ${fmtWhatIfNum(increment, dataType)})`;
  const valueMeasure = `SELECTEDVALUE('${name}'[${name}], ${fmtWhatIfNum(defaultValue, dataType)})`;
  const boundSlicerColumn = `'${name}'[${name}]`;
  return {
    id: typeof p.id === 'string' && p.id.trim() ? p.id.trim() : genId('whatif'),
    name,
    min,
    max,
    increment,
    defaultValue,
    dataType,
    seriesExpression,
    valueMeasure,
    boundSlicerColumn,
    createdAt: typeof p.createdAt === 'string' && p.createdAt ? p.createdAt : now,
    updatedAt: now,
  };
}

/** Upsert a what-if parameter by id OR name (the table name is the unique key). */
export function upsertWhatIfParameter(s: LoomModelState, p: WhatIfParameter): LoomModelState {
  const whatIfParameters = (s.whatIfParameters || []).filter((x) => x.id !== p.id && x.name !== p.name);
  whatIfParameters.push(p);
  return { ...s, whatIfParameters };
}

/** Remove a what-if parameter by id. */
export function removeWhatIfParameter(s: LoomModelState, id: string): LoomModelState {
  return { ...s, whatIfParameters: (s.whatIfParameters || []).filter((x) => x.id !== id) };
}

/**
 * Validate a calculated-table payload. The expression is the ONE sanctioned
 * free-form surface; it is guarded to a single read-only statement (no `;`, and
 * for SQL no DDL/DML — a calculated table is a projection, never a side effect).
 * Throws a plain Error (→ 400) on invalid input.
 */
export function normalizeCalculatedTable(input: unknown): CalculatedTable {
  const t = (input || {}) as Record<string, unknown>;
  const name = String(t.name ?? '').trim();
  if (!name) throw new Error('calculated table name is required');
  if (!MODEL_OBJECT_NAME.test(name)) {
    throw new Error('calculated table name must start with a letter or underscore and contain only letters, digits, spaces or underscores');
  }
  const language: CalculatedTable['language'] = t.language === 'sql' ? 'sql' : 'dax';
  const expression = String(t.expression ?? '').trim().replace(/;+\s*$/, '').trim();
  if (!expression) throw new Error('calculated table expression is required');
  if (expression.includes(';')) {
    throw new Error('calculated table expression must be a single statement (no ";")');
  }
  if (language === 'sql') {
    if (!/^\s*(with|select)\b/i.test(expression)) {
      throw new Error('a SQL calculated table must be a SELECT (optionally WITH … SELECT)');
    }
    if (/\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|deny|exec|execute|into)\b/i.test(expression)) {
      throw new Error('a SQL calculated table must be a read-only SELECT (no DDL/DML)');
    }
  }
  const now = new Date().toISOString();
  return {
    id: typeof t.id === 'string' && t.id.trim() ? t.id.trim() : genId('calctbl'),
    name,
    expression,
    language,
    createdAt: typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : now,
    updatedAt: now,
  };
}

/** Upsert a calculated table by id OR name. */
export function upsertCalculatedTable(s: LoomModelState, t: CalculatedTable): LoomModelState {
  const calculatedTables = (s.calculatedTables || []).filter((x) => x.id !== t.id && x.name !== t.name);
  calculatedTables.push(t);
  return { ...s, calculatedTables };
}

/** Remove a calculated table by id. */
export function removeCalculatedTable(s: LoomModelState, id: string): LoomModelState {
  return { ...s, calculatedTables: (s.calculatedTables || []).filter((x) => x.id !== id) };
}

/** Validate a mark-as-date-table payload. Throws a plain Error (→ 400). */
export function normalizeDateTableMark(input: unknown): DateTableMark {
  const m = (input || {}) as Record<string, unknown>;
  const table = String(m.table ?? '').trim();
  const dateColumn = String(m.dateColumn ?? '').trim();
  if (!table) throw new Error('a date table mark requires a table');
  if (!dateColumn) throw new Error('a date table mark requires a dateColumn');
  return { table, dateColumn, updatedAt: new Date().toISOString() };
}

/** Upsert a date-table mark by table (one mark per table). */
export function upsertDateTableMark(s: LoomModelState, m: DateTableMark): LoomModelState {
  const dateTables = (s.dateTables || []).filter((x) => x.table !== m.table);
  dateTables.push(m);
  return { ...s, dateTables };
}

/** Remove a date-table mark by table. */
export function removeDateTableMark(s: LoomModelState, table: string): LoomModelState {
  return { ...s, dateTables: (s.dateTables || []).filter((x) => x.table !== table) };
}

/**
 * Validate a security-role payload into the canonical `SecurityRoleDef` shape
 * (the RLS/OLS compiler's source of truth). Structural validation only — the DAX
 * filter is lowered/validated by rls-compiler / validateRlsDax in the route.
 * Throws a plain Error (→ 400) on a malformed shape.
 */
export function normalizeSecurityRole(input: unknown): SecurityRoleDef {
  const r = (input || {}) as Record<string, unknown>;
  const name = String(r.name ?? '').trim();
  if (!name) throw new Error('security role name is required');
  if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(name)) {
    throw new Error('security role name must start with a letter or underscore and contain only letters, digits, spaces, dashes or underscores');
  }
  const members = Array.isArray(r.members)
    ? Array.from(new Set(r.members.map((x) => String(x).trim()).filter(Boolean)))
    : [];
  const rawPerms = Array.isArray(r.tablePermissions) ? r.tablePermissions : [];
  const tablePermissions: SecurityRoleDef['tablePermissions'] = rawPerms.map(
    (tp, i): SecurityRoleDef['tablePermissions'][number] => {
      const t = (tp || {}) as Record<string, unknown>;
      const table = String(t.table ?? '').trim();
      if (!table) throw new Error(`table permission #${i + 1} requires a table`);
      const filter = String(t.filterExpression ?? '').trim();
      const metadataPermission: 'read' | 'none' | undefined =
        t.metadataPermission === 'none' ? 'none' : t.metadataPermission === 'read' ? 'read' : undefined;
      const columnPermissions = Array.isArray(t.columnPermissions)
        ? t.columnPermissions.map((cp, j) => {
            const c = (cp || {}) as Record<string, unknown>;
            const cn = String(c.name ?? '').trim();
            if (!cn) throw new Error(`column permission #${j + 1} on ${table} requires a name`);
            return { name: cn, metadataPermission: (c.metadataPermission === 'none' ? 'none' : 'read') as 'read' | 'none' };
          })
        : undefined;
      return {
        table,
        ...(filter ? { filterExpression: filter } : {}),
        ...(metadataPermission ? { metadataPermission } : {}),
        ...(columnPermissions ? { columnPermissions } : {}),
      };
    },
  );
  return { name, members, tablePermissions, updatedAt: new Date().toISOString() };
}

/** Upsert a security role by name (the role name is the unique key). */
export function upsertSecurityRole(s: LoomModelState, role: SecurityRoleDef): LoomModelState {
  const securityRoles = (s.securityRoles || []).filter((x) => x.name !== role.name);
  securityRoles.push(role);
  return { ...s, securityRoles };
}

/** Remove a security role by name. */
export function removeSecurityRole(s: LoomModelState, name: string): LoomModelState {
  return { ...s, securityRoles: (s.securityRoles || []).filter((x) => x.name !== name) };
}
