/**
 * GET  /api/items/ontology/[id]/bind
 *   → { ok, workspaceId, boundLakehouseId, boundWarehouseId, entityBindings[],
 *       lakehouses: [{id, displayName}], warehouses: [{id, displayName}],
 *       activatorId?, listError? }
 *
 * POST /api/items/ontology/[id]/bind  body:
 *   { sourceKind: 'lakehouse'|'warehouse', sourceItemId, sourceDisplayName,
 *     entityTypes: string[] }
 *   → { ok, updatedAt, entityBindings[] }
 *
 * DELETE /api/items/ontology/[id]/bind?sourceItemId=<id>
 *   (or body { sourceItemId })
 *   → { ok, updatedAt, entityBindings[] }
 *   Durably removes a single binding by sourceItemId and reconciles the
 *   boundLakehouseId / boundWarehouseId convenience pointers.
 *
 * Wires the OntologyEditor's "Bind to data source" surface (phase4-editors).
 * Cosmos-only — lists the lakehouse/warehouse items that live in the SAME
 * workspace as the ontology, and persists the chosen binding onto the ontology
 * item's state. The ontology's own workspaceId is resolved server-side from the
 * item, so the client never has to coordinate it.
 *
 * Per .claude/rules/no-fabric-dependency.md this is 100% Azure-native (no Fabric
 * workspace required): a binding is metadata linking an ADLS/Delta lakehouse or
 * a Synapse-backed warehouse to ontology entity types. No api.fabric host.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import type { OntologyEntityBinding } from '@/lib/editors/_family-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

/** List {id, displayName} for items of a type within a workspace (Cosmos only). */
async function listByType(workspaceId: string, itemType: string): Promise<Array<{ id: string; displayName: string }>> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; displayName: string }>({
      query: 'SELECT c.id, c.displayName FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.displayName ASC',
      parameters: [
        { name: '@w', value: workspaceId },
        { name: '@t', value: itemType },
      ],
    }, { partitionKey: workspaceId })
    .fetchAll();
  return resources;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') {
    return NextResponse.json({ ok: true, workspaceId: null, boundLakehouseId: null, boundWarehouseId: null, entityBindings: [], lakehouses: [], warehouses: [] });
  }
  const onto = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const state = (onto.state || {}) as Record<string, unknown>;
  const entityBindings = Array.isArray(state.entityBindings) ? (state.entityBindings as OntologyEntityBinding[]) : [];

  let lakehouses: Array<{ id: string; displayName: string }> = [];
  let warehouses: Array<{ id: string; displayName: string }> = [];
  let listError: string | undefined;
  try {
    [lakehouses, warehouses] = await Promise.all([
      listByType(onto.workspaceId, 'lakehouse'),
      listByType(onto.workspaceId, 'warehouse'),
    ]);
  } catch (e: any) {
    listError = e?.message || String(e);
  }

  return NextResponse.json({
    ok: true,
    workspaceId: onto.workspaceId,
    boundLakehouseId: (state.boundLakehouseId as string) || null,
    boundWarehouseId: (state.boundWarehouseId as string) || null,
    entityBindings,
    activatorId: (state.activatorId as string) || null,
    lakehouses,
    warehouses,
    ...(listError ? { listError } : {}),
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology before binding (no id yet)', 400, 'no_id');

  const body = await req.json().catch(() => ({} as any));
  const sourceKind = body?.sourceKind === 'warehouse' ? 'warehouse' : body?.sourceKind === 'lakehouse' ? 'lakehouse' : null;
  const sourceItemId = String(body?.sourceItemId || '').trim();
  const sourceDisplayName = String(body?.sourceDisplayName || '').trim();
  const entityTypes = Array.isArray(body?.entityTypes)
    ? body.entityTypes.map((t: unknown) => String(t || '').trim()).filter(Boolean)
    : [];

  if (!sourceKind) return err("sourceKind must be 'lakehouse' or 'warehouse'", 400, 'bad_source_kind');
  if (!sourceItemId) return err('sourceItemId is required', 400, 'missing_source');
  if (entityTypes.length === 0) return err('select at least one entity type to bind', 400, 'no_entity_types');

  const onto = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');

  // Verify the source item exists in the same workspace (tenant-scoped via the
  // ontology we already loaded as owned).
  const sources = await listByType(onto.workspaceId, sourceKind);
  const match = sources.find((s) => s.id === sourceItemId);
  if (!match) return err(`${sourceKind} '${sourceItemId}' not found in this workspace`, 404, 'source_not_found');

  const state = { ...((onto.state || {}) as Record<string, unknown>) };
  const existing = Array.isArray(state.entityBindings) ? (state.entityBindings as OntologyEntityBinding[]) : [];
  const next: OntologyEntityBinding = {
    sourceKind,
    sourceItemId,
    sourceDisplayName: sourceDisplayName || match.displayName,
    entityTypes,
    boundAt: new Date().toISOString(),
  };
  const entityBindings = [...existing.filter((b) => b.sourceItemId !== sourceItemId), next];
  state.entityBindings = entityBindings;
  if (sourceKind === 'lakehouse') state.boundLakehouseId = sourceItemId;
  else state.boundWarehouseId = sourceItemId;

  const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state });
  if (!updated) return err('ontology not found', 404, 'not_found');
  return NextResponse.json({ ok: true, updatedAt: updated.updatedAt, entityBindings });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology before unbinding (no id yet)', 400, 'no_id');

  // sourceItemId may arrive as a query param or in the request body.
  let sourceItemId = (req.nextUrl.searchParams.get('sourceItemId') || '').trim();
  if (!sourceItemId) {
    const body = await req.json().catch(() => ({} as any));
    sourceItemId = String(body?.sourceItemId || '').trim();
  }
  if (!sourceItemId) return err('sourceItemId is required', 400, 'missing_source');

  const onto = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');

  const state = { ...((onto.state || {}) as Record<string, unknown>) };
  const existing = Array.isArray(state.entityBindings) ? (state.entityBindings as OntologyEntityBinding[]) : [];
  const removed = existing.find((b) => b.sourceItemId === sourceItemId);
  const entityBindings = existing.filter((b) => b.sourceItemId !== sourceItemId);
  state.entityBindings = entityBindings;

  // Reconcile the convenience pointers: if the removed binding was the one
  // recorded as boundLakehouseId / boundWarehouseId, point them at the most
  // recent remaining binding of the same kind (or clear them).
  if (removed) {
    const lastOfKind = (kind: 'lakehouse' | 'warehouse') =>
      [...entityBindings].reverse().find((b) => b.sourceKind === kind)?.sourceItemId || null;
    if (state.boundLakehouseId === sourceItemId) {
      const next = lastOfKind('lakehouse');
      if (next) state.boundLakehouseId = next; else delete state.boundLakehouseId;
    }
    if (state.boundWarehouseId === sourceItemId) {
      const next = lastOfKind('warehouse');
      if (next) state.boundWarehouseId = next; else delete state.boundWarehouseId;
    }
  }

  const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state });
  if (!updated) return err('ontology not found', 404, 'not_found');
  return NextResponse.json({ ok: true, updatedAt: updated.updatedAt, entityBindings });
}
