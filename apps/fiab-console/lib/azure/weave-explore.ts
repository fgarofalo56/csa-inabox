/**
 * weave-explore — cross-type Object Explorer queries (Foundry-parity row 2.6).
 *
 * Foundry's Object Explorer browses object instances ACROSS types with facet
 * counts + link traversal. The per-type write-back store (weave-ontology-store)
 * already exposes listObjects/listLinks/runCypher over the same Apache AGE
 * graph — this module composes them into the cross-type reads the explorer
 * needs, with the SAME safeLabel injection guard. Pure query composition; the
 * only I/O is the shared runCypher.
 */
import { runCypher, safeLabel, type WeaveObject } from '@/lib/azure/weave-ontology-store';
import { PostgresError } from '@/lib/azure/postgres-flex-client';

export interface ObjectFacet { objectType: string; count: number }

function parseVertex(cell: unknown): WeaveObject | null {
  // rowToObject is not exported; re-parse the agtype vertex the same way.
  const text = cell == null ? '' : String(cell).replace(/::vertex$/, '');
  let v: any;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  return { id: v.id !== undefined ? String(v.id) : '', objectType: String(v.label || ''), properties: (v.properties || {}) as Record<string, unknown> };
}

/**
 * Per-type instance counts across the whole graph (the explorer's facet rail).
 * One `MATCH (n) RETURN label(n), count(n)` — cheaper than N per-type queries.
 * `declared` scopes the result to the ontology's declared object types (drops
 * any stray labels), preserving loom-no-freeform-config.
 */
export async function objectFacets(declared: readonly string[]): Promise<ObjectFacet[]> {
  const allow = new Set(declared);
  const res = await runCypher(
    'MATCH (n) RETURN label(n) AS t, count(n) AS c',
    [{ name: 't', type: 'agtype' }, { name: 'c', type: 'agtype' }],
  );
  const out: ObjectFacet[] = [];
  for (const [t, c] of res.rows) {
    const objectType = String(t ?? '').replace(/^"|"$/g, '');
    if (!objectType || !allow.has(objectType)) continue;
    out.push({ objectType, count: Number(String(c ?? '0').replace(/[^0-9]/g, '')) || 0 });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * Free-text search of an object type's instances: case-insensitive CONTAINS on
 * any string property. `q` is embedded via a JSON-escaped cypher literal (the
 * same guard runCypher uses for values) so it can't break out of the string.
 */
export async function searchObjects(objectType: string, q: string, top = 100): Promise<WeaveObject[]> {
  const label = safeLabel(objectType);
  if (!label) throw new PostgresError(`Object type '${objectType}' is not a valid AGE label`, 400);
  const limit = Math.min(Math.max(Math.trunc(top) || 100, 1), 1000);
  const query = (q || '').trim();
  if (!query) {
    const res = await runCypher(`MATCH (n:${label}) RETURN n LIMIT ${limit}`, [{ name: 'n', type: 'agtype' }]);
    return res.rows.map((r) => parseVertex(r[0])).filter((o): o is WeaveObject => !!o);
  }
  const needle = JSON.stringify(query.toLowerCase()); // double-quoted, escaped
  // AGE openCypher: toLower + CONTAINS over properties(n) values, any string prop.
  const stmt =
    `MATCH (n:${label}) WITH n, [k IN keys(properties(n)) WHERE toString(properties(n)[k]) IS NOT NULL] AS ks ` +
    `WHERE any(k IN ks WHERE toLower(toString(properties(n)[k])) CONTAINS ${needle}) ` +
    `RETURN n LIMIT ${limit}`;
  const res = await runCypher(stmt, [{ name: 'n', type: 'agtype' }]);
  return res.rows.map((r) => parseVertex(r[0])).filter((o): o is WeaveObject => !!o);
}

export interface TraverseNeighbor { linkType: string; direction: 'out' | 'in'; neighbor: WeaveObject }

/**
 * Traverse from one object (by its numeric AGE id) to its immediate neighbours,
 * both directions, with the connecting link type. The explorer's graph view.
 */
export async function traverseObject(objectType: string, vertexId: string, top = 100): Promise<TraverseNeighbor[]> {
  const label = safeLabel(objectType);
  if (!label) throw new PostgresError(`Object type '${objectType}' is not a valid AGE label`, 400);
  const idNum = String(vertexId).trim();
  if (!/^\d+$/.test(idNum)) throw new PostgresError('vertexId must be the numeric AGE id', 400);
  const limit = Math.min(Math.max(Math.trunc(top) || 100, 1), 1000);
  const stmt =
    `MATCH (a:${label})-[r]-(b) WHERE id(a) = ${idNum} ` +
    `RETURN type(r) AS lt, startNode(r) = a AS isOut, b LIMIT ${limit}`;
  const res = await runCypher(stmt, [{ name: 'lt', type: 'agtype' }, { name: 'isOut', type: 'agtype' }, { name: 'b', type: 'agtype' }]);
  const out: TraverseNeighbor[] = [];
  for (const [lt, isOut, b] of res.rows) {
    const neighbor = parseVertex(b);
    if (!neighbor) continue;
    out.push({
      linkType: String(lt ?? '').replace(/^"|"$/g, ''),
      direction: String(isOut) === 'true' ? 'out' : 'in',
      neighbor,
    });
  }
  return out;
}
