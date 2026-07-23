/**
 * /api/telemetry/rum — RUM1 browser-beacon control plane + ingest
 * (loom-next-level ws-verification-dr.md RUM1).
 *
 *   GET  — capture config for the client provider: `{ ok, enabled, sampleRate }`.
 *          `enabled` folds LOOM_RUM_ENABLED + APPLICATIONINSIGHTS_CONNECTION_STRING
 *          + the FLAG0 runtime kill-switch `rum1-client-telemetry`, so a flag
 *          flip on /admin/runtime-flags stops capture on the next page load —
 *          no revision roll.
 *   POST — session-gated, rate-limited, size-capped beacon ingest. The body is
 *          validated + PII-re-scrubbed by `parseRumBatch` (defense in depth on
 *          top of the client-side scrub), then forwarded to App Insights via
 *          the classic track API (lib/telemetry/rum-ingest.ts). When RUM is
 *          unconfigured the route answers `{ ok:true, accepted:0 }` — a
 *          SILENT no-op per the spec, never an error the browser console
 *          would surface on every page.
 *
 * Auth: withSession on BOTH verbs (401 pre-auth — the client treats it as
 * capture-off). No user identifier is forwarded to App Insights: the session
 * gates ABUSE, it never becomes a telemetry dimension.
 * Rate limit: per-oid token bucket, class 'rum' (2/s sustained, burst 20 —
 * a page emits ≤ ~4 beacon POSTs across its lifetime).
 * Size cap: 64 KB body / 30 items (RUM_MAX_BODY_BYTES / RUM_MAX_ITEMS).
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiError, apiOk } from '@/lib/api/respond';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { RUM_FLAG_ID, RUM_MAX_BODY_BYTES, parseRumBatch } from '@/lib/telemetry/rum-shared';
import { isRumEnvEnabled, postRumBatch, rumSampleRate } from '@/lib/telemetry/rum-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Capture config for the browser provider (see lib/telemetry/rum.ts). */
export const GET = withSession(async () => {
  const envEnabled = isRumEnvEnabled();
  const flagEnabled = envEnabled ? await runtimeFlag(RUM_FLAG_ID) : false;
  return apiOk({ enabled: envEnabled && flagEnabled, sampleRate: rumSampleRate() });
});

/** Beacon ingest → App Insights (silent no-op when unconfigured). */
export const POST = withSession(async (req: NextRequest, { session }) => {
  const limited = await enforceRateLimit(session, 'rum', { ratePerSec: 2, burst: 20 });
  if (limited) return limited;

  const raw = await req.text();
  if (raw.length > RUM_MAX_BODY_BYTES) return apiError('payload too large', 413);

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return apiError('invalid JSON', 400);
  }
  const items = parseRumBatch(body);
  if (!items.length) return apiOk({ accepted: 0 });

  // Kill-switch (FLAG0): OFF → drop server-side too, covering pages loaded
  // before the flip. Fail-open default-ON (a flags outage never 500s beacons).
  if (!(await runtimeFlag(RUM_FLAG_ID))) return apiOk({ accepted: 0, disabled: true });

  try {
    const { sent } = await postRumBatch(items);
    return apiOk({ accepted: sent });
  } catch (e) {
    // Telemetry loss is NEVER a caller failure — log server-side, answer ok.
    // eslint-disable-next-line no-console
    console.warn('[rum] forward to App Insights failed:', (e as Error)?.message || e);
    return apiOk({ accepted: 0, forwarded: false });
  }
});
