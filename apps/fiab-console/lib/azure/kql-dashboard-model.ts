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

/**
 * Per-tile drill-through wiring. Fabric Real-Time Dashboards expose
 * "drillthroughs" under a visual's Interactions: selecting a value in a
 * visual maps a result column to a dashboard parameter, which re-filters the
 * (target) page. Loom is single-page, so the parameter injection stays on the
 * current page — clicking a value sets `paramName` to the value in `column`
 * and re-runs every tile (cross-filter), matching the documented behavior.
 * Grounded in Microsoft Learn: dashboard-parameters#use-drillthroughs-as-
 * dashboard-parameters.
 */
export interface DashTileDrillthrough {
  /** Column name from the tile's query result to extract on click. */
  column: string;
  /** The dashboard parameter `variableName` to inject the clicked value into. */
  paramName: string;
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
  /** Drill-through: clicking a result value sets a dashboard parameter. */
  drillthrough?: DashTileDrillthrough;
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

/** Map a DashboardParam dataType to the KQL scalar type used in declare query_parameters. */
export function paramTypeToKustoType(dt: ParamDataType | undefined): string {
  switch (dt) {
    case 'long': return 'long';
    case 'int': return 'int';
    case 'real': return 'real';
    case 'datetime': return 'datetime';
    case 'bool': return 'bool';
    case 'string':
    default: return 'string';
  }
}

/**
 * Build the final, injection-safe KQL sent to ADX for a single tile, using a
 * `declare query_parameters(...)` prefix for scalar params and `let` bindings
 * for dynamic (multi-select) params, instead of splicing values into the body.
 *
 * Why this exists (vs. the older text-substitution `substituteTileKql`):
 * splicing a user-typed value straight into a filter condition is not
 * injection-safe — `", x)` could break the query structure. ADX's
 * `declare query_parameters(name:type = default);` prefix lets Kusto bind the
 * value through its own typed parser, so the body stays literal.
 *
 * Grounded in Microsoft Learn — Query parameters declaration statement
 * (https://learn.microsoft.com/kusto/query/query-parameters-statement):
 *   - scalar query parameters CAN carry a default value in the declaration,
 *     e.g. `declare query_parameters(maxInjured:long = 90);`
 *   - `dynamic` query parameters CANNOT carry default values, so multi-select
 *     params are emitted as a `let _name = dynamic([...]);` binding instead
 *     (valid KQL, evaluated before the body).
 *
 * Synthetic time tokens (`_startTime`, `_endTime`, `_loomTimeFrom`) are
 * meta-variables resolved by text substitution (they are not user params).
 *
 * Only params whose `variableName` actually appears in the KQL body are
 * emitted in the prefix, keeping the query minimal. A param with no value is
 * skipped — its token is left in the body so Kusto surfaces the honest
 * "parameter unset" error (matches Fabric's inactive-filter behaviour).
 */
export function buildTileKql(
  kql: string,
  params: DashboardParam[],
  timeKey: string | undefined,
): string {
  const timeFrom = resolveTimeFrom(timeKey);

  // Synthetic time tokens — text-substitute (not user params).
  const body = kql
    .replace(/\b_loomTimeFrom\b/g, timeFrom)
    .replace(/\b_startTime\b/g, timeFrom)
    .replace(/\b_endTime\b/g, 'now()');

  const declares: string[] = []; // declare query_parameters(...) entries
  const lets: string[] = [];     // let _name = dynamic([...]);

  for (const p of params || []) {
    if (!p.variableName || !/^_?[a-zA-Z][a-zA-Z0-9_]*$/.test(p.variableName)) continue;
    // `duration` params drive the global _startTime/_endTime resolution, not a
    // named scalar declaration — skip them here.
    if (p.type === 'duration') continue;
    // Only emit if the variable is actually referenced in the body.
    const esc = p.variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\b${esc}\\b`).test(body)) continue;

    if (p.type === 'multi' && Array.isArray(p.value) && p.value.length > 0) {
      // dynamic cannot have a default in declare query_parameters — use a let.
      const arr = p.value.map((v) => renderParamLiteral(v, p.dataType || 'string')).join(', ');
      lets.push(`let ${p.variableName} = dynamic([${arr}]);`);
    } else if (p.value !== undefined && p.value !== '' && !Array.isArray(p.value)) {
      const dt = paramTypeToKustoType(p.dataType);
      const defaultLit = renderParamLiteral(p.value, p.dataType);
      declares.push(`${p.variableName}:${dt} = ${defaultLit}`);
    }
    // No value → skip; token stays in the body (honest "param unset").
  }

  const prefix: string[] = [];
  if (declares.length) prefix.push(`declare query_parameters(${declares.join(', ')});`);
  prefix.push(...lets);

  return prefix.length ? prefix.join('\n') + '\n' + body : body;
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
          drillthrough:
            t?.drillthrough?.column != null && t?.drillthrough?.paramName != null &&
            String(t.drillthrough.column).trim() && String(t.drillthrough.paramName).trim()
              ? {
                  column: String(t.drillthrough.column).slice(0, 80),
                  paramName: String(t.drillthrough.paramName).slice(0, 80),
                }
              : undefined,
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
