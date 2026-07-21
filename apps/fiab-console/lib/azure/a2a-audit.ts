/**
 * a2a-audit — durable + SIEM audit for WS-5.2 A2A task delegation.
 *
 * Every delegated A2A task (inbound: an external agent delegating INTO Loom;
 * outbound: a Loom user delegating OUT) writes ONE row to the Cosmos audit-log
 * container (the authoritative trail read by /admin/audit-logs) AND fans out to
 * the SIEM stream + webhooks via emitAuditEvent — mirroring how every other
 * governed mutation is recorded. Fire-and-forget: never throws, never blocks the
 * delegation. No mocks — a real Cosmos write (no-vaporware.md).
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

export interface A2aAuditInput {
  actorOid: string;
  actorUpn: string;
  tenantId: string;
  /** 'inbound' = external agent delegated in; 'outbound' = Loom delegated out. */
  direction: 'inbound' | 'outbound';
  method: string;
  skillId?: string;
  taskId: string;
  contextId?: string;
  outcome: 'success' | 'failure';
  detail?: string;
}

/** Record an A2A delegation event (durable Cosmos row + SIEM/webhook fan-out). */
export function auditA2aDelegation(ev: A2aAuditInput): void {
  const at = new Date().toISOString();
  const action = `a2a.${ev.direction}.${ev.method.replace(/\//g, '.')}`;
  // Durable Cosmos audit-log row (partition key /itemId → the task id).
  void (async () => {
    try {
      const c = await auditLogContainer();
      await c.items.create({
        id: `a2a-${ev.taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        itemId: ev.taskId,
        tenantId: ev.tenantId,
        who: ev.actorOid,
        at,
        timestamp: at,
        kind: 'a2a.delegation',
        category: 'a2a',
        action,
        outcome: ev.outcome,
        details: {
          direction: ev.direction,
          method: ev.method,
          skillId: ev.skillId,
          taskId: ev.taskId,
          contextId: ev.contextId,
          outcome: ev.outcome,
          detail: ev.detail,
        },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[a2a-audit] durable audit write failed (non-fatal):', (e as Error)?.message || e);
    }
  })();
  // SIEM + webhook fan-out (best-effort).
  emitAuditEvent({
    actorOid: ev.actorOid,
    actorUpn: ev.actorUpn,
    action,
    targetType: 'a2a-task',
    targetId: ev.taskId,
    outcome: ev.outcome === 'success' ? 'success' : 'failure',
    tenantId: ev.tenantId,
    detail: { direction: ev.direction, method: ev.method, skillId: ev.skillId, detail: ev.detail },
  });
}
