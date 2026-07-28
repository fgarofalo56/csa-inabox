/**
 * B-N19d — POST /api/insights/digests/[id]/preview.
 *
 * Runs the digest FOR REAL against Azure Monitor (platform metrics over the
 * current window vs the immediately preceding window + fired alert instances)
 * and narrates it on the Loom Azure OpenAI deployment — then returns the
 * observation, narration, and the exact HTML body the C5 report-subscriptions
 * Function would deliver. NOTHING is emailed: preview is compute-only, so an
 * operator can see real output before the first scheduled tick.
 *
 * The run is appended to `insight-digest-log` with `preview: true` so the
 * history pane distinguishes previews from deliveries.
 *
 * Honest gate: when Azure Monitor is not configured the route returns the same
 * `{ ok:false, gate:{ missing, message } }` shape every other Monitor-backed
 * surface uses (503) rather than an empty, fake-looking digest. The DELIVERY
 * gate (`svc-report-subscriptions`) rides every response as `deliveryGate`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiNotFound, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { MonitorNotConfiguredError } from '@/lib/azure/monitor-client';
import { deliveryGateBlock } from '@/lib/insights/digest-gate';
import { getDigest, runDigest, recordDigestRun } from '@/lib/insights/digest-store';
import type { InsightDigestRun } from '@/lib/insights/digest-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (_req: NextRequest, { session, params }) => {
  const id = String(params.id || '');
  const tenantId = session.claims.oid;

  try {
    const digest = await getDigest(tenantId, id);
    if (!digest) return apiNotFound('digest not found');

    // Kill-switch: OFF reverts previews to "wait for the scheduled tick".
    if (!(await runtimeFlag('n19d-insight-digests'))) {
      return apiOk({
        disabled: true,
        message: 'Insight-digest previews are switched off by the n19d-insight-digests runtime flag. Scheduled deliveries are unaffected.',
      });
    }

    const result = await runDigest(digest);
    const run: InsightDigestRun = {
      id: `digestrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      digestId: id,
      tenantId,
      ranAt: new Date().toISOString(),
      status: 'succeeded',
      windowStart: result.observation.windowStart,
      windowEnd: result.observation.windowEnd,
      narration: result.narration,
      deltaCount: result.observation.deltas.length,
      anomalyCount: result.observation.deltas.filter((d) => d.anomaly).length,
      alertCount: result.observation.alerts.length,
      preview: true,
    };
    await recordDigestRun(run);

    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.oid,
      action: 'insights.digest.preview',
      targetType: 'insight-digest',
      targetId: id,
      outcome: 'success',
      tenantId,
      detail: {
        deltas: run.deltaCount,
        anomalies: run.anomalyCount,
        alerts: run.alertCount,
        copilot: result.narratedByCopilot,
      },
    });

    return apiOk({
      run,
      observation: result.observation,
      narration: result.narration,
      narratedByCopilot: result.narratedByCopilot,
      narrationNote: result.narrationNote,
      html: result.html,
      resourcesSampled: result.resourcesSampled,
      deliveryGate: deliveryGateBlock(),
    });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'monitor_not_configured',
          missing: e.missing,
          gate: {
            missing: e.missing,
            message:
              'Azure Monitor is not configured in this deployment, so metric deltas cannot be sampled. Set LOOM_SUBSCRIPTION_ID + a Loom resource group (LOOM_ADMIN_RG / LOOM_DLZ_RG) on the Console app and grant the Console UAMI "Monitoring Reader" (platform/fiab/bicep/modules/admin-plane/monitoring-reader-rbac.bicep).',
          },
          deliveryGate: deliveryGateBlock(),
        },
        { status: 503 },
      );
    }
    return apiServerError(e, 'Failed to run the digest preview', 'insight_digest_preview_failed');
  }
});
