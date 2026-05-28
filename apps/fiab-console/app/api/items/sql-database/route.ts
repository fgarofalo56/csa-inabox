/**
 * Fabric SQL Database list + create.
 *
 * Calls Fabric REST /v1/workspaces/{ws}/SqlDatabases. Loom maps the user's
 * "Loom workspace" 1:1 to a Fabric workspace by the workspace.capacity
 * pointer; the Cosmos record stores the Fabric workspace id under
 * workspace.capacity.fabricWorkspaceId.
 *
 * For the create wizard the editor posts displayName + optional definition;
 * Fabric creates an empty SQL DB and Loom returns the long-running
 * acceptance pointer so the editor can poll.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  listFabricSqlDatabases, createFabricSqlDatabase,
} from '@/lib/azure/fabric-client';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

function fabricWsIdOf(ws: Workspace | null): string | null {
  if (!ws) return null;
  const cap: any = (ws as any).capacity;
  return cap?.fabricWorkspaceId || cap?.id || null;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const fabricWs = fabricWsIdOf(ws);
    if (!fabricWs) {
      return err(
        'Fabric workspace not attached to this Loom workspace',
        503,
        {
          code: 'NO_FABRIC_WS',
          hint: 'Attach a Fabric capacity + workspace under Workspace settings → Capacity. Until then the SQL database list is empty.',
        },
      );
    }
    const value = await listFabricSqlDatabases(fabricWs);
    return NextResponse.json({
      ok: true, workspaceId, fabricWorkspaceId: fabricWs,
      sqlDatabases: value.map(v => ({
        id: v.id, displayName: v.displayName, description: v.description, type: v.type,
      })),
    });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 500, e?.hint ? { hint: e.hint } : undefined);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return err('displayName required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const fabricWs = fabricWsIdOf(ws);
    if (!fabricWs) {
      return err('Fabric workspace not attached', 503, { code: 'NO_FABRIC_WS' });
    }
    const created = await createFabricSqlDatabase(fabricWs, {
      displayName,
      description: body?.description,
      definition: body?.definition,
    });
    return NextResponse.json({ ok: true, sqlDatabase: created });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 500, e?.hint ? { hint: e.hint } : undefined);
  }
}
