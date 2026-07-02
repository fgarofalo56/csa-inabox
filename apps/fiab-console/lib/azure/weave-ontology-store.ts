/**
 * Weave (Semantic Ontology) — graph instance write-back over Apache AGE on
 * Azure Database for PostgreSQL Flexible Server.
 *
 * Phase 1 (audit-T50): the ontology object/link/action *types* are declared in
 * the ontology DSL (parseOntologyHierarchy → classes) + state.actionTypes[]. This
 * module is the real *instance* store: object instances become AGE vertices, link
 * instances become AGE edges, and action types execute create/update/delete
 * cypher inside a PostgreSQL transaction. AGE inherits PostgreSQL ACID semantics,
 * so write-back is durable (satisfies the "real write-back" acceptance).
 *
 * Reuse (per .claude/rules/no-vaporware.md — real backend, no mocks):
 *   - executePostgresQuery / postgresQueryGate from postgres-flex-client.ts give
 *     us token-auth (Entra) PG wire-protocol execution. This module only wraps
 *     openCypher on top of that — there is NO new client.
 *
 * Apache AGE grounding (Microsoft Learn):
 *   azure/postgresql/azure-ai/generative-ai-age-overview
 *   azure/postgresql/extensions/concepts-extensions-considerations
 *   - server params: shared_preload_libraries must include AGE (else
 *     "unhandled cypher(cstring) function call"), azure.extensions allowlists AGE
 *   - one-time data-plane: CREATE EXTENSION AGE CASCADE; SELECT create_graph(...)
 *   - query: SELECT * FROM ag_catalog.cypher('<graph>', $$ ... $$) AS (v agtype);
 *
 * The graph + extension are created by the post-deploy bootstrap
 * (scripts/csa-loom/bootstrap-weave-pg.sh) so the data plane is ready when the
 * Console first connects. The bicep module modules/landing-zone/postgres-weave.bicep
 * provisions the server + the required configurations, default-on.
 */
import { executePostgresQuery, postgresQueryGate, PostgresError } from './postgres-flex-client';

/** Default graph name (matches LOOM_WEAVE_GRAPH / the bootstrap create_graph). */
const DEFAULT_GRAPH = 'loom_ontology';

export function weaveGraphName(): string {
  return (process.env.LOOM_WEAVE_GRAPH || DEFAULT_GRAPH).trim() || DEFAULT_GRAPH;
}

export function weavePgFqdn(): string {
  return (process.env.LOOM_WEAVE_PG_FQDN || '').trim();
}

export function weavePgDatabase(): string {
  return (process.env.LOOM_WEAVE_PG_DATABASE || 'loom-weave').trim() || 'loom-weave';
}

export interface WeaveGate {
  missing: string;
  detail: string;
  /** The bicep module + env vars the operator must wire (named per no-vaporware). */
  remediation: string;
}

/**
 * Honest config gate for the Weave AGE backend. Composes the PG Entra-auth gate
 * (LOOM_POSTGRES_AAD_USER) with the Weave-specific server FQDN env var. Returns
 * `null` when ready, else a structured gate the route surfaces verbatim (503).
 */
export function weaveGate(): WeaveGate | null {
  if (!weavePgFqdn()) {
    return {
      missing: 'LOOM_WEAVE_PG_FQDN',
      detail:
        'Set LOOM_WEAVE_PG_FQDN to the fully-qualified domain name of the Weave ontology ' +
        'PostgreSQL flexible server (with the Apache AGE extension enabled).',
      remediation:
        'Deploy platform/fiab/bicep/modules/landing-zone/postgres-weave.bicep (default-on, ' +
        'weaveOntologyEnabled=true). It provisions an Entra-only PG flexible server with ' +
        'shared_preload_libraries=AGE + azure.extensions=AGE, then the post-deploy bootstrap ' +
        '(scripts/csa-loom/bootstrap-weave-pg.sh) runs CREATE EXTENSION AGE CASCADE + ' +
        "create_graph('loom_ontology') and registers the Console UAMI as a PG principal.",
    };
  }
  const pgGate = postgresQueryGate();
  if (pgGate) {
    return {
      missing: pgGate.missing,
      detail: pgGate.detail,
      remediation:
        'The Weave server is provisioned but the Console identity is not yet a PG principal. ' +
        'The post-deploy bootstrap (scripts/csa-loom/bootstrap-weave-pg.sh) runs ' +
        "pgaadauth_create_principal('<console-uami>', false, false) and sets LOOM_POSTGRES_AAD_USER.",
    };
  }
  return null;
}

// ============================================================
// Cypher / agtype helpers
// ============================================================

/**
 * A safe AGE label / identifier: letters, digits, underscore; must start with a
 * letter or underscore; max 63 (PG identifier limit). Object/link/action types
 * are validated against the ontology's declared classes BEFORE reaching here, but
 * this is the last line of defence against cypher injection via a label name.
 */
export function safeLabel(name: string): string | null {
  return /^[A-Za-z_][\w]{0,62}$/.test(name || '') ? name : null;
}

/**
 * Encode a JS value as an openCypher map *property literal value*. AGE's
 * cypher() does not accept bound parameters the way the pg driver does for the
 * outer SQL, so property values are embedded into the cypher map. We JSON-encode
 * strings/numbers/bools (JSON string escaping is a strict superset of cypher
 * string escaping for the characters we allow) and reject anything else. This is
 * the injection guard — never string-concatenate a raw user value.
 */
function cypherValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v); // double-quoted, escaped
  throw new PostgresError('Weave property values must be string, number, boolean, or null', 400);
}

/** Build a cypher property-map literal `{k: "v", n: 3}` from a plain object. */
export function buildPropMap(props: Record<string, unknown>): string {
  const entries = Object.entries(props || {}).filter(([k]) => /^[A-Za-z_][\w]{0,62}$/.test(k));
  if (entries.length === 0) return '{}';
  return `{${entries.map(([k, v]) => `${k}: ${cypherValue(v)}`).join(', ')}}`;
}

/** Render a single value for a SET clause (`n.k = <value>`), guarded like buildPropMap. */
function cypherScalar(v: unknown): string {
  return cypherValue(v);
}

/**
 * Run an openCypher statement against the Weave AGE graph. The statement is
 * embedded into `SELECT * FROM ag_catalog.cypher('<graph>', $weave$ ... $weave$)
 * AS (<columns>)`. The graph name is validated (safeLabel). `columns` is the
 * agtype column projection (AGE requires an explicit column list matching the
 * cypher RETURN arity).
 *
 * `search_path` is set on the same connection so `cypher` + the graph schema
 * resolve without qualification inside the statement.
 */
export async function runCypher(
  statement: string,
  columns: Array<{ name: string; type?: string }>,
): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number }> {
  const graph = weaveGraphName();
  if (!safeLabel(graph)) throw new PostgresError(`Invalid Weave graph name '${graph}'`, 500);
  const fqdn = weavePgFqdn();
  if (!fqdn) throw new PostgresError('LOOM_WEAVE_PG_FQDN is not set', 503);
  const db = weavePgDatabase();
  const colDefs = (columns.length ? columns : [{ name: 'v', type: 'agtype' }])
    .map((c) => `${c.name} ${c.type || 'agtype'}`)
    .join(', ');
  // $weave$ dollar-quoting avoids escaping the cypher body; the body never
  // contains the literal "$weave$" because all user values are JSON-encoded.
  const sql =
    'SET search_path = ag_catalog, "$user", public; ' +
    `SELECT * FROM ag_catalog.cypher('${graph}', $weave$ ${statement} $weave$) AS (${colDefs});`;
  return executePostgresQuery(fqdn, db, sql);
}

// ============================================================
// agtype parsing — AGE returns vertices/edges as agtype JSON-ish text
// ============================================================

/**
 * Parse an agtype scalar/object cell into a JS value. AGE returns vertices as
 * `{"id": 844..., "label": "Customer", "properties": {...}}::vertex` — we strip
 * the `::vertex` / `::edge` suffix and JSON.parse. Scalars come back as JSON
 * (numbers, quoted strings). Best-effort: returns the raw string on parse fail.
 */
export function parseAgtype(cell: unknown): unknown {
  if (cell === null || cell === undefined) return null;
  if (typeof cell !== 'string') return cell;
  const stripped = cell.replace(/::(vertex|edge|path)\s*$/i, '');
  try {
    return JSON.parse(stripped);
  } catch {
    return cell;
  }
}

export interface WeaveObject {
  id: string;
  objectType: string;
  properties: Record<string, unknown>;
}

function rowToObject(cell: unknown): WeaveObject | null {
  const v = parseAgtype(cell) as { id?: unknown; label?: string; properties?: Record<string, unknown> } | null;
  if (!v || typeof v !== 'object') return null;
  return {
    id: v.id !== undefined ? String(v.id) : '',
    objectType: String(v.label || ''),
    properties: (v.properties as Record<string, unknown>) || {},
  };
}

// ============================================================
// Object instance write-back (AGE vertices)
// ============================================================

/**
 * Create an object instance: `CREATE (n:<objectType> {props}) RETURN n`. Returns
 * the persisted vertex (with its AGE-assigned id). The caller MUST have validated
 * objectType ∈ declared ontology classes (loom-no-freeform-config) — safeLabel is
 * the structural guard here.
 */
export async function createObject(objectType: string, props: Record<string, unknown>): Promise<WeaveObject> {
  const label = safeLabel(objectType);
  if (!label) throw new PostgresError(`Object type '${objectType}' is not a valid AGE label`, 400);
  const stmt = `CREATE (n:${label} ${buildPropMap(props)}) RETURN n`;
  const res = await runCypher(stmt, [{ name: 'n', type: 'agtype' }]);
  const obj = res.rows.length ? rowToObject(res.rows[0][0]) : null;
  if (!obj) throw new PostgresError('AGE create returned no vertex', 502);
  return obj;
}

/** List object instances of a type: `MATCH (n:<type>) RETURN n LIMIT <top>`. */
export async function listObjects(objectType: string, top = 100): Promise<WeaveObject[]> {
  const label = safeLabel(objectType);
  if (!label) throw new PostgresError(`Object type '${objectType}' is not a valid AGE label`, 400);
  const limit = Math.min(Math.max(Math.trunc(top) || 100, 1), 1000);
  const stmt = `MATCH (n:${label}) RETURN n LIMIT ${limit}`;
  const res = await runCypher(stmt, [{ name: 'n', type: 'agtype' }]);
  return res.rows.map((r) => rowToObject(r[0])).filter((o): o is WeaveObject => o !== null);
}

/**
 * Update an object instance by its AGE id: SET each prop, RETURN the vertex.
 * `objectType` scopes the MATCH so a wrong-typed id is a no-op (returns null → 404).
 */
export async function updateObject(
  objectType: string,
  vertexId: string,
  props: Record<string, unknown>,
): Promise<WeaveObject | null> {
  const label = safeLabel(objectType);
  if (!label) throw new PostgresError(`Object type '${objectType}' is not a valid AGE label`, 400);
  const idNum = String(vertexId).trim();
  if (!/^\d+$/.test(idNum)) throw new PostgresError('vertexId must be the numeric AGE id', 400);
  const sets = Object.entries(props || {})
    .filter(([k]) => /^[A-Za-z_][\w]{0,62}$/.test(k))
    .map(([k, v]) => `n.${k} = ${cypherScalar(v)}`);
  if (sets.length === 0) throw new PostgresError('No valid properties to update', 400);
  const stmt = `MATCH (n:${label}) WHERE id(n) = ${idNum} SET ${sets.join(', ')} RETURN n`;
  const res = await runCypher(stmt, [{ name: 'n', type: 'agtype' }]);
  return res.rows.length ? rowToObject(res.rows[0][0]) : null;
}

/** Delete an object instance (DETACH so its edges go too). Returns rows deleted. */
export async function deleteObject(objectType: string, vertexId: string): Promise<number> {
  const label = safeLabel(objectType);
  if (!label) throw new PostgresError(`Object type '${objectType}' is not a valid AGE label`, 400);
  const idNum = String(vertexId).trim();
  if (!/^\d+$/.test(idNum)) throw new PostgresError('vertexId must be the numeric AGE id', 400);
  const stmt = `MATCH (n:${label}) WHERE id(n) = ${idNum} DETACH DELETE n RETURN count(*) AS deleted`;
  const res = await runCypher(stmt, [{ name: 'deleted', type: 'agtype' }]);
  const n = res.rows.length ? Number(parseAgtype(res.rows[0][0])) : 0;
  return Number.isFinite(n) ? n : 0;
}

// ============================================================
// Link instance write-back (AGE edges)
// ============================================================

export interface WeaveLink {
  id: string;
  linkType: string;
  fromId: string;
  toId: string;
  properties: Record<string, unknown>;
}

/**
 * Create a link instance between two existing object instances (matched by their
 * AGE ids): `MATCH (a),(b) WHERE id(a)=.. AND id(b)=.. CREATE (a)-[r:<type>]->(b)`.
 */
export async function createLink(
  fromObjectType: string,
  fromId: string,
  linkType: string,
  toObjectType: string,
  toId: string,
  props: Record<string, unknown> = {},
): Promise<WeaveLink> {
  const fromLabel = safeLabel(fromObjectType);
  const toLabel = safeLabel(toObjectType);
  const linkLabel = safeLabel(linkType);
  if (!fromLabel || !toLabel || !linkLabel) {
    throw new PostgresError('from/to object type and link type must be valid AGE labels', 400);
  }
  const a = String(fromId).trim();
  const b = String(toId).trim();
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new PostgresError('fromId/toId must be numeric AGE ids', 400);
  const stmt =
    `MATCH (a:${fromLabel}), (b:${toLabel}) WHERE id(a) = ${a} AND id(b) = ${b} ` +
    `CREATE (a)-[r:${linkLabel} ${buildPropMap(props)}]->(b) ` +
    'RETURN id(r) AS rid, label(r) AS rlabel, id(a) AS aid, id(b) AS bid';
  const res = await runCypher(stmt, [
    { name: 'rid', type: 'agtype' },
    { name: 'rlabel', type: 'agtype' },
    { name: 'aid', type: 'agtype' },
    { name: 'bid', type: 'agtype' },
  ]);
  if (!res.rows.length) {
    throw new PostgresError('Link create matched no endpoints — check fromId/toId exist with the given types', 409);
  }
  const [rid, rlabel, aid, bid] = res.rows[0];
  return {
    id: String(parseAgtype(rid)),
    linkType: String(parseAgtype(rlabel)),
    fromId: String(parseAgtype(aid)),
    toId: String(parseAgtype(bid)),
    properties: props || {},
  };
}

/** A listed link instance — the edge plus both endpoints' labels. */
export interface WeaveLinkRow {
  id: string;
  linkType: string;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  properties: Record<string, unknown>;
}

/**
 * List link instances (AGE edges), optionally filtered to one edge label:
 * `MATCH (a)-[r(:<type>)]->(b) RETURN r, label(a), label(b) LIMIT <top>`.
 * The edge agtype carries id / label / start_id / end_id / properties.
 */
export async function listLinks(linkType?: string, top = 200): Promise<WeaveLinkRow[]> {
  let edgePattern = '[r]';
  if (linkType) {
    const l = safeLabel(linkType);
    if (!l) throw new PostgresError(`Link type '${linkType}' is not a valid AGE label`, 400);
    edgePattern = `[r:${l}]`;
  }
  const limit = Math.min(Math.max(Math.trunc(top) || 200, 1), 1000);
  const stmt = `MATCH (a)-${edgePattern}->(b) RETURN r, label(a), label(b) LIMIT ${limit}`;
  const res = await runCypher(stmt, [
    { name: 'r', type: 'agtype' },
    { name: 'alabel', type: 'agtype' },
    { name: 'blabel', type: 'agtype' },
  ]);
  const out: WeaveLinkRow[] = [];
  for (const row of res.rows) {
    const e = parseAgtype(row[0]) as {
      id?: unknown; label?: string; start_id?: unknown; end_id?: unknown;
      properties?: Record<string, unknown>;
    } | null;
    if (!e || typeof e !== 'object') continue;
    out.push({
      id: e.id !== undefined ? String(e.id) : '',
      linkType: String(e.label || ''),
      fromId: e.start_id !== undefined ? String(e.start_id) : '',
      fromType: String(parseAgtype(row[1]) ?? ''),
      toId: e.end_id !== undefined ? String(e.end_id) : '',
      toType: String(parseAgtype(row[2]) ?? ''),
      properties: (e.properties as Record<string, unknown>) || {},
    });
  }
  return out;
}

/** Delete a link instance (edge) by its AGE id. Returns rows deleted (0 or 1). */
export async function deleteLink(linkId: string): Promise<number> {
  const idNum = String(linkId).trim();
  if (!/^\d+$/.test(idNum)) throw new PostgresError('linkId must be the numeric AGE edge id', 400);
  const stmt = `MATCH ()-[r]->() WHERE id(r) = ${idNum} DELETE r RETURN count(*) AS deleted`;
  const res = await runCypher(stmt, [{ name: 'deleted', type: 'agtype' }]);
  const n = res.rows.length ? Number(parseAgtype(res.rows[0][0])) : 0;
  return Number.isFinite(n) ? n : 0;
}

// ============================================================
// Action types — declared on the ontology state, executed here
// ============================================================

export type WeaveActionKind = 'create' | 'update' | 'delete';

export interface WeaveActionType {
  /** Stable name of the action (e.g. "createCustomer"). */
  name: string;
  /** Object type the action operates on (must be a declared ontology class). */
  objectType: string;
  /** Write-back kind. */
  kind: WeaveActionKind;
  /** Declared parameter names (the props the action writes). For documentation/UI. */
  params?: string[];
}

export interface WeaveActionResult {
  ok: true;
  action: string;
  kind: WeaveActionKind;
  objectType: string;
  object?: WeaveObject | null;
  deleted?: number;
}

/**
 * Execute a declared action type against AGE. `params` carries the runtime values
 * (object id for update/delete, properties for create/update). Each action is a
 * single cypher statement and thus a single PostgreSQL transaction (AGE is ACID).
 */
export async function runActionType(action: WeaveActionType, params: Record<string, unknown>): Promise<WeaveActionResult> {
  const label = safeLabel(action.objectType);
  if (!label) throw new PostgresError(`Action object type '${action.objectType}' is not a valid AGE label`, 400);
  const { id: vertexId, ...props } = params || {};
  switch (action.kind) {
    case 'create': {
      const obj = await createObject(action.objectType, props);
      return { ok: true, action: action.name, kind: 'create', objectType: action.objectType, object: obj };
    }
    case 'update': {
      if (vertexId === undefined || vertexId === null || vertexId === '') {
        throw new PostgresError('update action requires an object id', 400);
      }
      const obj = await updateObject(action.objectType, String(vertexId), props);
      return { ok: true, action: action.name, kind: 'update', objectType: action.objectType, object: obj };
    }
    case 'delete': {
      if (vertexId === undefined || vertexId === null || vertexId === '') {
        throw new PostgresError('delete action requires an object id', 400);
      }
      const deleted = await deleteObject(action.objectType, String(vertexId));
      return { ok: true, action: action.name, kind: 'delete', objectType: action.objectType, deleted };
    }
    default:
      throw new PostgresError(`Unknown action kind '${(action as WeaveActionType).kind}'`, 400);
  }
}

/**
 * Coerce a persisted state.actionTypes value into a clean WeaveActionType[].
 * Drops malformed entries (no name / bad kind / no objectType). Used by the
 * surface loader + the run-action route to validate the requested action.
 */
export function normalizeActionTypes(raw: unknown): WeaveActionType[] {
  if (!Array.isArray(raw)) return [];
  const kinds: WeaveActionKind[] = ['create', 'update', 'delete'];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x): WeaveActionType | null => {
      const name = String((x as { name?: unknown }).name || '').trim();
      const objectType = String((x as { objectType?: unknown }).objectType || '').trim();
      const kind = (x as { kind?: unknown }).kind as WeaveActionKind;
      if (!name || !objectType || !kinds.includes(kind)) return null;
      const params = Array.isArray((x as { params?: unknown }).params)
        ? ((x as { params: unknown[] }).params).map((p) => String(p || '').trim()).filter(Boolean)
        : undefined;
      return { name, objectType, kind, ...(params ? { params } : {}) };
    })
    .filter((a): a is WeaveActionType => a !== null);
}
