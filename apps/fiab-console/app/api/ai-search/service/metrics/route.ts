/**
 * Azure AI Search service Monitor metrics (AIF-17).
 *
 *   GET /api/ai-search/service/metrics?timespan=PT6H&interval=PT15M
 *     → { ok, metrics:[{ name, unit, points:[{timeStamp,value}] }] }
 *
 * QPS (SearchQueriesPerSecond), latency (SearchLatency), and throttling
 * (ThrottledSearchQueriesPercentage) from Azure Monitor for the configured
 * search service. Honest 503 when ARM env is unset; 502 with the Monitor error
 * (e.g. the UAMI lacks Monitoring Reader) otherwise. Real Monitor REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryServiceMetrics, SearchAdminError } from '@/lib/azure/aisearch-admin';
import { readSearchConfig, SearchNotConfiguredError } from '@/lib/azure/aisearch-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const timespan = req.nextUrl.searchParams.get('timespan') || 'PT6H';
  const interval = req.nextUrl.searchParams.get('interval') || 'PT15M';
  try {
    const cfg = readSearchConfig();
    const metrics = await queryServiceMetrics({ timespan, interval }, cfg);
    return NextResponse.json({ ok: true, metrics });
  } catch (e: any) {
    if (e instanceof SearchNotConfiguredError) {
      return NextResponse.json({
        ok: false, code: 'not_configured', error: e.message, missing: e.missing,
        hint: `Set ${e.missing.join(', ')} on the Console Container App.`,
      }, { status: 503 });
    }
    const status = e instanceof SearchAdminError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
