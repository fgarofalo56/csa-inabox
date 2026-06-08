/**
 * POST /api/governance/govern/refresh — kick the posture-refresh Azure Function
 * for the signed-in data owner (F3). Fired on Govern-tab open.
 *
 * Parity: Fabric's data-owner Govern view refreshes its insights on every
 * tab-open (unlike the admin view's daily cadence). The Loom equivalent
 * dispatches the owner-scoped recompute to an Azure Function, which writes
 * fresh aggregates into the posture-aggregates Cosmos container. The browser
 * then re-reads GET /api/governance/govern/owner to pick up the new values.
 *
 * This call is FIRE-AND-FORGET: it does not await the Function's cold start.
 * The UI renders immediately from cached/live Cosmos data and shows a
 * "Refreshing…" badge. This keeps the page responsive within the cold-start
 * budget — no request ever blocks on a Consumption-plan cold start (2–5 s).
 *
 * Owner identity (oid/upn) is taken from the validated session cookie, never
 * from the request body, so a caller cannot trigger a refresh scoped to
 * someone else. The Function key lives in Key Vault and is surfaced to this
 * route via the LOOM_POSTURE_FUNCTION_KEY app setting (secretRef) — it is
 * never exposed to the browser.
 *
 * Honest gate: when LOOM_POSTURE_FUNCTION_URL is unset the route returns 200
 * with `{ ok:false, gate:'not_configured', ... }` so the UI shows a Fluent
 * MessageBar (and still renders live-computed posture). No silent failure.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const functionUrl = (process.env.LOOM_POSTURE_FUNCTION_URL || '').trim().replace(/\/$/, '');
  if (!functionUrl) {
    // Honest infra gate — 200 so the UI doesn't error; live compute still works.
    return NextResponse.json({
      ok: false,
      gate: 'not_configured',
      missingEnvVar: 'LOOM_POSTURE_FUNCTION_URL',
      bicepModule: 'azure-functions/posture-refresh/deploy/main.bicep',
      message:
        'On-open posture refresh Function not provisioned. Deploy azure-functions/posture-refresh and set LOOM_POSTURE_FUNCTION_URL. Posture below is computed live from Cosmos.',
    });
  }

  const payload = {
    scope: 'owner' as const,
    ownerId: s.claims.oid,
    ownerUpn: s.claims.upn,
  };

  // Fire-and-forget: kick the Function, do not await its result. The browser
  // re-reads /api/governance/govern/owner after this resolves to pick up the
  // freshly written aggregates (cache last-write-wins).
  void fetch(`${functionUrl}/api/posture-refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-functions-key': process.env.LOOM_POSTURE_FUNCTION_KEY || '',
    },
    body: JSON.stringify(payload),
    // Short timeout guard so a hung Function never holds a socket on this node.
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    /* swallow — fire-and-forget; cold start / transient errors don't surface here */
  });

  return NextResponse.json({ ok: true, dispatched: true, scope: 'owner' });
}
