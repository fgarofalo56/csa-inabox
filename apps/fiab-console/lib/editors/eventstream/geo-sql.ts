/**
 * Eventstream geospatial operators — PURE Stream Analytics SQL (SAQL) builders.
 *
 * PRP geo-graph-ml / Wave GEO-1: first-class geospatial operator nodes on the
 * eventstream canvas, compiled into the REAL ASA query the stream runs on the
 * Azure-native backend (Event Hubs + Stream Analytics — no Fabric, per
 * no-fabric-dependency.md). Zero gate: every function emitted here is built
 * into the ASA engine in Commercial AND Gov clouds.
 *
 * Grounded in the Stream Analytics geospatial-functions reference
 * (learn.microsoft.com/azure/stream-analytics/stream-analytics-geospatial-functions
 * + geospatial-scenarios):
 *   CreatePoint(lat, long)             → GeoJSON point record
 *   CreatePolygon(p1, …, pN)           → GeoJSON polygon (ring MUST close: p1 = pN)
 *   ST_WITHIN(point, polygon)          → 1 | 0
 *   ST_DISTANCE(point1, point2)        → meters
 * Reference-data geofences follow the documented pattern: a blob-backed ASA
 * reference input holding one row per fence (name + GeoJSON polygon column),
 * joined with ST_WITHIN — reference joins take NO temporal bound. Stream↔stream
 * proximity joins REQUIRE the DATEDIFF bound like any SAQL stream join.
 *
 * Pure, side-effect-free TypeScript: no React, no fetch. The shared ASA
 * compiler (lib/azure/asa-query-compiler.ts) and the editor's local emitter
 * both delegate the four geo operator kinds here so the canvas node, the
 * guided inspector, and the generated SAQL can never drift.
 */

// ============================================================
// Model
// ============================================================

export type GeoTransformKind = 'geo-point' | 'geo-fence' | 'geo-proximity' | 'geo-aggregate';

export const GEO_TRANSFORM_KINDS: readonly GeoTransformKind[] = [
  'geo-point', 'geo-fence', 'geo-proximity', 'geo-aggregate',
];

export function isGeoTransformKind(kind: unknown): kind is GeoTransformKind {
  return typeof kind === 'string' && (GEO_TRANSFORM_KINDS as readonly string[]).includes(kind);
}

export type GeoDistanceUnit = 'm' | 'km' | 'mi';

/** One polygon vertex, WGS84 degrees. */
export interface GeoFenceVertex {
  lat: number;
  lon: number;
}

/** An inline-defined fence: a named closed polygon (ring auto-closed on emit). */
export interface GeoFenceDef {
  name: string;
  vertices: GeoFenceVertex[];
}

export interface GeoAggregateSpec {
  func: 'AVG' | 'SUM' | 'COUNT' | 'MIN' | 'MAX';
  /** column name, or '*' for COUNT */
  field: string;
  alias: string;
}

/**
 * The typed config a geo transform node carries on the wire (a superset — each
 * kind uses its slice). All slots are structured config authored through
 * dropdowns / numeric fields (no freeform JSON — loom_no_freeform_config).
 */
export interface GeoTransformNode {
  kind: GeoTransformKind | string;
  name?: string;
  /** TIMESTAMP BY column (applied at the source read, same as other operators). */
  timestampBy?: string;

  // ── point derivation (geo-fence / geo-proximity reuse; geo-point builds) ──
  /** 'latlon' → build CreatePoint(lat, lon) from two stream columns; 'column' → an upstream point column (e.g. emitted by a geo-point node). */
  pointMode?: 'latlon' | 'column';
  latColumn?: string;
  lonColumn?: string;
  /** Existing GeoJSON-point column when pointMode='column'. */
  pointColumn?: string;
  /** geo-point only: output column name for the built point (default 'point'). */
  pointAlias?: string;

  // ── geo-fence ──
  /** 'inline' → fences drawn/entered in the inspector, compiled into the query;
   *  'reference' → the documented blob-backed ASA reference-data input. */
  fenceSource?: 'inline' | 'reference';
  /** inside → keep events IN a fence; outside → keep events in NO fence. */
  fenceMode?: 'inside' | 'outside';
  fences?: GeoFenceDef[];
  /** ASA reference-data input alias (fenceSource='reference'). */
  fenceRefInput?: string;
  fenceRefNameColumn?: string; // default 'fenceName'
  fenceRefPolygonColumn?: string; // default 'polygon'
  /** Output column carrying the matched fence name (default 'matchedFence'). */
  fenceOutputColumn?: string;

  // ── geo-proximity ──
  /** 'static' → distance to a fixed reference point (vehicle↔depot);
   *  'stream' → temporal join against a second source's point. */
  proximityTarget?: 'static' | 'stream';
  staticLat?: number;
  staticLon?: number;
  /** Second source name (proximityTarget='stream'). */
  joinSource?: string;
  joinDurationSeconds?: number;
  rightPointMode?: 'latlon' | 'column';
  rightLatColumn?: string;
  rightLonColumn?: string;
  rightPointColumn?: string;
  thresholdValue?: number;
  thresholdUnit?: GeoDistanceUnit;
  /** Output column carrying the computed distance in meters (default 'distanceMeters'). */
  distanceAlias?: string;

  // ── geo-aggregate ──
  /** Grouping column (e.g. the matchedFence / region emitted upstream). */
  regionColumn?: string;
  aggregates?: GeoAggregateSpec[];
  windowSize?: number;
  windowUnit?: 'second' | 'minute' | 'hour' | 'day';
  hopSize?: number;
}

// ============================================================
// Small pure helpers
// ============================================================

const UNIT_METERS: Record<GeoDistanceUnit, number> = { m: 1, km: 1000, mi: 1609.344 };

/** Convert a threshold to meters (ST_DISTANCE's unit). */
export function thresholdMeters(value: number | undefined, unit: GeoDistanceUnit | undefined): number {
  const v = Number.isFinite(value) ? Number(value) : 0;
  return Math.round(v * UNIT_METERS[unit || 'm'] * 1000) / 1000;
}

/** Bracket a source/input alias (strip pre-existing brackets first). */
function br(name: string | undefined, fallback = 'input'): string {
  const clean = (name || fallback).replace(/[[\]]/g, '').trim();
  return `[${clean || fallback}]`;
}

/** Escape a value for a single-quoted SAQL string literal. */
function sqlString(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Format a lat/lon degree number deterministically (no exponent noise). */
function deg(n: number): string {
  const v = Number.isFinite(n) ? Number(n) : 0;
  // Up to 6 decimal places (~0.11 m precision), trailing zeros trimmed.
  return String(Math.round(v * 1e6) / 1e6);
}

/**
 * The GeoJSON-point expression for one side of a geo operator: either the
 * upstream point column, or CreatePoint over CAST-to-float lat/lon columns
 * (CAST guards JSON numbers that arrive as strings). `prefix` qualifies the
 * columns in join contexts ('L.' / 'R.').
 */
export function pointExpr(
  node: Pick<GeoTransformNode, 'pointMode' | 'latColumn' | 'lonColumn' | 'pointColumn'>,
  prefix = '',
): string {
  if (node.pointMode === 'column' && (node.pointColumn || '').trim()) {
    return `${prefix}${node.pointColumn!.trim()}`;
  }
  const lat = (node.latColumn || 'lat').trim() || 'lat';
  const lon = (node.lonColumn || 'lon').trim() || 'lon';
  return `CreatePoint(CAST(${prefix}${lat} AS float), CAST(${prefix}${lon} AS float))`;
}

/** Right-side point expression for a stream↔stream proximity join. */
function rightPointExpr(node: GeoTransformNode, prefix = 'R.'): string {
  return pointExpr(
    {
      pointMode: node.rightPointMode,
      latColumn: node.rightLatColumn,
      lonColumn: node.rightLonColumn,
      pointColumn: node.rightPointColumn,
    },
    prefix,
  );
}

/**
 * A CreatePolygon(...) expression for an inline fence. The ring is auto-closed
 * (ASA requires first point == last point). Returns null when the fence has
 * fewer than 3 vertices (not a polygon — the authoring lint flags it).
 */
export function fencePolygonExpr(fence: GeoFenceDef): string | null {
  const vs = (fence?.vertices || []).filter(
    (v) => v && Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lon)),
  );
  if (vs.length < 3) return null;
  const ring = [...vs];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first.lat !== last.lat || first.lon !== last.lon) ring.push(first);
  const pts = ring.map((v) => `CreatePoint(${deg(v.lat)}, ${deg(v.lon)})`);
  return `CreatePolygon(${pts.join(', ')})`;
}

/** The inline fences that are valid polygons (>= 3 vertices, named or not). */
function validFences(node: GeoTransformNode): Array<{ name: string; poly: string }> {
  return (node.fences || [])
    .map((f, i) => ({ name: (f?.name || `fence-${i + 1}`).trim() || `fence-${i + 1}`, poly: fencePolygonExpr(f) }))
    .filter((f): f is { name: string; poly: string } => !!f.poly);
}

// ============================================================
// Per-kind SELECT-list builders
// ============================================================

/** geo-point: pass every column through + the built GeoJSON point. */
export function geoPointSelectList(node: GeoTransformNode): string {
  const alias = (node.pointAlias || 'point').trim() || 'point';
  // Force latlon mode: the whole purpose of this node is building the point.
  const expr = pointExpr({ ...node, pointMode: 'latlon' });
  return `*, ${expr} AS ${alias}`;
}

/** geo-fence: events + the matched fence name (inside mode). */
export function geoFenceSelectList(node: GeoTransformNode): string {
  const outCol = (node.fenceOutputColumn || 'matchedFence').trim() || 'matchedFence';
  const mode = node.fenceMode || 'inside';
  if ((node.fenceSource || 'inline') === 'reference') {
    if (mode === 'outside') return 'L.*';
    const nameCol = (node.fenceRefNameColumn || 'fenceName').trim() || 'fenceName';
    return `L.*, R.${nameCol} AS ${outCol}`;
  }
  // Inline fences.
  if (mode === 'outside') return '*';
  const fences = validFences(node);
  if (!fences.length) return '*';
  const pt = pointExpr(node);
  const cases = fences.map((f) => `WHEN ST_WITHIN(${pt}, ${f.poly}) = 1 THEN ${sqlString(f.name)}`);
  return `*, CASE ${cases.join(' ')} ELSE NULL END AS ${outCol}`;
}

/** geo-proximity: events + the computed distance in meters. */
export function geoProximitySelectList(node: GeoTransformNode): string {
  const alias = (node.distanceAlias || 'distanceMeters').trim() || 'distanceMeters';
  if ((node.proximityTarget || 'static') === 'stream') {
    const a = pointExpr(node, 'L.');
    const b = rightPointExpr(node);
    return `L.*, R.*, ST_DISTANCE(${a}, ${b}) AS ${alias}`;
  }
  const a = pointExpr(node);
  const b = `CreatePoint(${deg(node.staticLat ?? 0)}, ${deg(node.staticLon ?? 0)})`;
  return `*, ST_DISTANCE(${a}, ${b}) AS ${alias}`;
}

/** geo-aggregate: region + aggregates + the window-end timestamp. */
export function geoAggregateSelectList(node: GeoTransformNode): string {
  const parts: string[] = [];
  const region = (node.regionColumn || '').trim();
  if (region) parts.push(region);
  const aggs = (node.aggregates || []).filter((a) => a && a.func);
  for (const a of aggs) {
    const field = a.func === 'COUNT' ? (a.field && a.field !== '*' ? a.field : '*') : a.field || '*';
    const alias = (a.alias || `${a.func.toLowerCase()}_${(a.field || 'all').replace(/[^A-Za-z0-9_]/g, '')}`).trim();
    parts.push(`${a.func}(${field}) AS ${alias}`);
  }
  if (!aggs.length) parts.push('COUNT(*) AS eventCount');
  parts.push('System.Timestamp() AS windowEnd');
  return parts.join(', ');
}

// ============================================================
// Per-kind FROM/WHERE/JOIN/GROUP BY tail builders
// ============================================================

/**
 * geo-fence tail. `fromRef` is the bracketed input alias or CTE step name;
 * `ts` is the pre-computed ' TIMESTAMP BY x' suffix (empty for CTE steps).
 */
export function geoFenceTail(node: GeoTransformNode, fromRef: string, ts = ''): string {
  const mode = node.fenceMode || 'inside';
  if ((node.fenceSource || 'inline') === 'reference') {
    const ref = br(node.fenceRefInput, 'geofences');
    const polyCol = (node.fenceRefPolygonColumn || 'polygon').trim() || 'polygon';
    const nameCol = (node.fenceRefNameColumn || 'fenceName').trim() || 'fenceName';
    const pt = pointExpr(node, 'L.');
    if (mode === 'outside') {
      // Documented pattern: LEFT JOIN the fence reference table, keep the
      // events matching NO fence. Reference joins take no DATEDIFF bound.
      return (
        `FROM ${fromRef} L${ts}\n` +
        `LEFT OUTER JOIN ${ref} R\n` +
        `ON ST_WITHIN(${pt}, R.${polyCol}) = 1\n` +
        `WHERE R.${nameCol} IS NULL`
      );
    }
    return (
      `FROM ${fromRef} L${ts}\n` +
      `JOIN ${ref} R\n` +
      `ON ST_WITHIN(${pt}, R.${polyCol}) = 1`
    );
  }
  // Inline fences → a WHERE over ST_WITHIN per fence.
  const fences = validFences(node);
  if (!fences.length) return `FROM ${fromRef}${ts}`;
  const pt = pointExpr(node);
  const conds = fences.map((f) =>
    mode === 'outside' ? `ST_WITHIN(${pt}, ${f.poly}) = 0` : `ST_WITHIN(${pt}, ${f.poly}) = 1`,
  );
  const joined = mode === 'outside' ? conds.join('\n  AND ') : conds.join('\n  OR ');
  return `FROM ${fromRef}${ts}\nWHERE ${joined}`;
}

/** geo-proximity tail (static WHERE, or stream temporal-join + WHERE). */
export function geoProximityTail(node: GeoTransformNode, fromRef: string, ts = ''): string {
  const meters = thresholdMeters(node.thresholdValue ?? 100, node.thresholdUnit);
  if ((node.proximityTarget || 'static') === 'stream') {
    const right = br(node.joinSource, 'right');
    const dur = node.joinDurationSeconds ?? 60;
    const a = pointExpr(node, 'L.');
    const b = rightPointExpr(node);
    return (
      `FROM ${fromRef} L${ts}\n` +
      `INNER JOIN ${right} R\n` +
      `ON DATEDIFF(second, L, R) BETWEEN 0 AND ${dur}\n` +
      `WHERE ST_DISTANCE(${a}, ${b}) < ${meters}`
    );
  }
  const a = pointExpr(node);
  const b = `CreatePoint(${deg(node.staticLat ?? 0)}, ${deg(node.staticLon ?? 0)})`;
  return `FROM ${fromRef}${ts}\nWHERE ST_DISTANCE(${a}, ${b}) < ${meters}`;
}

/** geo-aggregate tail: GROUP BY region + HoppingWindow (the documented ride-share pattern). */
export function geoAggregateTail(node: GeoTransformNode, fromRef: string, ts = ''): string {
  const unit = node.windowUnit || 'minute';
  const size = node.windowSize ?? 5;
  const hop = node.hopSize ?? size;
  const gb: string[] = [];
  const region = (node.regionColumn || '').trim();
  if (region) gb.push(region);
  gb.push(`HoppingWindow(${unit}, ${size}, ${hop})`);
  return `FROM ${fromRef}${ts}\nGROUP BY ${gb.join(', ')}`;
}

// ============================================================
// Dispatchers (used by the shared compiler + the editor's local emitter)
// ============================================================

/** SELECT-list for any geo transform kind. */
export function geoSelectList(node: GeoTransformNode): string {
  switch (node.kind) {
    case 'geo-point': return geoPointSelectList(node);
    case 'geo-fence': return geoFenceSelectList(node);
    case 'geo-proximity': return geoProximitySelectList(node);
    case 'geo-aggregate': return geoAggregateSelectList(node);
    default: return '*';
  }
}

/**
 * FROM/WHERE/JOIN/GROUP BY tail for any geo transform kind. `ts` is the
 * pre-computed ' TIMESTAMP BY x' suffix (only non-empty at the source read).
 */
export function geoTail(node: GeoTransformNode, fromRef: string, ts = ''): string {
  switch (node.kind) {
    case 'geo-point': return `FROM ${fromRef}${ts}`;
    case 'geo-fence': return geoFenceTail(node, fromRef, ts);
    case 'geo-proximity': return geoProximityTail(node, fromRef, ts);
    case 'geo-aggregate': return geoAggregateTail(node, fromRef, ts);
    default: return `FROM ${fromRef}${ts}`;
  }
}

/**
 * One-line canvas-node caption for a geo transform (the 2-row compact node's
 * subtitle — ux-baseline node compactness). Pure + unit-tested.
 */
export function geoNodeSubtitle(node: GeoTransformNode): string | undefined {
  switch (node.kind) {
    case 'geo-point': {
      const lat = (node.latColumn || '').trim();
      const lon = (node.lonColumn || '').trim();
      const alias = (node.pointAlias || 'point').trim() || 'point';
      return lat && lon ? `${lat}, ${lon} → ${alias}` : 'pick lat / lon columns';
    }
    case 'geo-fence': {
      const mode = node.fenceMode === 'outside' ? 'outside' : 'inside';
      if ((node.fenceSource || 'inline') === 'reference') {
        return `ref ${((node.fenceRefInput || 'geofences').trim() || 'geofences')} · ${mode}`;
      }
      const n = (node.fences || []).filter((f) => (f?.vertices?.length || 0) >= 3).length;
      return `${n} fence${n === 1 ? '' : 's'} · ${mode}`;
    }
    case 'geo-proximity': {
      const meters = thresholdMeters(node.thresholdValue ?? 0, node.thresholdUnit);
      const target = (node.proximityTarget || 'static') === 'stream'
        ? `↔ ${(node.joinSource || 'stream').trim() || 'stream'}`
        : '↔ fixed point';
      return `< ${meters} m ${target}`;
    }
    case 'geo-aggregate': {
      const region = (node.regionColumn || '').trim();
      const size = node.windowSize ?? 5;
      const unit = node.windowUnit || 'minute';
      const hop = node.hopSize ?? size;
      return `${region ? `by ${region} · ` : ''}Hopping(${unit}, ${size}, ${hop})`;
    }
    default:
      return undefined;
  }
}

// ============================================================
// Fence import — GeoJSON + WKT payloads (allowed data-payload surfaces per
// the no-freeform rule) → typed GeoFenceDef[]. Pure + unit-tested.
// ============================================================

/** GeoJSON positions are [lon, lat]; drop the closing duplicate vertex. */
function ringToVertices(ring: unknown): GeoFenceVertex[] {
  if (!Array.isArray(ring)) return [];
  const vs = ring
    .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([lon, lat]) => ({ lat, lon }));
  if (vs.length > 1) {
    const a = vs[0];
    const b = vs[vs.length - 1];
    if (a.lat === b.lat && a.lon === b.lon) vs.pop();
  }
  return vs;
}

/**
 * Parse a GeoJSON payload (Polygon, MultiPolygon, Feature, FeatureCollection,
 * GeometryCollection) into named fences. Fence names come from feature
 * properties (`name` / `fenceName` / `id`) with an indexed fallback. Only the
 * outer ring of each polygon is used (ASA CreatePolygon models a single ring).
 * Throws on unparseable input so the caller can surface the exact error.
 */
export function parseGeoJsonFences(text: string, baseName = 'fence'): GeoFenceDef[] {
  const doc = JSON.parse(text);
  const out: GeoFenceDef[] = [];
  const pushPolygon = (coords: unknown, name: string) => {
    // Polygon coords = [outerRing, ...holes]
    const outer = Array.isArray(coords) ? coords[0] : null;
    const vertices = ringToVertices(outer);
    if (vertices.length >= 3) out.push({ name, vertices });
  };
  const visitGeometry = (geom: any, name: string) => {
    if (!geom || typeof geom !== 'object') return;
    if (geom.type === 'Polygon') pushPolygon(geom.coordinates, name);
    else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
      geom.coordinates.forEach((poly: unknown, i: number) =>
        pushPolygon(poly, geom.coordinates.length > 1 ? `${name}-${i + 1}` : name));
    } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      geom.geometries.forEach((g: any, i: number) => visitGeometry(g, `${name}-${i + 1}`));
    }
  };
  const featureName = (f: any, i: number): string =>
    String(f?.properties?.name || f?.properties?.fenceName || f?.id || `${baseName}-${i + 1}`);
  if (doc?.type === 'FeatureCollection' && Array.isArray(doc.features)) {
    doc.features.forEach((f: any, i: number) => visitGeometry(f?.geometry, featureName(f, i)));
  } else if (doc?.type === 'Feature') {
    visitGeometry(doc.geometry, featureName(doc, 0));
  } else {
    visitGeometry(doc, `${baseName}-1`);
  }
  if (!out.length) throw new Error('No polygon with at least 3 vertices found in the GeoJSON.');
  return out;
}

/**
 * Parse a WKT `POLYGON ((lon lat, …))` / `MULTIPOLYGON (((…)))` payload into
 * fences (outer rings only, WKT coordinate order lon lat). Throws on
 * unparseable input.
 */
export function parseWktFences(text: string, baseName = 'fence'): GeoFenceDef[] {
  const t = (text || '').trim();
  const out: GeoFenceDef[] = [];
  const parseRing = (ring: string): GeoFenceVertex[] => {
    const pairs = ring.split(',').map((p) => p.trim().split(/\s+/).map(Number));
    const vs = pairs
      .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map(([lon, lat]) => ({ lat, lon }));
    if (vs.length > 1) {
      const a = vs[0]; const b = vs[vs.length - 1];
      if (a.lat === b.lat && a.lon === b.lon) vs.pop();
    }
    return vs;
  };
  const polyMatch = /^POLYGON\s*\(\((.*)\)\)\s*$/is.exec(t);
  if (polyMatch) {
    // Outer ring = up to the first ')' (holes ignored).
    const outer = polyMatch[1].split(')')[0];
    const vertices = parseRing(outer);
    if (vertices.length >= 3) out.push({ name: `${baseName}-1`, vertices });
  } else {
    const multiMatch = /^MULTIPOLYGON\s*\((.*)\)\s*$/is.exec(t);
    if (multiMatch) {
      // Each polygon is ((ring)[,(hole)…]) — capture each outer ring.
      const polys = multiMatch[1].match(/\(\(([^)]*)\)/g) || [];
      polys.forEach((p, i) => {
        const inner = p.replace(/^\(\(/, '').replace(/\)$/, '');
        const vertices = parseRing(inner);
        if (vertices.length >= 3) out.push({ name: `${baseName}-${i + 1}`, vertices });
      });
    }
  }
  if (!out.length) throw new Error('No WKT POLYGON / MULTIPOLYGON with at least 3 vertices found.');
  return out;
}

// ============================================================
// Activator wiring — geofence-violation → Azure Monitor alert preset.
// Pure: maps a geo node's typed config into the property/operator/threshold the
// eventstream activator route (POST .../activator) consumes, so a one-click
// "Create violation alert" pre-fills a REAL Azure Monitor scheduled-query rule
// (no Fabric Reflex — no-fabric-dependency.md). Unit-tested.
// ============================================================

export type GeoAlertOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne' | 'isnotnull' | 'isnull';

export interface GeoAlertPreset {
  /** Suggested rule name. */
  ruleName: string;
  /** Column the alert watches (the fence-match / distance column the node emits). */
  property: string;
  operator: GeoAlertOperator;
  /** Threshold string (empty for the null-check operators). */
  threshold: string;
  /** One-line human explanation of what the alert fires on. */
  description: string;
}

/**
 * Derive the violation-alert preset for a geo operator node, or null when the
 * kind has no natural violation semantics (geo-point / geo-aggregate).
 *
 *  - geo-fence inside  → fires when the matched-fence column is set (an event
 *                        entered a fence): `isnotnull(matchedFence)`.
 *  - geo-fence outside → fires on any event that reached the stream (every event
 *                        here is already outside every fence — a "left the fence"
 *                        violation): count > 0.
 *  - geo-proximity     → fires when the distance column drops below the threshold
 *                        (a proximity breach): `distanceMeters < <meters>`.
 */
export function geoViolationAlertPreset(node: GeoTransformNode): GeoAlertPreset | null {
  const label = (node.name || node.kind || 'geo').trim();
  switch (node.kind) {
    case 'geo-fence': {
      const col = (node.fenceOutputColumn || 'matchedFence').trim() || 'matchedFence';
      if ((node.fenceMode || 'inside') === 'outside') {
        return {
          ruleName: `${label} exit violation`.slice(0, 60),
          property: col,
          operator: 'isnull',
          threshold: '',
          description: `Fires when an event is outside every fence (${col} is null).`,
        };
      }
      return {
        ruleName: `${label} entry violation`.slice(0, 60),
        property: col,
        operator: 'isnotnull',
        threshold: '',
        description: `Fires when an event enters any fence (${col} is set).`,
      };
    }
    case 'geo-proximity': {
      const col = (node.distanceAlias || 'distanceMeters').trim() || 'distanceMeters';
      const meters = thresholdMeters(node.thresholdValue ?? 0, node.thresholdUnit);
      return {
        ruleName: `${label} proximity breach`.slice(0, 60),
        property: col,
        operator: 'lt',
        threshold: String(meters),
        description: `Fires when ${col} < ${meters} m (a proximity breach).`,
      };
    }
    default:
      return null;
  }
}

/** True for the geo operators that carry a one-click "Create violation alert". */
export function geoHasViolationAlert(node: GeoTransformNode): boolean {
  return geoViolationAlertPreset(node) !== null;
}

/** Default typed config for a freshly-added geo operator of `kind`. */
export function geoDefaultOperator(kind: GeoTransformKind, n: number): Record<string, any> {
  const base = { kind, name: `${kind}-${n}` };
  switch (kind) {
    case 'geo-point':
      return { ...base, latColumn: '', lonColumn: '', pointAlias: 'point' };
    case 'geo-fence':
      return {
        ...base, pointMode: 'latlon', latColumn: '', lonColumn: '', pointColumn: '',
        fenceSource: 'inline', fenceMode: 'inside',
        fences: [{ name: 'fence-1', vertices: [] }] as GeoFenceDef[],
        fenceRefInput: 'geofences', fenceRefNameColumn: 'fenceName', fenceRefPolygonColumn: 'polygon',
        fenceOutputColumn: 'matchedFence',
      };
    case 'geo-proximity':
      return {
        ...base, pointMode: 'latlon', latColumn: '', lonColumn: '', pointColumn: '',
        proximityTarget: 'static', staticLat: 0, staticLon: 0,
        joinSource: '', joinDurationSeconds: 60,
        rightPointMode: 'latlon', rightLatColumn: '', rightLonColumn: '', rightPointColumn: '',
        thresholdValue: 500, thresholdUnit: 'm', distanceAlias: 'distanceMeters',
      };
    case 'geo-aggregate':
      return {
        ...base, regionColumn: '',
        aggregates: [{ func: 'COUNT', field: '*', alias: 'eventCount' }] as GeoAggregateSpec[],
        windowSize: 5, windowUnit: 'minute', hopSize: 1, timestampBy: '',
      };
    default:
      return base;
  }
}
