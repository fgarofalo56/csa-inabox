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
 *
 * The same gate fires when the URL IS set but LOOM_POSTURE_FUNCTION_KEY is not,
 * distinguished by `gateReason: 'key_not_bound'` and pointed at the admin-plane
 * module that binds the key (not at the Function module, which already ran).
 * The Function's `posture-refresh` route is `AuthLevel.FUNCTION`
 * (azure-functions/posture-refresh/function_app.py), so an unkeyed call is
 * rejected 401 — and because the dispatch is fire-and-forget that rejection
 * was swallowed and the route answered `{ ok:true, dispatched:true }`: a
 * success claim for a refresh that could never run. The key is bound only once
 * it is known to exist in Key Vault (admin-plane `postureFunctionKeyBound`), so
 * "URL without key" is a real, expected deploy state, not a misconfiguration.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POSTURE_FUNCTION_MODULE = 'azure-functions/posture-refresh/deploy/main.bicep';
// The module whose `postureFunctionKeyBound` (driven by
// `observabilityConfig.postureFunctionKeyEnabled`) binds the key onto this
// Console. On the key branch the Function already exists, so pointing at the
// Function module would send the operator to redeploy something that neither
// stores the key nor sets the flag (#4770 review, deploy-integrity R6/R7).
const KEY_BINDING_MODULE = 'platform/fiab/bicep/modules/admin-plane/main.bicep';

/**
 * Which half of the pre-warm is missing. `lib/panes/govern-owner.tsx` keys its
 * MessageBar title on this, because "not provisioned" is false once the URL is
 * set. Kept module-local: a route file exports only its handlers.
 */
type PostureRefreshGateReason = 'function_not_provisioned' | 'key_not_bound';

export const POST = withSession(async (_req, { session: s }) => {

  const functionUrl = (process.env.LOOM_POSTURE_FUNCTION_URL || '').trim().replace(/\/$/, '');
  if (!functionUrl) {
    // Honest infra gate — 200 so the UI doesn't error; live compute still works.
    return NextResponse.json({
      ok: false,
      gate: 'not_configured',
      gateReason: 'function_not_provisioned' satisfies PostureRefreshGateReason,
      missingEnvVar: 'LOOM_POSTURE_FUNCTION_URL',
      bicepModule: POSTURE_FUNCTION_MODULE,
      message:
        'On-open posture refresh Function not provisioned. Deploy azure-functions/posture-refresh and set LOOM_POSTURE_FUNCTION_URL. Posture below is computed live from Cosmos.',
    });
  }

  const functionKey = (process.env.LOOM_POSTURE_FUNCTION_KEY || '').trim();
  if (!functionKey) {
    // URL known, host key not bound: do NOT dispatch an unkeyed call the
    // Function would reject. The Function EXISTS on this branch (its URL is
    // set), so the remediation names the two things that bind the key, not the
    // Function module. This route cannot see Key Vault, so the message says
    // which of the two it cannot tell apart rather than guessing (R7).
    return NextResponse.json({
      ok: false,
      gate: 'not_configured',
      gateReason: 'key_not_bound' satisfies PostureRefreshGateReason,
      missingEnvVar: 'LOOM_POSTURE_FUNCTION_KEY',
      bicepModule: KEY_BINDING_MODULE,
      message:
        'On-open posture pre-warm unavailable: the posture-refresh Function is deployed (LOOM_POSTURE_FUNCTION_URL is set), but its host key is not bound to this Console, and the Function accepts only keyed calls, so no refresh was dispatched. The key is bound only when BOTH (1) the Function host key is stored in Key Vault as loom-posture-function-key AND (2) the deploy sets observabilityConfig.postureFunctionKeyEnabled, which drives admin-plane postureFunctionKeyBound. This route cannot read Key Vault, so it cannot tell which of the two is missing. Posture below is computed live from Cosmos.',
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
      'x-functions-key': functionKey,
    },
    body: JSON.stringify(payload),
    // Short timeout guard so a hung Function never holds a socket on this node.
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    /* swallow — fire-and-forget; cold start / transient errors don't surface here */
  });

  return NextResponse.json({ ok: true, dispatched: true, scope: 'owner' });
});
