/**
 * POST /api/embed/token — mint a short-lived, scoped, signed EMBED TOKEN (N18).
 *
 * The Fabric-FREE alternative to a Power BI Embedded embed token. A signed-in
 * owner (the "app owns data" host) mints a token for ONE of its end-users,
 * carrying that viewer's effective identity + row-level-security claims. The
 * token is HMAC-signed with a key derived from `SESSION_SECRET` (never inline),
 * TTL-clamped (default 10 min, max 60 min), and single-audience — it is ONLY
 * valid at `POST /api/embed/query`.
 *
 * Body: { reportId, identity?: { sub?, rls? }, ttlSeconds? }
 *   • reportId   — the report the token scopes to (required)
 *   • identity   — the viewer: `sub` (defaults to the caller) + `rls` claims
 *                  { dimension: value | [values] } applied at QUERY TIME by the
 *                  N15 metric compiler (a bound WHERE predicate, not client-side)
 *   • ttlSeconds — requested lifetime, clamped to [30, 3600]
 *
 * AUDITED (emit-first): every mint fires `emitAuditEvent` SYNCHRONOUSLY before
 * the best-effort Cosmos `_auditLog` row, so a fire-and-forget audit can never
 * skip the SIEM fan-out. The token secret is NEVER written to the audit trail —
 * only the reportId, effective identity, RLS dimension names, and expiry.
 *
 * No new Azure resource, no PBI host, no Fabric F-SKU — identical on every
 * cloud, and this IS the Gov embed story. IL5: minted entirely in-boundary.
 *
 * Auth: withSession (the route-guard ratchet matches `withSession(`); the token
 * owner is bound to `session.claims.oid`, so a caller can only mint tokens over
 * their OWN governed metrics.
 */

import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { mintEmbedToken, normalizeRlsClaims, type EffectiveIdentity } from '@/lib/embed/embed-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The N18 FLAG0 kill-switch id (also registered in lib/admin/runtime-flags.ts). */
const EMBED_FLAG_ID = 'n18-embedded-analytics';

interface EmbedTokenBody {
  reportId?: unknown;
  identity?: unknown;
  ttlSeconds?: unknown;
}

/** Coerce the request `identity` into a well-formed effective identity. */
function parseIdentity(raw: unknown, fallbackSub: string): EffectiveIdentity {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const sub = typeof obj.sub === 'string' && obj.sub.trim() ? obj.sub.trim() : fallbackSub;
  return { sub, rls: normalizeRlsClaims(obj.rls) };
}

export const POST = withSession(async (req: NextRequest, { session }) => {
  // FLAG0 kill-switch (default-ON). OFF → guided "turned off" gate.
  if (!(await runtimeFlag(EMBED_FLAG_ID, { default: true }))) {
    return apiError('Embedded analytics is turned off (admin → runtime flags).', 503, {
      code: 'embed_off',
    });
  }

  const body = (await req.json().catch(() => ({}))) as EmbedTokenBody;
  const reportId = typeof body.reportId === 'string' ? body.reportId.trim() : '';
  if (!reportId) return apiError('reportId is required', 400);

  const owner = { oid: session.claims.oid, tid: session.claims.tid || session.claims.oid };
  const identity = parseIdentity(body.identity, session.claims.upn || session.claims.oid);

  const minted = mintEmbedToken({
    reportId,
    owner,
    identity,
    ttlSeconds: typeof body.ttlSeconds === 'number' ? body.ttlSeconds : Number(body.ttlSeconds) || undefined,
  });

  // AUDIT — emit FIRST (synchronously), then the best-effort Cosmos row. NEVER
  // record the token itself; only its non-secret provenance.
  const auditDetail = {
    reportId,
    sub: identity.sub,
    rlsDimensions: Object.keys(identity.rls),
    expiresAt: minted.expiresAt,
  };
  emitAuditEvent({
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn || session.claims.oid,
    action: 'embed-token.mint',
    targetType: 'embed-token',
    targetId: reportId,
    tenantId: owner.tid,
    detail: auditDetail,
  });
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        itemId: `embed-token:${reportId}`,
        tenantId: owner.tid,
        who: session.claims.upn || session.claims.oid,
        actorOid: session.claims.oid,
        oid: session.claims.oid,
        at: new Date().toISOString(),
        kind: 'embed-token.mint',
        target: reportId,
        detail: auditDetail,
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }

  return apiOk({
    token: minted.token,
    expiresAt: minted.expiresAt,
    reportId,
    identity: { sub: identity.sub, rls: identity.rls },
  });
});
