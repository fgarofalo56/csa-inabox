/**
 * #3197 — the Entra → internal-token → catalog chain must SAY WHICH STEP FAILED.
 *
 * THE DEFECT THESE TESTS PIN. On 2026-08-10 the live Commercial console answered
 * both `/api/catalog/iceberg/config` and `/api/catalog/iceberg/namespaces` with
 *
 *   {"ok":false,"error":"Iceberg REST Catalog returned HTTP 403",
 *    "code":"iceberg_catalog_error"}
 *
 * and `az containerapp logs show -n loom-console` returned ZERO lines matching
 * iceberg / unity / 403 / exchange / token. Three completely different faults —
 * the Entra mint failing, the exchange being refused, and the catalog refusing a
 * good internal token — produced that ONE string and no other evidence, so the
 * failure could not be attributed to a step. That is the bug: not the 403, the
 * un-diagnosability of the 403 (`deploy-integrity.md` R6).
 *
 * NON-VACUITY. Each case below asserts BOTH the diagnostic that must appear AND
 * the diagnostics that must NOT — a mint failure must not claim the exchange
 * ran, an exchange denial must not claim the catalog was called. A test that
 * only asserted "some line was logged" would pass on a single generic message,
 * which is the state we are leaving.
 *
 * NOTHING MAY LEAK. Every case ends by asserting that neither the Entra subject
 * token nor the minted internal token appears anywhere in the captured output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── audit sinks (fire-and-forget in the code under test) ────────────────────
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { create: async (d: unknown) => ({ resource: d }) } }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: () => {} }));
vi.mock('@/lib/azure/unity-audit', () => ({
  recordUnityAccess: async () => {},
  recordDatabricksUnityAccess: () => {},
}));

// ── the Console managed identity ────────────────────────────────────────────
const getTokenMock = vi.fn();
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: (s: string) => getTokenMock(s) }),
}));

// ── the two upstream hops: the EXCHANGE and the CATALOG CALL ────────────────
//
// Modelling both is the point. A double that answers every request identically
// cannot tell a refused exchange from a refused catalog call, which is exactly
// the confusion under test.
const EXCHANGE_PATH = '/api/1.0/unity-control/auth/tokens';
let exchangeResponse: () => Response = () => new Response('{}', { status: 200 });
let catalogResponse: () => Response = () => new Response('{}', { status: 200 });
const hops: string[] = [];
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string) => {
    hops.push(String(url));
    return String(url).includes(EXCHANGE_PATH) ? exchangeResponse() : catalogResponse();
  },
}));

import { getCatalogConfig, IcebergCatalogError } from '../iceberg-catalog-client';
import {
  describeSubjectToken,
  resetUcTokenExchangeCache,
  UcTokenExchangeError,
  UC_AUTH_DIAG,
} from '../uc-token-exchange';

const BASE = 'https://iceberg-catalog.internal.example.net';
/** The Loom Unity app registration id from the live estate (#3197). */
const UNITY_CLIENT_ID = '5c59f3f3-e26d-4122-a707-a04e21ff5255';
/** The Console principal the catalog auto-bound as an ENABLED UC user at boot. */
const CONSOLE_OID = '85e5d083-7fd9-4588-9a28-6c035bea11a3';

/** Build a syntactically real (unsigned) JWT so the claim decoder has work to do. */
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
}

const SUBJECT_TOKEN = makeJwt({
  oid: CONSOLE_OID,
  appid: 'console-app-id',
  aud: `api://${UNITY_CLIENT_ID}`,
  iss: 'https://sts.windows.net/aaaabbbb-cccc-dddd-eeee-ffff00001111/',
  tid: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
  exp: 2000000000,
  // A claim that must NOT be copied into a diagnostic: the decoder is an
  // allow-list of six public identifiers, not a filter applied afterwards.
  secret_claim: 'do-not-log-me',
});
const INTERNAL_TOKEN = 'internal-minted-token-value';

// ── captured diagnostics ────────────────────────────────────────────────────
let logged: string[] = [];
const diag = () => logged.filter((l) => l.startsWith(UC_AUTH_DIAG));
const step = (name: string) => diag().filter((l) => l.includes(`step=${name} `));

beforeEach(() => {
  logged = [];
  hops.length = 0;
  resetUcTokenExchangeCache();
  getTokenMock.mockReset();
  vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
  process.env.LOOM_ICEBERG_CATALOG_URL = BASE;
  process.env.LOOM_MSAL_CLIENT_ID = UNITY_CLIENT_ID;
  delete process.env.LOOM_ICEBERG_CATALOG_TOKEN;
  delete process.env.LOOM_ICEBERG_CATALOG_AUDIENCE;
  exchangeResponse = () => new Response(JSON.stringify({ access_token: INTERNAL_TOKEN }), { status: 200 });
  catalogResponse = () => new Response(JSON.stringify({ overrides: {} }), { status: 200 });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOOM_ICEBERG_CATALOG_URL;
  delete process.env.LOOM_MSAL_CLIENT_ID;
});

/** No captured line may contain either credential. Asserted in every case. */
function expectNoTokenLeak() {
  for (const line of logged) {
    expect(line).not.toContain(SUBJECT_TOKEN);
    expect(line).not.toContain(INTERNAL_TOKEN);
    expect(line).not.toContain('Bearer ');
    expect(line).not.toContain('do-not-log-me');
  }
}

// ───────────────────────────────────────────────────────────────────── CASE 1
describe('step 1 — the Entra MINT fails', () => {
  it('names the mint, the audience and the reason, and does NOT claim the exchange ran', async () => {
    getTokenMock.mockRejectedValue(new Error('ManagedIdentityCredential: no MSI endpoint responded'));
    // The hop then goes out uncredentialed and the catalog refuses it — which is
    // byte-identical, from the route's side, to every other 403.
    catalogResponse = () => new Response('{}', { status: 403 });

    await expect(getCatalogConfig()).rejects.toBeInstanceOf(IcebergCatalogError);

    const mint = step('mint');
    expect(mint).toHaveLength(1);
    expect(mint[0]).toContain('outcome=failure');
    expect(mint[0]).toContain(`audience=api://${UNITY_CLIENT_ID}/.default`);
    expect(mint[0]).toContain(`base=${BASE}`);
    expect(mint[0]).toContain('no MSI endpoint responded');

    // Non-vacuity: the exchange was never reached, and nothing may imply it was.
    expect(step('exchange')).toHaveLength(0);
    expect(hops.some((h) => h.includes(EXCHANGE_PATH))).toBe(false);

    // And the catalog-call line states the decisive fact: the hop was ANONYMOUS.
    // Before this change that 403 and a rejected-good-token 403 were the same
    // observation.
    const call = step('catalog-call');
    expect(call).toHaveLength(1);
    expect(call[0]).toContain('outcome=denied');
    expect(call[0]).toContain('authMode=anonymous');
    expect(call[0]).toContain('status=403');
    expectNoTokenLeak();
  });

  it('a mint that returns NO token and raises no error is reported too', async () => {
    // The silent branch: `getToken` resolves with nothing. This used to
    // `return {}` with no trace at all.
    getTokenMock.mockResolvedValue(undefined);
    catalogResponse = () => new Response('{}', { status: 403 });

    await expect(getCatalogConfig()).rejects.toBeInstanceOf(IcebergCatalogError);
    expect(step('mint')[0]).toContain('outcome=empty');
    expect(step('catalog-call')[0]).toContain('authMode=anonymous');
    expectNoTokenLeak();
  });

  it('an unresolvable audience is reported instead of silently going anonymous', async () => {
    delete process.env.LOOM_MSAL_CLIENT_ID;
    catalogResponse = () => new Response('{}', { status: 403 });

    await expect(getCatalogConfig()).rejects.toBeInstanceOf(IcebergCatalogError);
    const mint = step('mint');
    expect(mint[0]).toContain('outcome=skipped');
    expect(mint[0]).toContain('LOOM_ICEBERG_CATALOG_AUDIENCE');
    expect(getTokenMock).not.toHaveBeenCalled();
    expectNoTokenLeak();
  });
});

// ───────────────────────────────────────────────────────────────────── CASE 2
describe('step 2 — the EXCHANGE returns 403', () => {
  beforeEach(() => {
    getTokenMock.mockResolvedValue({ token: SUBJECT_TOKEN, expiresOnTimestamp: Date.now() + 3600_000 });
  });

  it('names the exchange endpoint, the status, the server body and the subject principal', async () => {
    exchangeResponse = () => new Response(
      JSON.stringify({ error_code: 'PERMISSION_DENIED', message: 'principal is not an enabled user' }),
      { status: 403 },
    );

    await expect(getCatalogConfig()).rejects.toBeInstanceOf(UcTokenExchangeError);

    const ex = step('exchange');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toContain('outcome=denied');
    expect(ex[0]).toContain('status=403');
    expect(ex[0]).toContain(`path=${EXCHANGE_PATH}`);
    expect(ex[0]).toContain(`base=${BASE}`);
    // The subject's identity — the fact that says WHICH principal was refused
    // and WHAT audience its token carried.
    expect(ex[0]).toContain(`oid=${CONSOLE_OID}`);
    expect(ex[0]).toContain(`tokenAud=api://${UNITY_CLIENT_ID}`);
    expect(ex[0]).toContain('iss=https://sts.windows.net/');
    // The server's own words, which the BFF envelope discards.
    expect(ex[0]).toContain('PERMISSION_DENIED');

    // The mint SUCCEEDED — so the mint line says ok, and the catalog was never
    // called. Both halves matter: a reader must be able to rule steps OUT.
    expect(step('mint')[0]).toContain('outcome=ok');
    expect(step('catalog-call')).toHaveLength(0);
    expect(hops.filter((h) => !h.includes(EXCHANGE_PATH))).toHaveLength(0);
    expectNoTokenLeak();
  });

  it('distinguishes an unreachable exchange from a refused one', async () => {
    exchangeResponse = () => { throw new Error('ECONNREFUSED'); };
    await expect(getCatalogConfig()).rejects.toBeInstanceOf(UcTokenExchangeError);
    expect(step('exchange')[0]).toContain('outcome=unreachable');
    expect(step('exchange')[0]).toContain('ECONNREFUSED');
    expectNoTokenLeak();
  });

  it('distinguishes a 200 that carried no access_token', async () => {
    exchangeResponse = () => new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 });
    await expect(getCatalogConfig()).rejects.toBeInstanceOf(UcTokenExchangeError);
    expect(step('exchange')[0]).toContain('outcome=no-token');
    expectNoTokenLeak();
  });
});

// ───────────────────────────────────────────────────────────────────── CASE 3
describe('step 3 — the CATALOG refuses a successfully exchanged token', () => {
  beforeEach(() => {
    getTokenMock.mockResolvedValue({ token: SUBJECT_TOKEN, expiresOnTimestamp: Date.now() + 3600_000 });
  });

  it('reports a MINTED exchange followed by a denied catalog call, and evicts the token', async () => {
    // Exactly the live shape: the exchange succeeds, and the catalog answers 403
    // to the request that carries the token it just minted.
    catalogResponse = () => new Response(
      JSON.stringify({ error: { message: 'not authorized to list', type: 'Forbidden' } }),
      { status: 403 },
    );

    await expect(getCatalogConfig()).rejects.toBeInstanceOf(IcebergCatalogError);

    // The exchange is logged as loudly as its failures — its PRESENCE is what
    // turns the downstream 403 into a statement about the catalog call.
    const ex = step('exchange');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toContain('outcome=minted');
    expect(ex[0]).toContain('status=200');

    const call = step('catalog-call');
    expect(call).toHaveLength(1);
    expect(call[0]).toContain('outcome=denied');
    expect(call[0]).toContain('status=403');
    // The field that separates this case from CASE 1's identical HTTP status.
    expect(call[0]).toContain('authMode=exchanged');
    expect(call[0]).toContain(`base=${BASE}`);
    expect(call[0]).toContain('path=/api/2.1/unity-catalog/iceberg/v1/config');
    expect(call[0]).toContain(`oid=${CONSOLE_OID}`);
    expect(call[0]).toContain(`audience=api://${UNITY_CLIENT_ID}/.default`);
    expect(call[0]).toContain('code=Forbidden');
    expect(call[0]).toContain('not authorized to list');

    // #3197 — the Iceberg path was the ONE caller of the exchange with no
    // matching invalidation, so a token the catalog had stopped honouring
    // wedged every request for the rest of the 5-minute TTL. `outcome=evicted`
    // proves the eviction fired AND that a real exchanged token was in play.
    const inv = step('invalidate');
    expect(inv).toHaveLength(1);
    expect(inv[0]).toContain('outcome=evicted');
    expect(inv[0]).toContain(`oid=${CONSOLE_OID}`);
    expectNoTokenLeak();
  });

  it('the eviction makes the NEXT request re-exchange instead of reusing a dead token', async () => {
    catalogResponse = () => new Response('{}', { status: 403 });
    await expect(getCatalogConfig()).rejects.toBeInstanceOf(IcebergCatalogError);
    await expect(getCatalogConfig()).rejects.toBeInstanceOf(IcebergCatalogError);
    // Two exchanges, not one: without the eviction the second call would have
    // been served the cached token and the POST count would be 1.
    expect(hops.filter((h) => h.includes(EXCHANGE_PATH))).toHaveLength(2);
    expect(step('invalidate').filter((l) => l.includes('outcome=evicted'))).toHaveLength(2);
  });

  it('a non-auth catalog failure is NOT reported as denied and does NOT evict', async () => {
    // Non-vacuity for the classifier: a 500 must not be dressed up as an
    // authorization problem, and must not throw away a perfectly good token.
    catalogResponse = () => new Response('boom', { status: 500 });
    await expect(getCatalogConfig()).rejects.toBeInstanceOf(IcebergCatalogError);
    expect(step('catalog-call')[0]).toContain('outcome=failure');
    expect(step('catalog-call')[0]).not.toContain('outcome=denied');
    expect(step('invalidate')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────── mutual distinctness
describe('the three diagnostics are mutually distinguishable', () => {
  const run = async (setup: () => void) => {
    logged = [];
    hops.length = 0;
    resetUcTokenExchangeCache();
    setup();
    await getCatalogConfig().catch(() => {});
    return diag().join('\n');
  };

  it('each failing step produces a DIFFERENT greppable line and rules the others out', async () => {
    const mintFailed = await run(() => {
      getTokenMock.mockRejectedValue(new Error('no MSI endpoint'));
      catalogResponse = () => new Response('{}', { status: 403 });
    });
    const exchangeFailed = await run(() => {
      getTokenMock.mockResolvedValue({ token: SUBJECT_TOKEN });
      exchangeResponse = () => new Response('denied', { status: 403 });
      catalogResponse = () => new Response('{}', { status: 403 });
    });
    const catalogFailed = await run(() => {
      getTokenMock.mockResolvedValue({ token: SUBJECT_TOKEN });
      exchangeResponse = () => new Response(JSON.stringify({ access_token: INTERNAL_TOKEN }), { status: 200 });
      catalogResponse = () => new Response('{}', { status: 403 });
    });

    // All three routes answer the SAME user-visible 403. The logs must not.
    expect(mintFailed).toMatch(/step=mint outcome=failure/);
    expect(mintFailed).not.toMatch(/step=exchange/);

    expect(exchangeFailed).toMatch(/step=exchange outcome=denied/);
    expect(exchangeFailed).toMatch(/step=mint outcome=ok/);
    expect(exchangeFailed).not.toMatch(/step=catalog-call/);

    expect(catalogFailed).toMatch(/step=exchange outcome=minted/);
    expect(catalogFailed).toMatch(/step=catalog-call outcome=denied/);
    expect(catalogFailed).toMatch(/authMode=exchanged/);

    // And the three are not accidentally equal.
    expect(new Set([mintFailed, exchangeFailed, catalogFailed]).size).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────── claim decoder
describe('describeSubjectToken', () => {
  it('returns the six public identifiers and NOTHING else', () => {
    const c = describeSubjectToken(SUBJECT_TOKEN)!;
    expect(Object.keys(c).sort()).toEqual(['appid', 'exp', 'iss', 'oid', 'tid', 'tokenAud']);
    expect(c.oid).toBe(CONSOLE_OID);
    expect(c.tokenAud).toBe(`api://${UNITY_CLIENT_ID}`);
    expect(c.exp).toBe(new Date(2000000000 * 1000).toISOString());
    // The decisive property: it is an allow-list. An unexpected claim in the
    // payload cannot ride along into a log line.
    expect(JSON.stringify(c)).not.toContain('do-not-log-me');
    expect(JSON.stringify(c)).not.toContain('c2lnbmF0dXJl');
  });

  it('joins a multi-valued aud rather than rendering [object Object]', () => {
    const c = describeSubjectToken(makeJwt({ aud: ['api://a', 'api://b'], oid: 'o' }))!;
    expect(c.tokenAud).toBe('api://a,api://b');
  });

  it('returns undefined for an opaque (non-JWT) credential instead of throwing', () => {
    expect(describeSubjectToken('a-pre-shared-opaque-token')).toBeUndefined();
    expect(describeSubjectToken('')).toBeUndefined();
    expect(describeSubjectToken('a.b.c')).toBeUndefined();
  });
});
