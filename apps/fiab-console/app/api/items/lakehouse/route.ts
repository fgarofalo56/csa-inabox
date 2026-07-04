/**
 * GET /api/items/lakehouse?workspaceId=<uuid>
 *   List all lakehouses in a workspace. Returns shape compatible with
 *   what notebook-editor.tsx's loadLakehouses() expects:
 *     { ok: true, items: LakehouseLite[] }
 *
 * The notebook editor's "Add data items > Attach lakehouse" modal calls
 * this endpoint. Previously the route did not exist (404 HTML) so the
 * editor always showed "No lakehouses found in the workspace" even when
 * lakehouses existed in the Cosmos items container.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const workspaceId = req.nextUrl?.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId is required', 400, 'missing_workspaceId');

  try {
    // Tenant-scope check — workspace must belong to this caller's tenant.
    const ws = await workspacesContainer();
    const { resources: workspaces } = await ws.items
      .query<Workspace>({
        query: 'SELECT * FROM c WHERE c.id = @id AND c.tenantId = @t',
        parameters: [
          { name: '@id', value: workspaceId },
          { name: '@t', value: session.claims.oid },
        ],
      }, { partitionKey: session.claims.oid })
      .fetchAll();
    if (workspaces.length === 0) {
      return err('Workspace not found or not in tenant', 404, 'workspace_not_found');
    }

    const items = await itemsContainer();
    const { resources } = await items.items
      .query({
        query: 'SELECT c.id, c.displayName, c.description, c.workspaceId, c.createdAt, c.updatedAt FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.createdAt DESC',
        parameters: [
          { name: '@w', value: workspaceId },
          { name: '@t', value: 'lakehouse' },
        ],
      }, { partitionKey: workspaceId })
      .fetchAll();

    return NextResponse.json({
      ok: true,
      items: resources,
      // Back-compat alias — older editor versions read `lakehouses`.
      lakehouses: resources,
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500, 'cosmos_error');
  }
}
