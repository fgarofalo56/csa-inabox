/**
 * B-N19d — GET/PATCH/DELETE /api/insights/digests/[id].
 *
 * GET    — one digest + its recent run history (scheduled deliveries written by
 *          the C5 report-subscriptions Function AND console previews, in one list).
 * PATCH  — update the definition (same closed-value validation as create).
 * DELETE — remove the definition (the append-only run log is retained).
 *
 * Real backend: Cosmos `insight-digests` / `insight-digest-log`. No Fabric.
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiNotFound, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { deliveryGateBlock } from '@/lib/insights/digest-gate';
import {
  getDigest, upsertDigest, deleteDigest, listDigestRuns, digestResourceTypes, buildMetricPlan,
} from '@/lib/insights/digest-store';
import { validateDigestInput } from '@/lib/insights/digest-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req: NextRequest, { session, params }) => {
  const id = String(params.id || '');
  try {
    const digest = await getDigest(session.claims.oid, id);
    if (!digest) return apiNotFound('digest not found');
    const runs = await listDigestRuns(id, 20);
    return apiOk({ digest, runs, deliveryGate: deliveryGateBlock() });
  } catch (e) {
    return apiServerError(e, 'Failed to load the insight digest', 'insight_digest_load_failed');
  }
});

export const PATCH = withSession(async (req: NextRequest, { session, params }) => {
  const id = String(params.id || '');
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError('a JSON body is required', 400, { code: 'bad_body' });
  }

  try {
    const tenantId = session.claims.oid;
    const existing = await getDigest(tenantId, id);
    if (!existing) return apiNotFound('digest not found');

    const merged = {
      name: body.name ?? existing.name,
      description: body.description ?? existing.description,
      cron: body.cron ?? existing.cron,
      enabled: body.enabled ?? existing.enabled,
      lookbackHours: body.lookbackHours ?? existing.lookbackHours,
      resourceTypes: body.resourceTypes ?? existing.resourceTypes,
      includeAlerts: body.includeAlerts ?? existing.includeAlerts,
      anomalyThresholdPct: body.anomalyThresholdPct ?? existing.anomalyThresholdPct,
      recipients: body.recipients ?? existing.recipients,
      narration: body.narration ?? existing.narration,
    };
    const v = validateDigestInput(merged, digestResourceTypes());
    if (!v.ok) return apiError(v.errors.join('; '), 400, { code: 'invalid_digest', errors: v.errors });

    const saved = await upsertDigest({
      ...existing,
      ...v.value,
      metricPlan: buildMetricPlan(v.value.resourceTypes),
      updatedAt: new Date().toISOString(),
    });
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.oid,
      action: 'insights.digest.update',
      targetType: 'insight-digest',
      targetId: id,
      outcome: 'success',
      tenantId,
      detail: { name: saved.name, enabled: saved.enabled, cron: saved.cron },
    });
    return apiOk({ digest: saved, deliveryGate: deliveryGateBlock() });
  } catch (e) {
    return apiServerError(e, 'Failed to update the insight digest', 'insight_digest_update_failed');
  }
});

export const DELETE = withSession(async (_req: NextRequest, { session, params }) => {
  const id = String(params.id || '');
  try {
    const tenantId = session.claims.oid;
    const existing = await getDigest(tenantId, id);
    if (!existing) return apiNotFound('digest not found');
    const removed = await deleteDigest(tenantId, id);
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.oid,
      action: 'insights.digest.delete',
      targetType: 'insight-digest',
      targetId: id,
      outcome: removed ? 'success' : 'failure',
      tenantId,
      detail: { name: existing.name },
    });
    return apiOk({ deleted: removed });
  } catch (e) {
    return apiServerError(e, 'Failed to delete the insight digest', 'insight_digest_delete_failed');
  }
});
