/**
 * Lakehouse shortcut item — the Azure-native equivalent of a OneLake shortcut.
 *
 * A shortcut is a NAMED POINTER to external Delta/Parquet that a lakehouse reads
 * IN PLACE without copying. The pointer (name + target ADLS container/path,
 * resolved to an abfss:// location) persists as a Cosmos workspace item; the
 * LIVE backend is ADLS Gen2 (reused via adls-client). Create + Verify list the
 * target path with the real ADLS client to prove the pointer resolves WITHOUT
 * moving a byte. No Microsoft Fabric / OneLake dependency (no-fabric-dependency).
 *
 *   GET    /api/items/lakehouse-shortcut?workspaceId=…          → { ok, shortcuts }
 *   POST   /api/items/lakehouse-shortcut?workspaceId=…  { displayName, container, path }
 *   POST   /api/items/lakehouse-shortcut?workspaceId=…  { action:'verify', container, path }
 *   DELETE /api/items/lakehouse-shortcut?workspaceId=…&id=…     → delete the pointer
 *
 * Honest gate: if no ADLS account is configured the Verify/Create resolution
 * step returns a precise message naming the missing LOOM_*_URL container envs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  getAccountName, hasConfiguredContainers, listPaths, pathToHttpsUrl,
} from '@/lib/azure/adls-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

/** Sovereign-cloud-correct abfss:// location derived from the https DFS URL
 *  (host suffix comes from the configured container URL — no hard-coded domain). */
function abfssFromHttps(httpsUrl: string, container: string, path: string): string {
  const m = httpsUrl.match(/^https:\/\/([^/]+)/i);
  const dfsHost = m?.[1] || `${getAccountName()}.dfs.core.windows.net`;
  const clean = path.replace(/^\/+|\/+$/g, '');
  return `abfss://${container}@${dfsHost}/${clean}`;
}

/** Resolve a target by listing it via the real ADLS client (no copy). */
async function resolveTarget(container: string, path: string) {
  if (!hasConfiguredContainers()) {
    return {
      resolved: false as const,
      reason: 'No ADLS Gen2 data lake is configured. Set LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL (the DLZ medallion containers) so shortcuts can resolve external paths.',
    };
  }
  const account = getAccountName();
  const entries = await listPaths(container, path, 50);
  const httpsUrl = pathToHttpsUrl(container, path);
  return {
    resolved: true as const,
    account,
    abfss: abfssFromHttps(httpsUrl, container, path),
    httpsUrl,
    entryCount: entries.length,
    sample: entries.slice(0, 10).map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size })),
  };
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'lakehouse-shortcut' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId, adlsConfigured: hasConfiguredContainers(),
      shortcuts: resources.map((r) => ({
        id: r.id, displayName: r.displayName,
        container: (r.state as any)?.container, path: (r.state as any)?.path,
        abfss: (r.state as any)?.abfss, httpsUrl: (r.state as any)?.httpsUrl,
        lastVerifiedAt: (r.state as any)?.lastVerifiedAt, entryCount: (r.state as any)?.entryCount,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
    });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const container = String(body?.container || '').trim();
  const path = String(body?.path || '').trim();
  if (!container) return err('container required', 400);

  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);

    // Verify-only: resolve the target without persisting a pointer.
    if (body?.action === 'verify') {
      const r = await resolveTarget(container, path);
      if (!r.resolved) return NextResponse.json({ ok: true, resolved: false, reason: r.reason });
      return NextResponse.json({ ok: true, ...r });
    }

    const displayName = String(body?.displayName || '').trim();
    if (!displayName) return err('displayName required', 400);
    // Resolve the target as part of create so we never persist a dangling pointer.
    const r = await resolveTarget(container, path);
    if (!r.resolved) {
      return NextResponse.json({ ok: false, error: r.reason, code: 'not_configured' }, { status: 503 });
    }
    const items = await itemsContainer();
    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'lakehouse-shortcut',
      displayName, description: body?.description,
      state: {
        container, path,
        abfss: r.abfss, httpsUrl: r.httpsUrl,
        account: r.account, entryCount: r.entryCount, lastVerifiedAt: now,
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const { resource } = await items.items.create(item);
    return NextResponse.json({ ok: true, shortcut: resource, resolution: r });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const id = req.nextUrl.searchParams.get('id');
  if (!workspaceId || !id) return err('workspaceId and id required', 400);
  try {
    const items = await itemsContainer();
    await items.item(id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return err(e?.message || String(e), 500);
  }
}
