/**
 * KQL Dashboard model — shared types + the parameter/time substitution
 * engine used by both the read route (GET ?run=1) and the live builder
 * route (POST /run on an unsaved/dirty model).
 *
 * Parity target: Fabric Real-Time Dashboard
 * (https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create
 *  + .../dashboard-parameters). A dashboard is a collection of tiles, each
 * with a KQL query + a visual type, bound to a data source, parameterized by
 * dashboard-level parameters and a global time range.
 *
 * The substitution is deliberately literal — Fabric substitutes the
 * parameter *variable name* (e.g. `_eventType`, `_startTime`) directly into
 * the query text. Operators own their KQL (they wrote the dashboard), so we
 * do not attempt to quote/escape; we DO type-render the value so a `string`
 * param becomes a quoted KQL literal and a `datetime`/`long`/`int`/`real`
 * param becomes a bare literal, matching the ADX render semantics.
 */

export type TileViz =
  | 'table'
  | 'timechart'   // time-series line (x = first datetime col)
  | 'line'        // generic line (alias of timechart for category x)
  | 'bar'         // horizontal bars
  | 'column'      // vertical bars
  | 'pie'
  | 'stat'        // single big-number card (KPI)
  | 'map';        // point map (lat/long columns)

export const VALID_VIZ = new Set<TileViz>([
  'table', 'timechart', 'line', 'bar', 'column', 'pie', 'stat', 'map',
]);

export interface DashboardDataSource {
  /** Stable id referenced by tiles (`tile.dataSourceId`) + datasource params. */
  id: string;
  /** Friendly name shown in the picker. */
  name: string;
  /** Kusto database the source resolves to. */
  database: string;
  /** Optional cluster URI override; defaults to the Loom shared cluster. */
  clusterUri?: string;
}

export type ParamType =
  | 'freetext'        // operator types a value
  | 'fixed'           // single-select from a fixed list
  | 'multi'           // multi-select from a fixed list
  | 'query'           // values come from a KQL query (dropdown)
  | 'datasource'      // selects one of the dashboard data sources
  | 'duration';       // time-range (start/end datetimes)

export type ParamDataType = 'string' | 'long' | 'int' | 'real' | 'datetime' | 'bool';

export interface DashboardParam {
  /** KQL variable name, e.g. `_eventType` (Fabric convention — leading _). */
  variableName: string;
  /** UI label. */
  label?: string;
  type: ParamType;
  dataType?: ParamDataType;
  /** For `fixed`/`multi`: the allowed values. */
  values?: string[];
  /** For `query`: KQL that returns a single column of values. */
  query?: string;
  /** Data source the `query` param runs against (id). */
  dataSourceId?: string;
  /** Current selected value(s). multi → array; others → scalar. */
  value?: string | string[];
}

// ============================================================
// Conditional formatting (Fabric Real-Time Dashboard parity)
// https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-conditional-formatting
// Two rule types per tile, applied to table/stat cells:
//  - 'condition'  → "Color by condition" (operator threshold → fixed color/icon)
//  - 'value'      → "Color by value"     (numeric column → gradient theme)
// Rules are evaluated in order; the LAST matching rule wins (Fabric precedence).
// ============================================================
export type CfOperator = '<' | '<=' | '>' | '>=' | '==' | '!=' | 'is empty' | 'is not empty';
export type CfColor = 'red' | 'yellow' | 'green' | 'blue';
export type CfIcon = 'warning' | 'error' | 'success' | 'info';
export type CfTheme = 'traffic-lights' | 'cold' | 'warm' | 'blue' | 'red' | 'yellow';

export const CF_OPERATORS: CfOperator[] = ['<', '<=', '>', '>=', '==', '!=', 'is empty', 'is not empty'];
export const CF_COLORS: CfColor[] = ['red', 'yellow', 'green', 'blue'];
export const CF_ICONS: CfIcon[] = ['warning', 'error', 'success', 'info'];
export const CF_THEMES: CfTheme[] = ['traffic-lights', 'cold', 'warm', 'blue', 'red', 'yellow'];

/** A single AND-ed predicate inside a "color by condition" rule. */
export interface CfCondition {
  /** Result column the predicate tests. */
  column: string;
  operator: CfOperator;
  /** Comparand. Ignored for `is empty` / `is not empty`. */
  value?: string;
}

export interface ConditionalRule {
  type: 'condition' | 'value';
  name?: string;
  // ---- color-by-condition fields ----
  colorStyle?: 'bold' | 'light';
  /** All conditions must pass (AND) for the rule to apply. */
  conditions?: CfCondition[];
  color?: CfColor;
  tag?: string;
  icon?: CfIcon;
  /** table only: paint the whole row or just the matched cells. */
  applyTo?: 'cells' | 'row';
  /** table + `applyTo:'cells'`: which column's cell to paint. */
  targetColumn?: string;
  /** table + `applyTo:'cells'`: hide the cell text, keeping only color/icon. */
  hideText?: boolean;
  // ---- color-by-value fields ----
  /** The numeric column graded onto the gradient. */
  column?: string;
  theme?: CfTheme;
  minValue?: number;
  maxValue?: number;
  reverseColors?: boolean;
}

/** A resolved decoration for one cell/row, produced by `evalConditionalRules`. */
export interface CfMatch {
  /** Discrete bucket color (condition rules) → renderer maps to a Fluent token. */
  color?: CfColor;
  /** Precomputed gradient CSS (value rules). */
  bg?: string;
  /** Readable foreground for the gradient bg (value rules). */
  fg?: string;
  icon?: CfIcon;
  tag?: string;
  style: 'bold' | 'light';
  applyTo: 'cells' | 'row';
  /** In `cells` mode: the single column to paint (value rules, or explicit pick). */
  targetColumn?: string;
  /** In `cells` mode with no `targetColumn`: paint these columns (the conditioned ones). */
  cellColumns?: string[];
  hideText?: boolean;
}

export interface DashboardTile {
  title: string;
  kql: string;
  viz: TileViz;
  /** Bound data source id (resolves to a database). */
  dataSourceId?: string;
  /** Legacy direct database override (pre-data-source model). */
  database?: string;
  /** Grid geometry — column span 1..12, row height in grid units. */
  w?: number;
  h?: number;
  /** Per-tile conditional-formatting rules (table/stat cells). */
  conditionalRules?: ConditionalRule[];
}

// Gradient stops per theme, low→high (RGB). Mirrors Fabric's color-by-value
// palettes; interpolated by `evalConditionalRules`.
const CF_THEME_STOPS: Record<CfTheme, [number, number, number][]> = {
  'traffic-lights': [[216, 59, 1], [247, 180, 0], [16, 124, 16]],
  cold: [[199, 224, 244], [0, 90, 158]],
  warm: [[255, 241, 184], [202, 80, 16], [168, 0, 0]],
  blue: [[222, 235, 250], [0, 69, 120]],
  red: [[253, 231, 229], [168, 0, 0]],
  yellow: [[255, 244, 206], [180, 120, 0]],
};

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Interpolate a theme gradient at position t∈[0,1]; returns CSS bg + readable fg. */
export function gradientColor(theme: CfTheme, t: number, reverse?: boolean): { bg: string; fg: string } {
  const stops = CF_THEME_STOPS[theme] || CF_THEME_STOPS['traffic-lights'];
  const tt = clamp01(reverse ? 1 - clamp01(t) : t);
  const seg = tt * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const c0 = stops[i], c1 = stops[i + 1];
  const r = lerpChannel(c0[0], c1[0], f);
  const g = lerpChannel(c0[1], c1[1], f);
  const b = lerpChannel(c0[2], c1[2], f);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return { bg: `rgb(${r}, ${g}, ${b})`, fg: lum > 140 ? '#1b1b1b' : '#ffffff' };
}

function cellByColumn(columns: string[], row: unknown[], name: string | undefined): unknown {
  if (!name) return undefined;
  const idx = columns.indexOf(name);
  return idx >= 0 ? row[idx] : undefined;
}

function isEmptyCell(cell: unknown): boolean {
  return cell === null || cell === undefined || cell === '';
}

/** Evaluate one condition predicate against a cell value. */
export function evalCondition(cell: unknown, op: CfOperator, value: string | undefined): boolean {
  if (op === 'is empty') return isEmptyCell(cell);
  if (op === 'is not empty') return !isEmptyCell(cell);
  const cn = Number(cell);
  const vn = Number(value);
  const numeric = value !== undefined && value !== '' && Number.isFinite(cn) && Number.isFinite(vn) && cell !== null && cell !== '' && cell !== undefined;
  switch (op) {
    case '==': return numeric ? cn === vn : String(cell) === String(value);
    case '!=': return numeric ? cn !== vn : String(cell) !== String(value);
    case '<': return numeric ? cn < vn : String(cell) < String(value);
    case '<=': return numeric ? cn <= vn : String(cell) <= String(value);
    case '>': return numeric ? cn > vn : String(cell) > String(value);
    case '>=': return numeric ? cn >= vn : String(cell) >= String(value);
    default: return false;
  }
}

/**
 * Resolve the conditional-formatting decoration for one row. Rules are
 * evaluated in order; the LAST matching rule wins (Fabric precedence). Returns
 * `undefined` when no rule matches (cell renders unstyled).
 *
 * `colStats` (optional) gives per-column min/max across the whole result so a
 * color-by-value rule without explicit min/max auto-scales like Fabric.
 */
export function evalConditionalRules(
  rules: ConditionalRule[] | undefined,
  row: unknown[],
  columns: string[],
  colStats?: Record<string, { min: number; max: number }>,
): CfMatch | undefined {
  if (!Array.isArray(rules) || rules.length === 0) return undefined;
  let match: CfMatch | undefined;
  for (const rule of rules) {
    if (rule.type === 'value') {
      const raw = cellByColumn(columns, row, rule.column);
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      const stats = rule.column ? colStats?.[rule.column] : undefined;
      const min = Number.isFinite(rule.minValue as number) ? (rule.minValue as number)
        : stats ? stats.min : 0;
      const max = Number.isFinite(rule.maxValue as number) ? (rule.maxValue as number)
        : stats ? stats.max : 100;
      const span = max - min;
      const t = span === 0 ? 0.5 : (n - min) / span;
      const { bg, fg } = gradientColor(rule.theme || 'traffic-lights', t, rule.reverseColors);
      match = {
        bg, fg,
        style: rule.colorStyle || 'bold',
        applyTo: rule.applyTo === 'row' ? 'row' : 'cells',
        targetColumn: rule.targetColumn || rule.column,
        hideText: rule.hideText,
        tag: rule.tag,
        icon: rule.icon,
      };
    } else {
      const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
      if (conds.length === 0) continue;
      const allPass = conds.every((c) => evalCondition(cellByColumn(columns, row, c.column), c.operator, c.value));
      if (!allPass) continue;
      match = {
        color: rule.color || 'red',
        icon: rule.icon,
        tag: rule.tag,
        style: rule.colorStyle || 'bold',
        applyTo: rule.applyTo === 'row' ? 'row' : 'cells',
        targetColumn: rule.targetColumn || undefined,
        cellColumns: rule.targetColumn ? undefined : conds.map((c) => c.column).filter(Boolean),
        hideText: rule.hideText,
      };
    }
  }
  return match;
}

export interface DashboardModel {
  tiles: DashboardTile[];
  dataSources: DashboardDataSource[];
  parameters: DashboardParam[];
  /** Global time range key, e.g. `last-24h`, or a raw `ago(...)` token. */
  timeRange?: string;
  autoRefreshMs?: number;
}

export const TIME_MAP: Record<string, string> = {
  'last-5m': 'ago(5m)',
  'last-15m': 'ago(15m)',
  'last-1h': 'ago(1h)',
  'last-4h': 'ago(4h)',
  'last-24h': 'ago(24h)',
  'last-7d': 'ago(7d)',
  'last-30d': 'ago(30d)',
  'all': 'datetime(1970-01-01)',
};

/** Resolve a time-range key (or raw ago token) to the start-bound KQL. */
export function resolveTimeFrom(timeKey: string | undefined): string {
  if (!timeKey) return TIME_MAP['last-24h'];
  return TIME_MAP[timeKey] || timeKey;
}

/** Render a parameter value as a KQL literal appropriate to its data type. */
export function renderParamLiteral(value: string, dataType: ParamDataType | undefined): string {
  switch (dataType) {
    case 'long':
    case 'int':
    case 'real':
      // Bare numeric literal; fall back to 0 if non-numeric.
      return Number.isFinite(Number(value)) ? String(Number(value)) : '0';
    case 'bool':
      return value === 'true' || value === '1' ? 'true' : 'false';
    case 'datetime':
      // datetime(...) wrapper; operators may also pass a bare ago(...) token.
      return /^(ago|now|datetime|startofday|endofday|bin)\b/.test(value.trim())
        ? value.trim()
        : `datetime(${value})`;
    case 'string':
    default:
      // Double-quoted KQL string literal with internal quotes escaped.
      return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
}

/**
 * Substitute the global time range and every dashboard parameter into a
 * tile's KQL.
 *
 * Substitution tokens (in precedence order):
 *  - `_loomTimeFrom`  → resolved time-from (back-compat with v2.x tiles)
 *  - `_startTime` / `_endTime` → Fabric duration-param convention
 *  - each param's `variableName` (e.g. `_eventType`) → typed literal.
 *    `multi` params render as a `dynamic([...])` array so `x in (_p)` works.
 */
export function substituteTileKql(
  kql: string,
  params: DashboardParam[],
  timeKey: string | undefined,
): string {
  const timeFrom = resolveTimeFrom(timeKey);
  let out = kql.replace(/\b_loomTimeFrom\b/g, timeFrom);

  // Fabric duration-parameter convention: _startTime / _endTime.
  out = out
    .replace(/\b_startTime\b/g, timeFrom)
    .replace(/\b_endTime\b/g, 'now()');

  for (const p of params || []) {
    if (!p.variableName || !/^_?[a-zA-Z][a-zA-Z0-9_]*$/.test(p.variableName)) continue;
    const token = p.variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${token}\\b`, 'g');
    if (p.type === 'multi' && Array.isArray(p.value)) {
      const arr = p.value.map((v) => renderParamLiteral(v, p.dataType || 'string')).join(', ');
      out = out.replace(re, `dynamic([${arr}])`);
    } else if (Array.isArray(p.value)) {
      out = out.replace(re, renderParamLiteral(p.value[0] ?? '', p.dataType));
    } else if (p.value !== undefined && p.value !== '') {
      out = out.replace(re, renderParamLiteral(p.value, p.dataType));
    }
    // If no value, leave the token — KQL will error, surfacing "param unset",
    // which is the honest behavior (matches Fabric's inactive-filter note).
  }
  return out;
}

const DEFAULT_DB = process.env.LOOM_KUSTO_DEFAULT_DB || 'loomdb-default';

/**
 * Resolve the database a tile executes against: explicit `database` override,
 * else the bound data source, else the item's resolved database, else the
 * cluster default.
 */
export function resolveTileDatabase(
  tile: DashboardTile,
  dataSources: DashboardDataSource[],
  fallback: string,
): string {
  if (tile.database && tile.database.trim()) return tile.database.trim();
  if (tile.dataSourceId) {
    const ds = (dataSources || []).find((d) => d.id === tile.dataSourceId);
    if (ds?.database) return ds.database;
  }
  return fallback || DEFAULT_DB;
}

/** Coerce arbitrary input into a clean DashboardModel (PUT body / JSON edit). */
export function sanitizeModel(input: any): DashboardModel {
  const sources: DashboardDataSource[] = Array.isArray(input?.dataSources)
    ? input.dataSources
        .map((d: any): DashboardDataSource => ({
          id: String(d?.id || '').slice(0, 80) || crypto.randomUUID(),
          name: String(d?.name || 'Source').slice(0, 120),
          database: String(d?.database || DEFAULT_DB).slice(0, 200),
          clusterUri: d?.clusterUri ? String(d.clusterUri).slice(0, 300) : undefined,
        }))
        .slice(0, 25)
    : [];

  const parameters: DashboardParam[] = Array.isArray(input?.parameters)
    ? input.parameters
        .map((p: any): DashboardParam => ({
          variableName: String(p?.variableName || '').slice(0, 80),
          label: p?.label ? String(p.label).slice(0, 120) : undefined,
          type: ['freetext', 'fixed', 'multi', 'query', 'datasource', 'duration'].includes(p?.type)
            ? p.type
            : 'freetext',
          dataType: ['string', 'long', 'int', 'real', 'datetime', 'bool'].includes(p?.dataType)
            ? p.dataType
            : 'string',
          values: Array.isArray(p?.values) ? p.values.map((v: any) => String(v)).slice(0, 500) : undefined,
          query: p?.query ? String(p.query).slice(0, 8192) : undefined,
          dataSourceId: p?.dataSourceId ? String(p.dataSourceId).slice(0, 80) : undefined,
          value: Array.isArray(p?.value) ? p.value.map((v: any) => String(v)) : p?.value !== undefined ? String(p.value) : undefined,
        }))
        .filter((p: DashboardParam) => /^_?[a-zA-Z][a-zA-Z0-9_]*$/.test(p.variableName))
        .slice(0, 50)
    : [];

  const tiles: DashboardTile[] = Array.isArray(input?.tiles)
    ? input.tiles
        .map((t: any): DashboardTile => ({
          title: String(t?.title || 'Untitled tile').slice(0, 200),
          kql: String(t?.kql || ''),
          viz: VALID_VIZ.has(t?.viz) ? t.viz : 'table',
          dataSourceId: t?.dataSourceId ? String(t.dataSourceId).slice(0, 80) : undefined,
          database: t?.database ? String(t.database).slice(0, 200) : undefined,
          w: clampInt(t?.w, 1, 12),
          h: clampInt(t?.h, 1, 8),
          conditionalRules: sanitizeConditionalRules(t?.conditionalRules),
        }))
        .filter((t: DashboardTile) => t.kql.length > 0 && t.kql.length <= 65_536)
        .slice(0, 100)
    : [];

  return {
    tiles,
    dataSources: sources,
    parameters,
    timeRange: input?.timeRange ? String(input.timeRange).slice(0, 60) : undefined,
    autoRefreshMs: Number.isFinite(Number(input?.autoRefreshMs)) ? Number(input.autoRefreshMs) : undefined,
  };
}

function clampInt(v: any, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Coerce arbitrary input into clean ConditionalRule[] (max 20 rules/tile). */
function sanitizeConditionalRules(input: any): ConditionalRule[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const rules = input
    .map((r: any): ConditionalRule | null => {
      const type = r?.type === 'value' ? 'value' : 'condition';
      const base: ConditionalRule = {
        type,
        name: r?.name ? String(r.name).slice(0, 120) : undefined,
        colorStyle: r?.colorStyle === 'light' ? 'light' : 'bold',
        icon: CF_ICONS.includes(r?.icon) ? r.icon : undefined,
        tag: r?.tag ? String(r.tag).slice(0, 80) : undefined,
        applyTo: r?.applyTo === 'row' ? 'row' : 'cells',
        targetColumn: r?.targetColumn ? String(r.targetColumn).slice(0, 200) : undefined,
        hideText: r?.hideText === true ? true : undefined,
      };
      if (type === 'value') {
        if (!r?.column) return null;
        base.column = String(r.column).slice(0, 200);
        base.theme = CF_THEMES.includes(r?.theme) ? r.theme : 'traffic-lights';
        base.minValue = Number.isFinite(Number(r?.minValue)) && r?.minValue !== '' && r?.minValue != null ? Number(r.minValue) : undefined;
        base.maxValue = Number.isFinite(Number(r?.maxValue)) && r?.maxValue !== '' && r?.maxValue != null ? Number(r.maxValue) : undefined;
        base.reverseColors = r?.reverseColors === true ? true : undefined;
      } else {
        base.color = CF_COLORS.includes(r?.color) ? r.color : 'red';
        const conds: CfCondition[] = Array.isArray(r?.conditions)
          ? r.conditions
              .map((c: any): CfCondition | null => {
                if (!c?.column || !CF_OPERATORS.includes(c?.operator)) return null;
                return {
                  column: String(c.column).slice(0, 200),
                  operator: c.operator,
                  value: c?.value !== undefined && c?.value !== null ? String(c.value).slice(0, 200) : undefined,
                };
              })
              .filter((c: CfCondition | null): c is CfCondition => c !== null)
              .slice(0, 10)
          : [];
        if (conds.length === 0) return null;
        base.conditions = conds;
      }
      return base;
    })
    .filter((r: ConditionalRule | null): r is ConditionalRule => r !== null)
    .slice(0, 20);
  return rules.length > 0 ? rules : undefined;
}
