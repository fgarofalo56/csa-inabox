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
}
export async function loadOntologySurface(ontologyId: string, tenantId: string): Promise<OntologySurface | null> {
  const onto = await loadOwnedItem(ontologyId, 'ontology', tenantId);
  if (!onto) return null;
  const state = (onto.state || {}) as Record<string, unknown>;
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
