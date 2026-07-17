/**
 * Shared CRUD factory for the Palantir-class migration item types
 * (workshop-app, slate-app, ontology-sdk, release-environment, health-check,
 * aip-logic). Each per-type route file is a one-liner that binds this factory
 * to its ITEM_TYPE — identical tenant-scoped Cosmos behavior as the hand-written
 * ontology / graph-model routes, no duplication.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 *
 * Per .claude/rules/no-fabric-dependency.md every type here is Azure-native by
 * default; nothing reads fabricWorkspaceId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadOwnedItem, updateOwnedItem, deleteOwnedItem, createOwnedItem, listOwnedItems, jerr,
} from './item-crud';
import { parseOntologyHierarchy, type OntologyEntityBinding, type OntologyClass } from '@/lib/editors/_family-utils';
import { normalizeActionTypes, type WeaveActionType } from '@/lib/azure/weave-ontology-store';
import { apiServerError } from '@/lib/api/respond';

/** Summary of a saved ontology, for the bind-ontology dropdowns. */
export interface OntologySummary {
  id: string;
  displayName: string;
  workspaceId: string;
  classCount: number;
}

/** List the caller's saved ontology items (Azure-native; Cosmos only). */
export async function listOntologies(tenantId: string): Promise<OntologySummary[]> {
  const items = await listOwnedItems('ontology', tenantId).catch(() => []);
  return items.map((it) => {
    const src = String((it.state as Record<string, unknown> | undefined)?.source || '');
    return {
      id: it.id,
      displayName: it.displayName,
      workspaceId: it.workspaceId,
      classCount: parseOntologyHierarchy(src).length,
    };
  });
}

/**
 * Resolve an ontology's object/link/action surface from its persisted state:
 * parsed classes (objects), IS_A parent links (links), and any data bindings.
 * Pure Cosmos read — no Fabric.
 */
export interface OntologySurface {
  id: string;
  displayName: string;
  workspaceId: string;
  classes: OntologyClass[];
  links: Array<{ from: string; to: string; kind: string }>;
  bindings: OntologyEntityBinding[];
  /** Declared write-back action types (Weave Phase 1) — create/update/delete over object types. */
  actionTypes: WeaveActionType[];
  /**
   * FOUNDRY-W1: real typed properties per object type, present ONLY when the
   * ontology was authored in the structured designer (`state.objectTypes`).
   * The OSDK generator uses these verbatim instead of reverse-engineering
   * string-typed props, so the generated TS/Python carry the real types.
   */
  propertiesByType?: Record<string, Array<{ name: string; isKey?: boolean; tsType: string; pyType: string }>>;
}

/** Map an ontology base type → (TypeScript, Python) type names for OSDK codegen. */
function ontoBaseToLang(baseType: string, arrayOf?: boolean): { tsType: string; pyType: string } {
  const map: Record<string, { ts: string; py: string }> = {
    string: { ts: 'string', py: 'str' }, marking: { ts: 'string', py: 'str' },
    boolean: { ts: 'boolean', py: 'bool' },
    byte: { ts: 'number', py: 'int' }, short: { ts: 'number', py: 'int' },
    integer: { ts: 'number', py: 'int' }, long: { ts: 'number', py: 'int' },
    float: { ts: 'number', py: 'float' }, double: { ts: 'number', py: 'float' }, decimal: { ts: 'number', py: 'float' },
    date: { ts: 'string', py: 'date' }, timestamp: { ts: 'string', py: 'datetime' },
    geopoint: { ts: '{ lat: number; lon: number }', py: 'dict' }, geoshape: { ts: 'string', py: 'str' },
    timeseries: { ts: 'string', py: 'str' }, attachment: { ts: 'string', py: 'str' },
    mediaReference: { ts: 'string', py: 'str' }, vector: { ts: 'number[]', py: 'list[float]' },
    struct: { ts: 'Record<string, unknown>', py: 'dict' },
  };
  const m = map[baseType] || { ts: 'string', py: 'str' };
  return arrayOf ? { tsType: `${m.ts}[]`, pyType: `list[${m.py}]` } : { tsType: m.ts, pyType: m.py };
}
export async function loadOntologySurface(ontologyId: string, tenantId: string): Promise<OntologySurface | null> {
  const onto = await loadOwnedItem(ontologyId, 'ontology', tenantId);
  if (!onto) return null;
  const state = (onto.state || {}) as Record<string, unknown>;

  // FOUNDRY-W1 (live-found 2026-07-17): the ontology DESIGNER (ontology-model.ts)
  // persists a STRUCTURED model (`state.objectTypes` with typed properties +
  // `state.linkTypes` + `state.actionTypes`), but this OSDK/Workshop surface
  // loader only ever read the legacy TEXT-DSL `state.source` — so a
  // designer-authored ontology produced an EMPTY OSDK (zero classes). Prefer
  // the structured model when present; fall back to the text DSL for legacy
  // ontologies that only have `state.source`.
  const structured = Array.isArray(state.objectTypes) ? (state.objectTypes as any[]) : [];
  if (structured.length > 0) {
    const classes: OntologyClass[] = structured
      .filter((o) => o && typeof o.apiName === 'string')
      .map((o) => ({
        name: o.apiName,
        parent: typeof o.parent === 'string' ? o.parent : undefined,
        description: typeof o.description === 'string' ? o.description : undefined,
      }));
    const classNames = new Set(classes.map((c) => c.name));
    const isaLinks = classes
      .filter((c) => c.parent && classNames.has(c.parent))
      .map((c) => ({ from: c.name, to: c.parent as string, kind: 'IS_A' }));
    const relLinks = (Array.isArray(state.linkTypes) ? (state.linkTypes as any[]) : [])
      .filter((l) => l && typeof l.fromType === 'string' && typeof l.toType === 'string')
      .map((l) => ({ from: l.fromType, to: l.toType, kind: String(l.apiName || l.cardinality || 'LINK') }));
    const bindings = Array.isArray(state.entityBindings) ? (state.entityBindings as OntologyEntityBinding[]) : [];
    const actionTypes = normalizeActionTypes(state.actionTypes);
    // Real typed properties per object type (with the primary key flagged).
    const propertiesByType: Record<string, Array<{ name: string; isKey?: boolean; tsType: string; pyType: string }>> = {};
    for (const o of structured) {
      if (!o || typeof o.apiName !== 'string' || !Array.isArray(o.properties)) continue;
      propertiesByType[o.apiName] = o.properties
        .filter((p: any) => p && typeof p.apiName === 'string')
        .map((p: any) => ({
          name: p.apiName,
          isKey: p.apiName === o.primaryKey,
          ...ontoBaseToLang(String(p.baseType || 'string'), !!p.arrayOf),
        }));
    }
    return {
      id: onto.id,
      displayName: onto.displayName,
      workspaceId: onto.workspaceId,
      classes,
      links: [...isaLinks, ...relLinks],
      bindings,
      actionTypes,
      propertiesByType,
    };
  }

  // Legacy text-DSL path (state.source).
  const classes = parseOntologyHierarchy(String(state.source || ''));
  const links = classes
    .filter((c) => c.parent)
    .map((c) => ({ from: c.name, to: c.parent as string, kind: 'IS_A' }));
  const bindings = Array.isArray(state.entityBindings) ? (state.entityBindings as OntologyEntityBinding[]) : [];
  // Weave Phase 1: surface declared action types alongside object/link types so
  // the OSDK / Workshop callers can introspect the full ontology surface.
  const actionTypes = normalizeActionTypes(state.actionTypes);
  return { id: onto.id, displayName: onto.displayName, workspaceId: onto.workspaceId, classes, links, bindings, actionTypes };
}

/** GET /api/items/<type> → { ok, items[] }  ·  POST → create (201). */
export function makeCollectionRoute(itemType: string) {
  async function GET() {
    const session = getSession();
    if (!session) return jerr('unauthenticated', 401);
    const items = await listOwnedItems(itemType, session.claims.oid).catch(() => []);
    return NextResponse.json({ ok: true, items });
  }
  async function POST(req: NextRequest) {
    const session = getSession();
    if (!session) return jerr('unauthenticated', 401);
    const body = await req.json().catch(() => ({}));
    const r = await createOwnedItem(session, itemType, body);
    if (!r.ok) return jerr(r.error, r.status);
    return NextResponse.json({ ok: true, item: r.item, id: r.item.id }, { status: 201 });
  }
  return { GET, POST };
}

/** GET/PATCH/DELETE /api/items/<type>/[id] — the editor's useItemState driver. */
export function makeItemRoute(itemType: string) {
  async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const s = getSession();
    if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    const { id } = await ctx.params;
    if (!id || id === 'new') return NextResponse.json({ id, displayName: '', state: {}, updatedAt: null });
    try {
      const item = await loadOwnedItem(id, itemType, s.claims.oid);
      if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 });
      return NextResponse.json({
        id: item.id,
        displayName: item.displayName,
        description: item.description,
        state: item.state || {},
        updatedAt: item.updatedAt || null,
      });
    } catch (e: any) {
      return apiServerError(e);
    }
  }
  async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const s = getSession();
    if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    const { id } = await ctx.params;
    if (!id || id === 'new') return NextResponse.json({ error: 'save the item before patching (no id yet)' }, { status: 400 });
    const body = await req.json().catch(() => ({} as any));
    try {
      const updated = await updateOwnedItem(id, itemType, s.claims.oid, {
        displayName: body?.displayName,
        ...('description' in (body || {}) ? { description: body.description } : {}),
        ...(body?.state && typeof body.state === 'object' ? { state: body.state } : {}),
      });
      if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
      return NextResponse.json({ ok: true, id: updated.id, updatedAt: updated.updatedAt });
    } catch (e: any) {
      return apiServerError(e);
    }
  }
  async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const s = getSession();
    if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    const { id } = await ctx.params;
    try {
      await deleteOwnedItem(id, itemType, s.claims.oid);
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return apiServerError(e);
    }
  }
  return { GET, PATCH, DELETE };
}
