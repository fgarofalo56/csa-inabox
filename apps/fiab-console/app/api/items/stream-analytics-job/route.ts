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
import { listJobs, AsaNotConfiguredError } from '@/lib/azure/stream-analytics-client';
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
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different from LOOM_SUBSCRIPTION_ID). ' +
  'Grant the Loom Console UAMI the "Stream Analytics Contributor" role on the RG.';

export const GET = withSession(async () => {
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
      { ok: false, error: e?.message || String(e), jobs: [] },
      { status: 502 },
    );
  }
});
