/**
 * LU-4 (remediation) — audit for the Unity Catalog **access-review** query.
 *
 * `GET /api/databricks/unity-catalog/grants?effective=true[&principal=…]` is a
 * privileged read: it enumerates who holds what on a securable, and with a
 * `principal` filter it additionally resolves that principal's transitive Entra
 * group membership using the Console UAMI's Graph app role. That is an
 * access-review + directory-membership primitive, so every call — ALLOWED and
 * DENIED alike — leaves a record. A denial with no trace is how an enumeration
 * sweep goes unnoticed.
 *
 * Writes to the shared Cosmos `audit-log` container (partition `/itemId`) as
 * `kind:'uc-access-review'`, so the rows surface in the existing Admin → Audit
 * Logs reader next to the object-security and PDP-shadow rows. Best-effort: a
 * write miss NEVER fails the guarded request.
 *
 * Azure-native (Cosmos), Gov-safe — no Fabric, no Databricks dependency.
 */
import { auditLogContainer } from './cosmos-client';
import { randomUUID } from 'node:crypto';
import type { SessionPayload } from '@/lib/auth/session';

export const UC_ACCESS_REVIEW_KIND = 'uc-access-review';

export type UcAccessReviewDecision =
  /** The caller was allowed to run the query. */
  | 'allowed'
  /** The caller asked to probe a principal that is not itself, without being a
   *  tenant admin — the directory-enumeration guard fired. */
  | 'denied-principal-probe';

export interface UcAccessReviewEvent {
  id: string;
  /** Partition key — the securable the query was about. */
  itemId: string;
  kind: typeof UC_ACCESS_REVIEW_KIND;
  category: 'access-review';
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
  /** Injected so the route owns the clock (deterministic in tests). */
  nowIso: string;
}

/**
 * Record one Unity Catalog access-review query. Awaited form — throws whatever
 * Cosmos throws, so tests can assert the record shape. Routes use
 * {@link auditUcAccessReview}, which never throws.
 */
export async function recordUcAccessReview(
  session: SessionPayload,
  input: UcAccessReviewInput,
): Promise<void> {
  const c = session.claims;
  const at = input.nowIso;
  const securableName = input.securableName || '(metastore)';
  const rec: UcAccessReviewEvent = {
    id: `${UC_ACCESS_REVIEW_KIND}:${at}:${randomUUID()}`,
    itemId: `unity-catalog:${input.securableType}:${securableName}`,
    kind: UC_ACCESS_REVIEW_KIND,
    category: 'access-review',
    decision: input.decision,
    securableType: input.securableType,
    securableName,
    effective: input.effective,
    ...(input.probedPrincipal ? { probedPrincipal: input.probedPrincipal } : {}),
    ...(typeof input.resultPrincipals === 'number' ? { resultPrincipals: input.resultPrincipals } : {}),
    ...(typeof input.closureSize === 'number' ? { closureSize: input.closureSize } : {}),
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
}

/**
 * Fire-and-forget wrapper for the route: record the event, swallow + log any
 * error. Returns the promise so a caller (or a test) may await it, but the
 * route deliberately does not — the audit must never add latency to, or fail,
 * the guarded read.
 */
export function auditUcAccessReview(
  session: SessionPayload,
  input: UcAccessReviewInput,
): Promise<void> {
  return recordUcAccessReview(session, input).catch((e) => {
    console.error('[uc-access-review:audit] non-fatal audit write error', e);
  });
}
