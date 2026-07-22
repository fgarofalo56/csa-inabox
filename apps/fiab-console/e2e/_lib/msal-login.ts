/**
 * loginViaMsal — the TRUE MSAL login-path probe (V1 / J1).
 *
 * Drives the REAL sign-in flow end-to-end in a fresh browser context:
 *   /auth/sign-in → Entra authorize (login.microsoftonline.com|.us) →
 *   /auth/callback → an authenticated landing with a `loom_session` cookie
 *   minted by the REAL callback (NOT our test mint).
 *
 * WHY: minted-session monitoring is blind to broken sign-in — on 2026-07-19 an
 * MSAL client-secret drift (AADSTS7000215) broke ALL user sign-in while the
 * minted-session `verify` project stayed green (memory
 * csa_loom_msal_secret_outage_2026_07_19). This probe exercises the exact
 * authorize-code + client-secret redemption path a human hits, so that class
 * goes RED within one 15-minute synthetic cycle.
 *
 * CREDENTIAL: SYNTHETIC_LOGIN_UPN / SYNTHETIC_LOGIN_SECRET — a least-privilege
 * Entra automation account (KV-sourced secret, Conditional-Access
 * named-location exception scoped to the monitor egress; see
 * docs/fiab/runbooks/synthetic-journeys.md). When either is ABSENT the probe
 * returns a clear `skipped` marker (NOT a failure) so estates without the
 * credential degrade honestly — the minted-session journeys still run.
 */
import type { BrowserContext } from '@playwright/test';
import { BASE } from './uat';

export interface MsalLoginResult {
  /** True when the automation credential is absent — an HONEST skip, not a fail. */
  skipped: boolean;
  /** Human-readable reason for a skip / failure diagnosis aid. */
  reason?: string;
  /** True when the REAL /auth/callback minted a loom_session cookie. */
  cookieMinted?: boolean;
  /** Final URL the flow landed on (diagnosis aid). */
  landedUrl?: string;
}

/** Clear marker string the Journeys tab + verdict log surface for a skip. */
export const MSAL_LOGIN_SKIP_REASON =
  'SYNTHETIC_LOGIN_UPN / SYNTHETIC_LOGIN_SECRET not set — MSAL login probe skipped (honest skip; minted-session journeys still run)';

/**
 * Perform the real authorize-code sign-in inside `context` (which must be a
 * FRESH context with no pre-minted cookies, or the callback assertion is
 * meaningless). Returns the context carrying the callback-minted cookie.
 */
export async function loginViaMsal(context: BrowserContext): Promise<MsalLoginResult> {
  const upn = (process.env.SYNTHETIC_LOGIN_UPN || '').trim();
  const secret = (process.env.SYNTHETIC_LOGIN_SECRET || '').trim();
  if (!upn || !secret) {
    return { skipped: true, reason: MSAL_LOGIN_SKIP_REASON };
  }

  const origin = new URL(BASE).origin;
  const page = await context.newPage();
  try {
    // 1) Kick off the real flow — /auth/sign-in 302s to the Entra authorize URL.
    await page.goto(`${BASE}/auth/sign-in`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // 2) Entra username page (login.microsoftonline.com / .us — cloud-agnostic
    //    selectors: loginfmt is stable across both authorities).
    await page.waitForSelector('input[name="loginfmt"]', { timeout: 45_000 });
    await page.fill('input[name="loginfmt"]', upn);
    await page.click('input[type="submit"]');

    // 3) Password page.
    await page.waitForSelector('input[name="passwd"]', { timeout: 45_000 });
    await page.fill('input[name="passwd"]', secret);
    await page.click('input[type="submit"]');

    // 4) Optional "Stay signed in?" (KMSI) interstitial — accept if it appears.
    try {
      await page.waitForSelector('#idSIButton9', { timeout: 10_000 });
      await page.click('#idSIButton9');
    } catch {
      /* no KMSI prompt — fine */
    }

    // 5) Land back on the console (the REAL /auth/callback ran server-side and
    //    Set-Cookie'd loom_session before redirecting into the app).
    await page.waitForURL((u) => u.origin === origin, { timeout: 60_000 });

    const cookies = await context.cookies(BASE);
    const minted = cookies.some((c) => c.name === 'loom_session' && c.value.length > 32);
    return {
      skipped: false,
      cookieMinted: minted,
      landedUrl: page.url(),
      reason: minted
        ? undefined
        : `landed on ${page.url()} but no loom_session cookie was minted by the callback`,
    };
  } catch (e: unknown) {
    // A thrown step (e.g. AADSTS error page — no password field ever appears)
    // is a REAL login-path failure, not a skip. Surface the page URL + error.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      skipped: false,
      cookieMinted: false,
      landedUrl: page.url(),
      reason: `MSAL login flow failed at ${page.url()}: ${msg.slice(0, 300)}`,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
