/**
 * API Gateway Plane — audit kinds helper (W1-1).
 *
 * Pure: builds `apiplane.<area>.<verb>` kinds and the audit-log row shape
 * (pattern: lib/admin/finops-audit.ts). Writing the row stays with the caller.
 */
import type { ApiplaneAuditArea, ApiplaneAuditRecord } from './types';

const SEGMENT = /^[a-z][a-z0-9]*$/;

export function apiplaneAuditKind(area: ApiplaneAuditArea | string, verb: string): string {
  if (!SEGMENT.test(area)) throw new Error(`invalid audit area: ${JSON.stringify(area)}`);
  if (!SEGMENT.test(verb)) throw new Error(`invalid audit verb: ${JSON.stringify(verb)}`);
  return `apiplane.${area}.${verb}`;
}

export interface ApiplaneAuditInput {
  tenantId: string;
  who: string;
  actorOid: string;
  area: ApiplaneAuditArea | string;
  verb: string;
  target: string;
  capability: 'apiplane-admin' | 'tenant-admin';
  prior?: unknown;
  next?: unknown;
  now?: Date;
  nonce?: string;
}

export function buildApiplaneAuditRecord(i: ApiplaneAuditInput): ApiplaneAuditRecord {
  const kind = apiplaneAuditKind(i.area, i.verb);
  const now = i.now ?? new Date();
  return {
    id: `audit-${now.getTime()}-${i.nonce ?? Math.random().toString(36).slice(2, 8)}`,
    itemId: `${kind}:${i.target}`,
    tenantId: i.tenantId,
    who: i.who,
    actorOid: i.actorOid,
    at: now.toISOString(),
    kind,
    action: i.verb,
    target: i.target,
    capability: i.capability,
    detail: { prior: i.prior ?? null, next: i.next ?? null },
  };
}
