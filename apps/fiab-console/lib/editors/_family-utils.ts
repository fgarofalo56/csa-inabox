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
 * A binding from a Lakehouse / Warehouse data item into the ontology. One
 * binding maps a physical data source to one or more ontology entity types
 * (classes) — the rows of the source tables become instances of those types.
 * Persisted on the ontology item's `state.entityBindings[]`.
 */
export interface OntologyEntityBinding {
  /** Azure-native source kind. Both default to Cosmos-listed items. */
  sourceKind: 'lakehouse' | 'warehouse';
  /** Cosmos item GUID of the bound lakehouse/warehouse. */
  sourceItemId: string;
  /** Display name of the bound item (cached for the UI). */
  sourceDisplayName: string;
  /** Ontology class names this source materializes as entity instances. */
  entityTypes: string[];
  /** ISO-8601 timestamp the binding was created/updated. */
  boundAt?: string;
}

/**
 * Given a parsed ontology class list and a list of physical table names from a
 * Lakehouse/Warehouse schema, return the classes whose names match a table name
 * (case-insensitive, ignoring any `schema.` prefix). Used to pre-select the
 * entity types when binding a data source so the user doesn't have to map by
 * hand when the names already line up.
 */
export function matchClassesToTables(
  classes: OntologyClass[],
  tableNames: string[],
): OntologyClass[] {
  const normalised = new Set(
    (Array.isArray(tableNames) ? tableNames : [])
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .map((t) => (t.split('.').pop() || t).toLowerCase()),
  );
  return (Array.isArray(classes) ? classes : []).filter((c) => normalised.has(c.name.toLowerCase()));
}

/**
 * Build the Azure-native (Log Analytics KQL) change-detection query for an
 * Activator trigger fired on entity changes. The query targets the custom-log
 * table the Loom activator engine emits entity-change events to
 * (`LOOM_ACTIVATOR_DEFAULT_TABLE`, default `AppEvents_CL`) and fires when a row
 * with the matching `entityType` and a write operation (INSERT/UPDATE/DELETE)
 * appears. The created scheduledQueryRule runs this verbatim — see
 * activator-monitor.ts buildRuleQuery (a verbatim `query` always wins).
 *
 * Pure + side-effect-free except for reading the env default table name, so it
 * is vitest-coverable. `sourceKind`/`sourceItemId` are recorded in the query
 * comment for provenance (and to scope future per-source filters) without
 * changing the firing condition.
 */
export function buildEntityChangeQuery(
  entityType: string,
  sourceKind: 'lakehouse' | 'warehouse',
  sourceItemId: string,
  defaultTable?: string,
): string {
  const table = (defaultTable || process.env.LOOM_ACTIVATOR_DEFAULT_TABLE || 'AppEvents_CL').trim() || 'AppEvents_CL';
  const et = String(entityType || '').replace(/"/g, '\\"');
  const src = String(sourceItemId || '').replace(/[\r\n]/g, ' ');
  return [
    `// Loom ontology entity-change trigger — ${sourceKind} ${src}`,
    table,
    `| where entityType == "${et}"`,
    `| where operation in ("INSERT","UPDATE","DELETE")`,
  ].join('\n');
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

/** Format a bbox as a compact "[minLon, minLat] -> [maxLon, maxLat]" label. */
export function bboxLabel(bbox: BBox | null): string | null {
  if (!bbox) return null;
  const f = (n: number) => n.toFixed(4);
  return `[${f(bbox.minLon)}, ${f(bbox.minLat)}] → [${f(bbox.maxLon)}, ${f(bbox.maxLat)}]`;
}

// ============================================================
// Geo-dataset inspector — turn OPENROWSET probe rows into GeoJSON
// (geo-editors.tsx GeoDatasetEditor map render)
// ============================================================

/**
 * Parse a single Well-Known-Text geometry literal into a GeoJSON geometry.
 * Handles POINT / LINESTRING / POLYGON (and their MULTI* variants). Returns
 * null for anything it can't parse (e.g. WKB hex blobs, which Synapse returns
 * for varbinary geometry columns and which can't be decoded client-side).
 *
 * Pure + side-effect-free so vitest can exercise it without a DOM. The grammar
 * is deliberately tolerant: it strips the type keyword, then recursively reads
 * the parenthesised coordinate groups. Z/M ordinates beyond lon/lat are dropped
 * (GeoJSON is 2-D for our SVG renderer).
 */
export function parseWktGeometry(wkt: string): { type: string; coordinates: unknown } | null {
  if (typeof wkt !== 'string') return null;
  const s = wkt.trim();
  const m = s.match(/^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON)\s*(Z|M|ZM)?\s*\((.*)\)\s*$/i);
  if (!m) return null;
  const type = m[1].toUpperCase();
  const body = m[3];

  // Read a flat list of "lon lat" pairs from a coordinate string.
  const readPairs = (str: string): number[][] => {
    const pairs: number[][] = [];
    for (const tok of str.split(',')) {
      const nums = tok.trim().split(/\s+/).map(Number);
      if (nums.length >= 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1])) {
        pairs.push([nums[0], nums[1]]);
      }
    }
    return pairs;
  };
  // Split a body into top-level parenthesised groups (handles nesting).
  const splitGroups = (str: string): string[] => {
    const groups: string[] = [];
    let depth = 0, start = -1;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '(') { if (depth === 0) start = i + 1; depth++; }
      else if (ch === ')') { depth--; if (depth === 0 && start >= 0) { groups.push(str.slice(start, i)); start = -1; } }
    }
    return groups;
  };

  switch (type) {
    case 'POINT': {
      const p = readPairs(body)[0];
      return p ? { type: 'Point', coordinates: p } : null;
    }
    case 'LINESTRING':
      return { type: 'LineString', coordinates: readPairs(body) };
    case 'MULTIPOINT': {
      // MULTIPOINT can be "(1 2, 3 4)" or "((1 2),(3 4))".
      const groups = splitGroups(body);
      const coords = groups.length ? groups.map((g) => readPairs(g)[0]).filter(Boolean) : readPairs(body);
      return { type: 'MultiPoint', coordinates: coords };
    }
    case 'POLYGON':
      return { type: 'Polygon', coordinates: splitGroups(body).map(readPairs) };
    case 'MULTILINESTRING':
      return { type: 'MultiLineString', coordinates: splitGroups(body).map(readPairs) };
    case 'MULTIPOLYGON':
      return { type: 'MultiPolygon', coordinates: splitGroups(body).map((poly) => splitGroups(poly).map(readPairs)) };
    default:
      return null;
  }
}

/** GeoJSON FeatureCollection shape used by the SVG renderer. */
export interface GeoFeatureCollection { type: 'FeatureCollection'; features: any[] }

/**
 * Turn the geometry inspector's probe result ({ columns, rows }) into a GeoJSON
 * FeatureCollection so the dataset editor can render the actual geometry on the
 * shared map — not just a schema panel + raw JSON dump.
 *
 * Resolution order per row, using the declared geometry column first:
 *   1. The geometry cell is a GeoJSON object/array literal → use it directly.
 *   2. The geometry cell is a WKT literal (POINT(...)/POLYGON(...)) → parse it.
 *   3. Fallback: lon/lat (or longitude/latitude, x/y) columns → Point feature.
 *
 * WKB hex blobs (varbinary geometry) can't be decoded client-side, so those
 * rows are skipped (the schema panel still badges them "WKB"). Bounded to the
 * first `max` rows. Pure + unit-tested.
 */
export function geoFeaturesFromInspectRows(
  columns: string[],
  rows: unknown[][],
  geomColumn: string,
  max = 2000,
): GeoFeatureCollection {
  const fc: GeoFeatureCollection = { type: 'FeatureCollection', features: [] };
  if (!Array.isArray(columns) || !Array.isArray(rows)) return fc;
  const lc = columns.map((c) => String(c).toLowerCase());
  const geomI = lc.indexOf(String(geomColumn || '').toLowerCase());
  const lonI = lc.findIndex((c) => ['lon', 'lng', 'longitude', 'x'].includes(c));
  const latI = lc.findIndex((c) => ['lat', 'latitude', 'y'].includes(c));

  for (const row of rows.slice(0, max)) {
    if (!Array.isArray(row)) continue;
    const props: Record<string, unknown> = {};
    columns.forEach((c, i) => { if (i !== geomI && i !== lonI && i !== latI) props[c] = row[i]; });

    let geometry: { type: string; coordinates: unknown } | null = null;
    const cell = geomI >= 0 ? row[geomI] : undefined;

    // 1. GeoJSON literal cell (object, or a string that parses to one).
    if (cell && typeof cell === 'object' && (cell as any).type && (cell as any).coordinates) {
      geometry = cell as any;
    } else if (typeof cell === 'string') {
      const t = cell.trim();
      if (t.startsWith('{')) {
        try { const j = JSON.parse(t); if (j?.type && j?.coordinates) geometry = j; } catch { /* not GeoJSON */ }
      }
      // 2. WKT literal.
      if (!geometry) geometry = parseWktGeometry(t);
    }

    // 3. lon/lat column fallback.
    if (!geometry && lonI >= 0 && latI >= 0) {
      const lon = Number(row[lonI]); const lat = Number(row[latI]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) geometry = { type: 'Point', coordinates: [lon, lat] };
    }

    if (geometry) fc.features.push({ type: 'Feature', properties: props, geometry });
  }
  return fc;
}

// ============================================================
// Data Agent source normalization (phase4-editors.tsx — DataAgentEditor)
// ============================================================

export type DaSourceType =
  | 'warehouse'
  | 'lakehouse'
  | 'kql'
  | 'semantic-model'
  | 'ai-search'
  | 'ontology'
  | 'graph';

export interface DaSource {
  id: string;
  type: DaSourceType;
  name: string;
  /** Selected tables / views / functions / model — comma separated (schema selection). */
  tables?: string;
  /** Per-source NL2X grounding instructions (## General knowledge / ## Table descriptions / …). */
  instructions?: string;
  /** Per-source description the agent uses to ROUTE a question to this source (Fabric "Data source description"). */
  description?: string;
  examples?: { question: string; query: string }[];
}

const DA_INSTRUCTION_TEMPLATE = '## General knowledge\n\n## Table descriptions\n\n## When asked about\n';
const DA_SOURCE_TYPE_VALUES: DaSourceType[] = [
  'warehouse',
  'lakehouse',
  'kql',
  'semantic-model',
  'ai-search',
  'ontology',
  'graph',
];

/**
 * Whether a given source type supports few-shot example query/answer pairs.
 *
 * Grounded in Microsoft Learn (Fabric data agent "Example queries" matrix):
 *   Lakehouse ✅, Warehouse ✅, Eventhouse/KQL ✅, GQL/Graph ✅, AI Search ✅
 *   Semantic model ❌ (use Power BI "Prep for AI" Verified Answers instead)
 *   Ontology ❌
 * See https://learn.microsoft.com/fabric/data-science/data-agent-example-queries
 */
export function daSupportsExampleQueries(type: DaSourceType): boolean {
  return type !== 'semantic-model' && type !== 'ontology';
}

/** Guess a DaSourceType from a free-text legacy source name. */
export function guessDaSourceType(name: string): DaSourceType {
  const n = name.toLowerCase();
  if (/semantic|dataset|power\s*bi|\bpbi\b/.test(n)) return 'semantic-model';
  if (/lakehouse|\blh\b|delta|gold|silver|bronze/.test(n)) return 'lakehouse';
  if (/kql|kusto|eventhouse|adx/.test(n)) return 'kql';
  if (/ai\s*search|search\s*index|\bindex\b|vector/.test(n)) return 'ai-search';
  if (/ontolog/.test(n)) return 'ontology';
  if (/\bgraph\b|gql|cypher|node|edge/.test(n)) return 'graph';
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
          description: typeof x.description === 'string' ? x.description : '',
          examples: Array.isArray(x.examples) && daSupportsExampleQueries(type) ? x.examples : [],
        };
      });
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((tok) => tok.trim()).filter(Boolean).map((name): DaSource => {
      const type = guessDaSourceType(name);
      return { id: `${type}:${slugify(name, 'src')}:legacy`, type, name, tables: '', instructions: DA_INSTRUCTION_TEMPLATE, description: '', examples: [] };
    });
  }
  return [];
}

export interface DaChatTurn { role: 'user' | 'assistant'; content: string }

/**
 * Shape an in-memory chat thread into the `history` array the chat BFF expects:
 * only `{role, content}` for user/assistant turns with non-empty string content,
 * capped to the last `max` turns (default 10) to bound the prompt. Error bubbles
 * (assistant turns flagged `error`) are excluded so a failed turn never poisons
 * the next request's grounding. Pure + unit-tested (no Fluent UI dependency).
 */
export function shapeDaHistory(
  chat: { role: 'user' | 'assistant'; content: string; error?: boolean }[],
  max = 10,
): DaChatTurn[] {
  const turns = (Array.isArray(chat) ? chat : [])
    .filter((m) => m && !m.error && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
  return max > 0 ? turns.slice(-max) : turns;
}

/** Send is enabled only when there is a non-blank question and no turn is in flight. */
export function canSendDaQuestion(question: string, asking: boolean): boolean {
  return !asking && typeof question === 'string' && question.trim().length > 0;
}
