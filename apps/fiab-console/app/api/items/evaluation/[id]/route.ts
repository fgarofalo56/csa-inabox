/**
 * GET /api/items/evaluation/[id]?project=<name>&results=1 — fetch evaluation,
 * optionally with results table.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getEvaluation, getEvaluationResults, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';
import { loadContentBackedItem, evaluationFromContent } from '../../_lib/ai-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fall back to the bundle's EvaluationContent (metric definitions + dataset
 * ref) stamped on the Cosmos item, so a bundle-installed evaluation opens
 * FULLY BUILT-OUT before any live AI Foundry run exists. Returns the
 * editor-shaped { evaluation, results:null } or null when this item has no
 * such content (then the caller surfaces the real error).
 */
async function evaluationContentFallback(id: string, tenantId: string) {
  const item = await loadContentBackedItem(id, 'evaluation', tenantId);
  if (!item) return null;
  const built = evaluationFromContent(item);
  return built ? { evaluation: built.evaluation, results: built.results, source: 'bundle' } : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  const wantResults = req.nextUrl.searchParams.get('results') === '1';
  const { id } = await ctx.params;
  // No Foundry project bound yet — the live data-plane is unreachable, but a
  // bundle-installed evaluation can still open from its stamped content.
  if (!project) {
    const fb = await evaluationContentFallback(id, session.claims.oid);
    if (fb) return NextResponse.json({ ok: true, ...fb });
    return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  }
  try {
    const evaluation = await getEvaluation(project, id);
    if (!evaluation) {
      const fb = await evaluationContentFallback(id, session.claims.oid);
      if (fb) return NextResponse.json({ ok: true, ...fb });
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    let results: any = null;
    if (wantResults) {
      try { results = await getEvaluationResults(project, id); } catch { results = null; }
    }
    return NextResponse.json({ ok: true, evaluation, results });
  } catch (e: any) {
    // Foundry not provisioned (or transient data-plane error): surface the
    // bundle definition rather than an empty editor, when available.
    const fb = await evaluationContentFallback(id, session.claims.oid);
    if (fb) return NextResponse.json({ ok: true, ...fb });
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
