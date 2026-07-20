/**
 * Entitlement-ledger write helpers (access-governance Wave-1).
 *
 * Every grant path calls `recordAssignment` on a successful grant and
 * `revokeAssignmentLedger` on a revoke. Both are BEST-EFFORT — they never throw
 * into the grant/revoke path (a ledger hiccup must not fail a real RBAC grant),
 * mirroring the existing best-effort audit-log/notification writes. Failures are
 * logged (not silently swallowed) per the no-vaporware catch-logging rule.
 *
 * The assignment `id` is deterministic so re-granting the same principal→resource
 * via the same source upserts one row (no duplicates) and revoke targets it
 * without a lookup.
 */
import crypto from 'node:crypto';
import { accessAssignmentsContainer } from '@/lib/azure/cosmos-client';
import type {
  AccessAssignment,
  RecordAssignmentInput,
  AssignmentPrincipalType,
} from '@/lib/types/access-assignment';

/** Deterministic assignment id — stable across re-grants of the same tuple. */
export function assignmentId(principalId: string, resourceType: string, resourceRef: string, source: string): string {
  return crypto
    .createHash('sha256')
    .update(`${principalId}|${resourceType}|${resourceRef}|${source}`)
    .digest('hex')
    .slice(0, 32);
}

/** Build the durable doc from a record input (pure — unit-testable). */
export function toAssignmentDoc(input: RecordAssignmentInput, now = new Date().toISOString()): AccessAssignment {
  const principalType: AssignmentPrincipalType = input.principalType || 'User';
  return {
    id: assignmentId(input.principalId, input.resourceType, input.resourceRef, input.source),
    principalId: input.principalId,
    principalUpn: input.principalUpn,
    principalType,
    tenantId: input.tenantId,
    resourceType: input.resourceType,
    resourceRef: input.resourceRef,
    resourceName: input.resourceName,
    role: input.role,
    permission: input.permission,
    source: input.source,
    sourceRef: input.sourceRef,
    grantedBy: input.grantedBy,
    grantedAt: now,
    roleAssignmentId: input.roleAssignmentId,
    expiresAt: input.expiresAt ?? null,
    state: 'active',
    updatedAt: now,
  };
}

/**
 * Append (upsert) an active assignment to the ledger. Best-effort: returns
 * `true` on success, `false` on any failure (logged), never throws.
 */
export async function recordAssignment(input: RecordAssignmentInput): Promise<boolean> {
  try {
    if (!input.principalId || !input.resourceRef) return false;
    const doc = toAssignmentDoc(input);
    const c = await accessAssignmentsContainer();
    await c.items.upsert(doc);
    return true;
  } catch (e: any) {
    console.warn('[access-ledger] recordAssignment failed:', e?.message || String(e));
    return false;
  }
}

/**
 * Mark an assignment revoked (state='revoked'). Best-effort; matches on the
 * deterministic id, so callers pass the same tuple used to record it.
 */
export async function revokeAssignmentLedger(
  principalId: string,
  resourceType: string,
  resourceRef: string,
  source: string,
  revokedBy?: string,
): Promise<boolean> {
  try {
    if (!principalId || !resourceRef) return false;
    const id = assignmentId(principalId, resourceType, resourceRef, source);
    const c = await accessAssignmentsContainer();
    const { resource } = await c.item(id, principalId).read<AccessAssignment>();
    if (!resource) return false;
    const now = new Date().toISOString();
    resource.state = 'revoked';
    resource.revokedAt = now;
    resource.revokedBy = revokedBy;
    resource.updatedAt = now;
    await c.item(id, principalId).replace(resource);
    return true;
  } catch (e: any) {
    console.warn('[access-ledger] revokeAssignmentLedger failed:', e?.message || String(e));
    return false;
  }
}
