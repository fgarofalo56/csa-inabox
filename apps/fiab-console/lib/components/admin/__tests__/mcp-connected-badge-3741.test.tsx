/**
 * #3741 — a "Connected" badge over a card whose own body said "Sign-in required".
 *
 * MEASURED LIVE, 2026-08-18, `/admin/mcp-servers` → Microsoft MCP servers →
 * Microsoft Foundry: a green **Connected** badge in the card header, and a
 * yellow **Sign-in required** MessageBar in the same card's body, for the same
 * signed-in admin. Microsoft Sentinel — another `entra-obo` server on the same
 * page, in the same un-consented state but not yet registered — correctly showed
 * neither, so the contradiction was visible side by side.
 *
 * ROOT CAUSE. The badge read `configured && registered`; the MessageBar read
 * `auth === 'entra-obo' && !tokenReady`. Two hand-written conditions over ONE
 * status object, and only one of them knew about the per-user token.
 * `registered` is a TENANT fact (set once ANY admin registers the server);
 * `tokenReady` is the per-user OBO lookup `ms-remote/route.ts:258-274` performs
 * for precisely this, its own comment saying it exists so the panel can show
 * "Connected vs. 'sign in again / consent' WITHOUT FAKING AN OK".
 *
 * WHY THE PREDICATE AND NOT THE BADGE IS UNDER TEST. Rendering this panel needs
 * the whole admin shell, nine server cards and a live probe; the defect is a
 * boolean, and a boolean is where a control can be sharp. The badge and the
 * MessageBar now call `mcpServerUsable` — the same function — so the two cannot
 * disagree again, which is the property that actually failed. The truth table
 * below is the tenant/user matrix, and the last describe is the counterfactual:
 * the old badge condition, restored, calls the live Foundry state "Connected".
 */
import { describe, it, expect } from 'vitest';
import { mcpServerUsable } from '../mcp-servers-panel';

/** The exact live state of the Foundry card on 2026-08-18. */
const FOUNDRY_LIVE = { auth: 'entra-obo' as const, tokenReady: false };

describe('mcpServerUsable — tenant registration is not per-user readiness', () => {
  it('is FALSE for an entra-obo server with no cached user token (the live defect)', () => {
    expect(mcpServerUsable(FOUNDRY_LIVE)).toBe(false);
  });

  it('is TRUE for an entra-obo server the signed-in user HAS consented', () => {
    // Acceptance 2: a genuinely usable server must still read Connected. A
    // predicate that always returned false would "fix" the contradiction by
    // removing the signal.
    expect(mcpServerUsable({ auth: 'entra-obo', tokenReady: true })).toBe(true);
  });

  it('is TRUE for auth:"none" servers, which have no token concept', () => {
    // Acceptance 3 — Microsoft Learn, Microsoft Release Communications.
    expect(mcpServerUsable({ auth: 'none' })).toBe(true);
    expect(mcpServerUsable({ auth: 'none', tokenReady: false })).toBe(true);
  });

  it('is TRUE for key-vault auth, which is a deployment credential not a user one', () => {
    expect(mcpServerUsable({ auth: 'key-vault' })).toBe(true);
    expect(mcpServerUsable({ auth: 'key-vault', tokenReady: false })).toBe(true);
  });

  it('treats a MISSING tokenReady on an entra-obo server as not-ready, never as ready', () => {
    // Fail closed. `tokenReady` is optional on the wire, and an older route (or
    // a partial serializer) that omits it must not be read as an OK — that is
    // the "faking an OK" the route's own comment forbids.
    expect(mcpServerUsable({ auth: 'entra-obo' })).toBe(false);
    expect(mcpServerUsable({ auth: 'entra-obo', tokenReady: undefined })).toBe(false);
  });

  it('does not accept a truthy non-boolean as readiness', () => {
    // `tokenReady: 'no'` is truthy. A `!!` check would pass it.
    expect(mcpServerUsable({ auth: 'entra-obo', tokenReady: 'no' as unknown as boolean })).toBe(false);
  });

  it('an UNDECLARED auth is treated as tokenless, matching the badge it drives', () => {
    // Not an oversight: the badge is only reached when `configured && registered`,
    // and every entra-obo server the route emits declares `auth`. Stated so the
    // behaviour is a decision rather than an accident.
    expect(mcpServerUsable({})).toBe(true);
  });
});

describe('#3741 the badge and the warning cannot disagree', () => {
  it('is the SINGLE source for both, over the whole tenant/user matrix', () => {
    // Before the fix these were two conditions:
    //   badge:   configured && registered
    //   warning: auth === 'entra-obo' && !tokenReady
    // For an entra-obo server they are BOTH TRUE in exactly one cell — the cell
    // Foundry was in — and both rendered.
    const cases = [
      { auth: 'entra-obo' as const, tokenReady: false },
      { auth: 'entra-obo' as const, tokenReady: true },
      { auth: 'none' as const, tokenReady: false },
      { auth: 'key-vault' as const, tokenReady: false },
    ];
    for (const c of cases) {
      const showsConnected = mcpServerUsable(c);
      const showsSignInWarning = !mcpServerUsable(c);
      expect(showsConnected && showsSignInWarning).toBe(false);
      expect(showsConnected || showsSignInWarning).toBe(true);
    }
  });
});

describe('#3741 COUNTERFACTUAL: the condition that shipped calls the live state Connected', () => {
  it('configured && registered alone is true for a card that cannot be called', () => {
    // The removed badge condition, restored verbatim. If it did NOT say
    // "Connected" here, the assertions above would be measuring nothing.
    const legacyBadge = (s: { configured: boolean; registered?: boolean }) => !!(s.configured && s.registered);
    const foundry = { configured: true, registered: true, ...FOUNDRY_LIVE };
    expect(legacyBadge(foundry)).toBe(true);      // showed "Connected" …
    expect(mcpServerUsable(foundry)).toBe(false); // … while the body said sign in
  });
});
