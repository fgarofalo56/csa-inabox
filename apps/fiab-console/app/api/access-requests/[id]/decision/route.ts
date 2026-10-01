/**
 * POST /api/access-requests/[id]/decision — advance the F16 approval workflow.
 *
 * Body: { decision: 'approved' | 'denied', reason?: string }
 *
 * State machine (tier advances on approval; denial closes at any tier):
 *   open · manager         + approved → privacy        (open)
 *   open · privacy         + approved → approver        (open)
 *   open · approver        + approved → access-provider (open)
 *   open · access-provider + approved → enforceAccessGrant() on every scope:
 *        active  → status: completed, subscribedAt set, requester notified,
 *                  enforcement.roleAssignmentId = REAL ARM role assignment id.
 *        pending → stays at access-provider (honest infra/config gate surfaced).
 *        error   → stays at access-provider, 502 with the grant error.
 *        Every grant is written to the GRANT LEDGER before it is made and
 *        settled after (lib/access/grant-intents.ts), and every grant that
 *        lands is recorded in the entitlement ledger, on a mixed result too
 *        (lib/access/landed-grants.ts).
 *   open · ANY tier        + denied   → status: denied, deniedAt, denialReason;
 *        grants the request's grant ledger says it created are revoked.
 *
 * The grant scope is derived at the final tier from the requested asset's own
 * record (lib/access/request-asset.ts) — its bound output ports, the item's
 * own store, or the item itself. If that differs from the scopes recorded when
 * the request was made (what the approvers reviewed), the approval is refused
 * with 409 `targets_changed`, naming the cause per scope (one
 * `predates_recording` change for a request that recorded no scopes), and the
 * request stays open.
 * An access-package leg keeps the scope its package defines.
 *
 * One grant or revoke at a time per request: a final approval, and a denial,
 * take the same short lease on the request document (an etag-conditioned write
 * of `grantLeaseUntil`) before they grant or revoke, renew it (etag-conditioned)
 * after each scope, and release it with the final write, or when they stop. A
 * second decision while the lease is held is refused with 409
 * `grant_in_progress`, which says when the hold expires. The lease bounds how
 * long a stalled decision blocks others; correctness rests on the grant
 * ledger, not on its length:
 *   - a grant is never made before its ledger row is written, so a grant is
 *     never live and recorded nowhere;
 *   - a decision that stops after granting (a renewal, a ledger settle or the
 *     final write found the request changed, a store failed, or a grant call
 *     threw) revokes exactly the grants it made itself, whoever holds the
 *     request now, unless an approval that completed the request adopted them —
 *     409 `request_changed`, or 503 `grant_interrupted` for a failure; it never
 *     revokes another attempt's grants;
 *   - a denial revokes from the ledger, every attempt's created grants, after
 *     resolving rows a stopped decision left `pending` from the store itself.
 * The scheduled access sweep resolves rows nobody decided on again.
 * Separate requests for the same principal and scope are not serialized with
 * each other.
 *
 * Every decision writes an audit-log entry (itemId = requestId). No Fabric
 * dependency: the grant is a real Azure ARM Storage / Synapse SQL / ADX
 * data-plane assignment via lib/azure/rbac-client.
 *
 * PARTITION KEY — read this before changing the point read.
 *
 * `access-request-workflow` is partitioned by `/tenantId`, which carries
 * `tenantScopeId(session)` = `claims.tid || claims.oid` (the Entra TENANT), NOT
 * the caller's `oid`. This route actions a document a DIFFERENT user wrote, so
 * a point read keyed on the approver's `oid` misses the requester's partition
 * and 404s before any approver logic runs — which is exactly what it did until
 * this adoption.
 *
 * AUTHORIZATION — the oid-keyed partition used to confine every caller to their
 * own rows. That accident, not a check, was what stopped one user actioning
 * another's request; it also meant the only person who COULD action a request
 * was its requester (self-approval). Both are now explicit:
 *   1. approval authority   — tenant admin / capability / named approver,
 *      enforced STRUCTURALLY by the `withApprovalAuthority` wrapper so there is
 *      no returned-value gate to drop;
 *   2. separation of duties — a requester never actions their own request
 *      (needs the loaded doc, so it runs right after the point read);
 *   3. `actorMayApprove`    — per-stage named-approver enforcement (unchanged).
 *
 * Route-toolkit: withApprovalAuthority (R3).
 */
import { NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withApprovalAuthority } from '@/lib/api/route-toolkit';
import {
  accessRequestWorkflowContainer, auditLogContainer, notificationsContainer,
} from '@/lib/azure/cosmos-client';
import { enforceAccessGrant } from '@/lib/azure/rbac-client';
import {
  TIER_APPROVAL_KEY, TIER_LABEL,
  type AccessRequestDoc, type AccessRequestEnforcement, type AccessRequestGrantResult,
  type AccessRequestGrantTarget, type ApprovalStep, type ApprovalTier,
} from '@/lib/types/access-request-workflow';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';
import { recordAssignment } from '@/lib/access/assignment-ledger';
import { effectiveStages, nextStage, actorMayApprove } from '@/lib/access/approval-policy';
import { checkSelfApproval } from '@/lib/access/approval-authority';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { computeExpiry } from '@/lib/access/expiry';
import { deriveRequestTargets, loadCatalogItem } from '@/lib/access/request-asset';
import {
  denialKeptWarning, grantLedgerId, grantResult, keptTail, mergeGrantResults, recordLandedGrants,
  type LandedGrantContext, type LedgerRecord,
} from '@/lib/access/landed-grants';
import {
  GRANT_LEASE_MS, adoptGrantIntents, newAttemptId, reconcileRequestIntents, revokeIntents, revokeOwnIntents,
  settleGrantIntent, writeGrantIntent, type GrantIntent, type IntentContext, type OwnGrant,
} from '@/lib/access/grant-intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * How the re-derived `current` scopes differ from the ones the approvers
 * reviewed; empty when they match (order-insensitive, one-to-one).
 *
 * A reviewed scope with an EMPTY scopeRef was a store not yet bound when the
 * request was made; it is satisfied by a current scope of the same type from
 * the same source (the same item, or the same output port) that also names the
 * same store the port named then (`declaredRef`), which is that store as Loom
 * has since recorded it. Every other reviewed scope must reappear exactly.
 *
 * What is left over is paired by source and named by cause:
 *   predates_recording   — an unbound output-port scope recorded with no
 *                          `declaredRef` (every port scope carries one now, so
 *                          the request was recorded before they existed);
 *   port_unbound         — a port bound then, bound to no store now;
 *   port_rebound         — a port bound to a different store now;
 *   declared_ref_changed — a port unbound then, naming a different store now;
 *   scope_removed / scope_added — a scope with no counterpart.
 */
type TargetCause =
  | 'predates_recording' | 'port_unbound' | 'port_rebound' | 'declared_ref_changed'
  | 'scope_removed' | 'scope_added';

interface TargetChange {
  cause: TargetCause;
  source?: string;
  reviewed?: AccessRequestGrantTarget;
  current?: AccessRequestGrantTarget;
}

function compareTargets(current: AccessRequestGrantTarget[], reviewed: AccessRequestGrantTarget[]): TargetChange[] {
  const open = [...reviewed];
  const unmatched: AccessRequestGrantTarget[] = [];
  for (const t of current) {
    let i = open.findIndex((r) => !!r.scopeRef && r.scopeType === t.scopeType && r.scopeRef === t.scopeRef);
    if (i < 0) {
      i = open.findIndex((r) => !r.scopeRef && r.scopeType === t.scopeType
        && (r.source || '') === (t.source || '')
        && (r.declaredRef || '') === (t.declaredRef || ''));
    }
    if (i < 0) unmatched.push(t);
    else open.splice(i, 1);
  }
  const changes: TargetChange[] = [];
  for (const r of open) {
    const src = r.source || '';
    const j = src ? unmatched.findIndex((t) => (t.source || '') === src) : -1;
    const partner = j >= 0 ? unmatched.splice(j, 1)[0] : undefined;
    let cause: TargetCause;
    if (!r.scopeRef && !r.declaredRef && src.startsWith('output port')) cause = 'predates_recording';
    else if (!partner) cause = 'scope_removed';
    else if (r.scopeRef && !partner.scopeRef) cause = 'port_unbound';
    else if (!r.scopeRef && r.declaredRef && (partner.declaredRef || partner.scopeRef) !== r.declaredRef) cause = 'declared_ref_changed';
    else cause = 'port_rebound';
    changes.push({ cause, ...(src ? { source: src } : {}), reviewed: r, ...(partner ? { current: partner } : {}) });
  }
  for (const t of unmatched) {
    changes.push({ cause: 'scope_added', ...(t.source ? { source: t.source } : {}), current: t });
  }
  return changes;
}

/** The store a scope names: its bound ref, else the name its port declared. */
const storeName = (t: AccessRequestGrantTarget) =>
  t.scopeRef ? `${t.scopeType} '${t.scopeRef}'` : t.declaredRef ? `${t.scopeType} '${t.declaredRef}' (not bound yet)` : `an unbound ${t.scopeType} scope`;

/** One sentence per change, for the approver. */
function describeChange(ch: TargetChange, assetName: string): string {
  const r = ch.reviewed;
  const t = ch.current;
  switch (ch.cause) {
    case 'predates_recording':
      return `${ch.source ? `${ch.source}: t` : 'T'}his request was made before targets were recorded; deny it and ask the requester to request access again.`;
    case 'port_unbound':
      return `${ch.source} was bound to ${storeName(r!)} when this request was made and `
        + (t?.declaredRef
          ? `now names '${t.declaredRef}', which no store in the workspace holds.`
          : 'now names no store.');
    case 'port_rebound':
      return `${ch.source} ${r!.scopeRef ? 'was bound to' : 'named'} ${storeName(r!)} when this request was made and is bound to ${storeName(t!)} now.`;
    case 'declared_ref_changed':
      return `${ch.source} named ${storeName(r!)} when this request was made and names ${storeName(t!)} now.`;
    case 'scope_removed':
      return `${storeName(r!)}${ch.source ? ` (${ch.source})` : ''} is no longer part of "${assetName}".`;
    case 'scope_added':
      // Reached only for a request that recorded its scopes (a request that
      // did not is one predates_recording change), so "after" is established.
      return `${storeName(t!)}${ch.source ? ` (${ch.source})` : ''} was added to "${assetName}" after this request was made.`;
  }
}

/** Every field a scope row renders with. */
const targetView = (t: AccessRequestGrantTarget) => ({
  scopeType: t.scopeType,
  scopeRef: t.scopeRef,
  ...(t.source ? { source: t.source } : {}),
  ...(t.declaredRef ? { declaredRef: t.declaredRef } : {}),
});

function targetsChanged(
  assetName: string, changes: TargetChange[],
  reviewed: AccessRequestGrantTarget[], current: AccessRequestGrantTarget[],
) {
  const onlyPredates = changes.every((ch) => ch.cause === 'predates_recording');
  const error = (onlyPredates
    ? `"${assetName}" cannot be approved as reviewed. `
    : `"${assetName}" is not bound to the storage that was reviewed. `)
    + changes.map((ch) => describeChange(ch, assetName)).join(' ')
    + (onlyPredates ? '' : ' Approving it would grant access nobody reviewed. Deny it and ask the requester to request access again.');
  const suggestedDenyReason = onlyPredates
    ? `This request was made before Loom recorded which storage it covers, so it cannot be approved as reviewed. Please request access to "${assetName}" again.`
    : `The storage behind "${assetName}" changed after you requested access, so this request cannot be approved as reviewed. Please request access again.`;
  return NextResponse.json(
    {
      ok: false,
      code: 'targets_changed',
      error,
      changes: changes.map((ch) => ({
        cause: ch.cause,
        ...(ch.source ? { source: ch.source } : {}),
        ...(ch.reviewed ? { reviewed: targetView(ch.reviewed) } : {}),
        ...(ch.current ? { current: targetView(ch.current) } : {}),
      })),
      reviewed: reviewed.map(targetView),
      current: current.map(targetView),
      suggestedDenyReason,
    },
    { status: 409 },
  );
}

type RequestContainer = Awaited<ReturnType<typeof accessRequestWorkflowContainer>>;

/**
 * Take (or renew) the per-request lease: write `grantLeaseUntil` onto the
 * document as it was read, conditioned on `etag` — the etag of that read, or of
 * this decision's last lease write. The lease lasts GRANT_LEASE_MS; a decision
 * renews it after every scope, so it bounds a single scope's grant or revoke.
 * Returns the leased document's etag and expiry, or null when another write
 * got there first (412).
 */
async function takeGrantLease(
  c: RequestContainer, id: string, pk: string, asRead: AccessRequestDoc, etag: string | undefined,
): Promise<{ etag: string; until: string } | null> {
  if (!etag) {
    throw new Error('The access request was read without an etag, so its grant could not be serialized; nothing was granted.');
  }
  const until = new Date(Date.now() + GRANT_LEASE_MS).toISOString();
  try {
    const { resource } = await c.item(id, pk).replace(
      { ...asRead, grantLeaseUntil: until },
      { accessCondition: { type: 'IfMatch', condition: etag } },
    );
    return { etag: String((resource as any)?._etag || ''), until };
  } catch (e: any) {
    if (isPreconditionFailed(e)) return null;
    throw e;
  }
}

/** HH:MM:SS of an ISO-8601 instant, for "until 12:04:31 UTC". */
const utcTime = (iso: string | undefined) => (iso || '').slice(11, 19) || 'an unknown time';

function grantInProgress(until: string | undefined) {
  return NextResponse.json(
    {
      ok: false,
      code: 'grant_in_progress',
      error: `Another decision holds this request until ${utcTime(until)} UTC. It is granting or removing access, `
        + 'or it stopped without releasing its hold. Reload after that time to see its result, or decide again.',
      ...(until ? { holdUntil: until } : {}),
    },
    { status: 409 },
  );
}

function requestChanged() {
  return NextResponse.json(
    {
      ok: false,
      code: 'request_changed',
      error: 'This request was changed by another decision while this one was being made. Reload it and decide again.',
    },
    { status: 409 },
  );
}

const isPreconditionFailed = (e: any) => e?.code === 412 || e?.statusCode === 412;

const STORE_STATUS_LABEL: Record<number, string> = {
  408: 'timed out', 429: 'throttled', 500: 'internal error', 502: 'bad gateway', 503: 'unavailable', 504: 'timed out',
};

/**
 * A failed call as the approver is told it: who answered, the status code and
 * its class, never the service's own message (which can quote internal detail).
 */
function describeStoreError(e: any, who = 'the request store'): string {
  const code = [e?.code, e?.statusCode, e?.status].find((v) => typeof v === 'number');
  if (code === undefined) return 'an unexpected error';
  return `${who} answered ${code}${STORE_STATUS_LABEL[code] ? `, ${STORE_STATUS_LABEL[code]}` : ''}`;
}

/**
 * A grant as a 409/503 body lists it: its scope, the id of its row in the
 * Access report (the entitlement ledger) and whether that row was written, and
 * why it stayed.
 */
function grantView(requesterId: string, r: AccessRequestGrantResult, ledger?: LedgerRecord[]) {
  const accessReportId = grantLedgerId(requesterId, r);
  const row = ledger?.find((l) => l.ledgerId === accessReportId);
  return {
    scopeType: r.scopeType,
    scopeRef: r.scopeRef,
    accessReportId,
    ...(r.roleName ? { roleName: r.roleName } : {}),
    ...(r.roleAssignmentId ? { roleAssignmentId: r.roleAssignmentId } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(row ? { recorded: row.recorded } : {}),
  };
}

const scopeList = (rs: AccessRequestGrantResult[]) => rs.map((r) => `${r.scopeType} ${r.scopeRef}`).join(', ');

/** One enforcement summary over every per-scope grant: active only when all are. */
function summarizeGrants(results: AccessRequestGrantResult[]): AccessRequestEnforcement {
  if (results.length === 1) {
    const { scopeType: _t, scopeRef: _r, created: _c, ...only } = results[0];
    return only;
  }
  const status = results.some((r) => r.status === 'error') ? 'error'
    : results.some((r) => r.status === 'pending') ? 'pending' : 'active';
  const roles = results.map((r) => r.roleName).filter(Boolean);
  const details = results
    .filter((r) => r.status !== 'active' && r.detail)
    .map((r) => `${r.scopeType} ${r.scopeRef}: ${r.detail}`);
  return {
    status,
    ...(roles.length ? { roleName: Array.from(new Set(roles)).join(', ') } : {}),
    ...(results[0].roleAssignmentId ? { roleAssignmentId: results[0].roleAssignmentId } : {}),
    ...(details.length ? { detail: details.join(' ') } : {}),
  };
}

export const POST = withApprovalAuthority<{ id: string }>(async (req, { session: s, params }) => {
  const { id } = params;
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });

  const body = await req.json().catch(() => ({} as any));
  const decision = body?.decision === 'denied' ? 'denied' : body?.decision === 'approved' ? 'approved' : null;
  if (!decision) {
    return NextResponse.json({ ok: false, error: 'decision must be "approved" or "denied"' }, { status: 400 });
  }
  const reason = String(body?.reason || '').trim().slice(0, 500);
  if (decision === 'denied' && !reason) {
    return NextResponse.json({ ok: false, error: 'a reason is required to deny a request' }, { status: 400 });
  }

  const tenantId = tenantScopeId(s);
  const now = new Date().toISOString();

  try {
    const c = await accessRequestWorkflowContainer();
    let doc: AccessRequestDoc;
    // The document as read (before this decision changes it) and its etag: the
    // grant lease below is written from these.
    let asRead: AccessRequestDoc;
    let readEtag: string | undefined;
    try {
      const { resource } = await c.item(id, tenantId).read<AccessRequestDoc>();
      if (!resource) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      doc = resource;
      asRead = { ...resource };
      readEtag = (resource as any)._etag;
    } catch (e: any) {
      if (e?.code === 404) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      throw e;
    }

    if (doc.status !== 'open') {
      return NextResponse.json(
        { ok: false, error: `request is already ${doc.status} and can no longer be actioned` },
        { status: 409 },
      );
    }
    // Another decision holds the request (a final approval granting, or a
    // denial revoking): no other decision until it has written its result.
    if (doc.grantLeaseUntil && Date.parse(doc.grantLeaseUntil) > Date.now()) {
      return grantInProgress(doc.grantLeaseUntil);
    }

    // ── Separation of duties. Absolute — it holds even for a tenant admin, so
    // it is checked here rather than folded into the wrapper's authority test.
    // It needs the loaded document (the requester's identity), which is why it
    // cannot live in `withApprovalAuthority`. Before the partition fix, a
    // self-approval was the ONLY decision that could ever succeed, because the
    // oid-keyed point read could only find the caller's own documents.
    const sod = checkSelfApproval(s, doc);
    if (!sod.allowed) {
      return NextResponse.json(
        { ok: false, error: sod.reason, code: 'self_approval_forbidden', remediation: sod.remediation },
        { status: 403 },
      );
    }

    const currentTier = doc.tier;
    // W2 — configurable approver enforcement. No-op for legacy requests and for
    // policies that don't enforce named approvers; tenant admins always pass.
    const approverCheck = actorMayApprove(doc.approvalPlan, currentTier, s.claims.oid, isTenantAdmin(s));
    if (!approverCheck.allowed) {
      return NextResponse.json({ ok: false, error: approverCheck.reason || 'You are not an approver for this stage.' }, { status: 403 });
    }
    const step: ApprovalStep = {
      decision,
      by: s.claims.upn || s.claims.oid,
      byOid: s.claims.oid,
      at: now,
      ...(reason ? { reason } : {}),
    };
    (doc as any)[TIER_APPROVAL_KEY[currentTier]] = step;

    let httpStatus = 200;
    let ok = true;
    let warning: string | undefined;
    /** This decision's lease on the request while it holds one: the etag of its last lease write, and its expiry. */
    let leaseEtag: string | undefined;
    let leaseUntil: string | undefined;
    /**
     * Why this decision stopped when a store call failed (not a 412): a short
     * classified reason, never the service's own message. When set, the
     * decision answers 503 `grant_interrupted`.
     */
    let stopReason = '';
    /** The requester's notification — sent only once the decision is recorded. */
    let notice: Record<string, unknown> | undefined;
    /** The eligible (PIM) ledger row — written only once the decision is recorded. */
    let eligibleRow: Parameters<typeof recordAssignment>[0] | undefined;
    /** The grants to record in the ledger once the decision is recorded, and their expiry. */
    let toRecord: { results: AccessRequestGrantResult[]; expiresAt: string | null } | undefined;
    /** What to answer when the final write finds the request changed (412). */
    let onLost: () => Promise<NextResponse> = async () => requestChanged();
    /**
     * What to answer when the final write fails otherwise, for a decision that
     * granted or revoked (it must not leave that unreported as a 500).
     */
    let onStopped: (() => Promise<NextResponse>) | undefined;
    /** Grants this approval made on this attempt. */
    const fresh: AccessRequestGrantResult[] = [];
    /** The grant-ledger rows this attempt wrote, each with the outcome of its grant (none when the grant call threw). */
    const mine: OwnGrant[] = [];
    const admin = isTenantAdmin(s);
    const intentCtx: IntentContext = {
      tenantId,
      requestId: doc.id,
      attemptId: newAttemptId(),
      principalId: doc.requesterId,
      principalName: doc.requesterUpn,
      permission: doc.permission,
      assetName: doc.assetName,
      by: s.claims.upn || s.claims.oid,
    };
    const ledgerCtx = (expiresAt: string | null): LandedGrantContext => ({
      requestId: doc.id,
      requesterId: doc.requesterId,
      requesterUpn: doc.requesterUpn,
      tenantId,
      assetName: doc.assetName,
      permission: doc.permission,
      grantedBy: s.claims.upn || s.claims.oid,
      expiresAt,
    });
    const revokeCtx = { requesterId: doc.requesterId, requesterUpn: doc.requesterUpn, permission: doc.permission };
    const view = (rs: AccessRequestGrantResult[], ledger?: LedgerRecord[]) => rs.map((r) => grantView(doc.requesterId, r, ledger));

    /** Take this decision's lease, or answer with the 409 that says who holds the request. */
    const acquireLease = async (): Promise<NextResponse | null> => {
      const leased = await takeGrantLease(c, id, tenantId, asRead, readEtag);
      if (leased !== null) {
        leaseEtag = leased.etag;
        leaseUntil = leased.until;
        return null;
      }
      const { resource: latest } = await c.item(id, tenantId).read<AccessRequestDoc>();
      return latest?.grantLeaseUntil && Date.parse(latest.grantLeaseUntil) > Date.now()
        ? grantInProgress(latest.grantLeaseUntil)
        : requestChanged();
    };
    /**
     * Renew the lease, conditioned on this decision's last lease write. False
     * when another write changed the request since (412: the lease is no longer
     * this decision's), or when the renewal itself failed (`stopReason`); the
     * caller stops either way.
     */
    const renewLease = async (): Promise<boolean> => {
      try {
        const renewed = await takeGrantLease(c, id, tenantId, asRead, leaseEtag);
        if (renewed === null) {
          leaseEtag = undefined;
          return false;
        }
        leaseEtag = renewed.etag;
        leaseUntil = renewed.until;
        return true;
      } catch (e: any) {
        stopReason = `its hold on the request could not be renewed (${describeStoreError(e)})`;
        return false;
      }
    };
    /**
     * Release this decision's hold when it stops, so the next decision is not
     * refused for a hold nobody is using. Returns '' when released (or no longer
     * held), otherwise a sentence giving when the hold expires.
     */
    const releaseLease = async (): Promise<string> => {
      if (!leaseEtag) return '';
      const { grantLeaseUntil: _held, ...unleased } = asRead;
      try {
        await c.item(id, tenantId).replace(unleased, { accessCondition: { type: 'IfMatch', condition: leaseEtag } });
        leaseEtag = undefined;
        return '';
      } catch (e: any) {
        if (isPreconditionFailed(e)) {
          leaseEtag = undefined;
          return '';
        }
        return ` Its hold on the request could not be released and expires at ${utcTime(leaseUntil)} UTC; `
          + 'the request can be decided again after that.';
      }
    };
    /** The answer of a decision that stopped before recording its result. */
    const stopAnswer = async (who: 'approval' | 'denial', text: string, body: Record<string, unknown>) => {
      const hold = await releaseLease();
      return NextResponse.json(
        {
          ok: false,
          code: stopReason ? 'grant_interrupted' : 'request_changed',
          error: (stopReason
            ? `This ${who} stopped and was not recorded: ${stopReason}.`
            : `This request was changed by another decision while this ${who} was being made, so the ${who} was not recorded.`)
            + text + hold,
          ...body,
        },
        { status: stopReason ? 503 : 409 },
      );
    };
    /**
     * A final approval that granted and then stopped: it lost the request (a
     * renewal, a ledger settle or its final write found it changed), a store
     * failed, or a grant call threw. It revokes exactly the grants it made
     * itself, whoever holds the request now — ownership decides, not the
     * request's state — except a grant an approval that completed the request
     * adopted (lib/access/grant-intents.ts, revokeOwnIntents). It never
     * revokes another attempt's grants: those stay with the request, for its
     * completion or its denial.
     */
    const compensate = async (): Promise<NextResponse> => {
      let latest: AccessRequestDoc | undefined;
      try {
        latest = (await c.item(id, tenantId).read<AccessRequestDoc>()).resource;
      } catch { /* the status is only reported */ }
      const out = await revokeOwnIntents(c, intentCtx, mine, revokeCtx, s, {
        record: (rs) => recordLandedGrants(ledgerCtx(null), rs),
        restore: (rs) => recordLandedGrants(
          ledgerCtx(computeExpiry(new Date(), { lifetimeDays: doc.grantLifetimeDays })), rs,
        ),
      });
      return stopAnswer(
        'approval',
        (out.revoked.length ? ` The access it had granted was removed: ${scopeList(out.revoked)}.` : '')
          + keptTail(out.kept, admin, doc.requesterId, out.ledger)
          + ' Reload it to see its current state.',
        { requestStatus: latest?.status ?? null, revoked: view(out.revoked, out.ledger), kept: view(out.kept, out.ledger) },
      );
    };

    if (decision === 'denied') {
      doc.status = 'denied';
      doc.deniedAt = now;
      doc.denialReason = reason;
      doc.deniedAtTier = currentTier;
      // Grants this request created (a partial self-serve grant, or a final
      // approval with a mixed or interrupted result) are revoked with the
      // denial, under the same lease an approval grants under, renewed before
      // each revoke after the first. What to revoke is read from the request's
      // grant ledger — never from the request document, which a stopped
      // approval may not have written — after its stale `pending` rows are
      // resolved from the store. Access the requester held beforehand is left
      // alone.
      const refused = await acquireLease();
      if (refused) return refused;
      let rows: GrantIntent[];
      try {
        rows = await reconcileRequestIntents(c, tenantId, id);
      } catch (e: any) {
        stopReason = `the request's grant records could not be read (${describeStoreError(e)})`;
        return stopAnswer('denial', ' Nothing was revoked. Reload it and decide again.', { revoked: [], kept: [] });
      }
      const out = await revokeIntents(c, rows, revokeCtx, s, { beforeEach: renewLease });
      if (out.aborted) {
        const notAttempted = out.notAttempted.map((r) => ({ ...r, detail: 'Not attempted: the denial stopped before this revoke.' }));
        return stopAnswer(
          'denial',
          (out.revoked.length ? ` It had removed: ${scopeList(out.revoked)}.` : '')
            + ` Not attempted, still in place: ${scopeList(notAttempted)}.`
            + keptTail(out.kept, admin, doc.requesterId)
            + ' Reload it and decide again.',
          { revoked: view(out.revoked), kept: view([...out.kept, ...notAttempted]) },
        );
      }
      if (out.revoked.length) doc.revokedGrants = out.revoked;
      if (out.kept.length) warning = denialKeptWarning(out.kept, admin);
      onLost = async () => stopAnswer(
        'denial',
        (out.revoked.length ? ` It had removed: ${scopeList(out.revoked)}.` : '')
          + keptTail(out.kept, admin, doc.requesterId)
          + ' Reload it and decide again.',
        { revoked: view(out.revoked), kept: view(out.kept) },
      );
      onStopped = onLost;
    } else {
      // Every decision on the request resolves grant-ledger rows a stopped
      // decision left `pending` (best-effort here; a denial and a stopped
      // approval do it themselves and act on the result).
      await reconcileRequestIntents(c, tenantId, id).catch(() => []);
      // W2 — advance over the request's approval-plan snapshot (an ordered subset
      // of the canonical tiers) when present; legacy requests fall back to the
      // full canonical sequence, so behaviour is identical by default.
      const stages = effectiveStages(doc.approvalPlan);
      const nxt = nextStage(stages, currentTier);
      const isFinal = nxt === null;
      if (!isFinal) {
        doc.tier = nxt;
      } else {
        // FINAL tier — the grant scope comes from the asset, never the body.
        // An access-package leg keeps the scope its package defines; every
        // other request re-derives it from the asset's current record, so the
        // grant follows what the asset is bound to at approval time.
        let targets: AccessRequestGrantTarget[];
        if (doc.packageId) {
          targets = [{ scopeType: doc.scopeType, scopeRef: doc.scopeRef }];
        } else {
          const item = await loadCatalogItem(doc.assetId);
          if (!item) {
            return NextResponse.json(
              { ok: false, error: `"${doc.assetName}" no longer exists, so there is nothing to grant. Deny the request to close it.`, code: 'asset_not_found' },
              { status: 409 },
            );
          }
          targets = (await deriveRequestTargets(item, doc.permission))
            .map((t) => ({
              scopeType: t.scopeType, scopeRef: t.scopeRef, source: t.source,
              ...(t.declaredRef ? { declaredRef: t.declaredRef } : {}),
            }));
          // The approvers decided on the scopes recorded when the request was
          // made (`grantTargets`; a request recorded before those existed shows
          // its single `scopeType`/`scopeRef`). If the asset's bindings have
          // changed since, granting now would bind scopes nobody reviewed: the
          // request is refused with 409, naming each change and its cause, and
          // left open, to be denied and requested again against the current
          // bindings. A store that was not bound when the request was made is
          // not a change once it is (`compareTargets`), and the resolved scopes
          // are recorded below.
          const reviewed: AccessRequestGrantTarget[] = doc.grantTargets?.length
            ? doc.grantTargets
            : [{ scopeType: doc.scopeType, scopeRef: doc.scopeRef }];
          let changes = compareTargets(targets, reviewed);
          // A request with no recorded scopes (recorded before `grantTargets`
          // existed) kept whatever scope its request body named, which nothing
          // verified. Any difference is reported as ONE predates-recording
          // change for the whole request: no per-scope "added"/"removed" claim
          // that nothing established.
          if (changes.length && !doc.grantTargets?.length) changes = [{ cause: 'predates_recording' }];
          if (changes.length) return targetsChanged(doc.assetName, changes, reviewed, targets);
          doc.grantTargets = targets;
        }
        doc.scopeType = targets[0].scopeType;
        doc.scopeRef = targets[0].scopeRef;
        if (doc.activationRequired) {
          // W3 (PIM) — final approval yields an ELIGIBLE assignment (no RBAC yet);
          // the requester activates it for a bounded window from the Access report.
          // The eligible row and the notification follow the recorded decision.
          doc.status = 'completed';
          eligibleRow = {
            principalId: doc.requesterId,
            principalUpn: doc.requesterUpn,
            principalType: 'User',
            tenantId,
            resourceType: doc.scopeType,
            resourceRef: doc.scopeRef,
            resourceName: doc.assetName,
            role: doc.scopeType,
            permission: doc.permission,
            source: 'direct',
            sourceRef: doc.id,
            grantedBy: s.claims.upn || s.claims.oid,
            state: 'eligible',
            expiresAt: null,
            activationWindowHours: doc.activationWindowHours ?? null,
          };
          notice = {
            id: crypto.randomUUID(),
            userId: doc.requesterId,
            title: `Access eligible: ${doc.assetName}`,
            body: `Your access to ${doc.assetName} is approved as ELIGIBLE. Activate it from the Access report to receive a time-bounded grant.`,
            severity: 'info',
            link: '/admin/access-report',
            read: false,
            createdAt: now,
          };
        } else {
        // One grant at a time per request (see the header): each scope is
        // granted under this lease, which is renewed after each one. Every
        // grant is written to the grant ledger BEFORE it is made, and settled
        // after (lib/access/grant-intents.ts).
        const refused = await acquireLease();
        if (refused) return refused;
        onStopped = compensate;
        // Provision the REAL Azure RBAC grant on every backing scope.
        for (const t of targets) {
          if (!t.scopeRef) {
            // A store not bound yet (an unbound store item, or an output port
            // naming no store of the product's workspace) — nothing to
            // bind to. Pending, never a wider (workspace) grant in its place.
            fresh.push({
              status: 'pending', scopeType: t.scopeType, scopeRef: '', created: false,
              detail: `"${doc.assetName}" has no ${t.scopeType} recorded by Loom for ${t.source || 'it'} yet. Once that storage is bound in its workspace, approve again.`,
            });
            continue;
          }
          let row: GrantIntent;
          try {
            row = await writeGrantIntent(c, intentCtx, { scopeType: t.scopeType, scopeRef: t.scopeRef });
          } catch (e: any) {
            stopReason = `the next grant could not be recorded before it was made, so it was not made (${describeStoreError(e)})`;
            return compensate();
          }
          let r: Awaited<ReturnType<typeof enforceAccessGrant>>;
          try {
            r = await enforceAccessGrant({
              principalId: doc.requesterId,
              principalName: doc.requesterUpn,
              principalType: 'User',
              scopeType: t.scopeType,
              scopeRef: t.scopeRef,
              permission: doc.permission,
            });
          } catch (e: any) {
            // The grant client answers most failures itself; one that throws
            // leaves whether the grant landed unknown. Its row stays `pending`
            // for the scheduled sweep, and the hold is released.
            mine.push({ row });
            stopReason = `a grant call failed (${describeStoreError(e, 'the grant service')}), so whether it landed is unknown`;
            return compensate();
          }
          const g = grantResult(r, t.scopeType, t.scopeRef);
          fresh.push(g);
          mine.push({ row, result: g });
          const settled = await settleGrantIntent(c, row, g);
          if (!settled.ok) {
            // Lost: the row was resolved by another decision, so this one's
            // lease had lapsed. Otherwise the store failed.
            if (!settled.lost) stopReason = `a grant could not be recorded after it was made (${describeStoreError(settled.error)})`;
            return compensate();
          }
          mine[mine.length - 1].row = settled.row;
          // Renewed between scopes and before the final write: a failed renewal
          // means the request may have been decided otherwise meanwhile.
          if (!(await renewLease())) return compensate();
        }
        onLost = compensate;
        // A retry keeps the record of grants an earlier attempt created.
        const results = mergeGrantResults(doc.grantResults, fresh);
        const grant = summarizeGrants(results);
        doc.enforcement = grant;
        if (targets.length > 1 || doc.grantResults) doc.grantResults = results;
        const grantExpiry = grant.status === 'active'
          ? computeExpiry(new Date(now), { lifetimeDays: doc.grantLifetimeDays })
          : null;
        // Entitlement ledger (access-governance W1): every grant that LANDED is
        // recorded with its role-assignment id once the decision is recorded —
        // on a mixed result too, so a grant that landed is in the who-has-access
        // report and a later denial revokes it (lib/access/landed-grants.ts).
        toRecord = { results, expiresAt: grantExpiry };
        if (grant.status === 'active') {
          // This approval completes the request. A scope it found already held
          // may be held because another attempt of this request granted it, and
          // that attempt revokes its own grants when it stops: adopt those rows
          // first, so the grant this completion relies on stays
          // (lib/access/grant-intents.ts, adoptGrantIntents).
          for (const g of fresh) {
            if (g.status !== 'active' || g.created === true || !g.scopeRef) continue;
            try {
              await adoptGrantIntents(c, intentCtx, g);
            } catch (e: any) {
              stopReason = `a grant another attempt made for this request could not be taken over (${describeStoreError(e)})`;
              return compensate();
            }
          }
          doc.status = 'completed';
          doc.subscribedAt = now;
          // Notify the requester they're now a subscriber (after the write below).
          notice = {
            id: crypto.randomUUID(),
            userId: doc.requesterId,
            title: `Access granted: ${doc.assetName}`,
            body:
              `Your ${doc.permission} access to ${doc.assetName} is approved and provisioned` +
              (grant.roleName ? ` (${grant.roleName})` : '') +
              (grant.roleAssignmentId ? `. Role assignment: ${grant.roleAssignmentId}` : '') + '.',
            severity: 'success',
            link: doc.itemType ? `/items/${doc.itemType}/${doc.assetId}` : null,
            read: false,
            createdAt: now,
          };
        } else {
          // pending (honest config/infra gate) or error — stay at the final tier
          // so the access provider can fix the scope/infra and retry. The step
          // is recorded but the request is NOT completed (no-vaporware).
          delete (doc as any)[TIER_APPROVAL_KEY[currentTier]];
          ok = grant.status !== 'error';
          httpStatus = grant.status === 'error' ? 502 : 200;
          warning = grant.detail;
        }
        }
      }
    }

    // Written over the document this decision read (or leased) only: a 412
    // means another decision changed it first, and this one is not recorded.
    // Any other failure, for a decision that granted or revoked, stops it the
    // same way a failed renewal does (503 grant_interrupted, grants undone or
    // listed) rather than a bare 500. Writing the result releases the lease.
    delete (doc as any).grantLeaseUntil;
    const writeEtag = leaseEtag || readEtag;
    if (!writeEtag) {
      throw new Error('The access request was read without an etag, so the decision was not recorded.');
    }
    try {
      await c.item(id, tenantId).replace(doc, { accessCondition: { type: 'IfMatch', condition: writeEtag } });
    } catch (e: any) {
      if (isPreconditionFailed(e)) {
        leaseEtag = undefined;
        return onLost();
      }
      if (!onStopped) throw e;
      stopReason = `its result could not be written (${describeStoreError(e)})`;
      return onStopped();
    }

    // The decision is recorded: now the ledger rows and the requester's notice.
    if (toRecord) await recordLandedGrants(ledgerCtx(toRecord.expiresAt), toRecord.results);
    if (eligibleRow) await recordAssignment(eligibleRow);
    if (notice) {
      const nc = await notificationsContainer();
      await nc.items.create(notice);
    }

    // Audit trail — one entry per decision (itemId = requestId).
    const al = await auditLogContainer();
    const verb = decision === 'approved' ? 'approved' : 'denied';
    await al.items.create({
      id: crypto.randomUUID(),
      itemId: id,
      itemType: 'access-request',
      action: `${verb}-by-${currentTier}`,
      summary:
        `${s.claims.upn || s.claims.oid} ${verb} access to "${doc.assetName}" at the ` +
        `${TIER_LABEL[currentTier]} tier${reason ? ` — "${reason}"` : ''}` +
        (doc.status === 'completed' && doc.enforcement?.roleAssignmentId
          ? ` · granted ${doc.enforcement.roleName} (${doc.enforcement.roleAssignmentId})`
          : ''),
      upn: s.claims.upn || s.claims.oid,
      at: now,
    });

    return NextResponse.json(
      { ok, request: doc, enforcement: doc.enforcement, ...(warning ? { warning } : {}) },
      { status: httpStatus },
    );
  } catch (e: any) {
    return apiServerError(e);
  }
});
