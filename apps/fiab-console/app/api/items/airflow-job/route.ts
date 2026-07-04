/**
 * Airflow Job list + create.
 *
 * Cosmos-backed in v3 — every Loom Airflow item stores the Airflow webserver
 * URL the tenant configured (or null if not configured yet, in which case
 * the editor surfaces the documented MessageBar gate).
 *
 * Live DAG / Run data is fetched from the configured webserver via the
 * [id]/dags route. Preview-tagged because the Fabric REST surface
 * (ApacheAirflowJob) is still evolving.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return apiError('workspace not found', 404);
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'airflow-job' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      jobs: resources.map(r => ({
        id: r.id, displayName: r.displayName, description: r.description,
        webserverUrl: (r.state as any)?.webserverUrl || null,
        gitRepo: (r.state as any)?.gitRepo || null,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
    });
  } catch (e: any) { return apiServerError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return apiError('displayName required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return apiError('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'airflow-job',
      displayName, description: body?.description,
      state: {
        webserverUrl: body?.webserverUrl || null,
        gitRepo: body?.gitRepo || null,
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const { resource } = await items.items.create(item);
    return NextResponse.json({ ok: true, job: resource });
  } catch (e: any) { return apiServerError(e); }
}
