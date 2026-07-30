/**
 * LU-9 round-3 — the inbound Entra verifier's UNAUTHENTICATED cost.
 *
 * `kid` is attacker-chosen and is consulted BEFORE any signature can be checked,
 * so "unknown kid ⇒ refetch the JWKS" turns every forged token into an outbound
 * request to login.microsoftonline.com that WE make on the caller's behalf. On
 * `/api/delta-sharing/*` — a brand-new, fully public, credential-free route with
 * no middleware and no rate limiter — that is a free remote resource-exhaustion
 * amplifier: 20 forged tokens with random kids produced 21 outbound fetches.
 *
 * These tests count real fetches, so they deliberately do NOT use the
 * `__setEntraJwksForTest` override (which short-circuits the network path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

const fetchMock = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));

const TENANT = '11111111-2222-3333-4444-555555555555';
const AUD = 'api://loom-sharing-recipients';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A syntactically valid RS256 JWT. `sign:false` leaves garbage in the signature
 *  slot — which is all an amplification probe needs, since the kid lookup runs
 *  first. */
function jwt(over: Record<string, unknown> = {}, kid = 'real-kid', sign = true): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
  const p = b64url(Buffer.from(JSON.stringify({
    iss: `https://sts.windows.net/${TENANT}/`, aud: AUD,
    scp: 'DeltaSharing.Read', oid: 'oid-1', tid: TENANT, exp: now + 3600, nbf: now - 60,
    ...over,
  })));
  const sig = sign
    ? b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), privateKey))
    : b64url(Buffer.alloc(256, 7));
  return `${h}.${p}.${sig}`;
}

function jwksResponse() {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return {
    ok: true,
    status: 200,
    json: async () => ({ keys: [{ ...jwk, kid: 'real-kid' }] }),
  };
}

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'AZURE_TENANT_ID', 'AZURE_CLOUD'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jwksResponse());
  // Clears the JWKS cache, the unknown-kid memo and the refresh clock.
  const { __setEntraJwksForTest } = await import('../entra-bearer-verify');
  __setEntraJwksForTest(null);
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('an unknown kid is not an outbound-request amplifier', () => {
  it('20 forged tokens with random kids do not produce 20 forced JWKS refetches', async () => {
    const { verifyEntraBearer, __entraForcedJwksRefreshCountForTest } = await import('../entra-bearer-verify');
    for (let i = 0; i < 20; i += 1) {
      const res = await verifyEntraBearer(`Bearer ${jwt({}, `forged-kid-${i}`, false)}`, { audiences: [AUD] });
      expect(res).toMatchObject({ ok: false, status: 401 });
    }
    // At most ONE forced refetch across the whole burst (one refresh per minute).
    expect(__entraForcedJwksRefreshCountForTest()).toBeLessThanOrEqual(1);
    // Total outbound fetches: the initial cache fill + at most that one refresh.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('a token whose CLAIMS cannot verify never reaches the network path at all', async () => {
    const { verifyEntraBearer, __entraForcedJwksRefreshCountForTest } = await import('../entra-bearer-verify');
    // Foreign issuer, wrong audience, and expired — each independently
    // disqualifying, so a refetch on its behalf can only ever be wasted work.
    const cases = [
      jwt({ iss: 'https://sts.windows.net/00000000-0000-0000-0000-000000000000/' }, 'k1', false),
      jwt({ aud: 'api://someone-else' }, 'k2', false),
      jwt({ exp: Math.floor(Date.now() / 1000) - 99_999 }, 'k3', false),
    ];
    for (const t of cases) {
      expect(await verifyEntraBearer(`Bearer ${t}`, { audiences: [AUD] })).toMatchObject({ ok: false, status: 401 });
    }
    expect(__entraForcedJwksRefreshCountForTest()).toBe(0);
  });

  it('the same unknown kid is remembered, so a repeat costs nothing', async () => {
    const { verifyEntraBearer, __entraForcedJwksRefreshCountForTest } = await import('../entra-bearer-verify');
    for (let i = 0; i < 5; i += 1) {
      await verifyEntraBearer(`Bearer ${jwt({}, 'same-unknown-kid', false)}`, { audiences: [AUD] });
    }
    expect(__entraForcedJwksRefreshCountForTest()).toBeLessThanOrEqual(1);
  });

  it('a genuine token still verifies (the throttle is not a denial of service on ourselves)', async () => {
    const { verifyEntraBearer } = await import('../entra-bearer-verify');
    const res = await verifyEntraBearer(`Bearer ${jwt()}`, { audiences: [AUD] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.audience).toBe(AUD);
  });

  it('still refuses an ID token (no scp/roles) and a nonce-bearing token', async () => {
    const { verifyEntraBearer } = await import('../entra-bearer-verify');
    expect(await verifyEntraBearer(`Bearer ${jwt({ scp: undefined })}`, { audiences: [AUD] }))
      .toMatchObject({ ok: false, status: 401 });
    expect(await verifyEntraBearer(`Bearer ${jwt({ nonce: 'abc' })}`, { audiences: [AUD] }))
      .toMatchObject({ ok: false, status: 401 });
  });
});
