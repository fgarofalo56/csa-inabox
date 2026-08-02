/**
 * LU-4 (remediation) — audit for the Unity Catalog **grants** surface: both the
 * access-review READ and the grant-change WRITE decision.
 *
 * `GET /api/databricks/unity-catalog/grants?effective=true[&principal=…]` is a
 * privileged read: it enumerates who holds what on a securable, and with a
 * `principal` filter it additionally resolves that principal's transitive Entra
 * group membership using the Console UAMI's Graph app role. That is an
 * access-review + directory-membership primitive, so every call — ALLOWED and
 * DENIED alike — leaves a record. A denial with no trace is how an enumeration
 * sweep goes unnoticed.
 *
 * `PATCH …/grants` (#2692) is the WRITE half of the same surface: it rewrites
 * WHO HOLDS WHICH PRIVILEGE on a securable, so it is tenant-admin-gated at the
 * route and its authorization decision is recorded here with the same
 * allowed-AND-denied discipline. The APPLIED call additionally lands on the LU-3
 * choke-point trail (`lib/azure/unity-audit.ts`, `grant.update`) with the
 * upstream outcome; a REFUSED call never reaches a transport, so this module is
 * the only place a denial can be recorded at all.
 *
 * Writes to the shared Cosmos `audit-log` container as `kind:'uc-access-review'`
 * with `tenantId` = the caller's Entra TENANT id, which is what the Admin →
 * Audit Logs reader scopes on (`app/api/admin/audit-logs/route.ts` matches the
 * viewer's `oid` OR `tid`, so tenant-scoped rows from this writer and from
 * `object-security-audit.ts` are actually retrievable — they were not before).
 * The row is ALSO fanned out through `emitAuditEvent`, so it reaches
 * LoomAudit_CL / the outbound webhook stream and a sweep is visible to the SIEM,
 * not only to an operator running a raw Cosmos query. Best-effort on both
 * sinks: a write miss NEVER fails the guarded request.
 *
 * Azure-native (Cosmos + Azure Monitor DCR), Gov-safe — no Fabric, no Databricks
 * dependency.
 */
import { auditLogContainer } from './cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { randomUUID } from 'node:crypto';
import type { SessionPayload } from '@/lib/auth/session';

export const UC_ACCESS_REVIEW_KIND = 'uc-access-review';

/** Ceiling on any caller-supplied STRING copied into an audit row. The 403
 *  branches run before the route validates anything and `withSession` applies no
 *  rate limit, so an ungranted caller could otherwise drive unbounded text into
 *  the shared audit container (the amplification defect #2607 round-3 fixed on
 *  the sibling governance trail). Bounded at the SINK so every caller inherits
 *  it. Real UC FQNs are `catalog.schema.object` — 256 chars is far past any
 *  legitimate one. */
const MAX_AUDIT_STRING = 256;

/** Ceiling on a counted attempt (principals / privileges in one PATCH). Keeps a
 *  hostile `changes: [ …100k entries… ]` from writing a 6-digit number that is
 *  itself the only interesting thing about the row. */
const MAX_AUDIT_COUNT = 10_000;

function boundStr(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return v.length > MAX_AUDIT_STRING ? `${v.slice(0, MAX_AUDIT_STRING)}…` : v;
}

function boundCount(v: number | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(Math.trunc(v), MAX_AUDIT_COUNT));
}

export type UcAccessReviewDecision =
  /** The caller was allowed to run the query. */
  | 'allowed'
  /** The caller asked to probe a principal that is not itself, without being a
   *  tenant admin — the directory-enumeration guard fired. */
  | 'denied-principal-probe'
  /** A tenant admin's `PATCH …/grants` was authorized and applied upstream. */
  | 'allowed-grant-change'
  /** A signed-in NON-admin tried to rewrite the grants on a securable (#2692).
   *  The mutation never reached Unity Catalog. */
  | 'denied-grant-change';

/** Whether a decision describes the WRITE half of the surface. */
function isGrantChange(d: UcAccessReviewDecision): boolean {
  return d === 'allowed-grant-change' || d === 'denied-grant-change';
}

/** Whether the caller was let through. */
function isAllowed(d: UcAccessReviewDecision): boolean {
  return d === 'allowed' || d === 'allowed-grant-change';
}

export interface UcAccessReviewEvent {
  id: string;
  /** Partition key — the securable the query was about. */
  itemId: string;
  kind: typeof UC_ACCESS_REVIEW_KIND;
  /** `access-review` for a READ decision, `access-change` for a grant WRITE. */
  category: 'access-review' | 'access-change';
  decision: UcAccessReviewDecision;
  securableType: string;
  securableName: string;
  /** True for the inheritance-resolving form (`effective=true`). */
  effective: boolean;
  /** The principal the caller asked about, when a filter was used. Recorded
   *  because "who did X ask about" is the interesting half of an access review. */
  probedPrincipal?: string;
  /** How many principals came back (allowed calls only) — a cheap blast-radius
   *  signal without copying the whole ACL into the audit row. */
  resultPrincipals?: number;
  /** Size of the resolved transitive group closure (allowed calls only). */
  closureSize?: number;
  /** Grant-change rows: how many distinct principals the PATCH touched. */
  changedPrincipals?: number;
  /** Grant-change rows: how many privileges were being ADDED in total. */
  privilegesAdded?: number;
  /** Grant-change rows: how many privileges were being REMOVED in total. */
  privilegesRemoved?: number;
  actorOid: string;
  actorName?: string;
  actorUpn?: string;
  /** Set when the caller was acting through a scoped API token (PAT). */
  actorTokenId?: string;
  tenantId?: string;
  at: string;
  timestamp: string;
  who: string;
}

export interface UcAccessReviewInput {
  securableType: string;
  securableName: string;
  effective: boolean;
  decision: UcAccessReviewDecision;
  probedPrincipal?: string;
  resultPrincipals?: number;
  closureSize?: number;
  changedPrincipals?: number;
  privilegesAdded?: number;
  privilegesRemoved?: number;
  /** Injected so the route owns the clock (deterministic in tests). */
  nowIso: string;
}

/**
 * Record one Unity Catalog access-review query or grant-change decision.
 * Awaited form — throws whatever Cosmos throws, so tests can assert the record
 * shape. Routes use {@link auditUcAccessReview}, which never throws.
 */
export async function recordUcAccessReview(
  session: SessionPayload,
  input: UcAccessReviewInput,
): Promise<void> {
  const c = session.claims;
  const at = input.nowIso;
  const securableType = boundStr(input.securableType) || 'unknown';
  const securableName = boundStr(input.securableName) || '(metastore)';
  const probedPrincipal = boundStr(input.probedPrincipal);
  const rec: UcAccessReviewEvent = {
    id: `${UC_ACCESS_REVIEW_KIND}:${at}:${randomUUID()}`,
    itemId: `unity-catalog:${securableType}:${securableName}`,
    kind: UC_ACCESS_REVIEW_KIND,
    category: isGrantChange(input.decision) ? 'access-change' : 'access-review',
    decision: input.decision,
    securableType,
    securableName,
    effective: input.effective,
    ...(probedPrincipal ? { probedPrincipal } : {}),
    ...(boundCount(input.resultPrincipals) !== undefined ? { resultPrincipals: boundCount(input.resultPrincipals) } : {}),
    ...(boundCount(input.closureSize) !== undefined ? { closureSize: boundCount(input.closureSize) } : {}),
    ...(boundCount(input.changedPrincipals) !== undefined ? { changedPrincipals: boundCount(input.changedPrincipals) } : {}),
    ...(boundCount(input.privilegesAdded) !== undefined ? { privilegesAdded: boundCount(input.privilegesAdded) } : {}),
    ...(boundCount(input.privilegesRemoved) !== undefined ? { privilegesRemoved: boundCount(input.privilegesRemoved) } : {}),
    actorOid: c.oid,
    ...(c.name ? { actorName: c.name } : {}),
    ...(c.upn ? { actorUpn: c.upn } : {}),
    ...(session.pat?.tokenId ? { actorTokenId: session.pat.tokenId } : {}),
    ...(c.tid ? { tenantId: c.tid } : {}),
    at,
    timestamp: at,
    who: c.oid,
  };
  const container = await auditLogContainer();
  await container.items.create(rec);
  // Fan the SAME record out to the SIEM stream (LoomAudit_CL) + outbound
  // webhooks. Without this, "an enumeration sweep cannot run untraced" was true
  // only for an operator running a raw Cosmos query. `emitAuditEvent` never
  // throws and never blocks.
  const family = isGrantChange(input.decision) ? 'grant-change' : 'access-review';
  const verb = isAllowed(input.decision)
    ? (isGrantChange(input.decision) ? 'applied' : 'read')
    : 'denied';
  emitAuditEvent({
    actorOid: rec.actorOid,
    actorUpn: rec.actorUpn || '',
    action: `unity-catalog.${family}.${verb}`,
    targetType: 'unity-catalog-securable',
    targetId: rec.itemId,
    outcome: isAllowed(input.decision) ? 'success' : 'denied',
    detail: {
      securableType: rec.securableType,
      securableName: rec.securableName,
      effective: rec.effective,
      decision: rec.decision,
      ...(rec.probedPrincipal ? { probedPrincipal: rec.probedPrincipal } : {}),
      ...(typeof rec.resultPrincipals === 'number' ? { resultPrincipals: rec.resultPrincipals } : {}),
      ...(typeof rec.closureSize === 'number' ? { closureSize: rec.closureSize } : {}),
      ...(typeof rec.changedPrincipals === 'number' ? { changedPrincipals: rec.changedPrincipals } : {}),
      ...(typeof rec.privilegesAdded === 'number' ? { privilegesAdded: rec.privilegesAdded } : {}),
      ...(typeof rec.privilegesRemoved === 'number' ? { privilegesRemoved: rec.privilegesRemoved } : {}),
      ...(rec.actorTokenId ? { actorTokenId: rec.actorTokenId } : {}),
    },
    tenantId: rec.tenantId || rec.actorOid,
    timestamp: at,
  });
}

/**
 * Fire-and-forget wrapper for the route: record the event, swallow + log any
 * error. Returns the promise so a caller (or a test) may await it, but the
 * route deliberately does not — the audit must never add latency to, or fail,
 * the guarded read or the guarded mutation.
 */
export function auditUcAccessReview(
  session: SessionPayload,
  input: UcAccessReviewInput,
): Promise<void> {
  return recordUcAccessReview(session, input).catch((e) => {
    console.error('[uc-access-review:audit] non-fatal audit write error', e);
  });
}
