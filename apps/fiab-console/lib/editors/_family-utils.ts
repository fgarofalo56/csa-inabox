/**
 * Pure utility functions used by the Power Platform / ML / Geo / Graph editor
 * family. Extracted to a stand-alone module so vitest can exercise them
 * without pulling in the whole `next/dynamic` + Fluent UI bundle.
 *
 * Keep this file:
 *   - dependency-free (no React, no Fluent, no Azure SDK imports)
 *   - side-effect-free
 *   - exported through named exports only
 *
 * Anything that needs to render UI lives in the editor .tsx file; this is
 * the "math" half.
 */

// ============================================================
// ADLS path helpers (geo-editors.tsx)
// ============================================================

/**
 * Parse an ADLS Gen2 path of the form
 *   abfss://<container>@<account>.dfs.core.windows.net/<suffix>
 * into its container + suffix parts. Returns `{ container: '', suffix: p }`
 * for anything that doesn't match (so legacy free-text paths still display).
 */
export function splitAdlsPath(p: string): { container: string; suffix: string } {
  const m = p.match(/^abfss:\/\/([^@]+)@[^/]+\/?(.*)$/i);
  if (m) return { container: m[1], suffix: m[2] || '' };
  return { container: '', suffix: p };
}

/**
 * Rebuild an ADLS Gen2 path from a container + suffix. When the account URL
 * is provided (from the discovery endpoint), use its host; otherwise emit a
 * `<account>.dfs.core.windows.net` placeholder so the user sees the shape
 * they need to provide.
 */
export function joinAdlsPath(container: string, suffix: string, accountUrl?: string): string {
  if (!container) return suffix;
  const host = accountUrl
    ? accountUrl.replace(/^https:\/\/([^.]+)\.dfs\.core\.windows\.net.*$/i, '$1.dfs.core.windows.net')
    : '<account>.dfs.core.windows.net';
  return `abfss://${container}@${host}/${suffix.replace(/^\//, '')}`;
}

// ============================================================
// Variable library validation (phase4-editors.tsx)
// ============================================================

export type VarType =
  | 'string'
  | 'integer'
  | 'number'
  | 'bool'
  | 'datetime'
  | 'guid'
  | 'item-ref'
  | 'connection-ref'
  | 'secret-ref';

/**
 * Validate a variable's value against the user-selected type. Returns `null`
 * on success or a human-readable error string otherwise. Empty values are
 * treated as "not set yet" and always pass.
 */
export function validateVarValue(type: VarType, value: string): string | null {
  if (!value) return null;
  switch (type) {
    case 'integer': return /^-?\d+$/.test(value) ? null : 'must be an integer';
    case 'number': return /^-?\d+(\.\d+)?$/.test(value) ? null : 'must be a number';
    case 'bool': return /^(true|false)$/i.test(value) ? null : 'must be true or false';
    case 'datetime': return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) ? null : 'ISO 8601 expected';
    case 'guid': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? null : 'GUID expected';
    default: return null;
  }
}

// ============================================================
// Ontology parser (phase4-editors.tsx)
// ============================================================

export interface OntologyClass {
  name: string;
  parent?: string;
  description?: string;
}

/**
 * Parse the lightweight ontology DSL into a class hierarchy. The DSL format:
 *   ClassName : ParentClass  -- description
 *
 * Lines starting with `#` are comments. Blank lines are ignored. Malformed
 * lines are silently dropped (the live editor surfaces parse counts via the
 * tree view).
 */
export function parseOntologyHierarchy(src: string): OntologyClass[] {
  const out: OntologyClass[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z_][\w]*)\s*:\s*([A-Za-z_][\w]*)?\s*(?:--\s*(.*))?$/);
    if (m) out.push({ name: m[1], parent: m[2] || undefined, description: m[3] });
  }
  return out;
}

// ============================================================
// AI Builder model state/status (powerplatform-editors.tsx)
// ============================================================

/** Map msdyn_aimodel.statecode -> display label. */
export function aiStateLabel(s?: number): string {
  return s === 0 ? 'Active' : s === 1 ? 'Inactive' : '—';
}

/** Map msdyn_aimodel.statuscode -> display label. */
export function aiStatusLabel(s?: number): string {
  switch (s) {
    case 1: return 'Draft';
    case 2: return 'Trained';
    case 3: return 'Published';
    case 4: return 'Training';
    case 5: return 'Training failed';
    case 6: return 'Publishing';
    default: return s !== undefined ? String(s) : '—';
  }
}

// ============================================================
// Map editor — GeoJSON bounding-box (phase4-editors.tsx)
// ============================================================

export interface BBox { minLon: number; maxLon: number; minLat: number; maxLat: number }

/**
 * Walk a GeoJSON FeatureCollection (or anything with a `features` array of
 * GeoJSON-shaped geometries) and compute its bounding box. Returns `null`
 * if no coordinates were found. Used by the MapEditor to center the Azure
 * Maps static tile preview on the right region.
 */
export function computeGeoBbox(featureCollection: unknown): BBox | null {
  const features = (featureCollection as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return null;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const [lon, lat] = c as [number, number];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    } else {
      c.forEach(walk);
    }
  };
  for (const f of features) {
    walk((f as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates);
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, maxLon, minLat, maxLat };
}

/**
 * Naive zoom estimate given a bounding box span. Larger spans get smaller
 * zooms; clamped to 1..18.
 */
export function bboxToZoom(bbox: BBox | null): number {
  if (!bbox) return 8;
  const span = Math.max(bbox.maxLon - bbox.minLon, bbox.maxLat - bbox.minLat);
  return Math.max(1, Math.min(18, Math.round(11 - Math.log2(Math.max(span, 0.0001)))));
}
