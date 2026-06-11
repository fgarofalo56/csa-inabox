/**
 * Shared "bind to a Weave ontology" route factory.
 *
 * Several Palantir-migration surfaces bind to the Weave ontology's entity types
 * (Workshop apps build operational UIs over them; the Ontology SDK generates a
 * typed client for them). Both expose the same contract:
 *
 *   GET  /api/items/<type>/[id]/bind-ontology
 *     → { ok, workspaceId, boundOntologyId?, ontologies:[{id,displayName}],
 *         entityTypes:[string], listError? }
 *   POST /api/items/<type>/[id]/bind-ontology  body: { ontologyId }
 *     → { ok, updatedAt, boundOntologyId, entityTypes }  + Thread edge
 *
 * Cosmos-only, 100% Azure-native (no Fabric workspace). Underscore-prefixed
 * folder — Next.js does not route it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem, updateOwnedItem } from './item-crud';
import { parseOntologyHierarchy } from '@/lib/editors/_family-utils';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import type { WorkspaceItem } from '@/lib/types/workspace';

function jb(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

/** Parsed entity-type names of an ontology item (from its DSL source). */
export function ontologyEntityTypes(onto: WorkspaceItem | null): string[] {
  const src = String(((onto?.state || {}) as Record<string, unknown>).source || '');
  return parseOntologyHierarchy(src).map((c) => c.name);
}

export function makeOntologyBindRoute(itemType: string, threadAction: string) {
  async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const s = getSession();
    if (!s) return jb('unauthenticated', 401, 'unauthenticated');
    const { id } = await ctx.params;
    if (!id || id === 'new') {
      return NextResponse.json({ ok: true, workspaceId: null, boundOntologyId: null, ontologies: [], entityTypes: [] });
    }
    const owner = await loadOwnedItem(id, itemType, s.claims.oid);
    if (!owner) return jb(`${itemType} not found`, 404, 'not_found');
    const boundOntologyId = (((owner.state || {}) as Record<string, unknown>).boundOntologyId as string) || null;

    let ontologies: Array<{ id: string; displayName: string }> = [];
    let listError: string | undefined;
    try {
      const items = await itemsContainer();
      const { resources } = await items.items
        .query<{ id: string; displayName: string }>({
          query: 'SELECT c.id, c.displayName FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.displayName ASC',
          parameters: [{ name: '@w', value: owner.workspaceId }, { name: '@t', value: 'ontology' }],
        }, { partitionKey: owner.workspaceId })
        .fetchAll();
      ontologies = resources;
    } catch (e: unknown) {
      listError = e instanceof Error ? e.message : String(e);
    }

    let entityTypes: string[] = [];
    if (boundOntologyId) {
      const onto = await loadOwnedItem(boundOntologyId, 'ontology', s.claims.oid);
      entityTypes = ontologyEntityTypes(onto);
    }
    return NextResponse.json({ ok: true, workspaceId: owner.workspaceId, boundOntologyId, ontologies, entityTypes, ...(listError ? { listError } : {}) });
  }

  async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const s = getSession();
    if (!s) return jb('unauthenticated', 401, 'unauthenticated');
    const { id } = await ctx.params;
    if (!id || id === 'new') return jb(`save the ${itemType} before binding`, 400, 'no_id');
    const body = await req.json().catch(() => ({} as { ontologyId?: string }));
    const ontologyId = String((body as { ontologyId?: string })?.ontologyId || '').trim();
    if (!ontologyId) return jb('ontologyId is required', 400, 'bad_request');

    const owner = await loadOwnedItem(id, itemType, s.claims.oid);
    if (!owner) return jb(`${itemType} not found`, 404, 'not_found');
    const onto = await loadOwnedItem(ontologyId, 'ontology', s.claims.oid);
    if (!onto) return jb('ontology not found in your tenant', 404, 'ontology_not_found');

    const entityTypes = ontologyEntityTypes(onto);
    const nextState = { ...(owner.state || {}), boundOntologyId: ontologyId, boundOntologyName: onto.displayName, ontologyEntityTypes: entityTypes };
    const updated = await updateOwnedItem(id, itemType, s.claims.oid, { state: nextState });
    if (!updated) return jb('failed to persist binding', 500);

    await recordThreadEdge(s, {
      fromItemId: id, fromType: itemType, fromName: owner.displayName,
      toItemId: ontologyId, toType: 'ontology', toName: onto.displayName,
      action: threadAction,
    });
    return NextResponse.json({ ok: true, updatedAt: updated.updatedAt, boundOntologyId: ontologyId, entityTypes });
  }

  return { GET, POST };
}
