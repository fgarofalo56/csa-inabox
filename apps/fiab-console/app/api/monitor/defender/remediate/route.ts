/**
 * POST /api/monitor/defender/remediate — "Fix via Loom" for a Defender for
 * Cloud recommendation. Triggers a REAL Azure Policy remediation task when the
 * recommendation is policy-backed; otherwise returns an honest gate so the UI
 * shows the Portal steps + PowerShell instead.
 *
 * Body: { policyDefinitionId?, resourceId?, name? }
 * Shape: { ok, ...RemediateResult } | { ok:false, gate } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { remediateRecommendation } from '@/lib/azure/defender-client';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const result = await remediateRecommendation({
      policyDefinitionId: body?.policyDefinitionId ? String(body.policyDefinitionId) : undefined,
      resourceId: body?.resourceId ? String(body.resourceId) : undefined,
      name: body?.name ? String(body.name) : undefined,
    });
    if (!result.ok && result.gate) {
      return NextResponse.json({ ok: false, gate: { message: result.message } });
    }
    return NextResponse.json({ ...result });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Resource Policy Contributor'],
          message:
            'The Console UAMI cannot create Azure Policy remediations. Grant it "Resource Policy Contributor" on the subscription to enable one-click Fix via Loom (the Portal steps + PowerShell still work).',
        },
      });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
