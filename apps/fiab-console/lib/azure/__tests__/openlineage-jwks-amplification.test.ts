/**
 * The OpenLineage ingest verifier's UNAUTHENTICATED outbound cost.
 *
 * `kid` is attacker-chosen and is consulted BEFORE any signature can be checked,
 * so an unthrottled "unknown kid ⇒ refetch the JWKS" rule turns every forged
 * token into an outbound request to login.microsoftonline.com that WE make on the
 * caller's behalf. `/api/lineage/openlineage` is credential-free-reachable in the
 * same way `/api/delta-sharing/*` is: the refusal is cheap for the caller and
 * costs us a network round trip.
 *
 * WHY THIS FILE EXISTS: the throttle and the `__openLineageForcedJwksRefreshCountForTest`
 * hook were added to `openlineage-auth.ts` in the same change that added them to
 * `entra-bearer-verify.ts`, but the hook was never called by any spec. So the
 * class sweep that claimed to close both copies of the shape only had evidence
 * for one of them — a fix nobody watched fail is not a fix that is known to work.
 *
 * These tests count REAL fetches, so they deliberately do not use the
 * `__setOpenLineageJwksForTest` override (which short-circuits the network path);
 * it is used only to reset the module's cache, unknown-kid memo and refresh clock
 * between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

const fetchMock = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const POOL_PRINCIPAL = '77777777-7777-7777-7777-777777777777';
const WORKSPACE = 'ws-analytics';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A syntactically valid RS256 JWT. `sign:false` leaves garbage in the signature
 *  slot — all an amplification probe needs, since the kid lookup runs first. */
function jwt(over: Record<string, unknown> = {}, kid = 'real-kid', sign = true): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
  const p = b64url(Buffer.from(JSON.stringify({
    iss: `https://sts.windows.net/${TENANT}/`, aud: CLIENT_ID,
    appid: POOL_PRINCIPAL, tid: TENANT, exp: now + 3600, nbf: now - 60,
    ...over,
  })));
  const sig = sign
    ? b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), privateKey))
    : b64url(Buffer.alloc(256, 7));
  return `${h}.${p}.${sig}`;
}

function jwksResponse() {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ok: true, status: 200, json: async () => ({ keys: [{ ...jwk, kid: 'real-kid' }] }) };
}

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_MSAL_TENANT_ID', 'AZURE_TENANT_ID', 'LOOM_MSAL_CLIENT_ID',
  'LOOM_OPENLINEAGE_AUDIENCE', 'LOOM_OPENLINEAGE_AUTH_MODE', 'LOOM_OPENLINEAGE_POOL_PRINCIPALS',
  'AZURE_CLOUD'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_OPENLINEAGE_POOL_PRINCIPALS = `${POOL_PRINCIPAL}=${WORKSPACE}`;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jwksResponse());
  // Clears the JWKS cache, the unknown-kid memo and the forced-refresh clock.
  const { __setOpenLineageJwksForTest } = await import('../openlineage-auth');
  __setOpenLineageJwksForTest(null);
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('openlineage ingest: an unknown kid is not an outbound-request amplifier', () => {
  it('20 forged tokens with rotating kids do not produce 20 forced JWKS refetches', async () => {
    const { verifyOpenLineageAuth, __openLineageForcedJwksRefreshCountForTest } =
      await import('../openlineage-auth');
    for (let i = 0; i < 20; i += 1) {
      const res = await verifyOpenLineageAuth(`Bearer ${jwt({}, `forged-kid-${i}`, false)}`);
      expect(res).toMatchObject({ ok: false, status: 401 });
    }
    // At most ONE forced refetch across the whole burst (one per minute).
    expect(__openLineageForcedJwksRefreshCountForTest()).toBeLessThanOrEqual(1);
    // Total outbound fetches: the initial cache fill + at most that one refresh.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('a token whose CLAIMS cannot verify never reaches the network path at all', async () => {
    const { verifyOpenLineageAuth, __openLineageForcedJwksRefreshCountForTest } =
      await import('../openlineage-auth');
    // Foreign issuer, wrong audience, expired — each independently disqualifying,
    // so a refetch on its behalf could only ever be wasted work.
    const cases = [
      jwt({ iss: 'https://sts.windows.net/00000000-0000-0000-0000-000000000000/' }, 'k1', false),
      jwt({ aud: 'api://someone-else' }, 'k2', false),
      jwt({ exp: Math.floor(Date.now() / 1000) - 99_999 }, 'k3', false),
    ];
    for (const t of cases) {
      expect(await verifyOpenLineageAuth(`Bearer ${t}`)).toMatchObject({ ok: false, status: 401 });
    }
    expect(__openLineageForcedJwksRefreshCountForTest()).toBe(0);
  });

  it('the same unknown kid is remembered, so a repeat costs nothing', async () => {
    const { verifyOpenLineageAuth, __openLineageForcedJwksRefreshCountForTest } =
      await import('../openlineage-auth');
    for (let i = 0; i < 5; i += 1) {
      await verifyOpenLineageAuth(`Bearer ${jwt({}, 'same-unknown-kid', false)}`);
    }
    expect(__openLineageForcedJwksRefreshCountForTest()).toBeLessThanOrEqual(1);
  });

  it('the refusal message does not leak WHICH claim was wrong', async () => {
    // The pre-flight that decides refetch eligibility must not short-circuit the
    // result, or an anonymous caller gains a "which field did I get right?"
    // oracle. Every unknown-kid refusal reads the same.
    const { verifyOpenLineageAuth } = await import('../openlineage-auth');
    const plausible = await verifyOpenLineageAuth(`Bearer ${jwt({}, 'unknown-1', false)}`);
    const implausible = await verifyOpenLineageAuth(
      `Bearer ${jwt({ aud: 'api://someone-else' }, 'unknown-2', false)}`,
    );
    expect(plausible).toMatchObject({ ok: false, status: 401, error: 'unknown token signing key' });
    expect(implausible).toMatchObject({ ok: false, status: 401, error: 'unknown token signing key' });
  });

  it('a genuine token still verifies (the throttle is not a denial of service on ourselves)', async () => {
    const { verifyOpenLineageAuth } = await import('../openlineage-auth');
    const res = await verifyOpenLineageAuth(`Bearer ${jwt()}`);
    expect(res).toMatchObject({ ok: true, workspaceId: WORKSPACE, mode: 'entra' });
  });

  it('a genuine token still verifies AFTER a forged burst has spent the refresh budget', async () => {
    // The bound must not become a self-inflicted outage: a real rollover key is
    // published ahead of first use, so the cached document still verifies.
    const { verifyOpenLineageAuth } = await import('../openlineage-auth');
    for (let i = 0; i < 30; i += 1) {
      await verifyOpenLineageAuth(`Bearer ${jwt({}, `forged-${i}`, false)}`);
    }
    expect(await verifyOpenLineageAuth(`Bearer ${jwt()}`)).toMatchObject({ ok: true, workspaceId: WORKSPACE });
  });
});
