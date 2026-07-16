/**
 * GET /api/monitor/defender — Microsoft Defender for Cloud summary (Monitor
 * Security tab): secure score, recommendations (action-required, with
 * remediation), and active security alerts for the Loom subscription.
 *
 * Shape: { ok, data: DefenderSummary } | { ok:false, gate } | { ok:false, error }
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildScopedCacheKey, getOrComputeCached } from '@/lib/azure/query-result-cache';
import { getDefenderSummary } from '@/lib/azure/defender-client';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    // Cached 10 min + SWR: Defender posture is a slow cross-sub read.
    const { value: data } = await getOrComputeCached(
      buildScopedCacheKey('monitor/defender', {}),
      'monitor',
      () => getDefenderSummary(),
      { ttlMs: 10 * 60_000, staleWhileRevalidate: true, budgetMs: 45_000, serveStaleOnError: true },
    );
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Security Reader'],
          message:
            'The Console UAMI cannot read Microsoft Defender for Cloud. Grant it "Security Reader" on the subscription so this tab can show secure score, recommendations, and security alerts.',
        },
      });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
