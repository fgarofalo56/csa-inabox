/**
 * Reference-Lakehouse federation (F8) — READ-ONLY path listing.
 *
 * GET /api/lakehouse/references/paths?refId=<lakehouseItemId>&container=<c>&prefix=<p>
 *   → { ok, refId, account, container, prefix, paths[] }
 *
 * Lists an ADLS Gen2 path inside a REFERENCED lakehouse via pass-through RBAC
 * (the Console UAMI must hold Storage Blob Data Reader on the container). There
 * is intentionally NO PUT/POST/DELETE here — references are read-only, and the
 * absence of write handlers is the enforcement layer (a disabled-button tooltip
 * in the UI is the affordance, not the guarantee).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { KNOWN_CONTAINERS, listPaths } from '@/lib/azure/adls-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LakehouseState {
  storageAccount?: string;
  ownedContainers?: string[];
  [k: string]: unknown;
}

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthorized');

  const refId = req.nextUrl.searchParams.get('refId') || '';
  const container = req.nextUrl.searchParams.get('container') || '';
  const prefix = req.nextUrl.searchParams.get('prefix') || '';
  const maxResults = Number(req.nextUrl.searchParams.get('maxResults') || '200');

  if (!refId) return err('refId is required', 400, 'missing_refId');
  if (!container) return err('container is required', 400, 'missing_container');

  try {
    const ref = await loadLakehouse(refId, session.claims.oid);
    if (!ref) return err('referenced lakehouse not found', 404, 'not_found');

    const state = (ref.state as LakehouseState | undefined) ?? {};
    const account = state.storageAccount || undefined; // undefined → primary LOOM account
    const allowed = Array.isArray(state.ownedContainers) && state.ownedContainers.length
      ? state.ownedContainers
      : [...KNOWN_CONTAINERS];
    if (!allowed.includes(container)) {
      return err(`container not owned by referenced lakehouse: ${container}`, 404, 'unknown_container');
    }

    const paths = await listPaths(container, prefix, Math.min(maxResults, 1000), account);
    return NextResponse.json({ ok: true, refId, account: account || '', container, prefix, paths });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return err(e?.message || String(e), status, e?.code);
  }
}
