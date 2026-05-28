/**
 * POST /api/items/airflow-job/[id]/connection?workspaceId=...
 *   body: { webserverUrl: string, gitRepo?: string }
 *
 * Persists the tenant-supplied Airflow webserver URL so the DAGs tab can
 * call the live `/api/v1/dags` endpoint. The actual token-acquisition path
 * (AAD app role or PAT) is documented in docs/fiab/v3-tenant-bootstrap.md
 * and the editor MessageBar links to it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const webserverUrl = String(body?.webserverUrl || '').trim();
  if (!webserverUrl) return err('webserverUrl required', 400);
  try {
    const parsed = new URL(webserverUrl);
    if (!/^https?:$/.test(parsed.protocol)) return err('webserverUrl must be http(s)', 400);
  } catch {
    return err('webserverUrl is not a valid URL', 400);
  }
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'airflow-job') return err('airflow job not found', 404);
    const next: WorkspaceItem = {
      ...existing,
      state: {
        ...(existing.state || {}),
        webserverUrl,
        gitRepo: body?.gitRepo ?? (existing.state as any)?.gitRepo ?? null,
      },
      updatedAt: new Date().toISOString(),
    };
    await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({ ok: true, webserverUrl, gitRepo: (next.state as any)?.gitRepo ?? null });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
