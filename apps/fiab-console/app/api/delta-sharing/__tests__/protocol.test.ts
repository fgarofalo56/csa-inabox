/**
 * LU-9 — /api/delta-sharing/[...path]: the recipient-facing protocol endpoint.
 *
 * The point of this spec is the NEGATIVE case. The OSS Delta Sharing reference
 * server behind this route cannot tell recipients apart — it authenticates with
 * one global bearer and would serve ANY share to anyone holding it. So the only
 * thing preventing recipient A from reading recipient B's tables is this route.
 *
 * Every cross-recipient test therefore asserts two things: the caller got a 403,
 * AND `loomSharingFetch` was never invoked. A test that only checked the status
 * code would still pass if the proxy ran first and we merely discarded the
 * result — which would already have signed a file URL for B's data.
 *
 * The `path traversal` block is the regression suite for the defect this route
 * shipped with: only seg[1] was authorized, while seg.join('/') was proxied, so
 * an encoded `../` inside the SCHEMA or TABLE segment (which Next.js decodes
 * per-segment before the handler sees it) redirected the upstream call at
 * another recipient's share. Those cases put the hostile payload where the check
 * was absent, not where it was present.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import type { LoomRecipient, LoomShare } from '@/lib/sharing/model';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OID_A = '99999999-8888-7777-6666-555555555555';
const OID_B = '12121212-3434-5656-7878-909090909090';
/** A valid tenant token that belongs to no registered recipient. */
const OID_STRANGER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const recipientA: LoomRecipient = { id: 'agency-a', tenantId: TENANT, principalIds: [OID_A], shares: ['share-a'] };
const recipientB: LoomRecipient = { id: 'agency-b', tenantId: TENANT, principalIds: [OID_B], shares: ['share-b'] };
const shareA: LoomShare = {
  id: 'share-a', tenantId: TENANT,
  tables: [{ schema: 'gold', name: 't1', location: 'abfss://lake@st.dfs.core.usgovcloudapi.net/gold/t1', id: 'id-1' }],
};
const shareB: LoomShare = {
  id: 'share-b', tenantId: TENANT,
  tables: [{ schema: 'gold', name: 't2', location: 'abfss://lake@st.dfs.core.usgovcloudapi.net/gold/t2', id: 'id-2' }],
};

const loomSharingFetchMock = vi.fn(async () => new Response('{"protocol":{}}', {
  status: 200, headers: { 'content-type': 'application/json' },
}));

vi.mock('@/lib/sharing/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sharing/store')>();
  return {
    ...actual,
    listShares: vi.fn(async () => [shareA, shareB]),
    getShare: vi.fn(async (_t: string, name: string) =>
      (name === 'share-a' ? shareA : name === 'share-b' ? shareB : null)),
    listRecipients: vi.fn(async () => [recipientA, recipientB]),
    loomSharingFetch: loomSharingFetchMock,
  };
});

// The audit write is best-effort and Cosmos-backed; capture the rows so the
// spec can assert on what the trail actually says, not merely that it ran.
const auditRows: Array<Record<string, any>> = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({
    items: { create: vi.fn(async (doc: Record<string, any>) => { auditRows.push(doc); return {}; }) },
  })),
}));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function tokenFor(oid: string, over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' })));
  const p = b64url(Buffer.from(JSON.stringify({
    iss: `https://sts.windows.net/${TENANT}/`, aud: `api://${CLIENT_ID}`,
    // An ACCESS token carrying the PINNED scope. See sharing-authz.test.ts for
    // the ID-token refusal and for the unpinned-audience 503.
    scp: 'DeltaSharing.Read',
    oid, tid: TENANT, exp: now + 3600, nbf: now - 60,
    ...over,
  })));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

/**
 * Build the request + the catch-all params the app router would pass. A real
 * NextRequest (not a bare Request) because the route reads `nextUrl.search` to
 * forward the protocol's query parameters.
 *
 * NOTE ON ENCODING: `pathSegments` are the DECODED values Next.js hands the
 * handler. Next.js decodes each catch-all segment individually
 * (`route-matcher.js`: `match.split('/').map(decode)`), so a request written as
 * `%2E%2E%2Fshares%2Fshare-b` arrives as the single segment
 * `../shares/share-b` — which is exactly what the traversal tests pass here.
 * The URL is built with the segments re-encoded so the request object is
 * faithful to the wire form.
 */
function call(
  pathSegments: string[],
  oid: string | null,
  method: 'GET' | 'POST' = 'GET',
  search = '',
  extraHeaders: Record<string, string> = {},
) {
  const url = `https://console.example.gov/api/delta-sharing/${pathSegments.map(encodeURIComponent).join('/')}${search}`;
  const headers: Record<string, string> = { ...extraHeaders };
  if (oid) headers.authorization = `Bearer ${tokenFor(oid)}`;
  const req = new NextRequest(url, { method, headers, body: method === 'POST' ? '{}' : undefined });
  return { req, ctx: { params: Promise.resolve({ path: pathSegments }) } };
}

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_MSAL_TENANT_ID', 'AZURE_TENANT_ID', 'LOOM_MSAL_CLIENT_ID',
  'LOOM_SHARING_AUDIENCE', 'LOOM_SHARING_SCOPE', 'LOOM_SHARING_URL', 'LOOM_SHARING_ENABLED', 'AZURE_CLOUD'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  loomSharingFetchMock.mockClear();
  auditRows.length = 0;
  const { __resetDenyThrottleForTest } = await import('../[...path]/route');
  __resetDenyThrottleForTest();
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_SHARING_URL = 'https://loom-sharing.internal';
  // The recipient credential must be PINNED to this API — either a dedicated
  // audience or a scope/app role. Without one of the two the endpoint fails
  // closed with 503 (store.sharingAudiencePinned), because api://<clientId>
  // alone is satisfied by any access token for the Console's own API.
  process.env.LOOM_SHARING_SCOPE = 'DeltaSharing.Read';
  const { __setEntraJwksForTest } = await import('@/lib/azure/entra-bearer-verify');
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  __setEntraJwksForTest([{ ...jwk, kid: 'test-kid' } as never]);
});

afterEach(async () => {
  const { __setEntraJwksForTest } = await import('@/lib/azure/entra-bearer-verify');
  __setEntraJwksForTest(null);
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('discovery is filtered to the caller', () => {
  it('GET /shares returns ONLY the caller\'s shares', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['share-a']);
    // The other recipient's share must not appear anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain('share-b');
  });

  it('GET /shares for recipient B returns B\'s share, not A\'s', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], OID_B);
    const body = await (await GET(req as never, ctx)).json();
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['share-b']);
  });

  it('an unauthenticated caller gets 401 and no share list', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], null);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('share-');
  });
});

describe('cross-recipient access is refused BEFORE the sharing server is touched', () => {
  const crossPaths: Array<{ label: string; segs: string[]; method: 'GET' | 'POST' }> = [
    { label: 'get share', segs: ['shares', 'share-b'], method: 'GET' },
    { label: 'list schemas', segs: ['shares', 'share-b', 'schemas'], method: 'GET' },
    { label: 'list all-tables', segs: ['shares', 'share-b', 'all-tables'], method: 'GET' },
    { label: 'list tables', segs: ['shares', 'share-b', 'schemas', 'gold', 'tables'], method: 'GET' },
    { label: 'table version', segs: ['shares', 'share-b', 'schemas', 'gold', 'tables', 't2', 'version'], method: 'GET' },
    { label: 'table metadata', segs: ['shares', 'share-b', 'schemas', 'gold', 'tables', 't2', 'metadata'], method: 'GET' },
    { label: 'table changes (CDF)', segs: ['shares', 'share-b', 'schemas', 'gold', 'tables', 't2', 'changes'], method: 'GET' },
    { label: 'table query', segs: ['shares', 'share-b', 'schemas', 'gold', 'tables', 't2', 'query'], method: 'POST' },
  ];

  for (const c of crossPaths) {
    it(`recipient A is refused 403 on B's share — ${c.label} — and nothing is proxied`, async () => {
      const mod = await import('../[...path]/route');
      const handler = c.method === 'POST' ? mod.POST : mod.GET;
      const { req, ctx } = call(c.segs, OID_A, c.method);
      const res = await handler(req as never, ctx);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.errorCode).toBe('PERMISSION_DENIED');
      // THE assertion: the reference server — which would have served B's data
      // to anyone holding the Console's bearer — was never called.
      expect(loomSharingFetchMock).not.toHaveBeenCalled();
    });
  }

  it('a granted data-plane call IS proxied (so the 403 tests above are not vacuous)', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-a', 'schemas', 'gold', 'tables', 't1', 'metadata'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(200);
    expect(loomSharingFetchMock).toHaveBeenCalledTimes(1);
    expect(loomSharingFetchMock.mock.calls[0][0]).toContain('/shares/share-a/schemas/gold/tables/t1/metadata');
  });

  it('an unknown share name is refused with the same 403 (no existence oracle)', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-does-not-exist', 'schemas'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(403);
    expect(loomSharingFetchMock).not.toHaveBeenCalled();
  });
});

describe('data-plane responses are not cacheable', () => {
  it('sets no-store on a proxied metadata response (it can embed signed file URLs)', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-a', 'schemas', 'gold', 'tables', 't1', 'metadata'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets no-store on the share list too', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('unsupported protocol resources', () => {
  it('404s an unknown table sub-resource instead of proxying an arbitrary path', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-a', 'schemas', 'gold', 'tables', 't1', 'evil'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(404);
    expect(loomSharingFetchMock).not.toHaveBeenCalled();
  });

  it('does not serve the POST-only query resource over GET', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-a', 'schemas', 'gold', 'tables', 't1', 'query'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(404);
    expect(loomSharingFetchMock).not.toHaveBeenCalled();
  });
});

// ── ATTACK: path traversal in the segments that were NOT authorized ────────
//
// The shipped defect. `authorize(req, seg[1], tail)` checked the SHARE segment
// and then `proxyToServer('/' + seg.join('/'))` forwarded all seven segments,
// so the hostile payload goes in seg[3] (schema) or seg[5] (table) — the ones
// with no check — and the upstream URL parser collapses `../` to land on
// another recipient's share. These are the cases the original suite's eight
// cross-recipient tests could not have caught: every one of them put the
// hostile name in seg[1], the one segment that WAS checked.
describe('path traversal: recipient A cannot reach recipient B through an unchecked segment', () => {
  /** The payload as Next.js delivers it — ONE segment, already percent-decoded. */
  const TRAVERSE_TO_B = '../../../shares/share-b/schemas/gold';

  it('GET metadata: traversal in the SCHEMA segment is refused and never proxied', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(
      ['shares', 'share-a', 'schemas', TRAVERSE_TO_B, 'tables', 't2', 'metadata'], OID_A,
    );
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(404);
    expect(loomSharingFetchMock).not.toHaveBeenCalled();
  });

  it('GET metadata: traversal in the TABLE segment is refused and never proxied', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(
      ['shares', 'share-a', 'schemas', 'gold', 'tables', '../../../../shares/share-b/schemas/gold/tables/t2', 'metadata'],
      OID_A,
    );
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(404);
    expect(loomSharingFetchMock).not.toHaveBeenCalled();
  });

  it('GET version + changes: traversal is refused on every data-plane verb', async () => {
    const { GET } = await import('../[...path]/route');
    for (const tail of ['version', 'changes']) {
      loomSharingFetchMock.mockClear();
      const { req, ctx } = call(['shares', 'share-a', 'schemas', TRAVERSE_TO_B, 'tables', 't2', tail], OID_A);
      expect((await GET(req as never, ctx)).status).toBe(404);
      expect(loomSharingFetchMock).not.toHaveBeenCalled();
    }
  });

  it('POST query: traversal is refused and never proxied', async () => {
    const { POST } = await import('../[...path]/route');
    const { req, ctx } = call(
      ['shares', 'share-a', 'schemas', TRAVERSE_TO_B, 'tables', 't2', 'query'], OID_A, 'POST',
    );
    const res = await POST(req as never, ctx);
    expect(res.status).toBe(404);
    expect(loomSharingFetchMock).not.toHaveBeenCalled();
  });

  it('an absolute-path payload in the schema segment cannot re-root the upstream URL', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(
      ['shares', 'share-a', 'schemas', '/shares/share-b/schemas/gold', 'tables', 't2', 'metadata'], OID_A,
    );
    expect((await GET(req as never, ctx)).status).toBe(404);
    expect(loomSharingFetchMock).not.toHaveBeenCalled();
  });

  it('a table that exists in ANOTHER share is not reachable by name from this one', async () => {
    // t2 is share-b's table. Asking for it inside share-a — no traversal at all,
    // just the other share's table name — must not resolve.
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-a', 'schemas', 'gold', 'tables', 't2', 'metadata'], OID_A);
    expect((await GET(req as never, ctx)).status).toBe(404);
    expect(loomSharingFetchMock).not.toHaveBeenCalled();
  });

  it('the proxied path is rebuilt from the SHARE RECORD, so no caller text survives into it', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(
      ['shares', 'share-a', 'schemas', 'gold', 'tables', 't1', 'metadata'], OID_A,
      'GET', '?startingVersion=1&evil=%2F..%2Fshares%2Fshare-b',
    );
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(200);
    const proxied = String(loomSharingFetchMock.mock.calls[0][0]);
    const [path, query] = proxied.split('?');
    // The PATH is rebuilt from the share record — nothing the caller typed.
    expect(path).toBe('/shares/share-a/schemas/gold/tables/t1/metadata');
    expect(path).not.toContain('share-b');
    // The query is re-encoded, so a value cannot reintroduce a path separator.
    expect(query).toContain('startingVersion=1');
    expect(query).not.toContain('/');
  });
});

// ── ATTACK: the audit trail must describe what was SERVED ──────────────────
describe('audit trail', () => {
  function rows(outcome?: 'allow' | 'deny') {
    return auditRows.filter((r) => !outcome || r.outcome === outcome);
  }

  it('records the resolved share/schema/table and the exact upstream path on an allow', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-a', 'schemas', 'gold', 'tables', 't1', 'metadata'], OID_A);
    await GET(req as never, ctx);
    const row = rows('allow').at(-1)!;
    expect(row.target).toBe('share-a');
    expect(row.who).toBe('recipient:agency-a');
    expect(row.detail.upstreamPath).toBe('/shares/share-a/schemas/gold/tables/t1/metadata');
    expect(row.detail.table).toBe('t1');
  });

  it('a traversal attempt is NOT logged as an authorized read of the caller\'s own share', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(
      ['shares', 'share-a', 'schemas', '../../../shares/share-b/schemas/gold', 'tables', 't2', 'metadata'], OID_A,
    );
    await GET(req as never, ctx);
    // The original code wrote outcome:'allow', share:'share-a' for exactly this
    // request while serving share-b — a trail that actively misleads.
    expect(rows('allow')).toHaveLength(0);
    const deny = rows('deny').at(-1)!;
    expect(deny.detail.reason).toBe('table-not-in-share');
    expect(deny.detail.requestedSchema).toContain('share-b');
  });

  it('writes a deny row for a 401 (an unauthenticated probe leaves a trace)', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], null);
    expect((await GET(req as never, ctx)).status).toBe(401);
    const row = rows('deny').at(-1)!;
    expect(row.outcome).toBe('deny');
    expect(row.detail.status).toBe(401);
    expect(row.detail.reason).toBe('no-credential');
  });

  it('writes a deny row for a valid token whose principal is not a recipient', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-a', 'schemas'], OID_STRANGER);
    expect((await GET(req as never, ctx)).status).toBe(403);
    const row = rows('deny').at(-1)!;
    expect(row.detail.reason).toBe('not-a-recipient');
    expect(row.actorOid).toBe(OID_STRANGER);
  });

  it('audits the ALLOW path of the discovery resources too', async () => {
    const { GET } = await import('../[...path]/route');
    for (const segs of [
      ['shares', 'share-a'],
      ['shares', 'share-a', 'schemas'],
      ['shares', 'share-a', 'all-tables'],
      ['shares', 'share-a', 'schemas', 'gold', 'tables'],
    ]) {
      auditRows.length = 0;
      const { req, ctx } = call(segs, OID_A);
      expect((await GET(req as never, ctx)).status).toBe(200);
      expect(rows('allow')).toHaveLength(1);
    }
  });

  it('coalesces an anonymous 401 flood into one row rather than one write per request', async () => {
    const { GET } = await import('../[...path]/route');
    for (let i = 0; i < 25; i += 1) {
      const { req, ctx } = call(['shares'], null);
      await GET(req as never, ctx);
    }
    // Bounded writes, but the burst is still visible in the row.
    expect(rows('deny').length).toBe(1);
    expect(auditRows.at(-1)!.detail.suppressedSincePrevious).toBe(0);
  });

  // ── ATTACK: the burst guard must survive a HOSTILE source header ─────────
  //
  // The test above sends no `x-forwarded-for` at all, so every request hashes to
  // the same key and the coalescing holds trivially — it cannot fail for the
  // reason the guard exists. The guard was keyed on `xff.split(',')[0]`, which is
  // a string the CALLER types on a route with no middleware and no rate limiter,
  // so this same loop with a rotating header produced 25 Cosmos writes, not 1.
  it('a rotating X-Forwarded-For does NOT buy the caller one audit write per request', async () => {
    const { GET } = await import('../[...path]/route');
    for (let i = 0; i < 60; i += 1) {
      const { req, ctx } = call(['shares'], null, 'GET', '', {
        // Every request claims a different origin. Real ingress APPENDS its own
        // hop, so the caller's claim is the LEFTMOST value and ours is the last.
        'x-forwarded-for': `203.0.113.${i}, 10.0.0.7`,
      });
      expect((await GET(req as never, ctx)).status).toBe(401);
    }
    // One trusted source ⇒ one key ⇒ one row. The pre-fix code wrote 60.
    expect(rows('deny').length).toBe(1);
    expect(rows('deny')[0].detail.sourceIp).toBe('10.0.0.7');
    // …and the attacker's claim is recorded, but labelled as untrusted so it
    // can never be mistaken for attribution.
    expect(rows('deny')[0].detail.claimedClientIpUntrusted).toBe('203.0.113.0');
    expect(rows('deny')[0].detail.sourceIp).not.toContain('203.0.113');
  });

  it('bounds anonymous deny writes even when the SOURCE genuinely rotates', async () => {
    // The backstop. A distributed flood from real addresses — nothing spoofed,
    // every key legitimately distinct — must still not become an unbounded
    // Cosmos write amplifier, because "throttled per source" is only as strong
    // as our ability to identify the source.
    const { GET } = await import('../[...path]/route');
    for (let i = 0; i < 200; i += 1) {
      const { req, ctx } = call(['shares'], null, 'GET', '', { 'x-azure-socketip': `198.51.100.${i}` });
      await GET(req as never, ctx);
    }
    expect(rows('deny').length).toBeLessThanOrEqual(20);
    // Still non-zero: the burst has to leave a trace, it just has a ceiling.
    expect(rows('deny').length).toBeGreaterThan(0);
  });

  it('bounds the not-a-recipient 403 flood, keyed on the VERIFIED principal', async () => {
    // This path was deliberately unthrottled ("always written, never
    // throttled"), so any holder of a valid estate token could drive unbounded
    // Cosmos writes — the same amplification class the 401 path guarded for.
    const { GET } = await import('../[...path]/route');
    for (let i = 0; i < 50; i += 1) {
      const { req, ctx } = call(['shares'], OID_STRANGER, 'GET', '', {
        'x-forwarded-for': `203.0.113.${i}`,
      });
      expect((await GET(req as never, ctx)).status).toBe(403);
    }
    const denies = rows('deny');
    expect(denies.length).toBe(1);
    expect(denies[0].detail.reason).toBe('not-a-recipient');
    // The row still attributes the probe to the cryptographically-attested
    // principal, and still carries the burst size.
    expect(denies[0].actorOid).toBe(OID_STRANGER);
    expect(denies[0].detail.suppressedSincePrevious).toBe(0);
  });

  it('an anonymous flood cannot starve the higher-signal 403 rows out of the trail', async () => {
    const { GET } = await import('../[...path]/route');
    for (let i = 0; i < 200; i += 1) {
      const { req, ctx } = call(['shares'], null, 'GET', '', { 'x-azure-socketip': `198.51.100.${i}` });
      await GET(req as never, ctx);
    }
    const anonRows = rows('deny').length;
    const { req, ctx } = call(['shares'], OID_STRANGER);
    expect((await GET(req as never, ctx)).status).toBe(403);
    // The 403 got its own budget, so it is written despite the flood.
    expect(rows('deny').length).toBe(anonRows + 1);
    expect(rows('deny').at(-1)!.detail.reason).toBe('not-a-recipient');
  });
});

// ── ATTACK: the endpoint itself has a request ceiling ─────────────────────
//
// This was the only internet-reachable, credential-free route in the tree with
// NO rate limiter at all — no middleware, no route toolkit, no `withSession` —
// which is what made every other cost on this surface amplifiable.
describe('request rate ceiling', () => {
  it('429s a single source past the burst, in the PROTOCOL error shape', async () => {
    const { GET } = await import('../[...path]/route');
    const { __resetRateLimiter } = await import('@/lib/azure/rate-limiter');
    // vitest.setup.ts pins LOOM_RATE_LIMIT='off' globally so the route hammer
    // does not trip; this spec is specifically about the limiter, so turn it on.
    const savedFlag = process.env.LOOM_RATE_LIMIT;
    process.env.LOOM_RATE_LIMIT = 'on';
    __resetRateLimiter();
    let limited: Response | null = null;
    for (let i = 0; i < 400; i += 1) {
      const { req, ctx } = call(['shares'], null, 'GET', '', { 'x-azure-socketip': '198.51.100.9' });
      const res = await GET(req as never, ctx);
      if (res.status === 429) { limited = res as unknown as Response; break; }
    }
    expect(limited).not.toBeNull();
    const body = await limited!.json();
    // A conforming delta-sharing client parses {errorCode,message}; the Loom
    // {ok,...} envelope here would break every one of them.
    expect(body.errorCode).toBe('RESOURCE_EXHAUSTED');
    expect(body.ok).toBeUndefined();
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0);
    __resetRateLimiter();
    if (savedFlag === undefined) delete process.env.LOOM_RATE_LIMIT;
    else process.env.LOOM_RATE_LIMIT = savedFlag;
  });

  it('the ceiling is keyed on the TRUSTED source, so a rotating XFF cannot evade it', async () => {
    const { GET } = await import('../[...path]/route');
    const { __resetRateLimiter } = await import('@/lib/azure/rate-limiter');
    const savedFlag = process.env.LOOM_RATE_LIMIT;
    process.env.LOOM_RATE_LIMIT = 'on';
    __resetRateLimiter();
    let limited = false;
    for (let i = 0; i < 400; i += 1) {
      const { req, ctx } = call(['shares'], null, 'GET', '', {
        'x-forwarded-for': `203.0.113.${i % 250}, 10.0.0.7`,
      });
      if ((await GET(req as never, ctx)).status === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
    __resetRateLimiter();
    if (savedFlag === undefined) delete process.env.LOOM_RATE_LIMIT;
    else process.env.LOOM_RATE_LIMIT = savedFlag;
  });
});

// ── ATTACK: an anonymous caller learns nothing about the deployment ────────
describe('no infrastructure disclosure to an unauthenticated caller', () => {
  const LEAKS = ['bicep', 'loom-sharing-app', 'LOOM_SHARING_URL', 'LOOM_ENTRA_TENANT_ID',
    'Key Vault', 'docs/fiab', 'LOOM_SHARING_ENABLED'];

  it('a credential-free request returns 401 and no configuration text', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], null);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(401);
    const body = await res.text();
    for (const leak of LEAKS) expect(body).not.toContain(leak);
  });

  it('an UNDEPLOYED estate does not describe itself to an anonymous caller', async () => {
    delete process.env.LOOM_SHARING_URL;
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], null);
    const res = await GET(req as never, ctx);
    const body = await res.text();
    for (const leak of LEAKS) expect(body).not.toContain(leak);
  });

  it('a DISABLED deployment does not name the env var that disabled it', async () => {
    process.env.LOOM_SHARING_ENABLED = 'false';
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(503);
    const body = await res.text();
    for (const leak of LEAKS) expect(body).not.toContain(leak);
  });
});
