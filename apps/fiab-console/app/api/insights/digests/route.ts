/**
 * B-N19d — GET/POST /api/insights/digests.
 *
 * Scheduled insight digests: metric + monitor deltas narrated by Copilot and
 * DELIVERED by the existing C5 report-subscriptions timer Function (the same
 * tick, the same delivery Logic App — no second scheduler exists).
 *
 * GET  — the tenant's digests + the sampled-resource-type option set + the live
 *        delivery-gate status (`svc-report-subscriptions`), so the pane can
 *        render an honest Fix-it banner while still saving definitions.
 * POST — create a digest. The body is validated against the closed value set in
 *        digest-model (no free-form config), then persisted to Cosmos.
 *
 * Real backend: Cosmos `insight-digests`. Azure-native, no Fabric.
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { deliveryGateBlock } from '@/lib/insights/digest-gate';
import { listDigests, upsertDigest, digestResourceTypes, buildMetricPlan } from '@/lib/insights/digest-store';
import { validateDigestInput, type InsightDigestDoc } from '@/lib/insights/digest-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req: NextRequest, { session }) => {
  try {
    const tenantId = session.claims.oid;
    const digests = await listDigests(tenantId);
    return apiOk({
      digests,
      resourceTypeOptions: digestResourceTypes(),
      deliveryGate: deliveryGateBlock(),
    });
  } catch (e) {
    return apiServerError(e, 'Failed to list insight digests', 'insight_digests_list_failed');
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError('a JSON body is required', 400, { code: 'bad_body' });
  }

  const v = validateDigestInput(body, digestResourceTypes());
  if (!v.ok) return apiError(v.errors.join('; '), 400, { code: 'invalid_digest', errors: v.errors });

  const now = new Date().toISOString();
  const tenantId = session.claims.oid;
  const doc: InsightDigestDoc = {
    id: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tenantId,
    ...v.value,
    // Resolved here so the C5 Function executes a plan instead of carrying a
    // second copy of METRIC_CATALOG.
    metricPlan: buildMetricPlan(v.value.resourceTypes),
    createdBy: tenantId,
    createdByName: session.claims.name || session.claims.upn || undefined,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const saved = await upsertDigest(doc);
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.oid,
      action: 'insights.digest.create',
      targetType: 'insight-digest',
      targetId: saved.id,
      outcome: 'success',
      tenantId,
      detail: { name: saved.name, cron: saved.cron, recipients: saved.recipients.length },
    });
    return apiOk({ digest: saved, deliveryGate: deliveryGateBlock() }, { status: 201 });
  } catch (e) {
    return apiServerError(e, 'Failed to create the insight digest', 'insight_digest_create_failed');
  }
});
