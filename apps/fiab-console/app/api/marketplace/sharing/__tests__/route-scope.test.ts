/**
 * LU-9 round-3 — the REDACTION WIRING, driven through the real routes.
 *
 * `loom-backend-scope.test.ts` proves `loomListShares({full:false})` redacts. It
 * does not prove that anything ever CALLS it that way. Those four routes are
 * `withSession`, so every signed-in user reaches them, and the entire protection
 * is the single expression `{ full: isTenantAdmin(session) }` in each one. A
 * regression to `{ full: true }` in any of the four would leave every assertion
 * in that spec green while re-exposing the internal sharing-server FQDN, every
 * `abfss://` root and every external recipient's Entra principal ids to any
 * signed-in user.
 *
 * So these tests start where the attack starts: a non-admin session, a real
 * route handler, and an assertion over the whole serialized response body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LoomRecipient, LoomShare } from '@/lib/sharing/model';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const TENANT = '11111111-2222-3333-4444-555555555555';
const LOCATION = 'abfss://lake@stloom.dfs.core.usgovcloudapi.net/gold/revenue';
const PRINCIPAL = '99999999-8888-7777-6666-555555555555';
const SHARING_HOST = 'https://loom-sharing.internal';
const ADMIN_OID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_OID = 'bbbbbbbb-0000-0000-0000-000000000002';

const shareA: LoomShare = {
  id: 'share-a', tenantId: TENANT,
  tables: [{ schema: 'gold', name: 't1', location: LOCATION, id: 'id-1' }],
};
const recipientA: LoomRecipient = {
  id: 'agency-a', tenantId: TENANT, principalIds: [PRINCIPAL], shares: ['share-a'],
};

vi.mock('@/lib/sharing/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sharing/store')>();
  return {
    ...actual,
    listShares: vi.fn(async () => [shareA]),
    getShare: vi.fn(async (_t: string, n: string) => (n === 'share-a' ? shareA : null)),
    listRecipients: vi.fn(async () => [recipientA]),
    getRecipient: vi.fn(async (_t: string, n: string) => (n === 'agency-a' ? recipientA : null)),
  };
});

import { getSession } from '@/lib/auth/session';

const NON_ADMIN = { claims: { upn: 'reader@contoso.com', oid: USER_OID, groups: [] }, exp: 9_999_999_999 };
const ADMIN = { claims: { upn: 'admin@contoso.com', oid: ADMIN_OID, groups: [] }, exp: 9_999_999_999 };

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_SHARING_URL', 'LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_IDS'] as const;
let saved: Record<string, string | undefined> = {};

function req(url = 'https://console.example.gov/api/marketplace/sharing/shares') {
  return new Request(url) as never;
}

/** Everything a non-admin must never see, in one place. */
const SECRETS = [LOCATION, PRINCIPAL, 'loom-sharing.internal'];

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_SHARING_URL = SHARING_HOST;
  // The bootstrap admin path — makes ADMIN_OID a tenant admin and USER_OID not.
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  (getSession as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(NON_ADMIN);
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('GET /api/marketplace/sharing/shares — non-admin', () => {
  it('withholds the abfss root and the sharing-server FQDN from a signed-in non-admin', async () => {
    const { GET } = await import('../shares/route');
    const res = await GET(req(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    for (const secret of SECRETS) expect(body).not.toContain(secret);
    // …while still returning the catalog, so this is redaction and not an outage.
    expect(body).toContain('share-a');
  });

  it('returns the full payload to a tenant admin (the redaction is not a regression)', async () => {
    (getSession as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(ADMIN);
    const { GET } = await import('../shares/route');
    const body = JSON.stringify(await (await GET(req(), { params: Promise.resolve({}) } as never)).json());
    expect(body).toContain(LOCATION);
    expect(body).toContain('loom-sharing.internal');
  });

  it('401s with no session at all', async () => {
    (getSession as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(null);
    const { GET } = await import('../shares/route');
    expect((await GET(req(), { params: Promise.resolve({}) } as never)).status).toBe(401);
  });
});

describe('GET /api/marketplace/sharing/shares/[name] — non-admin', () => {
  it('withholds the abfss root of a single share', async () => {
    const { GET } = await import('../shares/[name]/route');
    const res = await GET(req(), { params: Promise.resolve({ name: 'share-a' }) } as never);
    const body = JSON.stringify(await res.json());
    for (const secret of SECRETS) expect(body).not.toContain(secret);
  });

  it('returns it to a tenant admin', async () => {
    (getSession as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(ADMIN);
    const { GET } = await import('../shares/[name]/route');
    const body = JSON.stringify(
      await (await GET(req(), { params: Promise.resolve({ name: 'share-a' }) } as never)).json(),
    );
    expect(body).toContain(LOCATION);
  });
});

describe('GET /api/marketplace/sharing/recipients — non-admin', () => {
  it('withholds every recipient\'s Entra principal ids', async () => {
    const { GET } = await import('../recipients/route');
    const res = await GET(req(), { params: Promise.resolve({}) } as never);
    const parsed = await res.json();
    expect(JSON.stringify(parsed)).not.toContain(PRINCIPAL);
    // The count survives, so the admin surface is not silently misleading.
    expect(parsed.recipients[0].principalCount).toBe(1);
  });

  it('returns them to a tenant admin', async () => {
    (getSession as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(ADMIN);
    const { GET } = await import('../recipients/route');
    const body = JSON.stringify(await (await GET(req(), { params: Promise.resolve({}) } as never)).json());
    expect(body).toContain(PRINCIPAL);
  });
});

describe('GET /api/marketplace/sharing/recipients/[name] — non-admin', () => {
  it('withholds the principal ids of a single recipient', async () => {
    const { GET } = await import('../recipients/[name]/route');
    const res = await GET(req(), { params: Promise.resolve({ name: 'agency-a' }) } as never);
    expect(JSON.stringify(await res.json())).not.toContain(PRINCIPAL);
  });
});

// The mutations are the other half of the wiring: publishing data outside the
// boundary is an estate-level act, so a non-admin must not reach them at all.
describe('mutations are tenant-admin only', () => {
  const cases: Array<{ label: string; load: () => Promise<Record<string, unknown>>; method: string; params: unknown }> = [
    { label: 'POST /shares', load: () => import('../shares/route') as never, method: 'POST', params: {} },
    { label: 'PATCH /shares/[name]', load: () => import('../shares/[name]/route') as never, method: 'PATCH', params: { name: 'share-a' } },
    { label: 'DELETE /shares/[name]', load: () => import('../shares/[name]/route') as never, method: 'DELETE', params: { name: 'share-a' } },
    { label: 'POST /recipients', load: () => import('../recipients/route') as never, method: 'POST', params: {} },
    { label: 'DELETE /recipients/[name]', load: () => import('../recipients/[name]/route') as never, method: 'DELETE', params: { name: 'agency-a' } },
    { label: 'PATCH /recipients/[name]', load: () => import('../recipients/[name]/route') as never, method: 'PATCH', params: { name: 'agency-a' } },
  ];

  for (const c of cases) {
    it(`${c.label} refuses a signed-in NON-admin`, async () => {
      const mod = await c.load();
      const handler = mod[c.method] as (r: unknown, ctx: unknown) => Promise<Response>;
      const r = new Request('https://console.example.gov/x', { method: c.method === 'DELETE' ? 'DELETE' : 'POST', body: c.method === 'DELETE' ? undefined : '{}' });
      const res = await handler(r, { params: Promise.resolve(c.params) });
      expect(res.status).toBe(403);
    });
  }
});
