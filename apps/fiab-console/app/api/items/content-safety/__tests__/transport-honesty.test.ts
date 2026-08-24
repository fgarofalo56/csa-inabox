/**
 * Error-honesty regression tests for the /api/items/content-safety/** family (#3578).
 *
 * THE DEFECT
 * ----------
 * "Analyze text" — the headline action of the `content-safety` item type — was
 * failing with the bare string **"Error fetch failed"**: no status, no host, no
 * errno, no remediation. All four routes in the family shared the same relay:
 *
 *     return NextResponse.json({ ok:false, error: e?.message || String(e), … });
 *
 * `e.message` for an unreachable endpoint is undici's generic
 * `TypeError: fetch failed`, and undici puts the REAL failure in `e.cause`
 * (`getaddrinfo ENOTFOUND …`, `.code === 'ENOTFOUND'`). Reading only `.message`
 * threw away the one field that said what happened.
 *
 * It is also UNTRUE in the sense `deploy-integrity.md` R7 forbids: "fetch
 * failed" reads as a failed moderation call — i.e. as an answer from the
 * service — when in fact the request never arrived and there is no answer at
 * all. Same class as the 2026-08-05 "the tag does not exist" that was really
 * "I could not reach the registry".
 *
 * WHAT THIS FILE PINS
 * -------------------
 * 1. EVERY route in the family, enumerated from the FILESYSTEM rather than
 *    hand-listed. The classifier lives in one shared module, so a route that
 *    simply forgot to call it would still be broken while a
 *    classifier-only test stayed green — that is the narrow bypass here. The
 *    `covers every route` case walks `app/api/items/content-safety/**` for
 *    `route.ts` files and asserts the enumerated set EQUALS the driven set, so
 *    a fifth route added without the classifier fails this file.
 * 2. THE HONESTY PROPERTIES, not just "the message changed": the response must
 *    name the observed errno, must say no moderation result was produced, and
 *    must NOT contain the bare relay string.
 * 3. AN EMBEDDED NEGATIVE CONTROL — a real HTTP error from the service (which
 *    HAS a status and IS honest) must still pass through the old mapping
 *    untouched. A classifier that swallowed those would be a regression, and
 *    without this case an over-broad matcher would look like a pass.
 * 4. AN EMBEDDED POSITIVE CONTROL — a successful call still returns 200 with
 *    its payload, proving the routes are reachable and the suite is executing
 *    rather than vacuously green.
 *
 * No test in this file performs a network call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── session: signed in, so the tests exercise the error path, not the 401 ──
const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'admin@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

// ── the data-plane / ARM clients, stubbed. The error CLASSES are defined here
//    so the routes' `instanceof` checks resolve against the same objects. ──
const listContentSafetyPolicies = vi.fn();
const moderateText = vi.fn();
const moderateImage = vi.fn();
const listBlocklists = vi.fn();
const upsertBlocklist = vi.fn();
const deleteBlocklist = vi.fn();
const listBlocklistItems = vi.fn();
const addBlocklistItems = vi.fn();
const removeBlocklistItems = vi.fn();
const listRaiPolicies = vi.fn();
const upsertRaiPolicy = vi.fn();
const deleteRaiPolicy = vi.fn();

class FoundryError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
class NotDeployedError extends Error {
  service: string;
  hint: string;
  constructor(service: string, hint: string) {
    super(`${service} is not provisioned in this deployment`);
    this.service = service;
    this.hint = hint;
  }
}
class CsError extends FoundryError {}
class CsNotConfiguredError extends NotDeployedError {}

vi.mock('@/lib/azure/foundry-client', () => ({
  listContentSafetyPolicies: (...a: any[]) => listContentSafetyPolicies(...a),
  moderateText: (...a: any[]) => moderateText(...a),
  moderateImage: (...a: any[]) => moderateImage(...a),
  listBlocklists: (...a: any[]) => listBlocklists(...a),
  upsertBlocklist: (...a: any[]) => upsertBlocklist(...a),
  deleteBlocklist: (...a: any[]) => deleteBlocklist(...a),
  listBlocklistItems: (...a: any[]) => listBlocklistItems(...a),
  addBlocklistItems: (...a: any[]) => addBlocklistItems(...a),
  removeBlocklistItems: (...a: any[]) => removeBlocklistItems(...a),
  FoundryError,
  NotDeployedError,
}));
vi.mock('@/lib/azure/foundry-cs-client', () => ({
  listRaiPolicies: (...a: any[]) => listRaiPolicies(...a),
  upsertRaiPolicy: (...a: any[]) => upsertRaiPolicy(...a),
  deleteRaiPolicy: (...a: any[]) => deleteRaiPolicy(...a),
  CsError,
  CsNotConfiguredError,
}));

/** The exact error undici raises when a host does not resolve. */
function undiciFetchFailed(code: string, inner: string) {
  const cause: any = new Error(inner);
  cause.code = code;
  const outer: any = new TypeError('fetch failed');
  outer.cause = cause;
  return outer;
}

function getReq(search = '') {
  return { url: `http://x/api${search}`, nextUrl: new URL(`http://x/api${search}`) } as any;
}

/** Every route in the family, with the client call its GET reaches. */
const FAMILY: Array<{
  /** POSIX path relative to app/api/items/content-safety — the enumeration key. */
  rel: string;
  importPath: string;
  driver: ReturnType<typeof vi.fn>;
  req: () => any;
  okPayload: unknown;
  okAssert: (j: any) => void;
}> = [
  {
    rel: 'route.ts',
    importPath: '../route',
    driver: listContentSafetyPolicies,
    req: () => getReq(''),
    okPayload: [{ name: 'default' }],
    okAssert: (j) => expect(j.policies).toEqual([{ name: 'default' }]),
  },
  {
    rel: 'blocklists/route.ts',
    importPath: '../blocklists/route',
    driver: listBlocklists,
    req: () => getReq(''),
    okPayload: [{ blocklistName: 'bl1' }],
    okAssert: (j) => expect(j.blocklists).toEqual([{ blocklistName: 'bl1' }]),
  },
  {
    rel: 'blocklists/items/route.ts',
    importPath: '../blocklists/items/route',
    driver: listBlocklistItems,
    req: () => getReq('?name=bl1'),
    okPayload: [{ blocklistItemId: 'i1', text: 'x' }],
    okAssert: (j) => expect(j.items).toEqual([{ blocklistItemId: 'i1', text: 'x' }]),
  },
  {
    rel: 'rai-policies/route.ts',
    importPath: '../rai-policies/route',
    driver: listRaiPolicies,
    req: () => getReq(''),
    okPayload: { account: { name: 'acct', location: 'eastus', kind: 'AIServices' }, policies: [] },
    okAssert: (j) => expect(j.account.name).toBe('acct'),
  },
];

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'admin@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  for (const f of FAMILY) f.driver.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('content-safety routes — transport failures are diagnosed, not relayed (#3578)', () => {
  // ── POPULATION CONTROL ────────────────────────────────────────────────────
  // The fix lives in ONE shared module. Testing the module alone would pass
  // while a route that never calls it stayed broken — so the set under test is
  // derived from the filesystem and compared to the driven set.
  it('covers every route.ts under app/api/items/content-safety', () => {
    const root = path.join(__dirname, '..');
    const found: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === '_lib') continue;
          walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.name === 'route.ts') {
          found.push(prefix ? `${prefix}/route.ts` : 'route.ts');
        }
      }
    };
    walk(root, '');
    // A control on the control: an enumeration that found nothing would make
    // the equality below vacuously true against an empty FAMILY.
    expect(found.length).toBeGreaterThan(0);
    expect([...found].sort()).toEqual(FAMILY.map((f) => f.rel).sort());
  });

  for (const f of FAMILY) {
    it(`${f.rel}: an unreachable endpoint yields an honest 502, never "fetch failed"`, async () => {
      f.driver.mockRejectedValue(undiciFetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND cs.example.invalid'));
      const mod: any = await import(f.importPath);
      const res = await mod.GET(f.req(), undefined as any);

      expect(res.status).toBe(502);
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(j.code).toBe('upstream_unreachable');
      // The errno undici hid on `.cause` is now reported.
      expect(j.cause).toBe('ENOTFOUND');
      expect(j.error).toMatch(/did not resolve in DNS/);
      // R7: it must not assert a moderation outcome it never obtained.
      expect(j.error).toMatch(/never reached the service|no moderation result/i);
      // The old, untrue relay must be gone.
      expect(j.error).not.toBe('fetch failed');
      expect(j.error).not.toMatch(/^fetch failed$/);
      // And an actionable remediation must accompany it.
      expect(String(j.hint)).toMatch(/LOOM_CONTENT_SAFETY_ENDPOINT/);
    });

    it(`${f.rel}: a refused connection is reported as refused, not as a DNS failure`, async () => {
      f.driver.mockRejectedValue(undiciFetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.4:443'));
      const mod: any = await import(f.importPath);
      const res = await mod.GET(f.req(), undefined as any);
      const j = await res.json();
      expect(j.cause).toBe('ECONNREFUSED');
      expect(j.error).toMatch(/refused the TCP connection/);
      expect(j.error).not.toMatch(/DNS/);
    });

    it(`${f.rel}: an unknown cause says so rather than inventing one`, async () => {
      // A bare "fetch failed" with NO cause at all — the runtime told us
      // nothing, so the message must not claim it did.
      f.driver.mockRejectedValue(new TypeError('fetch failed'));
      const mod: any = await import(f.importPath);
      const res = await mod.GET(f.req(), undefined as any);
      const j = await res.json();
      expect(j.cause).toBeNull();
      expect(j.error).toMatch(/did not report an underlying cause/);
    });

    // ── NEGATIVE CONTROL: a REAL response is already honest; don't swallow it.
    it(`${f.rel}: a real HTTP error from the service still passes through unchanged`, async () => {
      const E = f.rel === 'rai-policies/route.ts' ? CsError : FoundryError;
      f.driver.mockRejectedValue(new E('Rate limit exceeded', 429, { code: 'TooManyRequests' }));
      const mod: any = await import(f.importPath);
      const res = await mod.GET(f.req(), undefined as any);
      expect(res.status).toBe(429);
      const j = await res.json();
      expect(j.error).toBe('Rate limit exceeded');
      expect(j.code).toBeUndefined();
      expect(j.transport).toBeUndefined();
    });

    it(`${f.rel}: the not-deployed honest gate is still a 503, not a transport 502`, async () => {
      const E = f.rel === 'rai-policies/route.ts' ? CsNotConfiguredError : NotDeployedError;
      f.driver.mockRejectedValue(new E('Azure AI Content Safety', 'Set LOOM_CONTENT_SAFETY_ENDPOINT'));
      const mod: any = await import(f.importPath);
      const res = await mod.GET(f.req(), undefined as any);
      expect(res.status).toBe(503);
      expect((await res.json()).notDeployed).toBe(true);
    });

    // ── POSITIVE CONTROL: the route is reachable and the suite really runs.
    it(`${f.rel}: a successful call still returns 200 with its payload`, async () => {
      f.driver.mockResolvedValue(f.okPayload);
      const mod: any = await import(f.importPath);
      const res = await mod.GET(f.req(), undefined as any);
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.ok).toBe(true);
      f.okAssert(j);
    });

    it(`${f.rel}: an unauthenticated GET gets the byte-exact 401 the prologue returned`, async () => {
      getSessionMock.mockReturnValue(null as any);
      const mod: any = await import(f.importPath);
      const res = await mod.GET(f.req(), undefined as any);
      expect(res.status).toBe(401);
      // withSession → apiUnauthorized() → apiError('unauthenticated', 401):
      // MEASURED byte-equal to the hand-rolled prologue it replaced (L4 §4).
      expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
      expect(f.driver).not.toHaveBeenCalled();
    });
  }

  it('POST /api/items/content-safety — "Analyze text" itself, the reported symptom', async () => {
    moderateText.mockRejectedValue(undiciFetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND cs.example.invalid'));
    const mod: any = await import('../route');
    const res = await mod.POST(
      { url: 'http://x/api/items/content-safety', json: async () => ({ kind: 'text', text: 'hello' }) } as any,
      undefined as any,
    );
    expect(res.status).toBe(502);
    const j = await res.json();
    // This is the exact string the operator saw in #3578. It must not come back.
    expect(j.error).not.toContain('fetch failed');
    expect(j.error).toMatch(/Could not reach Azure AI Content Safety/);
    expect(j.cause).toBe('ENOTFOUND');
  });
});
