/**
 * POST /api/lakehouse/shortcuts, targetType 'adls' on the Console identity:
 * ADLS shortcuts and browse share one container scope
 * (`app/api/lakehouse/_lib/adls-scope.ts`).
 *
 * The create route tests reachability and later reads the target on the Console
 * identity, so the account + container it accepts are decided by the same
 * helper the ADLS browse uses: the caller must be able to EDIT the lakehouse
 * item named by `itemId`, and the target must be one of this deployment's lake
 * containers or a container a readable lakehouse in that item's workspace
 * records. A tenant admin may target any account.
 *
 * What is mocked: the session, `resolveItemAccessByOid`, the Cosmos items
 * container, the shortcut registry writes, and the two engine calls that would
 * reach storage (`resolveAndTestAdls`, `createTablesShortcut`). `parseAbfss` is
 * the REAL shortcut-engines parser (the one `resolveAndTestAdls` uses), and the
 * adls-client is REAL over the LOOM_*_URL env below, so the target is parsed and
 * the lake is read exactly as a deployed Console does.
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

vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({
  listShortcuts: vi.fn(),
  createShortcut: vi.fn(),
  deleteShortcut: vi.fn(),
  getShortcut: vi.fn(),
  listShortcutSecretBindings: vi.fn(async () => []),
}));
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  getShortcutSecretOwnerRecord: vi.fn(async () => ({ exists: false })),
  getShortcutSecretValue: vi.fn(),
}));

const { resolveAndTestAdls, createTablesShortcut } = vi.hoisted(() => ({
  resolveAndTestAdls: vi.fn(),
  createTablesShortcut: vi.fn(),
}));
vi.mock('@/lib/azure/shortcut-engines', async () => {
  const actual: any = await vi.importActual('@/lib/azure/shortcut-engines');
  return {
    ...actual,
    resolveAndTestAdls: (...a: any[]) => resolveAndTestAdls(...a),
    createTablesShortcut: (...a: any[]) => createTablesShortcut(...a),
  };
});

import { POST } from '../shortcuts/route';
import { getSession } from '@/lib/auth/session';
import { createShortcut } from '@/lib/azure/lakehouse-shortcuts';

const MEMBER = { claims: { oid: 'user-1', upn: 'u@x', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 };
const ADMIN = { claims: { oid: 'admin-1', upn: 'a@x', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 };

/** ws-A holds the lakehouse the shortcut is created in (lh-1); ws-B is another workspace. */
const DOCS = [
  { id: 'lh-1', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Sales', state: { storageAccount: 'partneracct', adlsContainer: 'exports' } },
  // A sibling the caller cannot read.
  { id: 'lh-3', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Private', state: { storageAccount: 'privateacct', adlsContainer: 'vault' } },
  // A lakehouse in ANOTHER workspace that the caller can read.
  { id: 'lh-9', workspaceId: 'ws-B', itemType: 'lakehouse', displayName: 'Foreign', state: { storageAccount: 'foreignacct', adlsContainer: 'raw' } },
];

let readable: Set<string>;
let canWrite: boolean;

const ENV_KEYS = ['LOOM_BRONZE_URL', 'LOOM_LANDING_URL', 'LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_CSV_IMPORTS_URL',
  'LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID', 'LOOM_ADLS_ACCOUNT'] as const;
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
  readable = new Set(['lh-1', 'lh-9']);
  canWrite = true;
  resolveItemAccessByOid.mockImplementation(async (_s: any, id: string) => {
    if (!readable.has(id)) return null;
    return { item: DOCS.find((d) => d.id === id), role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
  });
  resolveAndTestAdls.mockImplementation(async (_t: string, uri: string) => ({ abfssUri: uri, reachable: true }));
  createTablesShortcut.mockResolvedValue({ engine: 'synapse', engineObject: 'shortcuts.a' });
  (createShortcut as any).mockImplementation(async (d: any) => ({ ...d, id: `${d.lakehouseId}:${d.kind}::${d.name}` }));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** One create. The registry key is the bound container name, as the editor sends it today. */
const create = (targetUri: string, over: Record<string, unknown> = {}) =>
  POST({ json: async () => ({ lakehouseId: 'landing', itemId: 'lh-1', name: 'a', kind: 'files', targetType: 'adls', targetUri, ...over }) } as any,
    undefined as never);

async function expectRefused(targetUri: string, over: Record<string, unknown> = {}) {
  const res = await create(targetUri, over);
  expect(res.status, targetUri).toBe(403);
  const body = await res.json();
  expect(body.code, targetUri).toBe('adls_location_not_permitted');
  // Nothing reached storage and no registry row was written.
  expect(resolveAndTestAdls, targetUri).not.toHaveBeenCalled();
  expect(createShortcut, targetUri).not.toHaveBeenCalled();
  return body;
}

async function expectCreated(targetUri: string, over: Record<string, unknown> = {}) {
  const res = await create(targetUri, over);
  expect(res.status, targetUri).toBe(200);
  expect(resolveAndTestAdls, targetUri).toHaveBeenCalledWith('adls', targetUri, expect.any(Function));
  expect(createShortcut, targetUri).toHaveBeenCalledTimes(1);
  vi.clearAllMocks();
}

describe('ADLS create shares the browse container scope', () => {
  it('a non-admin creating a shortcut to a foreign container gets 403 with the allowed locations', async () => {
    // WHAT BREAKS IT: deleting the scope call in the create route (the foreign
    // target would reach resolveAndTestAdls and answer 200), or a scope that
    // counts readable lakehouses in OTHER workspaces (lh-9 records foreignacct/raw
    // and the caller can read it). The paired create differs only in the target.
    const body = await expectRefused('abfss://raw@foreignacct.dfs.core.windows.net/x');
    expect(body.allowed).toEqual([
      { account: 'loomlake', container: 'bronze', dfsHost: 'loomlake.dfs.core.windows.net' },
      { account: 'loomlake', container: 'landing', dfsHost: 'loomlake.dfs.core.windows.net' },
      { account: 'partneracct', container: 'exports', dfsHost: 'partneracct.dfs.core.windows.net' },
    ]);
    expect(body.error).toMatch(/^ADLS shortcuts and browse are scoped to the containers bound to this workspace/);
    expect(body.error).toMatch(/so Loom did not create the shortcut\. Pick one of the 3 listed in the wizard, or ask a tenant admin, who can create this shortcut for you\.$/);
    await expectCreated('abfss://exports@partneracct.dfs.core.windows.net/x');
  });

  it('the scope is an exact account + container pair, not either half', async () => {
    // WHAT BREAKS IT: a check on the account alone (loomlake/gold would pass),
    // or on the container alone (foreignacct/landing would pass).
    await expectRefused('abfss://gold@loomlake.dfs.core.windows.net/');
    await expectRefused('abfss://landing@foreignacct.dfs.core.windows.net/');
    await expectCreated('abfss://landing@loomlake.dfs.core.windows.net/');
  });

  it('the https dfs and blob forms are scoped like abfss, and the account compares case-insensitively', async () => {
    // WHAT BREAKS IT: a create check that recognises only abfss:// (the https
    // forms would reach storage), or one that lower-cases nothing (the
    // upper-cased allowed account would be refused).
    await expectRefused('https://foreignacct.dfs.core.windows.net/raw/x');
    await expectRefused('https://foreignacct.blob.core.windows.net/raw/x');
    await expectCreated('https://partneracct.blob.core.windows.net/exports/x');
    await expectCreated('abfss://exports@PARTNERACCT.dfs.core.windows.net/x');
  });

  it('a container recorded by a sibling the caller cannot read is refused, and allowed once readable', async () => {
    // WHAT BREAKS IT: dropping the sibling readability check.
    await expectRefused('abfss://vault@privateacct.dfs.core.windows.net/');
    readable.add('lh-3');
    await expectCreated('abfss://vault@privateacct.dfs.core.windows.net/');
  });

  it('a Tables shortcut to a foreign container registers nothing with the engine', async () => {
    // WHAT BREAKS IT: a scope check placed after the Tables registration.
    await expectRefused('abfss://raw@foreignacct.dfs.core.windows.net/t', { kind: 'tables', format: 'delta' });
    expect(createTablesShortcut).not.toHaveBeenCalled();
    const res = await create('abfss://exports@partneracct.dfs.core.windows.net/t', { kind: 'tables', format: 'delta' });
    expect(res.status).toBe(200);
    expect(createTablesShortcut).toHaveBeenCalledTimes(1);
  });

  it('a tenant admin may target any account', async () => {
    // WHAT BREAKS IT: a create check that ignores the admin flag (403 here).
    (getSession as any).mockReturnValue(ADMIN);
    await expectCreated('abfss://raw@foreignacct.dfs.core.windows.net/x');
  });
});

describe('ADLS create names the lakehouse item it is created in', () => {
  it('400 item_required without itemId, even with a registry key, before any storage call', async () => {
    // WHAT BREAKS IT: deleting the itemId check, or authorizing `lakehouseId`
    // (the registry key `lh-1` here would authorize and answer 200).
    for (const over of [{ itemId: undefined }, { itemId: '  ' }, { itemId: undefined, lakehouseId: 'lh-1' }]) {
      const res = await create('abfss://exports@partneracct.dfs.core.windows.net/x', over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect((await res.json()).code, JSON.stringify(over)).toBe('item_required');
    }
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
    await expectCreated('abfss://exports@partneracct.dfs.core.windows.net/x', { lakehouseId: 'lh-1' });
  });

  it('404 for an item the caller cannot read', async () => {
    // WHAT BREAKS IT: dropping the 404 return from the scope (the unreadable
    // item would fall through to the location check).
    const res = await create('abfss://exports@partneracct.dfs.core.windows.net/x', { itemId: 'lh-3' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('lakehouse not found');
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
  });

  it('403 on a read-only role, for a location that is otherwise allowed', async () => {
    // WHAT BREAKS IT: resolving the create scope without `write: true`.
    canWrite = false;
    const res = await create('abfss://exports@partneracct.dfs.core.windows.net/x');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/^Your role on this lakehouse is read-only, so Loom did not create the shortcut\./);
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    canWrite = true;
    await expectCreated('abfss://exports@partneracct.dfs.core.windows.net/x');
  });

  it('503 adls_scope_unverified for a non-admin when the workspace lookup fails, even for a lake container', async () => {
    // WHAT BREAKS IT: treating a failed lookup as an allow, or as lake-only.
    cosmos.fail = true;
    for (const uri of ['abfss://exports@partneracct.dfs.core.windows.net/x', 'abfss://landing@loomlake.dfs.core.windows.net/']) {
      const res = await create(uri);
      expect(res.status, uri).toBe(503);
      expect((await res.json()).code, uri).toBe('adls_scope_unverified');
    }
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    cosmos.fail = false;
    await expectCreated('abfss://landing@loomlake.dfs.core.windows.net/');
  });

  it('a target that does not parse is left to its 400 bad_target', async () => {
    // WHAT BREAKS IT: refusing an unparseable target as out of scope (403) instead
    // of reporting what is wrong with it.
    resolveAndTestAdls.mockRejectedValueOnce(Object.assign(new Error('Target URI is not a valid ADLS Gen2 / internal path'), { code: 'bad_target' }));
    const res = await create('not-a-uri');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_target');
    expect(createShortcut).not.toHaveBeenCalled();
  });
});
