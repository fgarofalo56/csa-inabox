/**
 * AI Foundry Compute Instances — read live status of a single instance.
 *
 *   GET /api/foundry/computes/{id}/status
 *     → 200 { ok:true, data: FoundryCompute }  (data.state = live CI state)
 *     → 404 { ok:false } when the instance does not exist
 *     → 403 { ok:false, roleGate:true, ... }   when the operator role is missing
 *     → 401 unauthenticated
 *
 * Synchronous ARM GET (lib/azure/foundry-client.getCompute → GET
 * .../computes/{name}?api-version=2024-10-01). `data.state` is the live
 * ComputeInstance state — Stopped | Starting | Running | Stopping |
 * Restarting | Deleting — which the UI polls after a start until Running.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCompute, FoundryError } from '@/lib/azure/foundry-client';
import { computeRoleGate } from '@/lib/azure/foundry-compute-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const name = (id || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'compute name required' }, { status: 400 });

  try {
    const compute = await getCompute(name);
    if (!compute) {
      return NextResponse.json({ ok: false, error: `compute instance "${name}" not found` }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: compute });
  } catch (e: any) {
    if (e instanceof FoundryError && e.status === 403) {
      return NextResponse.json(computeRoleGate('read compute instance status'), { status: 403 });
    }
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
