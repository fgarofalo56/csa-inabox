/**
 * GET /api/lakehouse/shortcuts/adls-scope?itemId= — the ADLS locations the
 * shortcut wizard offers. ADLS shortcuts and browse share one container scope
 * (`app/api/lakehouse/_lib/adls-scope.ts`); this route returns it so the wizard
 * can list the containers instead of the caller guessing one.
 *
 * What is mocked: the session, `resolveItemAccessByOid`, and the Cosmos items
 * container (applying the query's own partition key, `itemType` and `_recycled`
 * filters). The adls-client is REAL over the LOOM_*_URL env below.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION (assertion-design.md) is stated at
 * each test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const resolveItemAccessByOid = vi.fn();
vi.mock('@/lib/auth/item-access', () => ({
  resolveItemAccessByOid: (...a: any[]) => resolveItemAccessByOid(...a),
}));

const { cosmos } = vi.hoisted(() => ({ cosmos: { docs: [] as any[], fail: false } }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any, opts: any) => ({
        fetchAll: async () => {
          if (cosmos.fail) throw new Error('cosmos unavailable');
          const q = String(spec?.query ?? '');
          let rows = cosmos.docs.filter((d) => d.workspaceId === opts?.partitionKey);
          if (/c\.itemType = 'lakehouse'/.test(q)) rows = rows.filter((d) => d.itemType === 'lakehouse');
          if (/_recycled/.test(q)) rows = rows.filter((d) => d.state?._recycled === undefined || d.state?._recycled === null);
          return {
            resources: rows.map((d) => ({
              id: d.id,
              displayName: d.displayName,
              storageAccount: d.state?.storageAccount,
              adlsContainer: d.state?.adlsContainer,
              ownedContainers: d.state?.ownedContainers,
              provContainer: d.state?.provisioning?.secondaryIds?.container,
              provAdlsRoot: d.state?.provisioning?.secondaryIds?.adlsRoot,
            })),
          };
        },
      }),
    },
  }),
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';

const MEMBER = { claims: { oid: 'user-1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 };
const ADMIN = { claims: { oid: 'admin-1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 };

const DOCS = [
  { id: 'lh-1', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Sales', state: { storageAccount: 'partneracct', adlsContainer: 'exports' } },
  { id: 'lh-5', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Curated', state: { provisioning: { secondaryIds: { container: 'curated' } } } },
  { id: 'lh-3', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Private', state: { storageAccount: 'privateacct', adlsContainer: 'vault' } },
  { id: 'lh-4', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Old', state: { storageAccount: 'binacct', adlsContainer: 'old', _recycled: true } },
  { id: 'nb-1', workspaceId: 'ws-A', itemType: 'notebook', displayName: 'NB', state: { storageAccount: 'nbacct', adlsContainer: 'scratch' } },
  { id: 'lh-9', workspaceId: 'ws-B', itemType: 'lakehouse', displayName: 'Foreign', state: { storageAccount: 'foreignacct', adlsContainer: 'raw' } },
];

let readable: Set<string>;

const ENV_KEYS = ['LOOM_BRONZE_URL', 'LOOM_LANDING_URL', 'LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_CSV_IMPORTS_URL',
  'LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LOOM_BRONZE_URL = 'https://loomlake.dfs.core.windows.net/bronze';
  process.env.LOOM_LANDING_URL = 'https://loomlake.dfs.core.windows.net/landing';
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-1';
  (getSession as any).mockReturnValue(MEMBER);
  cosmos.docs = DOCS;
  cosmos.fail = false;
  readable = new Set(['lh-1', 'lh-4', 'lh-5', 'lh-9', 'nb-1']);
  resolveItemAccessByOid.mockImplementation(async (_s: any, id: string) => {
    if (!readable.has(id)) return null;
    return { item: DOCS.find((d) => d.id === id), role: 'Viewer', via: 'workspace', canWrite: false };
  });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const scopeOf = (qs: string) =>
  GET({ nextUrl: new URL(`https://console.local/api/lakehouse/shortcuts/adls-scope?${qs}`) } as any, undefined as never);

const pairs = (locations: any[]) => locations.map((l) => `${l.account}/${l.container}`);

describe('GET /api/lakehouse/shortcuts/adls-scope', () => {
  it('400 item_required without itemId, before any item read', async () => {
    // WHAT BREAKS IT: deleting the itemId check (the route would authorize '').
    for (const qs of ['', 'itemId=', 'itemId=%20', 'lakehouseId=lh-1']) {
      const res = await scopeOf(qs);
      expect(res.status, qs).toBe(400);
      expect((await res.json()).code, qs).toBe('item_required');
    }
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });

  it('404 for an item the caller cannot read', async () => {
    // WHAT BREAKS IT: listing the scope without authorizing the item first.
    const res = await scopeOf('itemId=lh-3');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('lakehouse not found');
  });

  it('a non-admin gets the readable workspace lakehouses, and nothing else', async () => {
    // WHAT BREAKS IT: an unreadable sibling listed (privateacct/vault), a
    // recycled one (binacct/old), a non-lakehouse item (nbacct/scratch),
    // another workspace's lakehouse (foreignacct/raw), or this deployment's
    // lake containers granted unconditionally (loomlake/bronze, loomlake/landing
    // — narrowed per the operator decision in adls-scope.ts's module header:
    // a non-admin's locations are exactly what the workspace's own lakehouses
    // record).
    const res = await scopeOf('itemId=lh-1');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.unrestricted).toBe(false);
    expect(pairs(data.locations)).toEqual(['partneracct/exports', 'loomlake/curated']);
    expect(data.locations[0]).toEqual({
      account: 'partneracct', container: 'exports', dfsHost: 'partneracct.dfs.core.windows.net', source: 'lakehouse', lakehouseName: 'Sales',
    });
    // Positive control for the readability filter: the same sibling is listed once readable.
    readable.add('lh-3');
    const again = await (await scopeOf('itemId=lh-1')).json();
    expect(pairs(again.data.locations)).toContain('privateacct/vault');
  });

  it('a tenant admin is unrestricted, and the list is still offered', async () => {
    // WHAT BREAKS IT: the admin flag not reaching the response (unrestricted
    // false would hide the account list in the wizard).
    (getSession as any).mockReturnValue(ADMIN);
    const { data } = await (await scopeOf('itemId=lh-1')).json();
    expect(data.unrestricted).toBe(true);
    expect(pairs(data.locations)).toContain('partneracct/exports');
  });

  it('503 adls_scope_unverified for a non-admin when the workspace lookup fails; an admin still gets the lake', async () => {
    // WHAT BREAKS IT: returning a lake-only list (or an empty one) to a non-admin
    // as if the lookup had succeeded.
    cosmos.fail = true;
    const res = await scopeOf('itemId=lh-1');
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('adls_scope_unverified');
    (getSession as any).mockReturnValue(ADMIN);
    const admin = await scopeOf('itemId=lh-1');
    expect(admin.status).toBe(200);
    expect(pairs((await admin.json()).data.locations)).toEqual(['loomlake/bronze', 'loomlake/landing']);
  });
});
