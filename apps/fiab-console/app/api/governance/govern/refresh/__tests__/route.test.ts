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
 *   - "URL unset": deleting the URL gate, or reordering it below the key gate.
 *     Both vars are empty in that case, so the key gate would answer first and
 *     missingEnvVar would read LOOM_POSTURE_FUNCTION_KEY.
 *   - `gateReason` on each gate: swapping or dropping it, which is what the
 *     Govern owner pane keys its MessageBar title on.
 *   - `bicepModule` on each gate is RESOLVED against the repo and read, not
 *     compared as a string. The key gate's module must declare
 *     `postureFunctionKeyEnabled`, which the Function module does not (0
 *     occurrences). So pointing the key gate back at
 *     `azure-functions/posture-refresh/deploy/main.bicep`, the #4770 review
 *     blocker, fails, and so does any path that does not exist. The URL gate's
 *     module must declare `output functionUrl`, which admin-plane does not.
 *   - key-gate message: every term of admin-plane `postureFunctionKeyBound` is
 *     lifted from the bicep and must appear in it. The round-2 message, which
 *     omitted loomPostureFunctionUrl, fails.
 *   - 401 body: any change to the envelope, e.g. `{ error: 'unauthorized' }` or
 *     dropping `ok:false`, fails the `toEqual`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// __tests__ -> refresh -> govern -> governance -> api -> app -> fiab-console -> apps -> repo root
const REPO_ROOT = fileURLToPath(new URL('../../../../../../../../', import.meta.url));
function readModule(rel: string): string {
  const abs = path.join(REPO_ROOT, rel);
  // A missing file must fail loudly here, not read as "marker absent".
  expect(existsSync(abs), `bicepModule ${rel} must exist under ${REPO_ROOT}`).toBe(true);
  return readFileSync(abs, 'utf8');
}

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
    // Pin the envelope, not just the status: withSession -> apiUnauthorized()
    // must stay byte-compatible with the hand-rolled body it replaced.
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL unset → honest gate naming LOOM_POSTURE_FUNCTION_URL, no dispatch', async () => {
    // Key left EMPTY on purpose (beforeEach stubs both vars ''). With both
    // missing, the gate that answers is decided only by ORDER, so moving the
    // key gate above the URL gate turns this red: missingEnvVar would read
    // LOOM_POSTURE_FUNCTION_KEY. A key stubbed present would hide that reorder,
    // because the key gate cannot fire in either order (#4770 review).
    expect(process.env.LOOM_POSTURE_FUNCTION_KEY).toBe('');
    const res = await POST();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({
      ok: false,
      gate: 'not_configured',
      gateReason: 'function_not_provisioned',
      missingEnvVar: 'LOOM_POSTURE_FUNCTION_URL',
    });
    // Here the Function genuinely does not exist, so its own module IS the fix.
    expect(readModule(j.bicepModule)).toMatch(/^output functionUrl\b/m);
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
    expect(j.gateReason).toBe('key_not_bound');
    expect(j.dispatched).toBeUndefined();
    // The remediation module must be the one that BINDS the key. The Function
    // module has 0 occurrences of this flag, so the review's blocker (pointing
    // here at azure-functions/posture-refresh/deploy/main.bicep) fails this read.
    expect(readModule(j.bicepModule)).toMatch(/\bpostureFunctionKeyEnabled\b/);
    // The message must name EVERY condition the admin-plane binding needs. The
    // terms are LIFTED from the bicep at runtime, not transcribed:
    //   - `var postureFunctionKeyBound = ...` yields its identifiers, minus the
    //     bicep built-ins. The set is pinned exactly, so a new condition added to
    //     the var fails here until the message names it too.
    //   - `param loomPostureFunctionKeySecretName string = '<name>'` yields the
    //     secret the message must point at.
    // Breaking values: the round-2 message, which named the flag and the secret
    // but not loomPostureFunctionUrl (the #4770 round-3 blocker), fails the
    // loop below; renaming the secret default in bicep alone fails the
    // Key Vault match.
    const adminPlane = readModule(j.bicepModule);
    const bound = /^var postureFunctionKeyBound = (.+)$/m.exec(adminPlane);
    expect(bound, 'admin-plane must still declare var postureFunctionKeyBound').not.toBeNull();
    const BICEP_BUILTINS = new Set(['empty', 'observabilityConfig', 'false', 'true']);
    const terms = [...new Set(bound![1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])]
      .filter((t) => !BICEP_BUILTINS.has(t))
      .sort();
    expect(terms).toEqual(['loomPostureFunctionUrl', 'postureFunctionKeyEnabled']);
    for (const t of terms) expect(j.message).toContain(t);
    const secret = /^param loomPostureFunctionKeySecretName string = '([^']+)'/m.exec(adminPlane);
    expect(secret, 'admin-plane must still declare the secret-name param with a default').not.toBeNull();
    expect(j.message).toContain(`Key Vault as ${secret![1]}`);
    // loomPostureFunctionUrl must be named as the ROOT deploy param, and the
    // out-of-band assignment must be disowned: that assignment is what sets
    // LOOM_POSTURE_FUNCTION_URL today, and it does not satisfy the bicep var.
    expect(j.message).toContain('passed as a deploy parameter to platform/fiab/bicep/main.bicep');
    expect(j.message).toMatch(/az containerapp update does not count/);
    // It says it cannot tell which condition is missing, and does not claim
    // the Function is deployed: a set URL is configuration, not a reachable host.
    expect(j.message).toMatch(/cannot tell which of these is missing/);
    expect(j.message).toMatch(/Function URL is configured/);
    expect(j.message).not.toMatch(/Function is deployed/);
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
