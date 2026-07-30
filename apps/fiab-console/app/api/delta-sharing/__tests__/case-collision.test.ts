/**
 * LU-9 round-4 regression — CROSS-RECIPIENT READ VIA A CASE-COLLIDING SHARE NAME.
 *
 * The path-traversal variant (round 3) is closed by rebuilding the upstream path
 * from the authorized record. This is the SAME class through a different door,
 * and it needed no traversal at all:
 *
 *   recipient A is granted ['share-a']
 *   recipient B's share is literally named 'Share-A'
 *   A requests   /shares/Share-A/schemas/gold/tables/secret/metadata
 *     authorize  recipientCanAccessShare lower-cased both sides -> ALLOWED
 *     lookup     getShare built the id as `share:${name}` verbatim, and Cosmos
 *                ids are case-SENSITIVE -> document `share:Share-A` -> B's record
 *     proxy      upstreamTablePath from B's record -> the reference server, which
 *                holds the global bearer, signs a file URL for B's data
 *
 * Unlike the other specs in this directory, this one drives the REAL store
 * against a fake Cosmos container. The defect lived in the document-id
 * construction, which a store mock would have replaced with a lookup table —
 * i.e. the mock would have hidden it.
 *
 * The assertion is not "403". It is that the reference server is never asked for
 * anything outside the caller's own share, because a status-only check would
 * still pass if the proxy had already run and signed a URL for B's bytes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OID_A = '99999999-8888-7777-6666-555555555555';

/** Fake Cosmos, keyed on document id — which is the whole point: `share:share-a`
 *  and `share:Share-A` are two different documents to Cosmos. */
const docs = new Map<string, any>();
const auditRows: Array<Record<string, any>> = [];

const loomSharingFetchMock = vi.fn(async () => new Response('{"protocol":{}}', {
  status: 200, headers: { 'content-type': 'application/json' },
}));

vi.mock('@/lib/sharing/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sharing/store')>();
  // Only the upstream HTTP client is faked. listShares / getShare / the document
  // id construction are the REAL implementations.
  return { ...actual, loomSharingFetch: loomSharingFetchMock };
});

vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({
    items: { create: vi.fn(async (doc: Record<string, any>) => { auditRows.push(doc); return {}; }) },
  })),
  sharingContainer: vi.fn(async () => ({
    items: {
      query: (spec: { query: string; parameters: Array<{ name: string; value: string }> }) => ({
        fetchAll: async () => {
          const tenant = spec.parameters.find((p) => p.name === '@t')?.value;
          const kind = spec.query.includes("'share'") ? 'share' : 'recipient';
          return { resources: [...docs.values()].filter((d) => d.tenantId === tenant && d.kind === kind) };
        },
      }),
      upsert: async (doc: any) => { docs.set(doc.id, doc); return { resource: doc }; },
    },
    item: (id: string) => ({
      read: async () => ({ resource: docs.get(id) }),
      delete: async () => { docs.delete(id); },
    }),
  })),
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
    scp: 'DeltaSharing.Read', oid, tid: TENANT, exp: now + 3600, nbf: now - 60,
  })));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

function call(pathSegments: string[], oid: string | null, method: 'GET' | 'POST' = 'GET') {
  const url = `https://console.example.gov/api/delta-sharing/${pathSegments.map(encodeURIComponent).join('/')}`;
  const headers: Record<string, string> = {};
  if (oid) headers.authorization = `Bearer ${tokenFor(oid)}`;
  const req = new NextRequest(url, { method, headers, body: method === 'POST' ? '{}' : undefined });
  return { req, ctx: { params: Promise.resolve({ path: pathSegments }) } };
}

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_MSAL_TENANT_ID', 'AZURE_TENANT_ID', 'LOOM_MSAL_CLIENT_ID',
  'LOOM_SHARING_AUDIENCE', 'LOOM_SHARING_SCOPE', 'LOOM_SHARING_URL', 'LOOM_SHARING_ENABLED', 'AZURE_CLOUD'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  docs.clear();
  auditRows.length = 0;
  loomSharingFetchMock.mockClear();
  const { __resetDenyThrottleForTest } = await import('../[...path]/route');
  __resetDenyThrottleForTest();
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_SHARING_URL = 'https://loom-sharing.internal';
  process.env.LOOM_SHARING_SCOPE = 'DeltaSharing.Read';
  const { __setEntraJwksForTest } = await import('@/lib/azure/entra-bearer-verify');
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  __setEntraJwksForTest([{ ...jwk, kid: 'test-kid' } as never]);

  // A's own share and grant, written through the real store.
  const { upsertShare, upsertRecipient } = await import('@/lib/sharing/store');
  await upsertShare({
    id: 'share-a', tenantId: TENANT,
    tables: [{
      schema: 'gold', name: 't1', id: 'id-a-1',
      location: 'abfss://lake@st.dfs.core.usgovcloudapi.net/gold/a-public',
    }],
  });
  await upsertRecipient({ id: 'agency-a', tenantId: TENANT, principalIds: [OID_A], shares: ['share-a'] });

  // Recipient B's share, spelled to collide with A's grant, injected BELOW the
  // control plane — the state the create-time canonical check now prevents but a
  // record written before this fix could be in.
  docs.set('share:Share-A', {
    id: 'share:Share-A', name: 'Share-A', kind: 'share', tenantId: TENANT,
    tables: [{
      schema: 'gold', name: 'secret', id: 'id-b-secret',
      location: 'abfss://lake@st.dfs.core.usgovcloudapi.net/gold/b-secret',
    }],
  });
});

afterEach(async () => {
  const { __setEntraJwksForTest } = await import('@/lib/azure/entra-bearer-verify');
  __setEntraJwksForTest(null);
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

/** Every upstream path the reference server was asked for. */
function proxiedPaths(): string[] {
  return loomSharingFetchMock.mock.calls.map((c) => String((c as unknown as unknown[])[0]));
}

describe('a case-colliding share name cannot reach another recipient\'s data', () => {
  const spellings = ['Share-A', 'SHARE-A', 'sHaRe-A'];
  const verbs: Array<{ label: string; tail: string; method: 'GET' | 'POST' }> = [
    { label: 'version', tail: 'version', method: 'GET' },
    { label: 'metadata', tail: 'metadata', method: 'GET' },
    { label: 'changes', tail: 'changes', method: 'GET' },
    { label: 'query', tail: 'query', method: 'POST' },
  ];

  for (const spelling of spellings) {
    for (const v of verbs) {
      it(`"${spelling}" / ${v.label}: B's table is never proxied`, async () => {
        const mod = await import('../[...path]/route');
        const handler = v.method === 'POST' ? mod.POST : mod.GET;
        const { req, ctx } = call(
          ['shares', spelling, 'schemas', 'gold', 'tables', 'secret', v.tail],
          OID_A, v.method,
        );
        const res = await handler(req as never, ctx);

        // THE assertion: nothing outside A's own share was ever requested from
        // the reference server, which cannot tell recipients apart.
        for (const p of proxiedPaths()) {
          expect(p).not.toContain('secret');
          expect(p).not.toContain('Share-A');
        }
        // B's table is not in A's share, so the request stops at resolution.
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('b-secret');
      });
    }
  }

  it('A\'s OWN table still resolves and is proxied (the guard is not a blanket refusal)', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'share-a', 'schemas', 'gold', 'tables', 't1', 'metadata'], OID_A);
    const res = await GET(req as never, ctx);
    expect(res.status).toBe(200);
    expect(proxiedPaths()).toEqual(['/shares/share-a/schemas/gold/tables/t1/metadata']);
  });

  it('discovery never lists the colliding record', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares'], OID_A);
    const body = await (await GET(req as never, ctx)).json();
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['share-a']);
    expect(JSON.stringify(body)).not.toContain('Share-A');
  });

  it('the audit row names the share that was actually served, canonically', async () => {
    const { GET } = await import('../[...path]/route');
    const { req, ctx } = call(['shares', 'SHARE-A', 'schemas', 'gold', 'tables', 't1', 'version'], OID_A);
    expect((await GET(req as never, ctx)).status).toBe(200);
    const allow = auditRows.find((r) => r.outcome === 'allow' && r.action === 'version');
    expect(allow?.target).toBe('share-a');
    expect(JSON.stringify(auditRows)).not.toContain('SHARE-A');
  });
});
