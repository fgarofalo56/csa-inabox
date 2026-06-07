/**
 * AI Foundry Compute Instances — start a stopped instance.
 *
 *   POST /api/foundry/computes/{id}/start
 *     → 202 { ok:true, data:{ name, state, provisioningState } }  (LRO accepted)
 *     → 403 { ok:false, roleGate:true, requiredRole, roleId, resource, ... }
 *     → 401 unauthenticated
 *
 * Real ARM data plane (lib/azure/foundry-client.startCompute → POST
 * .../computes/{name}/start?api-version=2024-10-01, which ARM answers 202).
 * After the accept we snapshot the live state via getCompute so the receipt
 * shows the transition (Stopped → Starting). When the Console UAMI lacks the
 * AzureML Compute Operator role, ARM returns 403 and we surface the honest
 * gate. See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { startCompute, getCompute, FoundryError } from '@/lib/azure/foundry-client';
import { computeRoleGate } from '@/lib/azure/foundry-compute-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const name = (id || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'compute name required' }, { status: 400 });

  try {
    await startCompute(name);
    // ARM accepted the LRO (202). Snapshot the live state so the receipt shows
    // the transition out of Stopped (typically → Starting). Best-effort: a
    // failed snapshot must not turn a successful start into an error.
    let snapshot: { state?: string; provisioningState?: string } = {};
    try {
      const compute = await getCompute(name);
      if (compute) snapshot = { state: compute.state, provisioningState: compute.provisioningState };
    } catch { /* snapshot is best-effort */ }
    return NextResponse.json(
      { ok: true, data: { name, state: snapshot.state ?? 'Starting', provisioningState: snapshot.provisioningState } },
      { status: 202 },
    );
  } catch (e: any) {
    if (e instanceof FoundryError && e.status === 403) {
      return NextResponse.json(computeRoleGate('start compute instances'), { status: 403 });
    }
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
