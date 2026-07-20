/**
 * Ontology Object View (WS-4.1) — pure view-config resolution + panel-data
 * shaping for the per-instance object viewer (Palantir Foundry "Object Views"
 * parity, row Foundry-1.1-A8).
 *
 * No React, no Node I/O — the BFF route
 * (app/api/items/ontology/[id]/objects/[vertexId]/view) AND the client viewer
 * both import it, and it is vitest-coverable without a DOM.
 *
 * Every panel is fed by REAL Apache-AGE data (per .claude/rules/no-vaporware.md):
 *   - overview / properties  → the instance vertex's own properties
 *   - linked objects         → neighbours traversed via a real cypher MATCH
 *                              (weave-explore.traverseObject), grouped by
 *                              (link type × direction)
 *   - timeseries             → a real (timestamp, numeric) property series over
 *                              the instance + its linked objects
 *   - map                    → real geopoint / geoshape properties projected to
 *                              GeoJSON (MapLibre/GeoJsonMap-compatible)
 *
 * A panel self-gates to an honest empty state when its data genuinely isn't
 * present (no timestamp+numeric pair → no timeseries; no geo property → no map).
 * Azure-native (AGE / PostgreSQL) + GeoJSON — no Fabric/Foundry REST, Gov-safe.
 */
import type { OntoObjectType, OntoLinkType, OntoProperty } from '@/lib/editors/ontology-model';
import { parseTimeMs } from '@/lib/components/adx/time-series-model';

// ============================================================
// Panel kinds + view config
// ============================================================

/** The panels a configurable object view can render (Foundry Object View widgets). */
export const OBJECT_VIEW_PANEL_KINDS = ['overview', 'properties', 'linkedObjects', 'timeseries', 'map'] as const;
export type ObjectViewPanelKind = typeof OBJECT_VIEW_PANEL_KINDS[number];

/** Persisted per-object-type view configuration (Cosmos `state.objectViews[<type>]`). */
export interface ObjectViewConfig {
  /** Ordered panels to render. Absent → auto-resolved from the property schema. */
  panels?: ObjectViewPanelKind[];
  /** Explicit timeseries axes (else auto-detected from date + numeric properties). */
  timeseries?: { timeProp?: string; valueProp?: string };
  /** Explicit geo property (else the first geopoint/geoshape property). */
  map?: { geoProp?: string };
}

/** The effective view after resolution: which panels + which props feed each. */
export interface ResolvedObjectView {
  panels: ObjectViewPanelKind[];
  /** Resolved timeseries X (a date/timestamp property api-name), when available. */
  timeProp?: string;
  /** Resolved timeseries Y (a numeric property api-name), when available. */
  valueProp?: string;
  /** Resolved geo property api-name, when available. */
  geoProp?: string;
}

const TIME_BASE_TYPES: ReadonlySet<string> = new Set(['date', 'timestamp']);
const NUMERIC_BASE_TYPES: ReadonlySet<string> = new Set(['byte', 'short', 'integer', 'long', 'float', 'double', 'decimal']);
const GEO_BASE_TYPES: ReadonlySet<string> = new Set(['geopoint', 'geoshape']);

/** Date/timestamp (scalar) properties — timeseries X candidates. */
export function timeProperties(ot: OntoObjectType | null): OntoProperty[] {
  return (ot?.properties || []).filter((p) => TIME_BASE_TYPES.has(p.baseType) && !p.arrayOf);
}

/** Numeric (scalar) properties — timeseries Y candidates. */
export function numericProperties(ot: OntoObjectType | null): OntoProperty[] {
  return (ot?.properties || []).filter((p) => NUMERIC_BASE_TYPES.has(p.baseType) && !p.arrayOf);
}

/** Geopoint / geoshape properties — map candidates. */
export function geoProperties(ot: OntoObjectType | null): OntoProperty[] {
  return (ot?.properties || []).filter((p) => GEO_BASE_TYPES.has(p.baseType));
}

function hasProp(ot: OntoObjectType | null, apiName: string | undefined): boolean {
  if (!apiName) return false;
  return (ot?.properties || []).some((p) => p.apiName === apiName);
}

function dedupePanels(panels: readonly string[]): ObjectViewPanelKind[] {
  const seen = new Set<string>();
  const out: ObjectViewPanelKind[] = [];
  for (const p of panels) {
    if (!(OBJECT_VIEW_PANEL_KINDS as readonly string[]).includes(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p as ObjectViewPanelKind);
  }
  return out;
}

/** Coerce a persisted `state.objectViews[<type>]` value into a clean config. */
export function normalizeObjectViewConfig(raw: unknown): ObjectViewConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const cfg: ObjectViewConfig = {};
  if (Array.isArray(r.panels)) {
    const panels = dedupePanels(r.panels.map((x) => String(x)));
    if (panels.length) cfg.panels = panels;
  }
  if (r.timeseries && typeof r.timeseries === 'object') {
    const t = r.timeseries as Record<string, unknown>;
    const timeProp = typeof t.timeProp === 'string' ? t.timeProp : undefined;
    const valueProp = typeof t.valueProp === 'string' ? t.valueProp : undefined;
    if (timeProp || valueProp) cfg.timeseries = { ...(timeProp ? { timeProp } : {}), ...(valueProp ? { valueProp } : {}) };
  }
  if (r.map && typeof r.map === 'object') {
    const g = (r.map as Record<string, unknown>).geoProp;
    if (typeof g === 'string' && g) cfg.map = { geoProp: g };
  }
  return Object.keys(cfg).length ? cfg : null;
}

/**
 * Resolve the effective object view for an object type: honour a persisted
 * config's explicit panels/axes, else auto-derive from the property schema —
 * overview + properties + linked objects always, timeseries when a date + a
 * numeric property exist, map when a geo property exists.
 *
 * NB: the route may still ADD a timeseries/map panel when a linked NEIGHBOUR
 * carries the data even though the anchor type does not declare it — this
 * function only reflects the anchor type's own schema, which is what the config
 * editor persists.
 */
export function resolveObjectView(ot: OntoObjectType | null, rawConfig?: unknown): ResolvedObjectView {
  const cfg = normalizeObjectViewConfig(rawConfig);
  const times = timeProperties(ot);
  const nums = numericProperties(ot);
  const geos = geoProperties(ot);

  const timeProp = hasProp(ot, cfg?.timeseries?.timeProp) ? cfg!.timeseries!.timeProp : times[0]?.apiName;
  const valueProp = hasProp(ot, cfg?.timeseries?.valueProp) ? cfg!.timeseries!.valueProp : nums[0]?.apiName;
  const geoProp = hasProp(ot, cfg?.map?.geoProp) ? cfg!.map!.geoProp : geos[0]?.apiName;

  let panels: ObjectViewPanelKind[];
  if (cfg?.panels && cfg.panels.length) {
    panels = cfg.panels;
  } else {
    panels = ['overview', 'properties', 'linkedObjects'];
    if (timeProp && valueProp) panels.push('timeseries');
    if (geoProp) panels.push('map');
  }
  return {
    panels,
    ...(timeProp ? { timeProp } : {}),
    ...(valueProp ? { valueProp } : {}),
    ...(geoProp ? { geoProp } : {}),
  };
}

// ============================================================
// Linked-object traversal shaping
// ============================================================

export interface LinkedNeighborLite {
  id: string;
  objectType: string;
  properties: Record<string, unknown>;
}

/** A neighbour as returned by weave-explore.traverseObject. */
export interface RawNeighbor {
  linkType: string;
  direction: 'out' | 'in';
  neighbor: LinkedNeighborLite;
}

/** A linked-objects section: all neighbours reached by one (link type × direction). */
export interface LinkedSection {
  /** Stable key `<linkType>:<direction>`. */
  key: string;
  linkType: string;
  direction: 'out' | 'in';
  /** Display label resolved from the declared link type (per direction). */
  label: string;
  count: number;
  neighbors: LinkedNeighborLite[];
}

/**
 * Group traversed neighbours into sections by (link type × direction), each with
 * a human display label resolved from the declared link type — the forward
 * `displayName` for out-edges, the `reverseDisplayName` for in-edges (Foundry
 * shows linked objects grouped by link type, labelled per direction).
 *
 * Pure shaping over the real AGE traversal result — no store access.
 */
export function shapeLinkedSections(neighbors: RawNeighbor[], linkTypes: OntoLinkType[]): LinkedSection[] {
  const byLt = new Map(linkTypes.map((l) => [l.apiName, l]));
  const sections = new Map<string, LinkedSection>();
  for (const n of neighbors || []) {
    if (!n || !n.neighbor) continue;
    const direction = n.direction === 'in' ? 'in' : 'out';
    const key = `${n.linkType}:${direction}`;
    let sec = sections.get(key);
    if (!sec) {
      const lt = byLt.get(n.linkType);
      let label = n.linkType;
      if (lt) {
        label = direction === 'out'
          ? (lt.displayName || lt.apiName)
          : (lt.reverseDisplayName || lt.displayName || lt.apiName);
      }
      sec = { key, linkType: n.linkType, direction, label, count: 0, neighbors: [] };
      sections.set(key, sec);
    }
    sec.neighbors.push(n.neighbor);
    sec.count++;
  }
  return [...sections.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.direction.localeCompare(b.direction),
  );
}

// ============================================================
// Timeseries + map panel data
// ============================================================

/** A record fed to the timeseries / map detectors (the instance or a neighbour). */
export interface ViewRecord {
  id?: string;
  objectType?: string;
  label?: string;
  properties: Record<string, unknown>;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The grid shape consumed by `<TimeSeriesChart columns rows columnTypes />`. */
export interface TimeseriesGrid {
  columns: string[];
  rows: unknown[][];
  columnTypes: string[];
  timeProp: string;
  valueProp: string;
}

/**
 * Build a two-column (timestamp, value) grid from a set of records' real
 * properties. `hint` (from the resolved view / persisted config) picks the axes
 * explicitly; otherwise the first property whose values parse as timestamps is
 * the X axis and the first numeric property (≠ X) is the Y axis.
 *
 * Returns null when there is no (timestamp, numeric) pair with ≥2 plottable
 * points — the panel then shows an honest "no time-series data" empty state
 * rather than a fake chart.
 */
export function toTimeseriesGrid(
  records: ViewRecord[],
  hint?: { timeProp?: string; valueProp?: string },
): TimeseriesGrid | null {
  const recs = (records || []).filter((r) => r && r.properties && typeof r.properties === 'object');
  if (recs.length < 2) return null;

  const keys = new Set<string>();
  for (const r of recs) for (const k of Object.keys(r.properties)) if (!k.startsWith('_')) keys.add(k);

  // Resolve the X (time) property.
  const timeCandidates = hint?.timeProp && keys.has(hint.timeProp) ? [hint.timeProp] : [...keys];
  let timeProp = '';
  for (const k of timeCandidates) {
    const parsed = recs.reduce((n, r) => (parseTimeMs(r.properties[k]) !== null ? n + 1 : n), 0);
    if (parsed >= 2) { timeProp = k; break; }
  }
  if (!timeProp) return null;

  // Resolve the Y (value) property.
  const valueCandidates = hint?.valueProp && keys.has(hint.valueProp) && hint.valueProp !== timeProp
    ? [hint.valueProp]
    : [...keys].filter((k) => k !== timeProp);
  let valueProp = '';
  for (const k of valueCandidates) {
    const nums = recs.reduce((n, r) => (toNum(r.properties[k]) !== null ? n + 1 : n), 0);
    if (nums >= 2) { valueProp = k; break; }
  }
  if (!valueProp) return null;

  const rows: unknown[][] = [];
  for (const r of recs) {
    const t = r.properties[timeProp];
    const v = toNum(r.properties[valueProp]);
    if (parseTimeMs(t) === null || v === null) continue;
    rows.push([t, v]);
  }
  if (rows.length < 2) return null;
  rows.sort((a, b) => (parseTimeMs(a[0]) ?? 0) - (parseTimeMs(b[0]) ?? 0));

  return { columns: [timeProp, valueProp], rows, columnTypes: ['datetime', 'real'], timeProp, valueProp };
}

/** A GeoJSON FeatureCollection consumable by `<GeoJsonMap geojson=... />`. */
export interface GeoFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }>;
}

/**
 * Parse a property value into a GeoJSON geometry:
 *   - an object / JSON string that is already a GeoJSON geometry (geoshape)
 *   - a `{lat,lon}` / `{latitude,longitude}` object (geopoint)
 *   - a `"lat,lon"` (or `"lon,lat"`) numeric-pair string (geopoint) → Point
 * Longitude/latitude order is disambiguated by range (|lat| ≤ 90).
 */
export function parseGeometry(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;

  let v: unknown = value;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (s.startsWith('{') || s.startsWith('[')) {
      try { v = JSON.parse(s); } catch { /* fall through to pair parse */ }
    } else {
      const pair = parseLonLat(s);
      return pair ? { type: 'Point', coordinates: pair } : null;
    }
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.type === 'string' && (Array.isArray(o.coordinates) || o.type === 'GeometryCollection')) {
      return o; // already a GeoJSON geometry
    }
    const lat = toNum(o.lat ?? o.latitude);
    const lon = toNum(o.lon ?? o.lng ?? o.long ?? o.longitude);
    if (lat !== null && lon !== null) return { type: 'Point', coordinates: [lon, lat] };
  }
  return null;
}

function parseLonLat(s: string): [number, number] | null {
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n))) return null;
  const [a, b] = parts;
  // Prefer the "lat,lon" human convention; if the first value is out of latitude
  // range but the second is in range, it must already be "lon,lat".
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [a, b];
  return [b, a];
}

function labelFromProps(props: Record<string, unknown>): string {
  for (const k of ['name', 'title', 'label', 'displayName']) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Project a set of records to a GeoJSON FeatureCollection using the first
 * geo-parseable property on each (or `hint.geoProp` when given). Returns null
 * when no record carries a location — the map panel then shows an honest "no
 * location data" empty state rather than a fake basemap.
 */
export function toGeoFeatureCollection(
  records: ViewRecord[],
  hint?: { geoProp?: string },
): GeoFeatureCollection | null {
  const features: GeoFeatureCollection['features'] = [];
  for (const r of records || []) {
    const props = r?.properties;
    if (!props || typeof props !== 'object') continue;
    const keys = hint?.geoProp && props[hint.geoProp] !== undefined
      ? [hint.geoProp]
      : Object.keys(props).filter((k) => !k.startsWith('_'));
    for (const k of keys) {
      const geom = parseGeometry(props[k]);
      if (!geom) continue;
      features.push({
        type: 'Feature',
        geometry: geom,
        properties: {
          name: r.label || labelFromProps(props) || r.id || '',
          ...(r.objectType ? { objectType: r.objectType } : {}),
          sourceProp: k,
        },
      });
      break; // one location per record
    }
  }
  return features.length ? { type: 'FeatureCollection', features } : null;
}
