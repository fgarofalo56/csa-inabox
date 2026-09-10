/**
 * PUT /api/items/stream-analytics-job/[name]/query
 *   Body: { query: string }
 *   Persists a new ASA query (transformation) via ARM. Real PUT, no mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { saveTransformation, AsaNotConfiguredError } from '@/lib/azure/stream-analytics-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Applies to the NOT-CONFIGURED condition only — the one case where the env
 * vars really are the remediation.
 *
 * #3573 / `deploy-integrity.md` R7: this hint used to ride the generic 502 as
 * well, so a 403, a throttle or a DNS failure on a deployment where LOOM_ASA_RG
 * was set correctly told the operator to go set LOOM_ASA_RG — a cause the code
 * had established nothing about. The 502 below now carries the ARM error and
 * nothing else.
 */
const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different).';

export const PUT = withSession<{ name: string }>(async (req: NextRequest, { params }) => {
  const name = params?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const body = await req.json().catch(() => null) as { query?: string } | null;
  if (!body || typeof body.query !== 'string') {
    return NextResponse.json({ ok: false, error: 'body must be { query: string }' }, { status: 400 });
  }
  try {
    await saveTransformation(name, body.query);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: HINT }, { status: 501 });
    }
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 502 },
    );
  }
});
