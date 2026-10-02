/**
 * POST /api/lakehouse/shortcuts, targetType 'adls' or 'internal', on the
 * Console identity: ADLS shortcuts and browse share one container scope
 * (`app/api/lakehouse/_lib/adls-scope.ts`).
 *
 * The create route tests reachability and later reads the target on the Console
 * identity, so the account + container it accepts are decided by the same
 * helper the ADLS browse uses: the caller must be able to EDIT the lakehouse
 * item named by `lakehouseId` (the registry key IS the item id), and the
 * target must be a container a readable lakehouse in that item's workspace
 * records. This deployment's shared lake containers are NOT granted
 * unconditionally to a non-admin — only a workspace's own recorded containers
 * are. A tenant admin may target any account. `targetType: 'internal'` shares
 * the same gate as `'adls'`, since both reach the same reachability test.
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

/**
 * ws-A holds the lakehouse the shortcut is created in (lh-1) and its siblings;
 * ws-B is another workspace. lh-6 records the SAME container name as lh-1
 * ('exports') on a DIFFERENT account, so a location check keyed on the
 * container alone would conflate them.
 */
const DOCS = [
  { id: 'lh-1', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Sales', state: { storageAccount: 'partneracct', adlsContainer: 'exports' } },
  // A sibling the caller cannot read.
  { id: 'lh-3', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Private', state: { storageAccount: 'privateacct', adlsContainer: 'vault' } },
  // A lakehouse in ANOTHER workspace that the caller can read.
  { id: 'lh-9', workspaceId: 'ws-B', itemType: 'lakehouse', displayName: 'Foreign', state: { storageAccount: 'foreignacct', adlsContainer: 'raw' } },
  // Records the deployment's primary lake account under a container no
  // lakehouse above uses, for the internal:// / onelake:// scope tests
  // (those schemes always resolve to the primary account).
  { id: 'lh-5', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Curated', state: { adlsContainer: 'curated' } },
  // Same container NAME as lh-1 ('exports'), different account. Unreadable by
  // default; the "two accounts share a container name" test makes it readable.
  { id: 'lh-6', workspaceId: 'ws-A', itemType: 'lakehouse', displayName: 'Other', state: { storageAccount: 'otheracct2', adlsContainer: 'exports' } },
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
  // This deployment's lake: account `loomlake`, containers bronze + landing.
  // Neither lh-1 nor lh-5 records them, so neither is in a non-admin's scope
  // (narrowed per the operator decision: bound-only, see adls-scope.ts header).
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

/** One create. The registry key IS the authorized item id (lh-1 by default). */
const create = (targetUri: string, over: Record<string, unknown> = {}) =>
  POST({ json: async () => ({ lakehouseId: 'lh-1', name: 'a', kind: 'files', targetType: 'adls', targetUri, ...over }) } as any,
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
  expect(resolveAndTestAdls, targetUri).toHaveBeenCalledWith((over.targetType as string) || 'adls', targetUri, expect.any(Function));
  expect(createShortcut, targetUri).toHaveBeenCalledTimes(1);
  vi.clearAllMocks();
  resolveAndTestAdls.mockImplementation(async (_t: string, uri: string) => ({ abfssUri: uri, reachable: true }));
}

describe('ADLS create shares the browse container scope', () => {
  it('a non-admin creating a shortcut to a foreign container gets 403 with the allowed locations', async () => {
    // WHAT BREAKS IT: deleting the scope call in the create route (the foreign
    // target would reach resolveAndTestAdls and answer 200), or a scope that
    // counts readable lakehouses in OTHER workspaces (lh-9 records foreignacct/raw
    // and the caller can read it, but it is in ws-B, not lh-1's ws-A). This
    // deployment's lake containers (bronze/landing) are deliberately absent:
    // lh-1 does not record either.
    const body = await expectRefused('abfss://raw@foreignacct.dfs.core.windows.net/x');
    expect(body.allowed).toEqual([
      { account: 'partneracct', container: 'exports', dfsHost: 'partneracct.dfs.core.windows.net' },
    ]);
    expect(body.error).toMatch(/^ADLS shortcuts and browse are scoped to the containers bound to this workspace/);
    expect(body.error).toMatch(/so Loom did not create the shortcut\. Pick one of the 1 listed in the wizard, or ask a tenant admin, who can create this shortcut for you\.$/);
    await expectCreated('abfss://exports@partneracct.dfs.core.windows.net/x');
  });

  it('the scope is an exact account + container pair, not either half', async () => {
    // WHAT BREAKS IT: a check on the account alone (partneracct/landing would
    // pass), or on the container alone (foreignacct/exports would pass).
    await expectRefused('abfss://landing@partneracct.dfs.core.windows.net/');
    await expectRefused('abfss://exports@foreignacct.dfs.core.windows.net/');
    await expectCreated('abfss://exports@partneracct.dfs.core.windows.net/');
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

  it('two lakehouses recording the same container name on different accounts are both reachable', async () => {
    // WHAT BREAKS IT: a location key built from the container alone (dropping
    // the account) — lh-6's otheracct2/exports would collide with lh-1's own
    // partneracct/exports and be silently dropped from the scope, refusing a
    // location this workspace genuinely binds.
    readable.add('lh-6');
    const refused = await expectRefused('abfss://exports@unboundacct.dfs.core.windows.net/');
    expect(refused.allowed).toEqual(
      expect.arrayContaining([
        { account: 'partneracct', container: 'exports', dfsHost: 'partneracct.dfs.core.windows.net' },
        { account: 'otheracct2', container: 'exports', dfsHost: 'otheracct2.dfs.core.windows.net' },
      ]),
    );
    expect(refused.allowed).toHaveLength(2);
    await expectCreated('abfss://exports@otheracct2.dfs.core.windows.net/x');
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

describe('an internal target shares the adls create scope', () => {
  it('an out-of-scope internal target is refused before any storage call', async () => {
    // WHAT BREAKS IT: gating the scope check on `targetType === 'adls'` alone
    // (reverting the merged condition to drop 'internal') — this target would
    // then reach resolveAndTestAdls and answer 200.
    readable.add('lh-5');
    await expectRefused('internal://unbound-container/x', { targetType: 'internal' });
    await expectCreated('internal://curated/x', { targetType: 'internal' });
  });

  it('an out-of-scope onelake:// target is refused the same way', async () => {
    // WHAT BREAKS IT: the same gating gap, for the onelake:// form specifically
    // (it resolves through the same `getAccountName` resolver as internal://).
    readable.add('lh-5');
    await expectRefused('onelake://unbound-container/lh/x', { targetType: 'internal' });
    await expectCreated('onelake://curated/lh/x', { targetType: 'internal' });
  });
});

describe('a "." or ".." path segment is refused, raw or percent-encoded', () => {
  it('rejects a dot segment before any storage call, and allows the same target without one', async () => {
    // WHAT BREAKS IT: removing the dot-segment check — each URI below is
    // otherwise an in-scope, parseable target that would reach
    // resolveAndTestAdls and answer 200.
    for (const uri of [
      'abfss://exports@partneracct.dfs.core.windows.net/../raw/x',
      'abfss://exports@partneracct.dfs.core.windows.net/%2e%2e/raw/x',
      'abfss://exports@partneracct.dfs.core.windows.net/%2E%2E/raw/x',
      'abfss://exports@partneracct.dfs.core.windows.net/a/./b',
      'abfss://exports@partneracct.dfs.core.windows.net/a/%2e/b',
    ]) {
      const res = await create(uri);
      expect(res.status, uri).toBe(400);
      expect((await res.json()).code, uri).toBe('bad_target');
    }
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
    await expectCreated('abfss://exports@partneracct.dfs.core.windows.net/a/raw/b');
  });
});

describe('ADLS create applies the shared item check and its own checks', () => {
  it('404 for an item the caller cannot read', async () => {
    // WHAT BREAKS IT: dropping the 404 return from the outer item check (the
    // unreadable item would fall through to the location check).
    const res = await create('abfss://vault@privateacct.dfs.core.windows.net/x', { lakehouseId: 'lh-3' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('item_not_found');
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
  });

  it('503 adls_scope_unverified for a non-admin when the workspace lookup fails', async () => {
    // WHAT BREAKS IT: treating a failed lookup as an allow.
    cosmos.fail = true;
    const res = await create('abfss://exports@partneracct.dfs.core.windows.net/x');
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('adls_scope_unverified');
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    cosmos.fail = false;
    await expectCreated('abfss://exports@partneracct.dfs.core.windows.net/x');
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
