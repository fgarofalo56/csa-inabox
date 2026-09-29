/**
 * BFF contract tests for POST /api/governance/govern/refresh — the Govern
 * owner-view on-open posture pre-warm.
 *
 * The load-bearing case is "URL set, key absent". The admin-plane bicep now
 * binds LOOM_POSTURE_FUNCTION_KEY only once the Key Vault secret is known to
 * exist (`postureFunctionKeyBound`), so a console with the URL and no key is a
 * real deploy state. The Function's `posture-refresh` route is
 * `AuthLevel.FUNCTION`, so an unkeyed call is rejected — and before this fix the
 * route dispatched it anyway (fire-and-forget, rejection swallowed) and answered
 * `{ ok:true, dispatched:true }`.
 *
 * What value breaks each assertion:
 *   - "URL set, key absent": the pre-fix route — it returns ok:true /
 *     dispatched:true and calls fetch with `x-functions-key: ''`, so
 *     `ok === false`, `missingEnvVar === 'LOOM_POSTURE_FUNCTION_KEY'` and
 *     `fetch` called 0 times all fail.
 *   - "whitespace-only key": dropping the `.trim()` on the key read — '   ' is
 *     truthy, so the route would dispatch.
 *   - "URL + key set" (the POSITIVE control, so the gate cannot be satisfied by
 *     never dispatching): a gate that fires unconditionally, or a header that
 *     stops carrying the key, or the owner id taken from anywhere but the session.
 *   - "URL unset": deleting / reordering the URL gate so the key gate answers
 *     first (missingEnvVar would read LOOM_POSTURE_FUNCTION_KEY).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SESSION_OID = 'refresh-owner-oid';
const SESSION_UPN = 'owner@contoso.com';
const FUNCTION_URL = 'https://func-loom-posture-refresh-test.azurewebsites.net';
// Fixture value only — not a credential.
const FIXTURE_KEY = 'fixture-host-key';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: SESSION_OID, upn: SESSION_UPN }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
}));

import { POST } from '../route';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('', { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('LOOM_POSTURE_FUNCTION_URL', '');
  vi.stubEnv('LOOM_POSTURE_FUNCTION_KEY', '');
  getSessionMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/governance/govern/refresh', () => {
  it('401 without a session, and dispatches nothing', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    vi.stubEnv('LOOM_POSTURE_FUNCTION_URL', FUNCTION_URL);
    vi.stubEnv('LOOM_POSTURE_FUNCTION_KEY', FIXTURE_KEY);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL unset → honest gate naming LOOM_POSTURE_FUNCTION_URL, no dispatch', async () => {
    // Key set on purpose: the URL gate must answer first, so this reads the
    // URL name even though the key is present.
    vi.stubEnv('LOOM_POSTURE_FUNCTION_KEY', FIXTURE_KEY);
    const res = await POST();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: false, gate: 'not_configured', missingEnvVar: 'LOOM_POSTURE_FUNCTION_URL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL set, key absent → honest gate naming LOOM_POSTURE_FUNCTION_KEY, and NO unkeyed dispatch', async () => {
    vi.stubEnv('LOOM_POSTURE_FUNCTION_URL', FUNCTION_URL);
    const res = await POST();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(false);
    expect(j.gate).toBe('not_configured');
    expect(j.missingEnvVar).toBe('LOOM_POSTURE_FUNCTION_KEY');
    expect(j.dispatched).toBeUndefined();
    // The message must say live posture still renders (only the pre-warm is gated).
    expect(j.message).toMatch(/computed live from Cosmos/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('whitespace-only key counts as absent', async () => {
    vi.stubEnv('LOOM_POSTURE_FUNCTION_URL', FUNCTION_URL);
    vi.stubEnv('LOOM_POSTURE_FUNCTION_KEY', '   ');
    const j = await (await POST()).json();
    expect(j.missingEnvVar).toBe('LOOM_POSTURE_FUNCTION_KEY');
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('URL + key set → dispatches ONE keyed, session-scoped call and reports dispatched', async () => {
    vi.stubEnv('LOOM_POSTURE_FUNCTION_URL', `${FUNCTION_URL}/`); // trailing slash is stripped
    vi.stubEnv('LOOM_POSTURE_FUNCTION_KEY', FIXTURE_KEY);
    const j = await (await POST()).json();
    expect(j).toEqual({ ok: true, dispatched: true, scope: 'owner' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FUNCTION_URL}/api/posture-refresh`);
    expect((init.headers as Record<string, string>)['x-functions-key']).toBe(FIXTURE_KEY);
    expect(JSON.parse(String(init.body))).toEqual({ scope: 'owner', ownerId: SESSION_OID, ownerUpn: SESSION_UPN });
  });
});
