/**
 * GET  /api/items/activator/[id]/rules?workspaceId=...
 * POST /api/items/activator/[id]/rules?workspaceId=...  body { name, condition?, action? }
 * POST /api/items/activator/[id]/rules?workspaceId=&trigger=<ruleId>   — triggers rule run
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listRules, addRule, triggerRule, ActivatorError } from '@/lib/azure/activator-client';
import { loadContentBackedItem, activatorRuleFromContent } from '../../../_lib/ai-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bundle fallback: project the installed activator item's state.content.rule
 * (condition / window / action) into the editor's rule-list shape so the rule
 * renders FULLY BUILT-OUT before a live Fabric trigger exists. Returns a
 * single-element array or null when this item has no such content.
 */
async function bundleRules(id: string, tenantId: string) {
  const item = await loadContentBackedItem(id, 'activator', tenantId);
  if (!item) return null;
  const rule = activatorRuleFromContent(item);
  return rule ? [rule] : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const { id } = await ctx.params;
  try {
    const rules = await listRules(workspaceId, id);
    // No live triggers yet on this reflex — surface the bundle rule when this
    // is a bundle-installed activator item, so the editor isn't empty.
    if (!rules || rules.length === 0) {
      const fb = await bundleRules(id, session.claims.oid);
      if (fb) return NextResponse.json({ ok: true, rules: fb, source: 'bundle' });
    }
    return NextResponse.json({ ok: true, rules });
  } catch (e: any) {
    // Fabric Activator not reachable — fall back to the bundle rule rather than
    // failing the whole rules panel, when this item carries one.
    const fb = await bundleRules(id, session.claims.oid);
    if (fb) return NextResponse.json({ ok: true, rules: fb, source: 'bundle', fabricError: e?.message || String(e) });
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
