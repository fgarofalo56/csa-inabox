/**
 * GET  /api/items/activator/[id]/rules?workspaceId=...
 * POST /api/items/activator/[id]/rules?workspaceId=...  body { name, condition?, action? }
 * POST /api/items/activator/[id]/rules?workspaceId=&trigger=<ruleId>   — triggers rule run
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listRules, addRule, triggerRule, ActivatorError } from '@/lib/azure/activator-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const rules = await listRules(workspaceId, (await ctx.params).id);
    return NextResponse.json({ ok: true, rules });
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const triggerId = req.nextUrl.searchParams.get('trigger');
  if (triggerId) {
    try {
      const out = await triggerRule(workspaceId, (await ctx.params).id, triggerId);
      return NextResponse.json(out);
    } catch (e: any) {
      const status = e instanceof ActivatorError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const rule = await addRule(workspaceId, (await ctx.params).id, {
      name,
      condition: body?.condition || undefined,
      action: body?.action || undefined,
    });
    return NextResponse.json({ ok: true, rule });
  } catch (e: any) {
    const status = e instanceof ActivatorError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
