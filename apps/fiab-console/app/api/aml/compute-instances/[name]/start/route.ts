/**
 * POST /api/aml/compute-instances/[name]/start
 *
 * Starts a stopped Azure ML Compute Instance so the notebook can run on it.
 * Real ARM:
 *   POST .../workspaces/{ws}/computes/{name}/start?api-version=2024-10-01  → 202
 * Then probes the CI once so the caller gets the post-start state.
 *
 * Used by the editor's "Start compute" button AND the debounced auto-start that
 * kicks a Stopped CI when it's selected. Azure-native — no Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { startCI, getCI, amlIsConfigured, AmlNotConfiguredError, AmlError } from '@/lib/azure/aml-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const name = decodeURIComponent((await ctx.params).name);
  if (!name) return NextResponse.json({ ok: false, error: 'compute instance name required' }, { status: 400 });

  if (!amlIsConfigured()) {
    const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
    return NextResponse.json({ ok: false, configured: false, error: 'Azure ML workspace not configured', hint: err.hint }, { status: 200 });
  }

  try {
    await startCI(name);
    // Best-effort state probe — the start is async (202), so this typically
    // reports 'Starting'. The editor polls /compute-instances afterwards.
    let state: string | undefined;
    try { state = (await getCI(name))?.state; } catch { /* probe non-fatal */ }
    return NextResponse.json({ ok: true, name, state: state || 'Starting' });
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) {
      return NextResponse.json({ ok: false, configured: false, error: e.message, hint: e.hint }, { status: 200 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
