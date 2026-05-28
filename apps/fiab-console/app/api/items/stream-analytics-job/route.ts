/**
 * GET /api/items/stream-analytics-job
 *   List Azure Stream Analytics jobs in the configured RG (LOOM_ASA_RG /
 *   LOOM_ASA_SUB). Returns { ok: true, jobs: AsaJobSummary[] } on success.
 *
 * Honest gating: if ASA is not configured we return ok=false + hint that
 * names the bicep module + env vars the operator needs. The editor renders
 * that as a Fluent MessageBar — no mock arrays.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listJobs, AsaNotConfiguredError } from '@/lib/azure/stream-analytics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different from LOOM_SUBSCRIPTION_ID). ' +
  'Grant the Loom Console UAMI the "Stream Analytics Contributor" role on the RG.';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const jobs = await listJobs();
    return NextResponse.json({ ok: true, jobs });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: e.message, hint: HINT, jobs: [] },
        { status: 501 },
      );
    }
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: HINT, jobs: [] },
      { status: 502 },
    );
  }
}
