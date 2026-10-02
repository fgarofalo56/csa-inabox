/**
 * GET /api/lakehouse/shortcuts/browse?sourceType=adls — ADLS browse is scoped
 * to the containers bound to the caller's workspace. ADLS shortcuts and browse
 * share one container scope (`app/api/lakehouse/_lib/adls-scope.ts`).
 *
 * The route lists on the Console identity, so the account + container it may
 * list are decided by the route: the caller must be able to read the lakehouse
 * ITEM named by `itemId`, and the account + container must be a container a
 * readable lakehouse in that item's workspace records. This deployment's
 * shared lake containers are NOT granted to a non-admin unconditionally (see
 * `_lib/adls-scope.ts`'s module header). A tenant admin may browse any
 * account.
 *
 * `lakehouseId` is the shortcut registry key (s3/gcs/dataverse credentials are
 * saved under it); the editor sends the bound CONTAINER NAME there, so the ADLS
 * branch never authorizes it.
 *
 * What is mocked: the session, `resolveItemAccessByOid` (who can read which
 * lakehouse), the Cosmos items container, `listPaths`, and the vault transport.
 * `getAccountName` and `configuredContainerNames` are the REAL adls-client
 * functions over the LOOM_*_URL env set below, so the lake check reads the same
 * env a deployed Console does. The Cosmos mock applies the query's own filters
 * (partition key, `@ws`, `itemType`, `_recycled`) to full item documents and
 * projects the SELECT's aliases, so a fixture reaches the route only through
 * the query the route actually sends.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION (assertion-design.md) is stated at
 * each test, and every refusal is paired with an allowed request that differs
 * only in the value under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const resolveItemAccessByOid = vi.fn();
vi.mock('@/lib/auth/item-access', () => ({
  resolveItemAccessByOid: (...a: any[]) => resolveItemAccessByOid(...a),
}));

const { cosmos } = vi.hoisted(() => ({
  cosmos: { docs: [] as any[], fail: false, calls: [] as Array<{ spec: any; opts: any }> },
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any, opts: any) => {
        cosmos.calls.push({ spec, opts });
        return {
          fetchAll: async () => {
            if (cosmos.fail) throw new Error('cosmos unavailable');
            const q = String(spec?.query ?? '');
            const ws = (spec?.parameters ?? []).find((p: any) => p.name === '@ws')?.value;
            let rows = cosmos.docs;
            if (opts?.partitionKey !== undefined) rows = rows.filter((d) => d.workspaceId === opts.partitionKey);
            if (ws !== undefined && /c\.workspaceId = @ws/.test(q)) rows = rows.filter((d) => d.workspaceId === ws);
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
        };
      },
    },
  }),
}));

const listPathsMock = vi.fn(async (..._a: any[]) => [{ name: 'part-0001.parquet', isDirectory: false }] as any);
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return { ...actual, listPaths: (...a: any[]) => listPathsMock(...a) };
});

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn(async (_url: any) => new Response('{}', { status: 200 })),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: any[]) => fetchWithTimeoutMock(...(a as [any])),
}));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({ listShortcutSecretBindings: vi.fn(async () => []) }));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';

const MEMBER = { claims: { oid: 'user-1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 };
const ADMIN = { claims: { oid: 'admin-1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 };

/**
 * Workspace ws-A holds the lakehouse the wizard is open on (lh-1) and its
 * siblings; ws-B is another workspace. Each records storage a different way.
 */
const DOCS = [
  // The request's own lakehouse: an explicit external account + adlsContainer.
  { id: 'lh-1', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Sales', state: { storageAccount: 'partneracct', adlsContainer: 'exports' } },
  // A readable sibling, recorded only through its provisioning receipt.
  {
    id: 'lh-2', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Shared',
    state: { provisioning: { secondaryIds: { adlsRoot: 'abfss://shared@otheracct.dfs.core.windows.net/lakehouses/lh-2' } } },
  },
  // A readable sibling with no explicit account: its provisioned container is
  // on the deployment's primary lake account (loomlake), and is NOT one of the
  // configured lake containers, so only this record allows it.
  { id: 'lh-5', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Curated', state: { provisioning: { secondaryIds: { container: 'curated' } } } },
  // A sibling the caller cannot read, on an account nothing else names.
  { id: 'lh-3', workspaceId: 'ws-A', itemType: 'lakehouse', state: { storageAccount: 'privateacct', ownedContainers: ['vault'] } },
  // A recycled sibling the caller can read.
  { id: 'lh-4', workspaceId: 'ws-A', itemType: 'lakehouse', state: { storageAccount: 'binacct', adlsContainer: 'old', _recycled: true } },
  // A non-lakehouse item in the same workspace that names an account.
  { id: 'nb-1', workspaceId: 'ws-A', itemType: 'notebook', state: { storageAccount: 'nbacct', adlsContainer: 'scratch' } },
  // A lakehouse in ANOTHER workspace that the caller can read.
  { id: 'lh-9', workspaceId: 'ws-B', itemType: 'lakehouse', state: { storageAccount: 'foreignacct', adlsContainer: 'raw' } },
];

let readable: Set<string>;

const ENV_KEYS = ['LOOM_BRONZE_URL', 'LOOM_LANDING_URL', 'LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_CSV_IMPORTS_URL',
  'LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // This deployment's lake: account `loomlake`, containers bronze + landing only.
  process.env.LOOM_BRONZE_URL = 'https://loomlake.dfs.core.windows.net/bronze';
  process.env.LOOM_LANDING_URL = 'https://loomlake.dfs.core.windows.net/landing';
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-1';
  (getSession as any).mockReturnValue(MEMBER);
  cosmos.docs = DOCS;
  cosmos.fail = false;
  cosmos.calls = [];
  readable = new Set(['lh-1', 'lh-2', 'lh-4', 'lh-5', 'lh-9']);
  resolveItemAccessByOid.mockImplementation(async (_s: any, id: string) => {
    if (!readable.has(id)) return null;
    const item = DOCS.find((d) => d.id === id);
    return { item, role: 'Viewer', via: 'workspace', canWrite: false };
  });
  listPathsMock.mockImplementation(async () => [{ name: 'part-0001.parquet', isDirectory: false }] as any);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const req = (qs: string) =>
  ({ nextUrl: new URL(`https://console.local/api/lakehouse/shortcuts/browse?sourceType=adls&${qs}`) }) as any;

/** One browse call. The route reads no route params, so the handler context is empty. */
const browse = (qs: string) => GET(req(qs), undefined as never);

/** The (account, container) pairs listPaths was asked for. */
const listed = () => listPathsMock.mock.calls.map((c) => `${c[3]}/${c[0]}`);

async function expectNotPermitted(qs: string) {
  const res = await browse(qs);
  expect(res.status, qs).toBe(403);
  const body = await res.json();
  expect(body.ok, qs).toBe(false);
  expect(body.code, qs).toBe('adls_location_not_permitted');
  return body;
}

describe('ADLS browse names the lakehouse ITEM (itemId), not the registry key', () => {
  it('400 item_required when itemId is absent or blank, before any item or storage read', async () => {
    // WHAT BREAKS IT: deleting the itemId check, or reading `lakehouseId` for
    // the ADLS branch. The third and fourth requests carry `lakehouseId=lh-1`,
    // a READABLE item that binds partneracct/exports, so a route that
    // authorized `lakehouseId` would list (200) instead of 400.
    for (const qs of ['account=partneracct&container=exports', 'account=partneracct&container=exports&itemId=',
      'account=partneracct&container=exports&lakehouseId=lh-1', 'account=partneracct&container=exports&itemId=%20&lakehouseId=lh-1']) {
      const res = await browse(qs);
      expect(res.status, qs).toBe(400);
      const body = await res.json();
      expect(body.code, qs).toBe('item_required');
      expect(body.error, qs).toMatch(/itemId \(the lakehouse item\) is required/);
    }
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
    expect(listPathsMock).not.toHaveBeenCalled();

    // The same request naming the item lists.
    const ok = await browse('account=partneracct&container=exports&itemId=lh-1');
    expect(ok.status).toBe(200);
    expect(listed()).toEqual(['partneracct/exports']);
  });

  it('a registry key that is a container name does not get in the way: itemId is what is authorized', async () => {
    // The editor sends `lakehouseId=<bound container>` (here `landing`, which is
    // no item id). WHAT BREAKS IT: the route authorizing `lakehouseId` instead
    // of `itemId` — `landing` is not readable, so that route answers 404.
    const res = await browse('account=partneracct&container=exports&lakehouseId=landing&itemId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['partneracct/exports']);
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(MEMBER, 'lh-1', 'lakehouse');
    expect(resolveItemAccessByOid).not.toHaveBeenCalledWith(MEMBER, 'landing', 'lakehouse');
  });

  it('a tenant admin still names the item (400 without it)', async () => {
    // WHAT BREAKS IT: an admin short-circuit above the itemId check.
    (getSession as any).mockReturnValue(ADMIN);
    const res = await browse('account=foreignacct&container=raw');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('item_required');
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('404 when the caller cannot read the named item, with no storage call', async () => {
    // WHAT BREAKS IT: dropping authorizeLakehouse, its `return access` in
    // resolveAdlsScope, or the route's `return scope`. lh-3 binds
    // privateacct/vault and the caller cannot read lh-3. Without the item
    // refusal the scope is computed anyway and the request is refused 403 (or
    // the route throws on a response it treats as a scope) — never 404.
    const res = await browse('account=privateacct&container=vault&itemId=lh-3');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/lakehouse not found/);
    expect(listPathsMock).not.toHaveBeenCalled();
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(MEMBER, 'lh-3', 'lakehouse');

    // Once the caller can read lh-3, the same request lists.
    readable.add('lh-3');
    const ok = await browse('account=privateacct&container=vault&itemId=lh-3');
    expect(ok.status).toBe(200);
    expect(listed()).toEqual(['privateacct/vault']);
  });
});

describe('a non-admin may browse only containers bound to the workspace', () => {
  it('refuses an unbound account and container before any storage call, listing exactly the allowed pairs', async () => {
    // WHAT BREAKS IT: the scope check removed, or a refusal that falls through
    // to browseAdls. 'unboundacct' is named by no document. The `allowed` list
    // is the whole scope for lh-1: lh-1's own binding, lh-2's receipt and
    // lh-5's provisioned container. This deployment's shared lake containers
    // (bronze/landing) are deliberately absent — narrowed per the operator
    // decision in adls-scope.ts's module header: a non-admin's locations are
    // exactly what the workspace's own lakehouses record. An unreadable
    // (lh-3), recycled (lh-4), non-lakehouse (nb-1) or foreign-workspace
    // (lh-9) entry in it fails the toEqual.
    const body = await expectNotPermitted('account=unboundacct&container=data&itemId=lh-1');
    expect(body.allowed).toEqual([
      { account: 'partneracct', container: 'exports', dfsHost: 'partneracct.dfs.core.windows.net' },
      { account: 'otheracct', container: 'shared', dfsHost: 'otheracct.dfs.core.windows.net' },
      { account: 'loomlake', container: 'curated', dfsHost: 'loomlake.dfs.core.windows.net' },
    ]);
    expect(body.error).toMatch(/ADLS shortcuts and browse are scoped to the containers bound to this workspace/);
    expect(body.error).toMatch(/did not browse it/);
    expect(body.error).toMatch(/Pick one of the 3 listed in the wizard, or ask a tenant admin, who can create this shortcut for you\./);
    expect(body.hint).toBe(body.error);
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('does not automatically allow this deployment\'s lake containers', async () => {
    // WHAT BREAKS IT: the narrowed non-admin scope reverting to include the
    // lake locations unconditionally (a) — this would then list (200) even
    // though no document in ws-A binds loomlake/landing.
    const res = await expectNotPermitted('account=loomlake&container=landing&itemId=lh-1');
    expect(res.allowed.map((l: any) => `${l.account}/${l.container}`)).not.toContain('loomlake/landing');
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('allows the item\'s own bound account and container', async () => {
    // WHAT BREAKS IT: reading the explicit `storageAccount` wrongly (falling
    // back to the primary account) or skipping `adlsContainer`. Nothing else
    // names partneracct/exports.
    const res = await browse('account=partneracct&container=exports&itemId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['partneracct/exports']);
  });

  it('allows a container a readable sibling records through its provisioning receipt', async () => {
    // WHAT BREAKS IT: dropping the abfss receipt parse, or swapping its
    // container and account captures (the browse would then look for
    // account 'shared', container 'otheracct').
    const res = await browse('account=otheracct&container=shared&itemId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['otheracct/shared']);
  });

  it('allows a provisioned container a readable sibling records on the primary lake account', async () => {
    // WHAT BREAKS IT: skipping `provisioning.secondaryIds.container`, or dropping
    // the primary-account fallback for a row with no `storageAccount`. curated
    // is not a configured lake container, so the lake check does not allow it;
    // and the same container on any other account is refused.
    const res = await browse('account=loomlake&container=curated&itemId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['loomlake/curated']);
    await expectNotPermitted('account=partneracct&container=curated&itemId=lh-1');
    expect(listed()).toEqual(['loomlake/curated']);
  });

  it('refuses a container recorded by a sibling the caller cannot read; allows it once readable', async () => {
    // WHAT BREAKS IT: dropping the sibling's resolveItemAccessByOid check. The
    // refusal must come FROM that check, so it is asserted to have run for lh-3.
    await expectNotPermitted('account=privateacct&container=vault&itemId=lh-1');
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(MEMBER, 'lh-3', 'lakehouse');
    expect(listPathsMock).not.toHaveBeenCalled();

    readable.add('lh-3');
    const ok = await browse('account=privateacct&container=vault&itemId=lh-1');
    expect(ok.status).toBe(200);
    expect(listed()).toEqual(['privateacct/vault']);
  });

  it('refuses a container recorded only in another workspace, even when the caller can read that lakehouse', async () => {
    // WHAT BREAKS IT: dropping the workspace scope (the partition key AND the
    // `@ws` filter). lh-9 is readable, so the item check alone would allow it.
    await expectNotPermitted('account=foreignacct&container=raw&itemId=lh-1');
    expect(cosmos.calls).toHaveLength(1);
    expect(cosmos.calls[0].opts).toEqual({ partitionKey: 'ws-A' });
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('refuses a container recorded by a recycled lakehouse or by a non-lakehouse item', async () => {
    // WHAT BREAKS IT: dropping the `_recycled` clause (lh-4 is readable) or the
    // `itemType = 'lakehouse'` clause (nb-1 sits in the same workspace). The
    // REAL resolveItemAccessByOid also reads by item type, so in production that
    // clause is backed by a second check; this mock ignores the type and nb-1 is
    // made readable, so what this pins is the query clause on its own.
    readable.add('nb-1');
    await expectNotPermitted('account=binacct&container=old&itemId=lh-1');
    await expectNotPermitted('account=nbacct&container=scratch&itemId=lh-1');
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('503 adls_scope_unverified when the workspace lookup fails — even for a lake container, never an allow', async () => {
    // WHAT BREAKS IT: a catch that falls through with the lake locations alone
    // (loomlake/landing would list) or with no limit (partneracct/exports would).
    cosmos.fail = true;
    for (const qs of ['account=partneracct&container=exports&itemId=lh-1', 'account=loomlake&container=landing&itemId=lh-1']) {
      const res = await browse(qs);
      expect(res.status, qs).toBe(503);
      const body = await res.json();
      expect(body.code, qs).toBe('adls_scope_unverified');
      expect(body.error, qs).toMatch(/could not read which containers are bound to this workspace/);
    }
    expect(listPathsMock).not.toHaveBeenCalled();

    // The same request with the lookup answering lists.
    cosmos.fail = false;
    expect((await browse('account=partneracct&container=exports&itemId=lh-1')).status).toBe(200);
  });

  it('reads no vault secret on an ADLS browse', async () => {
    // Pinned with a positive: the browse below did list.
    const res = await browse('account=partneracct&container=exports&itemId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['partneracct/exports']);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });
});

describe('a tenant admin keeps full browse', () => {
  it('lists any account and container on an item the admin can read, even when the workspace lookup fails', async () => {
    // WHAT BREAKS IT: dropping the admin branch (foreignacct/raw is not bound to
    // ws-A, so the scope refuses it), failing the admin closed on the lookup
    // (503), or forcing `unrestricted` on for everyone (the MEMBER request at
    // the end would list instead of 403).
    (getSession as any).mockReturnValue(ADMIN);
    const res = await browse('account=foreignacct&container=raw&itemId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['foreignacct/raw']);
    cosmos.fail = true;
    expect((await browse('account=foreignacct&container=raw&itemId=lh-1')).status).toBe(200);
    cosmos.fail = false;

    (getSession as any).mockReturnValue(MEMBER);
    await expectNotPermitted('account=foreignacct&container=raw&itemId=lh-1');
    expect(listed()).toEqual(['foreignacct/raw', 'foreignacct/raw']);
  });
});
