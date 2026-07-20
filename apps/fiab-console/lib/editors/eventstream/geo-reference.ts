/**
 * Geofence ASA reference-data provisioning — PURE builders (no React, no fetch).
 *
 * PRP geo-graph-ml / Wave GEO-1, slice 2. Slice 1 emitted the SQL JOIN side of a
 * reference-data geofence (`JOIN [geofences] R ON ST_WITHIN(L.point, R.polygon) = 1`).
 * This module builds the two payloads that make that JOIN real on the Azure-native
 * backend (Event Hubs + Stream Analytics — no Fabric, per no-fabric-dependency.md):
 *
 *   1. the blob-backed fence reference TABLE — one JSON record per fence carrying
 *      a `fenceName` column + a GeoJSON `polygon` column (the shape ST_WITHIN
 *      consumes), and
 *   2. the ASA reference-data INPUT spec (Microsoft.Storage/Blob, type Reference,
 *      Json serialization) that points the job at that blob.
 *
 * The documented ASA geospatial reference-data pattern:
 *   learn.microsoft.com/azure/stream-analytics/stream-analytics-geospatial-functions
 *   — a reference input holding one row per fence, JOINed with ST_WITHIN (reference
 *   joins take NO temporal bound). ASA reads a GeoJSON polygon column directly.
 *
 * Everything here is deterministic + unit-tested; the route (geo-reference/route.ts)
 * only does the IO — upload the blob (adls-client) + PUT the input (stream-analytics
 * -client) — so the payload shape can never drift from the SQL slice-1 emits.
 */

import type { GeoFenceDef, GeoFenceVertex } from './geo-sql';

// ============================================================
// GeoJSON polygon for one fence (ASA reference-data `polygon` column)
// ============================================================

/** A GeoJSON polygon (single outer ring), the shape ASA ST_WITHIN accepts. */
export interface GeoJsonPolygon {
  type: 'Polygon';
  /** [ outerRing ] where each vertex is [lon, lat]; ring is closed (first == last). */
  coordinates: [number, number][][];
}

/** Deterministic degree rounding (~0.11 m at 6 dp) — matches geo-sql's `deg`. */
function deg(n: number): number {
  const v = Number.isFinite(n) ? Number(n) : 0;
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Build a closed-ring GeoJSON polygon (lon/lat order) for a fence, or null when
 * the fence has fewer than 3 valid vertices (not a polygon — the caller skips it,
 * exactly as geo-sql's fencePolygonExpr does for the inline path).
 */
export function fenceToGeoJsonPolygon(fence: GeoFenceDef): GeoJsonPolygon | null {
  const vs = (fence?.vertices || []).filter(
    (v): v is GeoFenceVertex => !!v && Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lon)),
  );
  if (vs.length < 3) return null;
  const ring: [number, number][] = vs.map((v) => [deg(v.lon), deg(v.lat)]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return { type: 'Polygon', coordinates: [ring] };
}

// ============================================================
// Reference table records + blob body
// ============================================================

export interface GeoFenceRefRecord {
  [column: string]: string | GeoJsonPolygon;
}

export interface GeoFenceRefColumns {
  /** Column carrying the fence name (default 'fenceName'). */
  nameColumn?: string;
  /** Column carrying the GeoJSON polygon (default 'polygon'). */
  polygonColumn?: string;
}

/**
 * Convert fences into ASA reference-data records: `{ <nameColumn>, <polygonColumn> }`
 * per valid fence (>= 3 vertices). Column names match the geo-fence node's
 * fenceRefNameColumn / fenceRefPolygonColumn so the emitted JOIN resolves.
 */
export function fenceReferenceRecords(
  fences: GeoFenceDef[],
  cols?: GeoFenceRefColumns,
): GeoFenceRefRecord[] {
  const nameCol = (cols?.nameColumn || 'fenceName').trim() || 'fenceName';
  const polyCol = (cols?.polygonColumn || 'polygon').trim() || 'polygon';
  const out: GeoFenceRefRecord[] = [];
  (fences || []).forEach((f, i) => {
    const poly = fenceToGeoJsonPolygon(f);
    if (!poly) return;
    const name = (f?.name || `fence-${i + 1}`).trim() || `fence-${i + 1}`;
    out.push({ [nameCol]: name, [polyCol]: poly });
  });
  return out;
}

/**
 * Serialize fence records as the ASA reference blob body. ASA JSON reference
 * data defaults to LINE-SEPARATED JSON (one object per line) — the format the
 * createOrUpdateInput Json serialization declares — so this emits exactly that.
 * Returns null when no fence is a valid polygon (the caller surfaces the gate).
 */
export function fenceReferenceBlobBody(
  fences: GeoFenceDef[],
  cols?: GeoFenceRefColumns,
): string | null {
  const records = fenceReferenceRecords(fences, cols);
  if (!records.length) return null;
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

// ============================================================
// Blob path + ASA reference-input spec
// ============================================================

/** Alphanumeric+dash safe token from a name (ASA input aliases / blob path segments). */
export function safeToken(v: string | undefined, fallback: string): string {
  const cleaned = (v || '').trim().replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/**
 * The blob path the fence reference table is written to. Static (no {date}/{time}
 * tokens) so the ASA reference input reads a single, stable snapshot. Namespaced
 * by eventstream id + input alias so multiple geofence nodes never collide.
 */
export function fenceReferenceBlobPath(eventstreamId: string, inputAlias: string): string {
  const id = safeToken(eventstreamId, 'stream');
  const alias = safeToken(inputAlias, 'geofences');
  return `geo-reference/${id}/${alias}.json`;
}

export interface GeoReferenceInputSpecOpts {
  /** ASA reference-data input alias (matches the geo-fence node's fenceRefInput). */
  inputAlias: string;
  /** ADLS Gen2 / Blob storage account name (MSI auth — no key). */
  storageAccount: string;
  /** Container / filesystem the reference blob lives in. */
  container: string;
  /** The exact blob path within the container (from fenceReferenceBlobPath). */
  blobPath: string;
}

/**
 * The AsaInputCreateSpec for a blob-backed reference-data input (MSI auth). Mirrors
 * the documented reference-data blob input; a static pathPattern (no date/time
 * tokens) reads the single snapshot fenceReferenceBlobBody writes.
 *
 * Returned as a plain object so the route imports the concrete AsaInputCreateSpec
 * type; this stays pure + testable with no client import.
 */
export function buildGeoReferenceInputSpec(opts: GeoReferenceInputSpecOpts): {
  name: string;
  inputType: 'Reference';
  datasourceType: 'Microsoft.Storage/Blob';
  authenticationMode: 'Msi';
  storageAccount: string;
  container: string;
  pathPattern: string;
  dateFormat: string;
  timeFormat: string;
  serialization: 'Json';
  encoding: 'UTF8';
} {
  return {
    name: safeToken(opts.inputAlias, 'geofences'),
    inputType: 'Reference',
    datasourceType: 'Microsoft.Storage/Blob',
    authenticationMode: 'Msi',
    storageAccount: opts.storageAccount,
    container: opts.container,
    // Static path — the whole blob is the reference snapshot (no {date}/{time}).
    pathPattern: opts.blobPath.replace(/^\/+/, ''),
    dateFormat: '',
    timeFormat: '',
    serialization: 'Json',
    encoding: 'UTF8',
  };
}

// ============================================================
// Topology helpers — find the geofence reference node(s) to publish
// ============================================================

export interface GeoFenceRefNode {
  name: string;
  fenceRefInput: string;
  fenceRefNameColumn: string;
  fenceRefPolygonColumn: string;
  fences: GeoFenceDef[];
}

/**
 * From a saved topology, the geo-fence transforms in reference mode that carry at
 * least one valid inline polygon to publish as the reference table. (Reference
 * mode reuses the node's `fences` list as the table rows.)
 */
export function collectGeoReferenceNodes(topology: {
  transforms?: any[];
}): GeoFenceRefNode[] {
  const out: GeoFenceRefNode[] = [];
  for (const t of topology?.transforms || []) {
    if (!t || t.kind !== 'geo-fence') continue;
    if ((t.fenceSource || 'inline') !== 'reference') continue;
    const fences: GeoFenceDef[] = Array.isArray(t.fences) ? t.fences : [];
    out.push({
      name: String(t.name || 'geo-fence'),
      fenceRefInput: safeToken(t.fenceRefInput, 'geofences'),
      fenceRefNameColumn: (t.fenceRefNameColumn || 'fenceName').trim() || 'fenceName',
      fenceRefPolygonColumn: (t.fenceRefPolygonColumn || 'polygon').trim() || 'polygon',
      fences,
    });
  }
  return out;
}
