/**
 * POST /api/aml/compute-instances/[name]/idle-shutdown
 *
 * Updates a Compute Instance's idle-shutdown TTL (auto-stop after N idle time),
 * so a CI left idle deallocates itself instead of billing indefinitely. Real
 * ARM:
 *   POST .../workspaces/{ws}/computes/{name}/updateIdleShutdownSetting
 *        ?api-version=2021-07-01   body { idleTimeBeforeShutdown: "PT30M" }
 *
 * Body: { idleTtl: "PT15M" | "PT30M" | "PT1H" | "PT3H" } (ISO-8601 duration).
 * Mirrors the sibling start/stop routes: session-gate, amlIsConfigured()
 * honest-200, and a 403 → "AzureML Compute Operator" honest gate. Azure-native
 * — no Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { updateCiIdleShutdown, amlIsConfigured, AmlNotConfiguredError, AmlError } from '@/lib/azure/aml-client';
import { computeRoleGate } from '@/lib/azure/foundry-compute-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ISO-8601 idle-TTL durations the UI offers (dropdown only — no freeform). */
const ALLOWED_TTL = new Set(['PT15M', 'PT30M', 'PT1H', 'PT2H', 'PT3H', 'PT4H']);

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const name = decodeURIComponent((await ctx.params).name);
  if (!name) return NextResponse.json({ ok: false, error: 'compute instance name required' }, { status: 400 });

  const body = await req.json().catch(() => ({} as any));
  const idleTtl = String(body?.idleTtl || '').trim();
  if (!idleTtl || !ALLOWED_TTL.has(idleTtl)) {
    return NextResponse.json(
      { ok: false, error: `idleTtl must be one of ${[...ALLOWED_TTL].join(', ')}` },
      { status: 400 },
    );
  }

  if (!amlIsConfigured()) {
    const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
    return NextResponse.json({ ok: false, configured: false, error: 'Azure ML workspace not configured', hint: err.hint }, { status: 200 });
  }

  try {
    await updateCiIdleShutdown(name, idleTtl);
    return NextResponse.json({ ok: true, name, idleTimeBeforeShutdown: idleTtl });
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) {
      return NextResponse.json({ ok: false, configured: false, error: e.message, hint: e.hint }, { status: 200 });
    }
    if (e instanceof AmlError && e.status === 403) {
      return NextResponse.json(computeRoleGate('update compute idle-shutdown'), { status: 403 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
