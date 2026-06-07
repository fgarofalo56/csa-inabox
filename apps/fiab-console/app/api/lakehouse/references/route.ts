/**
 * Reference-Lakehouse federation (F8) — Azure-native, NO Fabric dependency.
 *
 * A "reference" lets a primary lakehouse browse OTHER in-workspace lakehouses
 * side-by-side (read-only). The reference set is stored on the primary
 * lakehouse's Cosmos `items` doc as `state.referencedLakehouseIds: string[]`
 * — no new Cosmos container, no schema migration (Cosmos is schemaless).
 *
 * Reads go through pass-through RBAC: the Console UAMI must hold Storage Blob
 * Data Reader on the referenced lakehouse's containers (same primary LOOM ADLS
 * account by default; an explicit `state.storageAccount` for cross-account
 * lakehouses). Writes are NOT exposed on any reference route — the absence of
 * PUT/POST/DELETE on the file-listing route is the enforcement layer.
 *
 *   GET  /api/lakehouse/references?lakehouseId=<primaryItemId>
 *        → { ok, primary, references[], workspaceLakehouses[] }
 *   POST /api/lakehouse/references  { lakehouseId, addId?, removeId? }
 *        → { ok, referencedLakehouseIds }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  KNOWN_CONTAINERS, getAccountName, containerExistsOn,
} from '@/lib/azure/adls-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LakehouseState {
  storageAccount?: string;
  ownedContainers?: string[];
  referencedLakehouseIds?: string[];
  [k: string]: unknown;
}

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

/** Load a lakehouse item by id and verify it belongs to the caller's tenant. */
async function loadLakehouse(itemId: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: "SELECT * FROM c WHERE c.id = @id AND c.itemType = 'lakehouse'",
      parameters: [{ name: '@id', value: itemId }],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

/** All lakehouse items in a workspace (single physical partition). */
async function listWorkspaceLakehouses(workspaceId: string): Promise<WorkspaceItem[]> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: "SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = 'lakehouse' ORDER BY c.displayName ASC",
      parameters: [{ name: '@w', value: workspaceId }],
    }, { partitionKey: workspaceId })
    .fetchAll();
  return resources;
}

function ownedContainersOf(item: WorkspaceItem): string[] {
  const owned = (item.state as LakehouseState | undefined)?.ownedContainers;
  return Array.isArray(owned) && owned.length ? owned : [...KNOWN_CONTAINERS];
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthorized');

  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId') || '';
  if (!lakehouseId) return err('lakehouseId is required', 400, 'missing_lakehouseId');

  try {
    const primary = await loadLakehouse(lakehouseId, session.claims.oid);
    if (!primary) return err('lakehouse not found', 404, 'not_found');

    // Resolve the primary LOOM ADLS account once (may be unset pre-provision).
    let primaryAccount: string | null = null;
    try { primaryAccount = getAccountName(); } catch { primaryAccount = null; }

    const all = await listWorkspaceLakehouses(primary.workspaceId);
    const byId = new Map(all.map((l) => [l.id, l] as const));

    const refIds = (primary.state as LakehouseState | undefined)?.referencedLakehouseIds ?? [];

    const references = [];
    for (const refId of refIds) {
      const ref = byId.get(refId);
      if (!ref) continue; // referenced lakehouse was deleted — skip silently
      const account = (ref.state as LakehouseState | undefined)?.storageAccount || primaryAccount || '';
      const containers = ownedContainersOf(ref);
      // Pass-through RBAC probe: which containers the UAMI can actually reach.
      let reachable = false;
      if (account) {
        for (const c of containers) {
          // eslint-disable-next-line no-await-in-loop
          if (await containerExistsOn(account, c)) { reachable = true; break; }
        }
      }
      references.push({
        id: ref.id,
        displayName: ref.displayName,
        account,
        containers,
        reachable,
      });
    }

    const primaryContainers = ownedContainersOf(primary);
    const workspaceLakehouses = all
      .filter((l) => l.id !== primary.id)
      .map((l) => ({ id: l.id, displayName: l.displayName }));

    return NextResponse.json({
      ok: true,
      primary: { id: primary.id, displayName: primary.displayName, account: primaryAccount || '', containers: primaryContainers },
      references,
      workspaceLakehouses,
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500, 'cosmos_error');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthorized');

  let body: any;
  try { body = await req.json(); } catch { return err('invalid JSON', 400, 'bad_json'); }
  const { lakehouseId, addId, removeId } = body || {};
  if (!lakehouseId || typeof lakehouseId !== 'string') return err('lakehouseId is required', 400, 'missing_lakehouseId');
  if (!addId && !removeId) return err('addId or removeId is required', 400, 'missing_op');
  if (addId && addId === lakehouseId) return err('a lakehouse cannot reference itself', 400, 'self_reference');

  try {
    const primary = await loadLakehouse(lakehouseId, session.claims.oid);
    if (!primary) return err('lakehouse not found', 404, 'not_found');

    // Guard against reference-injection: addId must be a real lakehouse in the
    // SAME workspace (single-partition lookup, no cross-tenant reach).
    if (addId) {
      const siblings = await listWorkspaceLakehouses(primary.workspaceId);
      if (!siblings.some((l) => l.id === addId)) {
        return err('addId is not a lakehouse in this workspace', 400, 'invalid_reference');
      }
    }

    const state = (primary.state as LakehouseState | undefined) ?? {};
    const current = Array.isArray(state.referencedLakehouseIds) ? state.referencedLakehouseIds : [];
    let updated = current;
    if (addId) updated = current.includes(addId) ? current : [...current, addId];
    if (removeId) updated = current.filter((x) => x !== removeId);

    const items = await itemsContainer();
    const next: WorkspaceItem = {
      ...primary,
      state: { ...state, referencedLakehouseIds: updated },
      updatedAt: new Date().toISOString(),
    };
    await items.item(primary.id, primary.workspaceId).replace<WorkspaceItem>(next);

    return NextResponse.json({ ok: true, referencedLakehouseIds: updated });
  } catch (e: any) {
    return err(e?.message || String(e), 500, 'cosmos_error');
  }
}
