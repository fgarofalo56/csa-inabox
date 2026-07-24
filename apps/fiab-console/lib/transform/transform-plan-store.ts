/**
 * N4 — durable plan/apply history for `transformation-project` items.
 *
 * Every plan the operator previews and every apply they authorize is written to
 * `loom-transform-plans` (PK /itemId) AND to the shared `_auditLog` trail (the
 * ATO audit standard: every privileged mutation writes an audit row).
 *
 * Server-only — imports the Cosmos clients.
 */

import { auditLogContainer, transformPlansContainer } from '@/lib/azure/cosmos-client';
import {
  buildTransformPlanDoc, transformPlanId, type TransformPlanDoc,
} from '@/lib/azure/transform-plan-model';
import type { SessionPayload } from '@/lib/auth/session';
import type { PlanImpact } from './plan-impact';
import type { TransformBackend } from './transform-project-model';

/** Bound the log we persist — enough to explain a failure, never unbounded. */
const MAX_LOG_CHARS = 4000;

function actor(session: SessionPayload): { oid: string; upn: string } {
  return {
    oid: session.claims.oid,
    upn: session.claims.upn || session.claims.oid,
  };
}

/** Record a previewed plan. Returns the persisted doc (or null when Cosmos is down). */
export async function recordPlan(
  session: SessionPayload,
  itemId: string,
  backend: TransformBackend,
  impact: PlanImpact,
): Promise<TransformPlanDoc | null> {
  const who = actor(session);
  const doc = buildTransformPlanDoc({
    itemId,
    backend,
    environment: impact.environment,
    plannedByOid: who.oid,
    plannedByUpn: who.upn,
    hasChanges: impact.hasChanges,
    summary: impact.summary,
    rows: impact.rows,
  });
  try {
    const c = await transformPlansContainer();
    await c.items.upsert(doc);
  } catch {
    // A plan is a READ-side preview: losing the history row must never fail the
    // plan itself. The audit row below is attempted independently.
    return null;
  }
  await writeAudit(session, itemId, 'transform-plan', doc.environment,
    `${who.upn} planned ${backend} against "${doc.environment}" — ${impact.summary.breaking} breaking, ${impact.summary.modified} modified, ${impact.summary.added} added, ${impact.summary.removed} removed, ${impact.summary.downstreamImpacted} downstream impacted.`);
  return doc;
}

/**
 * Record an apply against the plan it was authorized from. Writes the audit row
 * FIRST-CLASS (an apply is a privileged mutation — the audit row is not
 * best-effort in the sense of "optional"; it is attempted for every apply and a
 * failure is logged server-side).
 */
export async function recordApply(
  session: SessionPayload,
  itemId: string,
  backend: TransformBackend,
  impact: PlanImpact,
  outcome: { ok: boolean; log?: string },
): Promise<void> {
  const who = actor(session);
  const at = new Date().toISOString();
  try {
    const c = await transformPlansContainer();
    const doc = buildTransformPlanDoc({
      itemId,
      backend,
      environment: impact.environment,
      plannedByOid: who.oid,
      plannedByUpn: who.upn,
      hasChanges: impact.hasChanges,
      summary: impact.summary,
      rows: impact.rows,
      plannedAt: at,
    });
    doc.id = transformPlanId(itemId, at);
    doc.applied = {
      at,
      byOid: who.oid,
      byUpn: who.upn,
      ok: outcome.ok,
      log: (outcome.log || '').slice(0, MAX_LOG_CHARS) || undefined,
    };
    await c.items.upsert(doc);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[transform] plan-history write failed:', e);
  }
  await writeAudit(session, itemId, 'transform-apply', impact.environment,
    `${who.upn} applied a ${backend} plan to "${impact.environment}" — ${outcome.ok ? 'succeeded' : 'FAILED'} (${impact.summary.breaking} breaking, ${impact.summary.backfillIntervals} intervals backfilled).`);
}

/** The project's plan history, newest first (single-partition read). */
export async function listPlans(itemId: string, limit = 25): Promise<TransformPlanDoc[]> {
  try {
    const c = await transformPlansContainer();
    const { resources } = await c.items.query<TransformPlanDoc>({
      query: 'SELECT * FROM c WHERE c.itemId = @itemId AND c.docType = @docType ORDER BY c.plannedAt DESC OFFSET 0 LIMIT @limit',
      parameters: [
        { name: '@itemId', value: itemId },
        { name: '@docType', value: 'transform-plan' },
        { name: '@limit', value: limit },
      ],
    }, { partitionKey: itemId }).fetchAll();
    return resources || [];
  } catch {
    return [];
  }
}

async function writeAudit(
  session: SessionPayload,
  itemId: string,
  action: string,
  environment: string,
  summary: string,
): Promise<void> {
  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      itemId,
      itemType: 'transformation-project',
      action,
      summary,
      environment,
      upn: session.claims.upn || session.claims.oid,
      at: new Date().toISOString(),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[transform] audit write failed:', e);
  }
}
