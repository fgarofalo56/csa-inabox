/**
 * lib/report/navigator/wire.ts
 *
 * The Navigator WIRE ADAPTER, extracted verbatim from
 * app/api/items/report/[id]/connector-objects/route.ts (rel-T64) —
 * behaviour-preserving. Bridges the per-provider `NavigatorObject` introspection
 * (which thinks in `level` + parent coords) to the connector dialog's `NavNode`
 * shape, and owns the opaque `childToken` codec the dialog echoes back to expand
 * a branch. The route calls `resolveCoords` (decode the tree position) and
 * `respond` (map objects → the 200 `nodes` body); everything else is internal.
 */

import { NextResponse } from 'next/server';
import {
  coerceLevel,
  directQueryCapable,
  type NavProvider,
  type NavKind,
  type NavCoords,
  type NavNode,
  type NavigatorObject,
  type ObjectsRequest,
} from './introspect';

/** Encode tree coordinates into an opaque, URL-safe childToken (undefined dropped). */
function encodeToken(c: NavCoords): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Decode a childToken back to coordinates; null on any tampering / bad shape. */
function decodeToken(token: string): NavCoords | null {
  try {
    const j = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    return {
      level: coerceLevel(j.level),
      schema: typeof j.schema === 'string' ? j.schema : undefined,
      catalog: typeof j.catalog === 'string' ? j.catalog : undefined,
      container: typeof j.container === 'string' ? j.container : undefined,
      path: typeof j.path === 'string' ? j.path : undefined,
      provider: typeof j.provider === 'string' ? j.provider : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the tree position to introspect. The dialog always echoes the branch's
 * opaque `parent` childToken (null at the root); a non-dialog caller may instead
 * pass the explicit `level` + coordinate fields. `parent` wins when present.
 */
export function resolveCoords(body: ObjectsRequest): NavCoords {
  if (typeof body.parent === 'string' && body.parent.trim()) {
    const decoded = decodeToken(body.parent.trim());
    if (decoded) return decoded;
  }
  return {
    level: coerceLevel(body.level),
    schema: typeof body.schema === 'string' ? body.schema : undefined,
    catalog: typeof body.catalog === 'string' ? body.catalog : undefined,
    container: typeof body.container === 'string' ? body.container : undefined,
    path: typeof body.path === 'string' ? body.path : undefined,
    provider: typeof body.provider === 'string' ? body.provider : undefined,
  };
}

/**
 * The childToken for a branch node: the NEXT level to fetch + the coordinates the
 * provider needs to enumerate this node's children. Returns undefined for leaves.
 * Mirrors each provider's hierarchy (catalog→schema→tables, db→containers/tables,
 * container→paths→files). 'lakehouse' is carried so a lakehouse drill stays one.
 */
function childTokenFor(provider: NavProvider, coords: NavCoords, obj: NavigatorObject): string | undefined {
  if (!obj.hasChildren) return undefined;
  const carry = coords.provider === 'lakehouse' || provider === 'lakehouse' ? 'lakehouse' : undefined;
  switch (obj.kind) {
    case 'catalog':
      if (provider === 'databricks') return encodeToken({ level: 'schema', catalog: obj.name, provider: carry });
      if (provider === 'sql' || provider === 'postgres') return encodeToken({ level: 'schema', provider: carry });
      // cosmos / adx: a catalog expands straight to its bindable tables/containers.
      return encodeToken({ level: 'tables', provider: carry });
    case 'schema':
      // carry the owning catalog (databricks) through to the tables level.
      return encodeToken({ level: 'tables', catalog: coords.catalog, schema: obj.name, provider: carry });
    case 'container':
      return encodeToken({ level: 'tables', container: obj.name, path: '', provider: carry });
    case 'folder':
      // ADLS folder drill-down: keep the container, descend by the folder's path.
      return encodeToken({ level: 'tables', container: coords.container, path: obj.path || '', provider: carry });
    default:
      // table / view / delta-table / file → terminal leaf.
      return undefined;
  }
}

/** state.tableStorage key for a selectable node (schema.name / fullName / name). */
function navTableKey(obj: NavigatorObject): string | undefined {
  if (!obj.selectable) return undefined;
  if (obj.fullName) return obj.fullName;
  return obj.schema ? `${obj.schema}.${obj.name}` : obj.name;
}

/** Row-badge metadata (only defined keys; undefined when there's nothing to show). */
function navMeta(obj: NavigatorObject): NavNode['meta'] | undefined {
  const meta: { format?: string; rowEstimate?: number; type?: string } = {};
  if (obj.format) meta.format = obj.format;
  if (typeof obj.rowCount === 'number') meta.rowEstimate = obj.rowCount;
  if (obj.kind === 'view') meta.type = 'view';
  else if (obj.deltaBacked && !obj.format) meta.type = 'delta';
  return Object.keys(meta).length ? meta : undefined;
}

/** The dialog's kind union has no 'delta-table' — render those as a table. */
function dialogKind(kind: NavKind): NavNode['kind'] {
  return kind === 'delta-table' ? 'table' : kind;
}

/** Stable, tree-unique id from the parent coords + the node's own identity. */
function stableId(provider: NavProvider, coords: NavCoords, obj: NavigatorObject): string {
  const ctx = [provider, coords.level, coords.catalog || '', coords.schema || '', coords.container || '', coords.path || ''].join('|');
  const self = [obj.kind, obj.schema || '', obj.path || obj.fullName || obj.name].join('|');
  return `${ctx}##${self}`;
}

/** Map a per-provider NavigatorObject to the dialog's NavNode wire shape. */
function toNavNode(obj: NavigatorObject, provider: NavProvider, coords: NavCoords): NavNode {
  const childToken = childTokenFor(provider, coords, obj);
  const tableKey = navTableKey(obj);
  const meta = navMeta(obj);
  return {
    id: stableId(provider, coords, obj),
    name: obj.name,
    kind: dialogKind(obj.kind),
    expandable: !!obj.hasChildren,
    ...(childToken ? { childToken } : {}),
    selectable: !!obj.selectable,
    ...(obj.objectRef ? { objectRef: obj.objectRef } : {}),
    ...(tableKey ? { tableKey } : {}),
    ...(obj.schema ? { schema: obj.schema } : {}),
    ...(obj.deltaBacked ? { deltaBacked: true } : {}),
    ...(meta ? { meta } : {}),
  };
}

/** Build the 200 success body — maps objects → `nodes` (the dialog's wire key). */
export function respond(provider: NavProvider, coords: NavCoords, objects: NavigatorObject[]) {
  return NextResponse.json({
    ok: true,
    provider,
    level: coords.level,
    capabilities: { directQueryCapable: directQueryCapable(provider) },
    nodes: objects.map((o) => toNavNode(o, provider, coords)),
  });
}
