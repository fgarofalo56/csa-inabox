/**
 * The Azure-native lakehouse installer: reading the item, and its own item root.
 *
 * The installer reads the item first. An item that records a location, or was
 * created before LAKEHOUSE_ITEM_ROOT_SINCE, is resolved by the RESOLVER and the
 * install writes into what it returns; those cases run against the real
 * resolver in `lakehouse-provisioner-recorded-root.test.ts`. This file pins the
 * rest with the storage helpers faked:
 *   - an item that cannot be read, or is not found, fails with the cause and
 *     writes nothing;
 *   - a new item that records nothing gets `lakehouseItemRootPath(name, id)`,
 *     created with its ownership marker (`createOwnedLakehouseRoot`);
 *   - an existing directory there is used when it is marked for the item or
 *     unmarked (then marked), and refused when it is marked for another item.
 *
 * The cutover instant is imported from `backing-name`, not transcribed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LAKEHOUSE_ITEM_ROOT_SINCE,
  isLakehouseItemRootOf,
  lakehouseItemRootPath,
  lakehouseRootPath,
} from '@/lib/azure/backing-name';

vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {},
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/azure/fabric-client', () => ({
  FabricError: class extends Error {},
  fabricHint: vi.fn(() => 'hint'),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({ createShortcut: vi.fn() }));
vi.mock('@/lib/apps/repo-datasets', () => ({ readRepoDataset: vi.fn(async () => null) }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(async () => ({ rows: [] })),
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'd' })),
}));

const adls = { dirs: [] as string[], files: [] as string[] };
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  createDirectory: vi.fn(async (_c: string, path: string) => { adls.dirs.push(path); return { ok: true }; }),
  uploadFile: vi.fn(async (_c: string, path: string, body: Buffer) => { adls.files.push(path); return { ok: true, size: body.length }; }),
  listContainers: vi.fn(async () => [{ name: 'landing' }]),
  getAccountName: vi.fn(() => 'fakeacct'),
  pathToHttpsUrl: vi.fn((c: string, p: string) => `https://fakeacct.dfs.core.windows.net/${c}/${p}`),
  resolveAbfssRoot: vi.fn((c: string, r: string) => `abfss://${c}@fakeacct.dfs.core.windows.net/${r}`),
}));

/** The owned-root writer. `existing` simulates a directory already at the path. */
const owned = {
  created: [] as Array<{ container: string; root: string; itemId: string }>,
  stamped: [] as Array<{ container: string; root: string; itemId: string }>,
  existing: null as null | { owner: string | null },
  resolves: 0,
};
vi.mock('@/lib/azure/lakehouse-abfss', () => ({
  createOwnedLakehouseRoot: vi.fn(async (container: string, root: string, itemId: string) => {
    if (owned.existing) throw Object.assign(new Error('The specified path already exists.'), { statusCode: 409 });
    owned.created.push({ container, root, itemId });
  }),
  readLakehouseRootOwner: vi.fn(async () => (owned.existing
    ? { exists: true, owner: owned.existing.owner, etag: '"e"', metadata: {} }
    : { exists: false })),
  stampLakehouseRootOwner: vi.fn(async (container: string, root: string, itemId: string) => {
    owned.stamped.push({ container, root, itemId });
    return true;
  }),
  // The same rule as the real one: its own marker, or none.
  mayAdoptRoot: (owner: string | null, id: string) => owner === id || owner === null,
  // Not reached by the cases in this file (a new item that records nothing).
  resolveLakehouseStorage: vi.fn(async () => { owned.resolves += 1; return { ok: false, reason: 'no-storage' }; }),
  lakehouseStorageWithheldMessage: () => null,
}));

/** The item document the provisioner reads. */
const cosmos = { doc: null as null | Record<string, unknown>, fail: null as null | Error, reads: [] as string[] };
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({
      read: async () => {
        cosmos.reads.push(`${id}@${pk}`);
        if (cosmos.fail) throw cosmos.fail;
        return { resource: cosmos.doc };
      },
    }),
  })),
}));

import { lakehouseProvisioner } from '../lakehouse';

const ID = 'lh-7f3a';
const NAME = 'Sales Lakehouse';
const AFTER = new Date(Date.parse(LAKEHOUSE_ITEM_ROOT_SINCE) + 60_000).toISOString();
const ITEM_ROOT = lakehouseItemRootPath(NAME, ID);
const NAME_ROOT = lakehouseRootPath(NAME, ID);

function run() {
  return lakehouseProvisioner({
    session: { claims: { oid: 'o' } } as any,
    target: { mode: 'shared' as const, lakehouseBackend: 'adls' as const },
    cosmosItemId: ID,
    workspaceId: 'ws-9',
    displayName: NAME,
    appId: 'app-test',
    content: { folders: [{ path: 'Files/raw' }] },
  } as any);
}

beforeEach(() => {
  adls.dirs = [];
  adls.files = [];
  owned.created = [];
  owned.stamped = [];
  owned.existing = null;
  owned.resolves = 0;
  cosmos.doc = { id: ID, itemType: 'lakehouse', createdAt: AFTER };
  cosmos.fail = null;
  cosmos.reads = [];
});

describe('installer: a new item that records nothing', () => {
  // Fixture arithmetic, so the assertions below cannot collapse onto one path:
  // FAILS IF the two roots were equal.
  it('fixture: the item root and the name root differ, and only the item root carries the id', () => {
    expect(ITEM_ROOT).not.toBe(NAME_ROOT);
    expect(isLakehouseItemRootOf(ITEM_ROOT, ID)).toBe(true);
    expect(isLakehouseItemRootOf(NAME_ROOT, ID)).toBe(false);
  });

  // FAILS IF the installer records the name-only root for a new item (rootPath
  // NAME_ROOT), creates the root without this item's ownership marker
  // (owned.created empty), or goes through the resolver for it (resolves 1).
  it('records its own item root, created with its marker', async () => {
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(ITEM_ROOT);
    expect(r.secondaryIds?.adlsRoot).toBe(`abfss://landing@fakeacct.dfs.core.windows.net/${ITEM_ROOT}`);
    expect(owned.created).toEqual([{ container: 'landing', root: ITEM_ROOT, itemId: ID }]);
    expect(adls.dirs).not.toContain(ITEM_ROOT);
    expect(adls.dirs).toContain(`${ITEM_ROOT}/Files/raw`);
    expect(cosmos.reads).toEqual([`${ID}@ws-9`]);
    expect(owned.resolves).toBe(0);
  });

  // FAILS IF an unreadable item falls back to a guessed root (status 'created')
  // or writes any directory before the item is read.
  it('an unreadable item fails with the cause and writes nothing', async () => {
    cosmos.fail = Object.assign(new Error('Request rate is large (429)'), { code: 429 });
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Request rate is large \(429\)/);
    expect(adls.dirs).toEqual([]);
    expect(owned.created).toEqual([]);
  });

  // FAILS IF a missing item document is read as "nothing recorded" (a root
  // would be written and status 'created' returned) instead of failing.
  it('an item document that is not found fails and writes nothing', async () => {
    cosmos.doc = null;
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.error).toContain(`${ID} was not found in workspace ws-9`);
    expect(adls.dirs).toEqual([]);
  });

  // FAILS IF a 409 from the conditional create is treated as an error when the
  // directory is already this item's (a second install run of the same item),
  // or if a directory already marked for it is marked again.
  it('an existing item root marked for this item is reused', async () => {
    owned.existing = { owner: ID };
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(ITEM_ROOT);
    expect(owned.stamped).toEqual([]);
  });

  // An unmarked directory at the item's own id-bearing root is its own (a first
  // write creates it with no marker). FAILS IF it is refused (status 'failed',
  // the behaviour this replaces) or used without being marked.
  it('an existing unmarked item root is adopted and marked', async () => {
    owned.existing = { owner: null };
    const r = await run();
    expect(r.status).toBe('created');
    expect(owned.stamped).toEqual([{ container: 'landing', root: ITEM_ROOT, itemId: ID }]);
  });

  // FAILS IF a directory marked for ANOTHER item is adopted: the status would
  // be 'created' and the folder writes would land in it.
  it('an existing item root marked for another item is not used', async () => {
    owned.existing = { owner: 'lh-other' };
    const r = await run();
    expect(r.status).not.toBe('created');
    expect(adls.dirs).toEqual([]);
    expect(owned.stamped).toEqual([]);
    expect(JSON.stringify(r)).toContain(ITEM_ROOT);
  });
});
