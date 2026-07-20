/**
 * Ontology object-level security audit (WS-4.3).
 *
 * Records object-security ENFORCEMENT events — a masked/filtered read or a
 * blocked action run — to the shared Cosmos `audit-log` container (partition
 * `/itemId` = the ontology id) as `kind:'object-security'`, so they surface in
 * the existing Admin → Audit Logs reader alongside the action-justification and
 * PDP-shadow rows. Best-effort: a write miss NEVER fails the guarded request.
 *
 * Azure-native (Cosmos), Gov-safe — no Fabric.
 */
import { auditLogContainer } from './cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';

export const OBJECT_SECURITY_KIND = 'object-security';

export type ObjectSecurityDecision =
  | 'read-masked' // a list/view read where property masking and/or row filtering applied
  | 'action-denied' // a write-back action blocked by an action marking (403)
  | 'action-allowed'; // a gated write-back action the caller was cleared to run

export interface ObjectSecurityEvent {
  id: string;
  itemId: string; // ontology id (partition key)
  kind: typeof OBJECT_SECURITY_KIND;
  category: 'object-security';
  decision: ObjectSecurityDecision;
  ontologyName?: string;
  objectType?: string;
  action?: string;
  targetId?: string;
  /** Properties masked for the caller on this read (read-masked). */
  maskedProperties?: string[];
  /** Instances hidden by a row marking on this read (read-masked). */
  filteredCount?: number;
  actorOid: string;
  actorName?: string;
  actorUpn?: string;
  /** The caller's Entra group object-ids at decision time (the ACL input). */
  actorGroups?: string[];
  tenantId?: string;
  at: string; // ISO timestamp
  timestamp: string;
  who: string;
}

/**
 * Record one object-security enforcement event. Best-effort — callers wrap this
 * so a Cosmos miss never breaks the guarded route. `nowIso` is injected so the
 * route owns the clock.
 */
export async function recordObjectSecurityEvent(
  session: SessionPayload,
  input: {
    ontologyId: string;
    ontologyName?: string;
    decision: ObjectSecurityDecision;
    objectType?: string;
    action?: string;
    targetId?: string;
    maskedProperties?: string[];
    filteredCount?: number;
    callerGroups?: readonly string[];
    nowIso: string;
  },
): Promise<void> {
  const c = session.claims;
  const at = input.nowIso;
  const rec: ObjectSecurityEvent = {
    id: `object-security:${input.ontologyId}:${input.decision}:${at}:${Math.random().toString(36).slice(2, 8)}`,
    itemId: input.ontologyId,
    kind: OBJECT_SECURITY_KIND,
    category: 'object-security',
    decision: input.decision,
    ...(input.ontologyName ? { ontologyName: input.ontologyName } : {}),
    ...(input.objectType ? { objectType: input.objectType } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.maskedProperties && input.maskedProperties.length ? { maskedProperties: input.maskedProperties } : {}),
    ...(typeof input.filteredCount === 'number' && input.filteredCount > 0 ? { filteredCount: input.filteredCount } : {}),
    actorOid: c.oid,
    ...(c.name ? { actorName: c.name } : {}),
    ...(c.upn ? { actorUpn: c.upn } : {}),
    ...(input.callerGroups && input.callerGroups.length ? { actorGroups: [...input.callerGroups] } : {}),
    ...(c.tid ? { tenantId: c.tid } : {}),
    at,
    timestamp: at,
    who: c.oid,
  };
  const container = await auditLogContainer();
  await container.items.create(rec);
}

/** Fire-and-forget wrapper: log the event, swallow + console any error. */
export function auditObjectSecurity(
  session: SessionPayload,
  input: Parameters<typeof recordObjectSecurityEvent>[1],
): void {
  void recordObjectSecurityEvent(session, input).catch((e) => {
    console.error('[object-security:audit] non-fatal audit write error', e);
  });
}
