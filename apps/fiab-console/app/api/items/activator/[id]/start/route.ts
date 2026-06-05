/**
 * POST /api/items/activator/[id]/start?workspaceId=...
 *
 * Real Fabric REST. Sets every trigger on the reflex to Active.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { startReflex, ActivatorError } from '@/lib/azure/activator-client';
import { loadContentBackedItem } from '../../../_lib/ai-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const useFabric = () => process.env.LOOM_ACTIVATOR_BACKEND === 'fabric';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  // Azure-native default: Azure Monitor scheduledQueryRules are created enabled
  // and run on their schedule — "start" confirms they're active (no Fabric call).
  if (!useFabric()) {
    const item = await loadContentBackedItem(ctx.params.id, 'activator', session.claims.oid);
    const count = Array.isArray((item?.state as any)?.rules) ? (item!.state as any).rules.length : 0;
    return NextResponse.json({ ok: true, updated: count, backend: 'azure-monitor', message: `${count} Azure Monitor alert rule(s) active.` });
  }

  try {
    const r = await startReflex(workspaceId, ctx.params.id);
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
