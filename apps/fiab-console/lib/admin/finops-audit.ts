/**
 * finops-audit — C4 (loom-next-level, SRE F7 / ATO): the audited-mutation
 * helper for the FinOps hub. Every budget create/update/delete and every
 * anomaly-rule change writes an authoritative `_auditLog` row via the existing
 * `auditLogContainer()` helper AND fans out through `emitAuditEvent`
 * (SIEM/webhooks) — the same audit standard as every other admin-plane
 * mutation (mirrors lib/admin/runtime-flags.setRuntimeFlag).
 *
 * Reviewer rejects the PR without the audit row in the G1 receipt.
 */
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

export type FinopsAuditKind = 'finops.budget' | 'finops.anomaly-rule';
export type FinopsAuditAction = 'create' | 'update' | 'delete';

export interface FinopsAuditActor {
  oid: string;
  /** UPN / email / display fallback. */
  who: string;
  tenantId: string;
}

export interface FinopsAuditInput {
  kind: FinopsAuditKind;
  action: FinopsAuditAction;
  /** The mutated target id (budget name / rule id). */
  target: string;
  /** The scope the mutation applies to (subscription / RG / 'all'). */
  scope: string;
  prior?: unknown;
  next?: unknown;
}

/**
 * Write the `_auditLog` row + emit the audit event for one FinOps mutation.
 * Best-effort on the Cosmos row (a mutation is never blocked by an audit
 * hiccup, matching setRuntimeFlag) but ALWAYS emits the audit event.
 */
export async function auditFinopsMutation(actor: FinopsAuditActor, input: FinopsAuditInput): Promise<void> {
  const now = new Date().toISOString();
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `${input.kind}:${input.target}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        at: now,
        kind: input.kind,
        action: input.action,
        target: input.target,
        scope: input.scope,
        detail: { prior: input.prior ?? null, next: input.next ?? null },
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: `${input.kind}.${input.action}`,
    targetType: input.kind,
    targetId: input.target,
    tenantId: actor.tenantId,
    detail: { scope: input.scope, prior: input.prior ?? null, next: input.next ?? null },
  });
}
