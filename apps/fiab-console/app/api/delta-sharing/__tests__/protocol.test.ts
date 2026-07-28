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
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import type { LoomRecipient, LoomShare } from '@/lib/sharing/model';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OID_A = '99999999-8888-7777-6666-555555555555';
const OID_B = '12121212-3434-5656-7878-909090909090';

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

// The audit write is best-effort and Cosmos-backed; stub the container so the
// route's audit path runs without a database.
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
}));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function tokenFor(oid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' })));
  const p = b64url(Buffer.from(JSON.stringify({
    iss: `https://sts.windows.net/${TENANT}/`, aud: `api://${CLIENT_ID}`,
    oid, tid: TENANT, exp: now + 3600, nbf: now - 60,
  })));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

/** Build the request + the catch-all params the app router would pass. A real
 *  NextRequest (not a bare Request) because the route reads `nextUrl.search` to
 *  forward the protocol's query parameters. */
function call(pathSegments: string[], oid: string | null, method: 'GET' | 'POST' = 'GET') {
  const url = `https://console.example.gov/api/delta-sharing/${pathSegments.join('/')}`;
  const headers: Record<string, string> = {};
  if (oid) headers.authorization = `Bearer ${tokenFor(oid)}`;
  const req = new NextRequest(url, { method, headers, body: method === 'POST' ? '{}' : undefined });
  return { req, ctx: { params: Promise.resolve({ path: pathSegments }) } };
}

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_MSAL_TENANT_ID', 'AZURE_TENANT_ID', 'LOOM_MSAL_CLIENT_ID',
  'LOOM_SHARING_AUDIENCE', 'LOOM_SHARING_URL', 'LOOM_SHARING_ENABLED', 'AZURE_CLOUD'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  loomSharingFetchMock.mockClear();
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_SHARING_URL = 'https://loom-sharing.internal';
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
});
