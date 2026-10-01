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
 * for the request, and the scheduled access sweep runs it for every tenant
 * ({@link reconcileStaleGrantIntents}, app/api/access-governance/sweep).
 *
 * `absent` is not final. It is what the store showed when the row was checked,
 * and a grant still in flight can land after that. When it does, the decision
 * that made it writes the real outcome onto the row ({@link settleGrantIntent}),
 * and the scheduled sweep re-checks `absent` rows for a day.
 *
 * OWNERSHIP decides what a stopped approval revokes ({@link revokeOwnIntents}):
 * exactly the rows THIS attempt wrote whose grant this attempt created, whoever
 * holds the request now. The one exception is a row another approval ADOPTED
 * when it completed the request ({@link adoptGrantIntents}): adopting re-points
 * the row's `attemptId`, conditioned on its etag, and the adopter's completed
 * request keeps the grant. A stopped approval never revokes another attempt's
 * rows. A denial revokes every created row of the request, from any attempt
 * ({@link revokeIntents}).
 *
 * Storage: rows live beside the request, in the `access-request-workflow`
 * container and the request's partition (`/tenantId`), as `kind: 'grant-intent'`
 * documents. Every other reader of that container filters on
 * `kind = "access-request"`, `status`, `requesterId` or `assetId`; an intent
 * row carries none of those fields, so it never appears in an inbox, a
 * "my requests" list, the access gate, the backfill or the repartition scan.
 * The Access report lists the rows that are not settled
 * ({@link listUnsettledGrantIntents}).
 */
import crypto from 'node:crypto';
import type { SessionPayload } from '@/lib/auth/session';
import { accessRequestWorkflowContainer } from '@/lib/azure/cosmos-client';
import { enforceAccessGrant, probeAccessGrant, type AccessPermission, type AccessScopeType } from '@/lib/azure/rbac-client';
import { recordAssignment } from '@/lib/access/assignment-ledger';
import {
  REQUEST_GRANT_SOURCE, grantResult, revokeLandedGrants, type LandedGrantContext, type LedgerRecord,
} from '@/lib/access/landed-grants';
import type { AccessRequestGrantResult } from '@/lib/types/access-request-workflow';

export const GRANT_INTENT_KIND = 'grant-intent' as const;

/**
 * How long one hold on a request lasts (decision/route.ts). A `pending` row
 * older than this belongs to a decision that has stopped or lost the request,
 * so it is resolved from the store instead of waited on.
 */
export const GRANT_LEASE_MS = 120_000;

/** How long the scheduled sweep keeps re-checking an `absent` row for a grant that landed late. */
export const ABSENT_RECHECK_MS = 24 * 60 * 60 * 1000;

export type GrantIntentState = 'pending' | 'active' | 'preexisting' | 'failed' | 'absent' | 'revoked';

export interface GrantIntent {
  id: string;
  kind: typeof GRANT_INTENT_KIND;
  /** Partition key: the request's tenant. */
  tenantId: string;
  requestId: string;
  /** The attempt that owns the row: the one that wrote it, or the approval that adopted it. */
  attemptId: string;
  /** The attempt that wrote the row, when another approval has since adopted it. */
  adoptedFrom?: string;
  adoptedAt?: string;
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
const key = (r: { scopeType: string; scopeRef: string }) => `${r.scopeType}\u0000${r.scopeRef}`;

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

export const LANDED_AFTER_CHECK =
  'This grant landed after the row was checked; the decision that made it recorded the outcome.';

/**
 * Whether a grant's own outcome may be written onto `row` as it stands now:
 * the row is still `pending`, was resolved `absent` (a grant can land after
 * that check), or was found in place with its origin unknown while this grant
 * says it created the assignment. A row already settled, failed or revoked
 * keeps what it says.
 */
export function takesOutcome(row: GrantIntent, result: AccessRequestGrantResult): boolean {
  if (row.state === 'pending' || row.state === 'absent') return true;
  return row.state === 'active' && row.created === undefined && result.status === 'active' && result.created === true;
}

/** `row` with a grant's outcome written over it (ownership unchanged). */
function withOutcome(row: GrantIntent, result: AccessRequestGrantResult): Partial<GrantIntent> {
  const fields = settledFields(result);
  return {
    ...fields,
    ...(fields.created === undefined ? {} : { created: fields.created }),
    detail: fields.detail || (row.state === 'pending' ? row.detail : LANDED_AFTER_CHECK),
  };
}

export type SettleOutcome =
  | { ok: true; row: GrantIntent }
  | { ok: false; lost: true; row?: GrantIntent }
  | { ok: false; lost: false; error: unknown };

/**
 * Settle a row with the grant's outcome, conditioned on the row's etag. `lost`
 * means another writer changed the row since it was written: the reconciler
 * (it resolved the row `absent` or found it in place) or an approval that
 * adopted it. The grant's outcome is still the truth about this grant, so it is
 * written onto the row as it stands now, keeping whoever owns it, before the
 * caller decides anything ({@link takesOutcome}); `row` is that result.
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
    if (!isPreconditionFailed(e)) return { ok: false, lost: false, error: e };
  }
  try {
    const { resource: current } = await c.item(row.id, row.tenantId).read<GrantIntent>();
    if (!current) return { ok: false, lost: true };
    if (!takesOutcome(current, result)) return { ok: false, lost: true, row: current };
    const written = await patchIntent(c, current, withOutcome(current, result), (x) => takesOutcome(x, result));
    return { ok: false, lost: true, row: written };
  } catch {
    return { ok: false, lost: true };
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

/** An `absent` row young enough that a grant in flight when it was checked may have landed since. */
export function isRecheckableAbsent(row: GrantIntent, now = Date.now()): boolean {
  return row.state === 'absent' && Date.parse(row.createdAt) + ABSENT_RECHECK_MS > now;
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
export const RECONCILED_LANDED_LATE =
  'Not in place when first checked, and found in place on a later check. Whether the requester held it before '
  + 'the request is unknown, so it is not removed automatically.';

/**
 * Resolve a stale `pending` row from the store (see the module header), and,
 * with `recheckAbsent`, re-check an `absent` row young enough for a late grant
 * ({@link isRecheckableAbsent}). A row neither applies to, or whose store could
 * not be read, is returned unchanged. A row found in place is also written to
 * the entitlement ledger (no expiry), so the Access report shows it.
 */
export async function reconcileGrantIntent(
  c: IntentContainer, row: GrantIntent, now = Date.now(), opts: { recheckAbsent?: boolean } = {},
): Promise<GrantIntent> {
  const absent = !!opts.recheckAbsent && isRecheckableAbsent(row, now);
  if (!isStalePending(row, now) && !absent) return row;
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
  if (absent && !probe.held) return row;
  const found = absent ? RECONCILED_LANDED_LATE : RECONCILED_FOUND;
  const patch: Partial<GrantIntent> = probe.held
    ? {
      state: 'active', roleName: probe.roleName, detail: found,
      ...(probe.roleAssignmentId ? { roleAssignmentId: probe.roleAssignmentId } : {}),
    }
    : { state: 'absent', detail: RECONCILED_ABSENT };
  let next: GrantIntent;
  try {
    next = await patchIntent(c, row, patch, (r) => r.state === row.state);
  } catch {
    return row;
  }
  if (probe.held && next.state === 'active' && next.detail === found) {
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
 * The scheduled sweep (app/api/access-governance/sweep): reconcile every stale
 * `pending` row, and re-check every `absent` row young enough for a grant that
 * landed late, in one tenant or across tenants. Returns what it found; a row
 * whose store could not be read is unchanged and counted as `unknown`.
 */
export async function reconcileStaleGrantIntents(opts: { tenantId?: string; now?: number; limit?: number } = {}): Promise<{
  checked: number; absent: number; found: number; landedLate: number; stillAbsent: number; unknown: number;
}> {
  const c = await accessRequestWorkflowContainer();
  const now = opts.now ?? Date.now();
  const { resources } = await c.items
    .query<GrantIntent>(
      {
        query: `SELECT TOP ${Math.max(1, Math.min(opts.limit ?? 500, 5000))} * FROM c WHERE c.kind = @k AND (c.state = @p OR c.state = @a)`,
        parameters: [{ name: '@k', value: GRANT_INTENT_KIND }, { name: '@p', value: 'pending' }, { name: '@a', value: 'absent' }],
      },
      opts.tenantId ? { partitionKey: opts.tenantId } : undefined,
    )
    .fetchAll();
  const tally = { checked: 0, absent: 0, found: 0, landedLate: 0, stillAbsent: 0, unknown: 0 };
  for (const row of resources || []) {
    const wasAbsent = isRecheckableAbsent(row, now);
    if (!isStalePending(row, now) && !wasAbsent) continue;
    tally.checked += 1;
    const next = await reconcileGrantIntent(c, row, now, { recheckAbsent: true });
    if (next.state === 'active') {
      if (wasAbsent) tally.landedLate += 1;
      else tally.found += 1;
    } else if (next.state === 'absent') {
      // An absent row re-checked and not found (or whose store could not be read) stays absent.
      if (wasAbsent) tally.stillAbsent += 1;
      else tally.absent += 1;
    } else tally.unknown += 1;
  }
  return tally;
}

/** The grant-ledger states the Access report lists: grants not settled as in place, held before or removed. */
export const UNSETTLED_STATES: GrantIntentState[] = ['pending', 'failed', 'absent'];

/**
 * The rows of one tenant that are not settled ({@link UNSETTLED_STATES}),
 * newest first, optionally for one principal or one scope ref. The Access
 * report shows them with their state and age.
 */
export async function listUnsettledGrantIntents(
  tenantId: string, opts: { principalId?: string; scopeRef?: string; limit?: number } = {},
): Promise<GrantIntent[]> {
  const c = await accessRequestWorkflowContainer();
  const where = ['c.kind = @k', '(c.state = @s0 OR c.state = @s1 OR c.state = @s2)'];
  const parameters: Array<{ name: string; value: string }> = [
    { name: '@k', value: GRANT_INTENT_KIND },
    ...UNSETTLED_STATES.map((s, i) => ({ name: `@s${i}`, value: s })),
  ];
  if (opts.principalId) {
    where.push('c.principalId = @p');
    parameters.push({ name: '@p', value: opts.principalId });
  }
  if (opts.scopeRef) {
    where.push('c.scopeRef = @r');
    parameters.push({ name: '@r', value: opts.scopeRef });
  }
  const top = Math.max(1, Math.min(opts.limit ?? 500, 1000));
  const { resources } = await c.items
    .query<GrantIntent>(
      { query: `SELECT TOP ${top} * FROM c WHERE ${where.join(' AND ')} ORDER BY c.createdAt DESC`, parameters },
      { partitionKey: tenantId },
    )
    .fetchAll();
  return (resources || []).filter((r) => UNSETTLED_STATES.includes(r.state));
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
  'Another decision was still granting this when it was checked. That decision removes the grant if it stops '
  + 'without completing the request; if it ends without recording the grant at all, the scheduled access sweep '
  + 'checks it against the store.';
export const ADOPTED = 'Left in place: another approval of this request took this grant over when it completed the request.';
export const UNCONFIRMED =
  "Left in place: the request's grant records could not be read to confirm this approval still owns this grant.";
export const OUTCOME_UNKNOWN =
  'The grant call failed, so whether it landed is unknown; the scheduled access sweep checks it against the store.';

/**
 * Revoke what the request's ledger rows say the request created: every
 * `active` row with `created: true`, from any attempt, one revoke per scope.
 * Used by a DENIAL. An `active` row whose prior state is unknown is kept with
 * that reason, and a `pending` row (a grant still in flight, or not yet
 * reconcilable) is kept with {@link IN_FLIGHT}. Each revoked scope's `active`
 * rows are marked `revoked`.
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

/** Rows whose scope another approval of the same request may rely on once it adopts them. */
const adoptable = (r: GrantIntent) => (r.state === 'pending' || r.state === 'absent' || r.state === 'active') && r.created !== false;

/**
 * Adopt, for an approval about to complete the request, the other attempts'
 * rows for `target`: a scope this approval found already held may be held
 * because another attempt of this request granted it. Adopting re-points the
 * row's `attemptId` to this attempt, conditioned on the row's etag, so the
 * attempt that wrote it no longer revokes it when it stops
 * ({@link revokeOwnIntents}). Throws when the rows cannot be read or written.
 */
export async function adoptGrantIntents(
  c: IntentContainer, ctx: IntentContext, target: { scopeType: string; scopeRef: string },
): Promise<GrantIntent[]> {
  const rows = await listGrantIntents(c, ctx.tenantId, ctx.requestId);
  const out: GrantIntent[] = [];
  for (const r of rows) {
    if (r.attemptId === ctx.attemptId || key(r) !== key(target) || !adoptable(r)) continue;
    const from = r.attemptId;
    const next = await patchIntent(
      c, r, { attemptId: ctx.attemptId, adoptedFrom: from, adoptedAt: nowIso() },
      (x) => x.attemptId === from && adoptable(x),
    );
    if (next.attemptId === ctx.attemptId) out.push(next);
  }
  return out;
}

/** One row this attempt wrote, and the outcome of its grant (absent when the grant call threw). */
export interface OwnGrant {
  row: GrantIntent;
  result?: AccessRequestGrantResult;
}

/**
 * What a STOPPED approval revokes: exactly the rows this attempt wrote, still
 * owned by this attempt, whose grant this attempt created, whoever holds the
 * request now. Each row is re-read first:
 *   - adopted by another approval   → kept ({@link ADOPTED});
 *   - still owned                   → this attempt's own outcome is written
 *     over a row the reconciler resolved meanwhile ({@link takesOutcome}), and
 *     a created grant is revoked and its row marked `revoked`;
 *   - owned, grant outcome unknown  → kept ({@link OUTCOME_UNKNOWN});
 *   - rows unreadable               → every landed grant is kept
 *     ({@link UNCONFIRMED}).
 * A row adopted between the re-read and the revoke is re-granted at once and
 * the new assignment written onto it, so the adopter's completed request keeps
 * the grant. `record` writes the grants to the entitlement ledger before any
 * revoke (`restore` for a re-granted one), so a kept grant is named as recorded
 * only when it is.
 */
export async function revokeOwnIntents(
  c: IntentContainer,
  ctx: IntentContext,
  own: OwnGrant[],
  revokeCtx: Pick<LandedGrantContext, 'requesterId' | 'requesterUpn' | 'permission'>,
  session: SessionPayload,
  hooks: {
    record: (rs: AccessRequestGrantResult[]) => Promise<LedgerRecord[]>;
    restore: (rs: AccessRequestGrantResult[]) => Promise<LedgerRecord[]>;
  },
): Promise<{ revoked: AccessRequestGrantResult[]; kept: AccessRequestGrantResult[]; ledger: LedgerRecord[] }> {
  const landed = (o: OwnGrant) => !o.result || (o.result.status === 'active' && o.result.created !== false);
  let stored: Map<string, GrantIntent>;
  try {
    stored = new Map((await listGrantIntents(c, ctx.tenantId, ctx.requestId)).map((r) => [r.id, r]));
  } catch {
    const kept = own.filter(landed).map((o) => ({ ...(o.result || intentAsResult(o.row)), detail: UNCONFIRMED }));
    const ledger = await hooks.record(own.filter((o) => o.result && landed(o)).map((o) => o.result!));
    return { revoked: [], kept, ledger };
  }
  const kept: AccessRequestGrantResult[] = [];
  const candidates: Array<{ row: GrantIntent; result: AccessRequestGrantResult; fix: Partial<GrantIntent> }> = [];
  for (const o of own) {
    const row = stored.get(o.row.id) || o.row;
    if (row.attemptId !== ctx.attemptId) {
      if (landed(o) && o.result) kept.push({ ...o.result, detail: ADOPTED });
      continue;
    }
    if (!o.result) {
      if (row.state === 'pending') kept.push({ ...intentAsResult(row), detail: OUTCOME_UNKNOWN });
      continue;
    }
    const fix = takesOutcome(row, o.result) ? withOutcome(row, o.result) : {};
    const eff: GrantIntent = { ...row, ...fix };
    if (eff.state !== 'active') continue;
    candidates.push({ row, result: intentAsResult(eff), fix });
  }
  const ledger = await hooks.record(candidates.map((x) => x.result));
  const out = await revokeLandedGrants(revokeCtx, candidates.map((x) => x.result), session);
  kept.push(...out.kept);
  const revoked: AccessRequestGrantResult[] = [];
  const by = session.claims.upn || session.claims.oid;
  for (const g of out.revoked) {
    const x = candidates.find((y) => key(y.row) === key(g))!;
    let marked: GrantIntent | undefined;
    try {
      marked = await patchIntent(
        c, x.row, { ...x.fix, state: 'revoked', revokedAt: nowIso(), revokedBy: by },
        (r) => r.attemptId === ctx.attemptId && r.state !== 'revoked',
      );
    } catch { /* the revoke itself happened; the row is reported below as revoked */ }
    if (!marked || marked.attemptId === ctx.attemptId) {
      revoked.push(g);
      continue;
    }
    // Adopted between the re-read and the revoke: put the grant back for the
    // approval that adopted it.
    const again = grantResult(await enforceAccessGrant({
      principalId: ctx.principalId, principalName: ctx.principalName, principalType: 'User',
      scopeType: g.scopeType as AccessScopeType, scopeRef: g.scopeRef, permission: ctx.permission,
    }).catch((e: any) => ({ status: 'error' as const, detail: String(e?.message || e).slice(0, 200) })), g.scopeType as AccessScopeType, g.scopeRef);
    if (again.status !== 'active') {
      revoked.push({ ...g, detail: `Removed while another approval was taking it over, and could not be granted again: ${again.detail || again.status}` });
      continue;
    }
    try {
      await patchIntent(c, marked, { ...settledFields(again), detail: ADOPTED }, (r) => r.state !== 'revoked');
    } catch { /* the grant is back in place; the row keeps the adopted outcome */ }
    const back = await hooks.restore([again]);
    ledger.push(...back);
    kept.push({ ...again, detail: ADOPTED });
  }
  return { revoked, kept, ledger };
}
