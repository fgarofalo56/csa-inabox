/**
 * ESTATE ACTIVITY — when did a HUMAN last use the console? (PRP-02 step 3, #4876)
 *
 * The idle signal for auto-pause. Stored in the `maintenance-jobs` container as
 * `estate-activity:current` (PK `/tenantId`), written at most once per
 * {@link ACTIVITY_WRITE_WINDOW_MS} per replica, fire-and-forget, so it costs the
 * request path one Map lookup and never a Cosmos round trip it waits on.
 *
 * WHAT COUNTS: an authenticated request from an interactive session. WHAT DOES
 * NOT: PAT/API-token callers, the service-principal route, health probes, the
 * session keepalive, `/api/internal/*` platform jobs, and the estate state poll
 * itself (an admin tab left open on /admin/scaling polls state every few
 * seconds; counting that would pin the estate awake forever).
 *
 * `idleForSeconds` is null when nothing is recorded or the read failed. Null is
 * "unknown", and the contract forbids auto-pausing on it.
 *
 * WIRING: call {@link recordHumanActivity} from the session-validation seam
 * (`getSession()` in lib/auth/session.ts, or middleware.ts). That seam is
 * outside this change's file ownership; until it calls this, nothing writes the
 * doc and `lastActivityAt` stays null, which the contract treats as unknown.
 */
import type { EstateActivityStatus } from './estate-power-contract';

export const ESTATE_ACTIVITY_DOC_ID = 'estate-activity:current';
export const ESTATE_ACTIVITY_DOC_KIND = 'estate-activity';
/** Max one Cosmos upsert per replica per tenant per this window. */
export const ACTIVITY_WRITE_WINDOW_MS = 5 * 60 * 1000;

const NOT_ACTIVITY_PREFIXES = [
  '/api/health',
  '/api/auth/refresh',
  '/api/estate/power',
  '/api/admin/estate/state',
  '/api/internal/',
];

/** True when a request to `pathname` is evidence a human is using the console. */
export function countsAsHumanActivity(pathname: string): boolean {
  return !NOT_ACTIVITY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`));
}

interface ActivityDoc {
  id: string;
  tenantId: string;
  kind: typeof ESTATE_ACTIVITY_DOC_KIND;
  lastActivityAt: string;
}

const lastWriteAt = new Map<string, number>();
/** Writes run one at a time: bounded concurrency, and no two concurrent dynamic imports of the Cosmos client. */
let writeChain: Promise<void> = Promise.resolve();

/** Test hook: forget the in-memory throttle. */
export function __resetEstateActivityThrottleForTest(): void {
  lastWriteAt.clear();
}

/**
 * Record activity for `tenantId`. Returns true when this call STARTED a Cosmos
 * write (i.e. it was outside the throttle window). Never throws, never awaits
 * the write. A PAT session is not a human and is ignored.
 */
export function recordHumanActivity(
  session: { claims: { tid?: string; oid: string }; pat?: unknown },
  pathname: string,
  now: number = Date.now(),
): boolean {
  if (session.pat) return false;
  if (!countsAsHumanActivity(pathname)) return false;
  const tenantId = session.claims.tid || session.claims.oid;
  if (!tenantId) return false;
  const prev = lastWriteAt.get(tenantId);
  if (prev !== undefined && now - prev < ACTIVITY_WRITE_WINDOW_MS) return false;
  // Claim the window BEFORE the async write so concurrent requests in the same
  // tick cannot each start one. A failed write keeps the claim: Cosmos being
  // down must not turn every request into a retry.
  lastWriteAt.set(tenantId, now);
  writeChain = writeChain.then(async () => {
    try {
      const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
      const c = await maintenanceJobsContainer();
      const doc: ActivityDoc = {
        id: ESTATE_ACTIVITY_DOC_ID,
        tenantId,
        kind: ESTATE_ACTIVITY_DOC_KIND,
        lastActivityAt: new Date(now).toISOString(),
      };
      await c.items.upsert(doc);
    } catch { /* best-effort; the request path must never see this */ }
  });
  return true;
}

/** Read the activity status. Never throws. */
export async function loadActivity(tenantId: string, now: number = Date.now()): Promise<EstateActivityStatus> {
  if (!tenantId) return { lastActivityAt: null, idleForSeconds: null, unreadable: true };
  try {
    const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
    const c = await maintenanceJobsContainer();
    const { resource } = await c.item(ESTATE_ACTIVITY_DOC_ID, tenantId).read<ActivityDoc>();
    if (!resource || resource.kind !== ESTATE_ACTIVITY_DOC_KIND) {
      return { lastActivityAt: null, idleForSeconds: null, unreadable: false };
    }
    const at = Date.parse(resource.lastActivityAt);
    if (!Number.isFinite(at)) return { lastActivityAt: null, idleForSeconds: null, unreadable: true };
    return {
      lastActivityAt: new Date(at).toISOString(),
      idleForSeconds: Math.max(0, Math.floor((now - at) / 1000)),
      unreadable: false,
    };
  } catch {
    return { lastActivityAt: null, idleForSeconds: null, unreadable: true };
  }
}
