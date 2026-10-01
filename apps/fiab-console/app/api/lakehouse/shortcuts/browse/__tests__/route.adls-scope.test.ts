/**
 * GET /api/lakehouse/shortcuts/browse?sourceType=adls — ADLS browse is scoped
 * to the containers bound to the caller's workspace.
 *
 * The route lists on the Console identity, so the account + container it may
 * list are decided by the route: the caller must be able to read `lakehouseId`,
 * and the account + container must be one of this deployment's lake containers
 * or a container a readable lakehouse in that lakehouse's workspace records. A
 * tenant admin may browse any account.
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
  { id: 'lh-1', workspaceId: 'ws-A', itemType: 'lakehouse', state: { storageAccount: 'partneracct', adlsContainer: 'exports' } },
  // A readable sibling, recorded only through its provisioning receipt.
  {
    id: 'lh-2', workspaceId: 'ws-A', itemType: 'lakehouse',
    state: { provisioning: { secondaryIds: { adlsRoot: 'abfss://shared@otheracct.dfs.core.windows.net/lakehouses/lh-2' } } },
  },
  // A readable sibling with no explicit account: its provisioned container is
  // on the deployment's primary lake account (loomlake), and is NOT one of the
  // configured lake containers, so only this record allows it.
  { id: 'lh-5', workspaceId: 'ws-A', itemType: 'lakehouse', state: { provisioning: { secondaryIds: { container: 'curated' } } } },
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

/** The (container, account) pairs listPaths was asked for. */
const listed = () => listPathsMock.mock.calls.map((c) => `${c[3]}/${c[0]}`);

async function expectNotPermitted(qs: string) {
  const res = await browse(qs);
  expect(res.status, qs).toBe(403);
  const body = await res.json();
  expect(body.ok, qs).toBe(false);
  expect(body.code, qs).toBe('adls_browse_not_permitted');
  return body;
}

describe('ADLS browse names the lakehouse', () => {
  it('400 item_required when lakehouseId is absent or blank, before any item or storage read', async () => {
    // WHAT BREAKS IT: deleting the lakehouseId check. The account and container
    // below are the request lakehouse's own binding, so without the check the
    // route would carry on, and authorizeLakehouse('') answers 404, not 400.
    for (const qs of ['account=partneracct&container=exports', 'account=partneracct&container=exports&lakehouseId=',
      'account=partneracct&container=exports&lakehouseId=%20%20']) {
      const res = await browse(qs);
      expect(res.status, qs).toBe(400);
      const body = await res.json();
      expect(body.code, qs).toBe('item_required');
      expect(body.error, qs).toMatch(/lakehouseId is required/);
    }
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
    expect(listPathsMock).not.toHaveBeenCalled();

    // The same request naming the lakehouse lists.
    const ok = await browse('account=partneracct&container=exports&lakehouseId=lh-1');
    expect(ok.status).toBe(200);
    expect(listed()).toEqual(['partneracct/exports']);
  });

  it('a tenant admin still names the lakehouse (400 without it)', async () => {
    // WHAT BREAKS IT: moving the admin short-circuit above the lakehouseId check.
    (getSession as any).mockReturnValue(ADMIN);
    const res = await browse('account=foreignacct&container=raw');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('item_required');
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('404 when the caller cannot read the named lakehouse, with no storage call', async () => {
    // WHAT BREAKS IT: dropping authorizeLakehouse. lh-3 binds privateacct/vault
    // and the caller cannot read lh-3; without the item check the binding scan
    // finds the row whose id IS the request lakehouse and allows it (200).
    const res = await browse('account=privateacct&container=vault&lakehouseId=lh-3');
    expect(res.status).toBe(404);
    expect(listPathsMock).not.toHaveBeenCalled();
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(MEMBER, 'lh-3', 'lakehouse');

    // Once the caller can read lh-3, the same request lists.
    readable.add('lh-3');
    const ok = await browse('account=privateacct&container=vault&lakehouseId=lh-3');
    expect(ok.status).toBe(200);
    expect(listed()).toEqual(['privateacct/vault']);
  });
});

describe('a non-admin may browse only containers bound to the workspace', () => {
  it('refuses an account and container no lakehouse in the workspace records, before any storage call', async () => {
    // WHAT BREAKS IT: the scope check removed, or a non-'allowed' scope that
    // still falls through to browseAdls. 'unboundacct' is named by no document.
    const body = await expectNotPermitted('account=unboundacct&container=data&lakehouseId=lh-1');
    expect(body.error).toMatch(/Pick a container bound to this workspace/);
    expect(body.error).toMatch(/ask a tenant admin/);
    expect(body.hint).toBe(body.error);
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('allows this deployment\'s lake containers without a workspace lookup', async () => {
    // WHAT BREAKS IT: dropping the lake check (a). No document binds
    // loomlake/landing, so without (a) the request is refused (403).
    const res = await browse('account=loomlake&container=landing&lakehouseId=lh-1');
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(listed()).toEqual(['loomlake/landing']);
    expect(cosmos.calls).toHaveLength(0);
  });

  it('the lake check pairs the account with a CONFIGURED container', async () => {
    // WHAT BREAKS IT: (a) testing the account alone (gold is not configured
    // here, so loomlake/gold passes) or the container alone (landing on
    // foreignacct passes). Each half is refused on its own.
    await expectNotPermitted('account=loomlake&container=gold&lakehouseId=lh-1');
    await expectNotPermitted('account=foreignacct&container=landing&lakehouseId=lh-1');
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('allows the request lakehouse\'s own bound account and container', async () => {
    // WHAT BREAKS IT: reading the explicit `storageAccount` wrongly (falling
    // back to the primary account) or skipping `adlsContainer`. Nothing else
    // names partneracct/exports.
    const res = await browse('account=partneracct&container=exports&lakehouseId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['partneracct/exports']);
  });

  it('allows a container a readable sibling records through its provisioning receipt', async () => {
    // WHAT BREAKS IT: dropping the abfss receipt parse, or swapping its
    // container and account captures (the browse would then look for
    // account 'shared', container 'otheracct').
    const res = await browse('account=otheracct&container=shared&lakehouseId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['otheracct/shared']);
  });

  it('allows a provisioned container a readable sibling records on the primary lake account', async () => {
    // WHAT BREAKS IT: skipping `provisioning.secondaryIds.container`, or dropping
    // the primary-account fallback for a row with no `storageAccount`. curated
    // is not a configured lake container, so the lake check does not allow it;
    // and the same container on any other account is refused.
    const res = await browse('account=loomlake&container=curated&lakehouseId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['loomlake/curated']);
    await expectNotPermitted('account=partneracct&container=curated&lakehouseId=lh-1');
    expect(listed()).toEqual(['loomlake/curated']);
  });

  it('refuses a container recorded by a sibling the caller cannot read; allows it once readable', async () => {
    // WHAT BREAKS IT: dropping the sibling's resolveItemAccessByOid check. The
    // refusal must come FROM that check, so it is asserted to have run for lh-3.
    await expectNotPermitted('account=privateacct&container=vault&lakehouseId=lh-1');
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(MEMBER, 'lh-3', 'lakehouse');
    expect(listPathsMock).not.toHaveBeenCalled();

    readable.add('lh-3');
    const ok = await browse('account=privateacct&container=vault&lakehouseId=lh-1');
    expect(ok.status).toBe(200);
    expect(listed()).toEqual(['privateacct/vault']);
  });

  it('refuses a container recorded only in another workspace, even when the caller can read that lakehouse', async () => {
    // WHAT BREAKS IT: dropping the workspace scope (the partition key AND the
    // `@ws` filter). lh-9 is readable, so the item check alone would allow it.
    await expectNotPermitted('account=foreignacct&container=raw&lakehouseId=lh-1');
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
    await expectNotPermitted('account=binacct&container=old&lakehouseId=lh-1');
    await expectNotPermitted('account=nbacct&container=scratch&lakehouseId=lh-1');
    expect(listPathsMock).not.toHaveBeenCalled();
  });

  it('503 adls_browse_unverified when the workspace lookup fails — never an allow', async () => {
    // WHAT BREAKS IT: a catch that returns 'allowed' or falls through to browse.
    cosmos.fail = true;
    const res = await browse('account=partneracct&container=exports&lakehouseId=lh-1');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('adls_browse_unverified');
    expect(body.error).toMatch(/could not confirm/);
    expect(listPathsMock).not.toHaveBeenCalled();

    // The same request with the lookup answering lists.
    cosmos.fail = false;
    expect((await browse('account=partneracct&container=exports&lakehouseId=lh-1')).status).toBe(200);
  });

  it('reads no vault secret on an ADLS browse', async () => {
    // Pinned with a positive: the browse below did list.
    const res = await browse('account=partneracct&container=exports&lakehouseId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['partneracct/exports']);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });
});

describe('a tenant admin keeps full browse', () => {
  it('lists any account and container on a lakehouse the admin can read, with no workspace lookup', async () => {
    // WHAT BREAKS IT: dropping the admin bypass (foreignacct/raw is not bound to
    // ws-A, so the scope check refuses it) or forcing it on for everyone (the
    // MEMBER request at the end would list instead of 403).
    (getSession as any).mockReturnValue(ADMIN);
    const res = await browse('account=foreignacct&container=raw&lakehouseId=lh-1');
    expect(res.status).toBe(200);
    expect(listed()).toEqual(['foreignacct/raw']);
    expect(cosmos.calls).toHaveLength(0);

    (getSession as any).mockReturnValue(MEMBER);
    await expectNotPermitted('account=foreignacct&container=raw&lakehouseId=lh-1');
    expect(listed()).toEqual(['foreignacct/raw']);
  });
});
