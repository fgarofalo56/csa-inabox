/**
 * GET  /api/items/activator?workspaceId=...                 — list reflexes
 * POST /api/items/activator?workspaceId=... body { displayName, description? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listActivators, createActivator, ActivatorError } from '@/lib/azure/activator-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { createOwnedItem } from '../_lib/item-crud';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per no-fabric-dependency.md the Activator defaults to the Azure-native backend
// (Cosmos item + Azure Monitor rules). Fabric Reflexes are opt-in via env.
const useFabric = () => process.env.LOOM_ACTIVATOR_BACKEND === 'fabric';

/**
 * List the Cosmos activator items installed into this workspace whose
 * state.content is an activator rule bundle. These are surfaced alongside the
 * live Fabric reflexes so a bundle-installed reflex (e.g. casino-analytics,
 * ml-pipeline) shows up FULLY BUILT-OUT — its rule renders via the /rules
 * fallback — even before a live Fabric Activator exists. Best-effort: any
 * Cosmos error yields [] so the live path is never blocked.
 */
async function listBundleActivators(workspaceId: string) {
  try {
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'activator' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return resources
      .filter((r) => (r.state as any)?.content?.kind === 'activator')
      .map((r) => ({ id: r.id, displayName: r.displayName, description: r.description, type: 'Reflex', __loomContent: true as const }));
  } catch { return []; }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // Always include bundle-installed activators (Cosmos). Merge live Fabric
  // reflexes on top when reachable; if Fabric isn't wired we still surface the
  // installed reflexes rather than failing the whole list.
  const bundle = await listBundleActivators(workspaceId);
  // Azure-native default: list the Cosmos activator items only — no Fabric call.
  if (!useFabric()) {
    return NextResponse.json({ ok: true, workspaceId, activators: bundle, backend: 'azure-monitor' });
  }
  // Fabric opt-in: merge live reflexes on top of the installed items.
  try {
    const live = await listActivators(workspaceId);
    const liveIds = new Set(live.map((a: any) => a.id));
    const merged = [...live, ...bundle.filter((b) => !liveIds.has(b.id))];
    return NextResponse.json({ ok: true, workspaceId, activators: merged, backend: 'fabric' });
  } catch (e: any) {
    if (bundle.length > 0) {
      return NextResponse.json({ ok: true, workspaceId, activators: bundle, fabricError: e?.message || String(e) });
    }
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName required' }, { status: 400 });

  // Azure-native default: create a Cosmos activator item (rules attach via the
  // /rules route → Azure Monitor). No Fabric reflex created.
  if (!useFabric()) {
    const res = await createOwnedItem(session, 'activator', {
      workspaceId, displayName,
      description: body?.description ? String(body.description) : undefined,
      state: { content: { kind: 'activator' }, rules: [] },
    });
    if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
    return NextResponse.json({ ok: true, activator: { id: res.item.id, displayName: res.item.displayName, type: 'Reflex' }, backend: 'azure-monitor' });
  }

  // Fabric opt-in.
  try {
    const activator = await createActivator(workspaceId, {
      displayName,
      description: body?.description ? String(body.description) : undefined,
    });
    return NextResponse.json({ ok: true, activator, backend: 'fabric' });
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
