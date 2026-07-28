/**
 * /api/admin/chaos/dependency — the CH1 dependency-fault chaos harness.
 *
 * The dependency-plane sibling of A13's Spark-only chaos route
 * (app/api/admin/spark/chaos). A RESILIENCE DRILL tool: it arms an in-process
 * fault against THIS replica for one of the four first-class dependencies so the
 * REAL client resilience path (getOrComputeCached serveStaleOnError, the
 * aoai-chat-client APIM→direct fallback + honest AoaiResponseError, the Kusto /
 * Key Vault honest errors, fetchWithTimeout's deadline) is exercised end-to-end
 * — proving the surface degrades to serve-stale / an honest gate instead of a
 * crash or a dark render.
 *
 *   GET  → { enabled, flagOn, armable, faultPoints[], armed[], matrix, coverage }
 *          Live status: which faults are armed on this replica, the resilience
 *          matrix, and whether the harness is armable in this deployment.
 *
 *   POST { action:'arm', point, ttlMs?, occurrences?, reason? }
 *          Arm one fault (bounded TTL, auto-expires — a forgotten drill self-heals).
 *   POST { action:'disarm', point }        Disarm one fault.
 *   POST { action:'disarm-all' }           Disarm every fault.
 *
 * TRIPLE-GATED (a destructive drill tool — mirrors A13):
 *   1. Tenant admin session (withTenantAdmin).
 *   2. The `ch1-dependency-chaos` runtime flag ON (default OFF — deliberately
 *      opt-in; chaos is operator-initiated). The seconds-fast kill switch.
 *   3. LOOM_DEPENDENCY_CHAOS_ENABLED=true — OFF by default; MUST stay off in
 *      prod. With it unset the injection code path is PROVABLY DEAD.
 *   4. A valid LOOM_INTERNAL_TOKEN on the request (Bearer / x-loom-internal-token)
 *      — the same machine-trust secret A13's Spark chaos requires.
 *
 * REAL only (no-vaporware): arming mutates the real in-process fault registry the
 * live cosmos-client / fetch-with-timeout chokepoints consult; every arm/disarm
 * and every injection is audited.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiForbidden, apiServerError } from '@/lib/api/respond';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  armFault,
  disarmFault,
  disarmAllFaults,
  listArmedFaults,
  dependencyChaosEnabled,
  isFaultPoint,
  FAULT_POINTS,
  FAULT_META,
  MAX_FAULT_TTL_MS,
  MAX_FAULT_OCCURRENCES,
} from '@/lib/resilience/fault-injection';
import { RESILIENCE_MATRIX, auditBreakerCoverage } from '@/lib/resilience/breaker-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHAOS_FLAG = 'ch1-dependency-chaos';

function presentedInternalToken(req: NextRequest): string | null {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return bearer || req.headers.get(INTERNAL_TOKEN_HEADER);
}

/** The static descriptor block returned on GET + every write (for the pane). */
function descriptors() {
  return {
    faultPoints: FAULT_POINTS.map((p) => ({ point: p, ...FAULT_META[p] })),
    matrix: RESILIENCE_MATRIX,
    coverage: auditBreakerCoverage(),
    limits: { maxTtlMs: MAX_FAULT_TTL_MS, maxOccurrences: MAX_FAULT_OCCURRENCES },
  };
}

// GET — status is READ-ONLY, so it is admin-gated but NOT internal-token gated:
// the pane must be able to render "harness is off" without a machine token.
export const GET = withTenantAdmin(async () => {
  const flagOn = await runtimeFlag(CHAOS_FLAG, { default: false });
  const enabled = dependencyChaosEnabled();
  return apiOk({
    enabled,
    flagOn,
    // Armable only when BOTH the opt-in flag is on AND the hard env gate is set.
    armable: flagOn && enabled,
    armed: listArmedFaults(),
    ...descriptors(),
  });
});

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  // Gate 2 — the opt-in runtime flag must be ON (default OFF).
  if (!(await runtimeFlag(CHAOS_FLAG, { default: false }))) {
    return apiForbidden(
      "Dependency chaos harness is OFF. Enable the 'ch1-dependency-chaos' runtime flag (Admin → Runtime flags) to arm a resilience drill — it is deliberately opt-in.",
    );
  }
  // Gate 3 — the hard env safety gate (must stay off in prod).
  if (!dependencyChaosEnabled()) {
    return apiForbidden(
      'Dependency chaos harness is disabled. Set LOOM_DEPENDENCY_CHAOS_ENABLED=true in a NON-PROD deployment to run a resilience drill.',
    );
  }
  // Gate 4 — a valid internal trust token must accompany the admin session.
  if (!isValidInternalToken(presentedInternalToken(req))) {
    return apiForbidden(
      'chaos drill requires a valid LOOM_INTERNAL_TOKEN (Bearer or x-loom-internal-token).',
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    point?: unknown;
    ttlMs?: unknown;
    occurrences?: unknown;
    reason?: unknown;
  };
  const action = typeof body.action === 'string' ? body.action : '';
  const armedBy = session.claims.upn || session.claims.oid;
  const tenantId = session.claims.tid || session.claims.oid;

  try {
    if (action === 'disarm-all') {
      const removed = disarmAllFaults();
      emitAuditEvent({
        actorOid: session.claims.oid, actorUpn: armedBy, action: 'chaos.fault.disarm-all',
        targetType: 'resilience-fault', targetId: 'all', tenantId, detail: { removed },
      });
      return apiOk({ action, removed, armed: listArmedFaults(), ...descriptors() });
    }

    if (!isFaultPoint(body.point)) {
      return apiError(`point must be one of: ${FAULT_POINTS.join(', ')}`, 400);
    }
    const point = body.point;

    if (action === 'disarm') {
      const wasArmed = disarmFault(point);
      emitAuditEvent({
        actorOid: session.claims.oid, actorUpn: armedBy, action: 'chaos.fault.disarm',
        targetType: 'resilience-fault', targetId: point, tenantId, detail: { wasArmed },
      });
      return apiOk({ action, point, wasArmed, armed: listArmedFaults(), ...descriptors() });
    }

    if (action === 'arm') {
      const ttlMs = Number(body.ttlMs);
      const occurrences = body.occurrences === undefined || body.occurrences === null ? undefined : Number(body.occurrences);
      const reason = typeof body.reason === 'string' ? body.reason : '';
      const view = armFault(point, {
        ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : undefined,
        occurrences: occurrences !== undefined && Number.isFinite(occurrences) ? occurrences : undefined,
        reason,
        armedBy,
      });
      if (!view) {
        // dependencyChaosEnabled() was re-checked false inside armFault (race).
        return apiForbidden('Dependency chaos is not enabled — nothing was armed.');
      }
      emitAuditEvent({
        actorOid: session.claims.oid, actorUpn: armedBy, action: 'chaos.fault.arm',
        targetType: 'resilience-fault', targetId: point, tenantId,
        detail: { expiresAt: view.expiresAt, remaining: view.remaining, reason: view.reason },
      });
      return apiOk({ action, point, armed: listArmedFaults(), justArmed: view, ...descriptors() });
    }

    return apiError("body must be { action: 'arm' | 'disarm' | 'disarm-all', point?, ttlMs?, occurrences?, reason? }", 400);
  } catch (e) {
    return apiServerError(e, 'dependency chaos drill failed — see the server logs.');
  }
});
