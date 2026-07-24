/**
 * POST /api/flightsql/session — mint a short-lived, Entra-scoped Flight ticket (N3).
 *
 * This is the ONLY way to obtain a Flight SQL credential for the Loom serving
 * tier. The ticket:
 *   • is minted ONLY from a verified Entra session (withSession — 401 first),
 *   • carries the caller's Entra oid / upn / tid and the scope they asked for,
 *   • expires in minutes (default 300s, hard-capped at 3600s by the minter),
 *   • is HMAC-signed with a Key-Vault-injected key that never leaves the
 *     boundary, and is single-audience so it cannot be replayed elsewhere, and
 *   • is NEVER a long-lived secret — there is no "service account token" path.
 *
 * AUDIT (round-3 extension): ticket issuance AND session creation are written to
 * `_auditLog` + the SIEM stream with the ticket id, scope, TTL and signing
 * posture. The serving tier logs the SAME ticket id on every redemption, so an
 * ATO reviewer joins mint → redeem on one key.
 *
 * The Flight wire being undeployed is NOT a reason to fail: a ticket is still
 * minted and audited (it is a Loom credential, not a service handle) and the
 * response reports the endpoint exposure honestly so the UI can explain what to
 * do with it.
 *
 * 200 → { ok:true, ticket, ticketId, expiresAt, ttlSeconds, signed, endpoint }
 * 400 → bad request (unusable ttl / scope)
 * 401 → unauthenticated
 */
import { apiError, apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import {
  logFlightAccess,
  mintFlightTicket,
  resolveFlightEndpoint,
} from '@/lib/azure/flight-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  ttlSeconds?: unknown;
  scope?: unknown;
  itemId?: unknown;
}

export const POST = withSession(async (req, { session }) => {
  const body = (await req.json().catch(() => ({}))) as Body;

  let ttlSeconds: number | undefined;
  if (body.ttlSeconds !== undefined) {
    const n = Number(body.ttlSeconds);
    if (!Number.isFinite(n) || n <= 0) {
      return apiError('ttlSeconds must be a positive number of seconds.', 400);
    }
    ttlSeconds = Math.floor(n);
  }

  const scope = Array.isArray(body.scope)
    ? body.scope.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  const itemId = typeof body.itemId === 'string' ? body.itemId : undefined;

  const endpoint = resolveFlightEndpoint();
  const tenantId = session.claims.tid || session.claims.oid;

  const minted = mintFlightTicket({
    oid: session.claims.oid,
    upn: session.claims.upn,
    tenantId,
    scope,
    ttlSeconds,
  });

  await logFlightAccess({
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn,
    tenantId,
    operation: 'flight.ticket.mint',
    ticketId: minted.claims.jti,
    scope: minted.claims.scope,
    ttlSeconds: minted.ttlSeconds,
    signed: minted.signed,
    exposure: endpoint.exposure,
    outcome: 'success',
    itemId,
  });

  return apiOk({
    ticket: minted.token,
    ticketId: minted.claims.jti,
    expiresAt: minted.expiresAt,
    ttlSeconds: minted.ttlSeconds,
    signed: minted.signed,
    scope: minted.claims.scope,
    endpoint: {
      uri: endpoint.uri,
      exposure: endpoint.exposure,
      note: endpoint.note,
    },
    // Honest note when no signing key is wired: the ticket is still short-lived
    // and audited, but the serving tier is trusting the VNet rather than a
    // signature. Never presented as if it were verified.
    signingNote: minted.signed
      ? undefined
      : 'No Flight ticket signing key is configured (LOOM_FLIGHT_TICKET_SECRET). The serving tier '
        + 'accepts this ticket on in-VNet trust and marks every access row ticketVerified:false. Wire '
        + 'the Key Vault secret on the loom-duckdb Container App to get cryptographic verification.',
  });
});
