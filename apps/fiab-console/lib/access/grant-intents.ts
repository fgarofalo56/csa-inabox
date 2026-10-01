/**
 * The grant ledger: a WRITE-AHEAD record of every grant an access request makes.
 *
 * Before any grant call, the decision (or the self-serve request) writes one
 * row for the grant it is about to make, in state `pending`, carrying the
 * request id, a per-attempt id, the principal and the scope. After the grant
 * the row is settled, conditioned on its own etag:
 *
 *   active       — the grant created the assignment (`created: true`, with the
 *                  role-assignment id), or landed with its prior state unknown
 *                  (`created` absent);
 *   preexisting  — the principal already held it (`created: false`);
 *   failed       — the grant did not land.
 *
 * A live grant is therefore never recorded nowhere: if anything stops the
 * decision between the grant and its settle (a crash, a store error, a lost
 * lease), the `pending` row is still there. {@link reconcileGrantIntent} resolves
 * a pending row older than the lease from the store itself and marks it
 * `absent` (not in place) or `active` with its prior state unknown (in place,
 * so it is kept and reported, never revoked blind). It runs on every decision
 * for the request and is exported for a scheduled sweep
 * ({@link reconcileStaleGrantIntents}).
 *
 * The ledger, not the request document, is what compensation and denial
 * revoke from: every `active` row with `created: true` for the request, from
 * any attempt ({@link revokeIntents}).
 *
 * Storage: rows live beside the request, in the `access-request-workflow`
 * container and the request's partition (`/tenantId`), as `kind: 'grant-intent'`
 * documents. Every other reader of that container filters on
 * `kind = "access-request"`, `status`, `requesterId` or `assetId`; an intent
 * row carries none of those fields, so it never appears in an inbox, a
 * "my requests" list, the access gate, the backfill or the repartition scan.
 */
import crypto from 'node:crypto';
import type { SessionPayload } from '@/lib/auth/session';
import { accessRequestWorkflowContainer } from '@/lib/azure/cosmos-client';
import { probeAccessGrant, type AccessPermission, type AccessScopeType } from '@/lib/azure/rbac-client';
import { recordAssignment } from '@/lib/access/assignment-ledger';
import { REQUEST_GRANT_SOURCE, revokeLandedGrants, type LandedGrantContext } from '@/lib/access/landed-grants';
import type { AccessRequestGrantResult } from '@/lib/types/access-request-workflow';

export const GRANT_INTENT_KIND = 'grant-intent' as const;

/**
 * How long one hold on a request lasts (decision/route.ts). A `pending` row
 * older than this belongs to a decision that has stopped or lost the request,
 * so it is resolved from the store instead of waited on.
 */
export const GRANT_LEASE_MS = 120_000;

export type GrantIntentState = 'pending' | 'active' | 'preexisting' | 'failed' | 'absent' | 'revoked';

export interface GrantIntent {
  id: string;
  kind: typeof GRANT_INTENT_KIND;
  /** Partition key: the request's tenant. */
  tenantId: string;
  requestId: string;
  /** One id per decision attempt (or self-serve request) that wrote the row. */
  attemptId: string;
  principalId: string;
  principalName: string;
  scopeType: AccessScopeType;
  scopeRef: string;
  permission: AccessPermission;
  assetName: string;
  state: GrantIntentState;
  created?: boolean;
  roleName?: string;
  roleAssignmentId?: string;
  detail?: string;
  /** Who made the grant (the approver, or the requester for self-serve). */
  by: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokedBy?: string;
  _etag?: string;
}

/** The request, principal and attempt a set of intent rows belongs to. */
export interface IntentContext {
  tenantId: string;
  requestId: string;
  attemptId: string;
  principalId: string;
  principalName: string;
  permission: AccessPermission;
  assetName: string;
  by: string;
}

export type IntentContainer = Awaited<ReturnType<typeof accessRequestWorkflowContainer>>;

export const newAttemptId = () => crypto.randomUUID();

/** The row id: one row per request, attempt and scope. */
export function intentId(requestId: string, attemptId: string, scopeType: string, scopeRef: string): string {
  const scope = crypto.createHash('sha256').update(`${scopeType}|${scopeRef}`).digest('hex').slice(0, 16);
  return `grant-intent:${requestId}:${attemptId}:${scope}`;
}

const nowIso = () => new Date(Date.now()).toISOString();
const etagOf = (r: unknown) => (r as { _etag?: string } | undefined)?._etag;
const isPreconditionFailed = (e: any) => e?.code === 412 || e?.statusCode === 412;

/**
 * Write the `pending` row for a grant about to be made. Throws when the row
 * cannot be written: the caller must not make a grant it could not record.
 */
export async function writeGrantIntent(
  c: IntentContainer, ctx: IntentContext, target: { scopeType: AccessScopeType; scopeRef: string },
): Promise<GrantIntent> {
  const at = nowIso();
  const row: GrantIntent = {
    id: intentId(ctx.requestId, ctx.attemptId, target.scopeType, target.scopeRef),
    kind: GRANT_INTENT_KIND,
    tenantId: ctx.tenantId,
    requestId: ctx.requestId,
    attemptId: ctx.attemptId,
    principalId: ctx.principalId,
    principalName: ctx.principalName,
    scopeType: target.scopeType,
    scopeRef: target.scopeRef,
    permission: ctx.permission,
    assetName: ctx.assetName,
    state: 'pending',
    by: ctx.by,
    createdAt: at,
    updatedAt: at,
  };
  const { resource } = await c.items.create(row);
  return { ...row, _etag: etagOf(resource) };
}

/** The settled state of a grant outcome (see the module header). */
export function settledFields(r: AccessRequestGrantResult): Pick<GrantIntent, 'state' | 'created' | 'roleName' | 'roleAssignmentId' | 'detail'> {
  const base = {
    ...(r.roleName ? { roleName: r.roleName } : {}),
    ...(r.roleAssignmentId ? { roleAssignmentId: r.roleAssignmentId } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
  };
  if (r.status !== 'active') return { ...base, state: 'failed', created: false };
  if (r.created === false) return { ...base, state: 'preexisting', created: false };
  if (r.created === true) return { ...base, state: 'active', created: true };
  return { ...base, state: 'active' };
}

export type SettleOutcome =
  | { ok: true; row: GrantIntent }
  | { ok: false; lost: true }
  | { ok: false; lost: false; error: unknown };

/**
 * Settle a row with the grant's outcome, conditioned on the row's etag. `lost`
 * means another writer (the reconciler) changed the row since it was written.
 */
export async function settleGrantIntent(c: IntentContainer, row: GrantIntent, result: AccessRequestGrantResult): Promise<SettleOutcome> {
  const { _etag, ...stored } = row;
  const next: GrantIntent = { ...stored, ...settledFields(result), updatedAt: nowIso() };
  if (result.created === undefined) delete next.created;
  try {
    const { resource } = await c.item(row.id, row.tenantId).replace(next, {
      accessCondition: { type: 'IfMatch', condition: _etag || '' },
    });
    return { ok: true, row: { ...next, _etag: etagOf(resource) } };
  } catch (e) {
    if (isPreconditionFailed(e)) return { ok: false, lost: true };
    return { ok: false, lost: false, error: e };
  }
}

/** Every intent row for one request (single-partition). */
export async function listGrantIntents(c: IntentContainer, tenantId: string, requestId: string): Promise<GrantIntent[]> {
  const { resources } = await c.items
    .query<GrantIntent>(
      {
        query: 'SELECT * FROM c WHERE c.kind = @k AND c.requestId = @r',
        parameters: [{ name: '@k', value: GRANT_INTENT_KIND }, { name: '@r', value: requestId }],
      },
      { partitionKey: tenantId },
    )
    .fetchAll();
  return resources || [];
}

/** A `pending` row older than the lease: its decision has stopped or lost the request. */
export function isStalePending(row: GrantIntent, now = Date.now()): boolean {
  return row.state === 'pending' && Date.parse(row.createdAt) + GRANT_LEASE_MS < now;
}

/** Write `patch` onto the stored row, conditioned on the etag it was read with; re-read once on a 412. */
async function patchIntent(c: IntentContainer, row: GrantIntent, patch: Partial<GrantIntent>, when: (r: GrantIntent) => boolean): Promise<GrantIntent> {
  let current = row;
  for (let i = 0; i < 2; i++) {
    if (!when(current)) return current;
    const { _etag, ...stored } = current;
    const next: GrantIntent = { ...stored, ...patch, updatedAt: nowIso() };
    try {
      const { resource } = await c.item(current.id, current.tenantId).replace(next, {
        accessCondition: { type: 'IfMatch', condition: _etag || '' },
      });
      return { ...next, _etag: etagOf(resource) };
    } catch (e) {
      if (!isPreconditionFailed(e)) throw e;
      const { resource } = await c.item(current.id, current.tenantId).read<GrantIntent>();
      if (!resource) return current;
      current = resource;
    }
  }
  return current;
}

export const RECONCILED_ABSENT = 'Not in place when checked after the decision that wrote this row stopped.';
export const RECONCILED_FOUND =
  'Found in place when checked after the decision that wrote this row stopped. Whether the requester held it '
  + 'before the request is unknown, so it is not removed automatically.';

/**
 * Resolve a stale `pending` row from the store (see the module header). A row
 * that is not stale, or whose store could not be read, is returned unchanged.
 * A row found in place is also written to the entitlement ledger, so the
 * Access report shows it.
 */
export async function reconcileGrantIntent(c: IntentContainer, row: GrantIntent, now = Date.now()): Promise<GrantIntent> {
  if (!isStalePending(row, now)) return row;
  let probe;
  try {
    probe = await probeAccessGrant({
      principalId: row.principalId, principalName: row.principalName, principalType: 'User',
      scopeType: row.scopeType, scopeRef: row.scopeRef, permission: row.permission,
    });
  } catch {
    probe = undefined;
  }
  if (!probe || 'unknown' in probe) return row;
  const patch: Partial<GrantIntent> = probe.held
    ? {
      state: 'active', roleName: probe.roleName, detail: RECONCILED_FOUND,
      ...(probe.roleAssignmentId ? { roleAssignmentId: probe.roleAssignmentId } : {}),
    }
    : { state: 'absent', detail: RECONCILED_ABSENT };
  let next: GrantIntent;
  try {
    next = await patchIntent(c, row, patch, (r) => r.state === 'pending');
  } catch {
    return row;
  }
  if (probe.held && next.state === 'active' && next.detail === RECONCILED_FOUND) {
    await recordAssignment({
      principalId: row.principalId, principalUpn: row.principalName, principalType: 'User',
      tenantId: row.tenantId, resourceType: row.scopeType, resourceRef: row.scopeRef,
      resourceName: row.assetName, role: probe.roleName, permission: row.permission,
      source: REQUEST_GRANT_SOURCE, sourceRef: row.requestId, grantedBy: row.by,
      roleAssignmentId: probe.roleAssignmentId, expiresAt: null,
    });
  }
  return next;
}

/** Every intent row for a request, with its stale `pending` rows reconciled. */
export async function reconcileRequestIntents(
  c: IntentContainer, tenantId: string, requestId: string, now = Date.now(),
): Promise<GrantIntent[]> {
  const rows = await listGrantIntents(c, tenantId, requestId);
  const out: GrantIntent[] = [];
  for (const r of rows) out.push(await reconcileGrantIntent(c, r, now));
  return out;
}

/**
 * Scheduled sweep: reconcile every stale `pending` row (in one tenant, or
 * across tenants). Returns what it found; a row whose store could not be read
 * stays `pending` and is counted as `unknown`.
 */
export async function reconcileStaleGrantIntents(opts: { tenantId?: string; now?: number; limit?: number } = {}): Promise<{
  checked: number; absent: number; found: number; unknown: number;
}> {
  const c = await accessRequestWorkflowContainer();
  const now = opts.now ?? Date.now();
  const { resources } = await c.items
    .query<GrantIntent>(
      {
        query: `SELECT TOP ${Math.max(1, Math.min(opts.limit ?? 500, 5000))} * FROM c WHERE c.kind = @k AND c.state = @s`,
        parameters: [{ name: '@k', value: GRANT_INTENT_KIND }, { name: '@s', value: 'pending' }],
      },
      opts.tenantId ? { partitionKey: opts.tenantId } : undefined,
    )
    .fetchAll();
  const tally = { checked: 0, absent: 0, found: 0, unknown: 0 };
  for (const row of resources || []) {
    if (!isStalePending(row, now)) continue;
    tally.checked += 1;
    const next = await reconcileGrantIntent(c, row, now);
    if (next.state === 'absent') tally.absent += 1;
    else if (next.state === 'active') tally.found += 1;
    else tally.unknown += 1;
  }
  return tally;
}

/** A row as the grant outcome the revoke path and the 409/503 bodies use. */
export function intentAsResult(row: GrantIntent): AccessRequestGrantResult {
  return {
    status: 'active',
    scopeType: row.scopeType,
    scopeRef: row.scopeRef,
    ...(row.roleName ? { roleName: row.roleName } : {}),
    ...(row.roleAssignmentId ? { roleAssignmentId: row.roleAssignmentId } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.created === undefined ? {} : { created: row.created }),
  };
}

export const IN_FLIGHT =
  'A decision that has since stopped was still granting this; it is recorded in the grant ledger and '
  + 'checked against the store on the next decision.';

const key = (r: { scopeType: string; scopeRef: string }) => `${r.scopeType}\u0000${r.scopeRef}`;

/**
 * Revoke what the request's ledger rows say the request created: every
 * `active` row with `created: true`, from any attempt, one revoke per scope.
 * An `active` row whose prior state is unknown is kept with that reason, and
 * a `pending` row (a grant still in flight, or not yet reconcilable) is kept
 * with {@link IN_FLIGHT}. Each revoked scope's rows are marked `revoked`.
 */
export async function revokeIntents(
  c: IntentContainer,
  rows: GrantIntent[],
  ctx: Pick<LandedGrantContext, 'requesterId' | 'requesterUpn' | 'permission'>,
  session: SessionPayload,
  opts?: { beforeEach?: () => Promise<boolean> },
): Promise<{
  revoked: AccessRequestGrantResult[];
  kept: AccessRequestGrantResult[];
  notAttempted: AccessRequestGrantResult[];
  aborted: boolean;
}> {
  const byScope = new Map<string, GrantIntent[]>();
  for (const r of rows) {
    if (r.state !== 'active' && r.state !== 'pending') continue;
    const k = key(r);
    byScope.set(k, [...(byScope.get(k) || []), r]);
  }
  const candidates: AccessRequestGrantResult[] = [];
  const inFlight: AccessRequestGrantResult[] = [];
  for (const group of byScope.values()) {
    const created = group.find((r) => r.state === 'active' && r.created === true);
    const landed = group.find((r) => r.state === 'active');
    if (created) candidates.push(intentAsResult(created));
    else if (landed) candidates.push(intentAsResult(landed));
    else inFlight.push({ ...intentAsResult(group[0]), detail: IN_FLIGHT });
  }
  const out = await revokeLandedGrants(ctx, candidates, session, opts);
  const by = session.claims.upn || session.claims.oid;
  for (const g of out.revoked) {
    for (const r of byScope.get(key(g)) || []) {
      if (r.state !== 'active') continue;
      try {
        await patchIntent(c, r, { state: 'revoked', revokedAt: nowIso(), revokedBy: by }, (x) => x.state === 'active');
      } catch { /* the revoke itself happened; a row left `active` is revoked again (ARM answers 204/404) */ }
    }
  }
  return { ...out, kept: [...out.kept, ...inFlight] };
}
