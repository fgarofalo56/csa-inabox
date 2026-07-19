/**
 * Foundry-parity "checkpoints / justifications" (row 4.7) — durable record of the
 * WRITTEN REASON an operator supplies before a justification-gated ontology
 * write-back action runs. Stored in the shared Cosmos `audit-log` container
 * (partition `/itemId` = the ontology id) as `kind:'action-justification'`, so it
 * shows up in the existing admin audit surfaces AND can be listed back per
 * ontology for a review pane.
 *
 * This is the honest, non-vaporware v1: a required reason, recorded to the audit
 * chain with actor + outcome, reviewable. Azure-native (Cosmos) — no Fabric.
 */
import { auditLogContainer } from './cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';

export const ACTION_JUSTIFICATION_KIND = 'action-justification';

export interface ActionJustification {
  id: string;
  itemId: string;          // ontology id (partition key)
  kind: typeof ACTION_JUSTIFICATION_KIND;
  ontologyName?: string;
  action: string;          // action type name
  objectType: string;
  actionKind: 'create' | 'update' | 'delete';
  targetId?: string;       // AGE vertex id for update/delete
  reason: string;
  outcome: 'succeeded' | 'failed';
  detail?: string;         // e.g. "vertex id 42" / "deleted 1" / error message
  actorOid: string;
  actorName?: string;
  actorUpn?: string;
  tenantId?: string;
  at: string;              // ISO timestamp
}

/** The minimum reason length we accept — a non-empty, meaningful justification. */
export const MIN_JUSTIFICATION_LEN = 4;

export function isValidReason(reason: unknown): reason is string {
  return typeof reason === 'string' && reason.trim().length >= MIN_JUSTIFICATION_LEN;
}

/**
 * Record a justification for a gated action run. Best-effort but reported: the
 * caller surfaces the returned record's id on the run receipt. `nowIso` is
 * injected so the route (not this lib) owns the clock.
 */
export async function recordActionJustification(
  session: SessionPayload,
  input: {
    ontologyId: string;
    ontologyName?: string;
    action: string;
    objectType: string;
    actionKind: 'create' | 'update' | 'delete';
    targetId?: string;
    reason: string;
    outcome: 'succeeded' | 'failed';
    detail?: string;
    nowIso: string;
  },
): Promise<ActionJustification> {
  const rec: ActionJustification = {
    id: `action-justification:${input.ontologyId}:${input.action}:${input.nowIso}`,
    itemId: input.ontologyId,
    kind: ACTION_JUSTIFICATION_KIND,
    ...(input.ontologyName ? { ontologyName: input.ontologyName } : {}),
    action: input.action,
    objectType: input.objectType,
    actionKind: input.actionKind,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    reason: input.reason.trim(),
    outcome: input.outcome,
    ...(input.detail ? { detail: input.detail } : {}),
    actorOid: session.claims.oid,
    ...(session.claims.name ? { actorName: session.claims.name } : {}),
    ...(session.claims.upn ? { actorUpn: session.claims.upn } : {}),
    ...(session.claims.tid ? { tenantId: session.claims.tid } : {}),
    at: input.nowIso,
  };
  const c = await auditLogContainer();
  await c.items.upsert(rec);
  return rec;
}

/** List the most recent justifications recorded for an ontology (newest first). */
export async function listActionJustifications(
  ontologyId: string,
  top = 50,
): Promise<ActionJustification[]> {
  const c = await auditLogContainer();
  const { resources } = await c.items
    .query<ActionJustification>({
      query:
        'SELECT TOP @n c.id, c.itemId, c.kind, c.action, c.objectType, c.actionKind, c.targetId, c.reason, c.outcome, c.detail, c.actorName, c.actorUpn, c.at ' +
        'FROM c WHERE c.itemId = @i AND c.kind = @k ORDER BY c._ts DESC',
      parameters: [
        { name: '@n', value: Math.max(1, Math.min(200, top)) },
        { name: '@i', value: ontologyId },
        { name: '@k', value: ACTION_JUSTIFICATION_KIND },
      ],
    })
    .fetchAll();
  return (resources as ActionJustification[]) || [];
}
