/**
 * Console-error classification shared by every UAT spec — pure, dependency-free.
 *
 * WHY IT IS ITS OWN MODULE AND NOT PART OF `_lib/uat.ts`. `uat.ts` calls
 * `requireAutomationOid()` at MODULE SCOPE, so importing it throws unless
 * `UAT_OID` / `LOOM_AUTOMATION_OID` is set. That is correct for a spec that is
 * about to drive the estate as that principal, and fatal for a unit test that
 * only wants to assert a predicate. Keeping the predicates here means the
 * classification that decides whether a UAT run is red can itself be tested,
 * which is the whole point: an over-broad filter here would silently swallow
 * the failures the suite exists to catch, and nothing would report that.
 *
 * `uat.ts` re-exports everything below, so specs may import from either.
 */

/**
 * Background session-maintenance beacons whose 401 is EXPECTED under a minted
 * session.
 *
 * The suites drive the console with a cookie written directly by `mintSession`,
 * which by construction has no MSAL refresh token and no token cache. So
 * `/api/auth/refresh` answers 401 every time and the BROWSER logs "Failed to
 * load resource: …401" unconditionally — no client code can suppress it. It
 * lands in `consoleErrors` and, before this filter existed, hard-failed a
 * journey whose editor had mounted perfectly.
 */
export const REAUTH_BEACONS = ['/api/auth/refresh', '/api/telemetry/rum'];

/**
 * True only for a 401 on one of the two beacons above.
 *
 * DELIBERATELY NARROW, and it must stay narrow. Any other console error, any
 * 5xx, and a 401 on any other path still fail. A blanket "ignore 401s" would
 * hide exactly the sign-in outage the journeys exist to catch (#2191,
 * AADSTS7000215) — a filter that can swallow the target class is worse than no
 * filter, because it reports green while watching nothing.
 */
export function isReauthGate(e: string): boolean {
  return /\b401\b/.test(e) && REAUTH_BEACONS.some((p) => e.includes(p));
}

/**
 * A React hydration failure, in every form the browser prints it.
 *
 * #418 is the minified code for "Hydration failed because the initial UI does
 * not match what was rendered on the server". In production builds React prints
 * ONLY the minified form plus a link, so a matcher that looked for the friendly
 * prose would never fire on a deployed console — which is the shape #3528 is
 * about: the app-install workspace Dropdown going click-dead after a hydration
 * error that nothing asserted on. #423 and #425 are the sibling codes emitted
 * for the same root cause, and `hydrat` catches the dev-build prose.
 */
export function isHydrationError(e: string): boolean {
  return /Minified React error #(418|423|425)\b/.test(e) || /hydrat/i.test(e);
}

/** Everything that is NOT an expected reauth beacon — i.e. the real population. */
export function realConsoleErrors(errors: readonly string[]): string[] {
  return errors.filter((e) => !isReauthGate(e));
}

/** Only the errors suppressed by {@link isReauthGate} — reported, never hidden. */
export function reauthGatedErrors(errors: readonly string[]): string[] {
  return errors.filter(isReauthGate);
}

/**
 * A complete, indexed listing for an assertion message.
 *
 * NOT TRUNCATED. On 2026-08-09 a journey had been red for two days and the only
 * surviving evidence was a note cut off mid-way through the SECOND error, so
 * the cause could not be read from the monitor's own output. Truncating
 * evidence you have already collected is a self-inflicted unknown.
 */
export function formatConsoleErrors(errors: readonly string[]): string {
  if (!errors.length) return '(none)';
  return errors
    .map((e, i) => `  [${i}]${isReauthGate(e) ? ' (reauth-gated)' : ''}${isHydrationError(e) ? ' (HYDRATION)' : ''} ${e}`)
    .join('\n');
}
