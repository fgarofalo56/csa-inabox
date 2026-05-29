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
// Fabric User Data Functions — parse @udf.function() signatures
// (phase4-editors.tsx Functions explorer + Test panel)
// ============================================================

export interface UdfParam { name: string; type?: string; default?: string }
export interface UdfFunction { name: string; params: UdfParam[]; returns?: string }

/**
 * Parse the function_app.py source for functions decorated with
 * `@udf.function()`. Returns the function name, its typed parameters
 * (name/type/default), and return annotation. Helper (undecorated) functions
 * are excluded, matching the Fabric Functions explorer behaviour.
 */
export function parseUdfFunctions(src: string): UdfFunction[] {
  const out: UdfFunction[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*@udf\.function\s*\(/.test(lines[i])) continue;
    // Find the def line (may be the next non-decorator line).
    let j = i + 1;
    while (j < lines.length && /^\s*@/.test(lines[j])) j++;
    // Accumulate the def signature across wrapped lines until the closing ):
    let sig = '';
    for (; j < lines.length; j++) {
      sig += lines[j];
      if (sig.includes(')')) break;
      sig += ' ';
    }
    const m = sig.match(/def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/);
    if (!m) continue;
    const params: UdfParam[] = [];
    for (const rawP of m[2].split(',')) {
      const p = rawP.trim();
      if (!p || p === 'self') continue;
      const pm = p.match(/^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/);
      if (pm) params.push({ name: pm[1], type: pm[2]?.trim(), default: pm[3]?.trim() });
    }
    out.push({ name: m[1], params, returns: m[3]?.trim() });
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

// ============================================================
// Data Agent source normalization (phase4-editors.tsx — DataAgentEditor)
// ============================================================

export type DaSourceType = 'warehouse' | 'lakehouse' | 'kql' | 'semantic-model' | 'ai-search';

export interface DaSource {
  id: string;
  type: DaSourceType;
  name: string;
  tables?: string;
  instructions?: string;
  examples?: { question: string; query: string }[];
}

const DA_INSTRUCTION_TEMPLATE = '## General knowledge\n\n## Table descriptions\n\n## When asked about\n';
const DA_SOURCE_TYPE_VALUES: DaSourceType[] = ['warehouse', 'lakehouse', 'kql', 'semantic-model', 'ai-search'];

/** Guess a DaSourceType from a free-text legacy source name. */
export function guessDaSourceType(name: string): DaSourceType {
  const n = name.toLowerCase();
  if (/semantic|dataset|power\s*bi|\bpbi\b/.test(n)) return 'semantic-model';
  if (/lakehouse|\blh\b|delta|gold|silver|bronze/.test(n)) return 'lakehouse';
  if (/kql|kusto|eventhouse|adx/.test(n)) return 'kql';
  if (/ai\s*search|search\s*index|\bindex\b|vector/.test(n)) return 'ai-search';
  if (/warehouse|\bdw\b|\bwh\b|synapse/.test(n)) return 'warehouse';
  return 'warehouse';
}

/**
 * Coerce a persisted `sources` value into a clean DaSource[].
 *
 * A legacy data-agent record could persist `sources` as a comma-separated
 * STRING (e.g. "fin-warehouse, orders semantic model, ldn-gold-lakehouse") —
 * calling `.map`/`.length` on that string is the confirmed
 * `eo.map is not a function` crash. This best-effort parses the legacy string
 * into typed sources and normalizes already-array values (filling missing
 * id/type/name). Any other shape (object/null/number) → [].
 */
export function normalizeDaSources(raw: unknown): DaSource[] {
  const slugify = (s: string, fb: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fb;
  if (Array.isArray(raw)) {
    return raw
      .filter((x) => x && typeof x === 'object')
      .map((x: any, i): DaSource => {
        const name = String(x.name ?? x.id ?? `source-${i + 1}`).trim();
        const type: DaSourceType = DA_SOURCE_TYPE_VALUES.includes(x.type) ? x.type : guessDaSourceType(name);
        return {
          id: typeof x.id === 'string' && x.id ? x.id : `${type}:${slugify(name, `src-${i + 1}`)}:legacy`,
          type,
          name,
          tables: typeof x.tables === 'string' ? x.tables : '',
          instructions: typeof x.instructions === 'string' ? x.instructions : DA_INSTRUCTION_TEMPLATE,
          examples: Array.isArray(x.examples) ? x.examples : [],
        };
      });
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((tok) => tok.trim()).filter(Boolean).map((name): DaSource => {
      const type = guessDaSourceType(name);
      return { id: `${type}:${slugify(name, 'src')}:legacy`, type, name, tables: '', instructions: DA_INSTRUCTION_TEMPLATE, examples: [] };
    });
  }
  return [];
}
