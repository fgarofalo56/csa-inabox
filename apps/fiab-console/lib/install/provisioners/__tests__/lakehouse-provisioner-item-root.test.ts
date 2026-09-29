/**
 * The Azure-native lakehouse installer writes the root the RESOLVER will read.
 *
 * `resolveLakehouseStorage` (lib/azure/lakehouse-abfss.ts) decides by the item's
 * Cosmos `createdAt`: a lakehouse created on or after LAKEHOUSE_ITEM_ROOT_SINCE
 * uses a recorded root only when `isLakehouseItemRootOf(root, item.id)` holds,
 * and an earlier one keeps its name-only root. The installer used to record the
 * name-only root for every item, so a lakehouse installed after the cutover had
 * its seeded folders and tables in a directory its own editor then skipped.
 *
 * The provisioner now reads the same `createdAt` and records:
 *   - on/after the cutover: `lakehouseItemRootPath(name, id)`, created with this
 *     item's ownership marker (`createOwnedLakehouseRoot`);
 *   - before it, or with no `createdAt`: `lakehouseRootPath(name, id)`, as before.
 * When the item cannot be read the era is unknown, and the install fails with the
 * cause rather than writing a root the resolver might skip.
 *
 * The acceptance predicate and the cutover instant are imported from
 * `backing-name`, not transcribed, so this spec and the resolver cannot disagree.
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
  pathToHttpsUrl: vi.fn((c: string, p: string) => `https://fakeacct.dfs.core.windows.net/${c}/${p}`),
  resolveAbfssRoot: vi.fn((c: string, r: string) => `abfss://${c}@fakeacct.dfs.core.windows.net/${r}`),
}));

/** The owned-root writer. `existing` simulates a directory already at the path. */
const owned = {
  created: [] as Array<{ container: string; root: string; itemId: string }>,
  existing: null as null | { owner: string | null },
};
vi.mock('@/lib/azure/lakehouse-abfss', () => ({
  createOwnedLakehouseRoot: vi.fn(async (container: string, root: string, itemId: string) => {
    if (owned.existing) throw Object.assign(new Error('The specified path already exists.'), { statusCode: 409 });
    owned.created.push({ container, root, itemId });
  }),
  readLakehouseRootOwner: vi.fn(async () => (owned.existing ? { exists: true, owner: owned.existing.owner } : { exists: false })),
}));

/** The item document the provisioner reads for `createdAt`. */
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
const BEFORE = new Date(Date.parse(LAKEHOUSE_ITEM_ROOT_SINCE) - 60_000).toISOString();
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
  owned.existing = null;
  cosmos.doc = { id: ID, itemType: 'lakehouse', createdAt: AFTER };
  cosmos.fail = null;
  cosmos.reads = [];
});

describe('installer root follows the item era the resolver uses', () => {
  // Fixture arithmetic, so the two eras below cannot collapse onto one path:
  // FAILS IF the two roots were equal (then no assertion here could tell them apart).
  it('fixture: the item root and the name root differ, and only the item root is accepted', () => {
    expect(ITEM_ROOT).not.toBe(NAME_ROOT);
    expect(isLakehouseItemRootOf(ITEM_ROOT, ID)).toBe(true);
    expect(isLakehouseItemRootOf(NAME_ROOT, ID)).toBe(false);
  });

  // FAILS IF the installer records the name-only root for a post-cutover item
  // (rootPath === NAME_ROOT, which the resolver's recorded-root check rejects), or
  // creates the root without this item's ownership marker (owned.created empty).
  it('an item created after the cutover records its own item root, created with its marker', async () => {
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(ITEM_ROOT);
    expect(isLakehouseItemRootOf(String(r.secondaryIds?.rootPath), ID)).toBe(true);
    expect(r.secondaryIds?.adlsRoot).toBe(`abfss://landing@fakeacct.dfs.core.windows.net/${ITEM_ROOT}`);
    expect(owned.created).toEqual([{ container: 'landing', root: ITEM_ROOT, itemId: ID }]);
    expect(adls.dirs).not.toContain(ITEM_ROOT);
    expect(adls.dirs).toContain(`${ITEM_ROOT}/Files/raw`);
    expect(cosmos.reads).toEqual([`${ID}@ws-9`]);
  });

  // FAILS IF the era is ignored and every item gets an item root: an earlier item
  // re-provisioned would then point at a new, empty directory.
  it('an item created before the cutover keeps the name root', async () => {
    cosmos.doc = { id: ID, itemType: 'lakehouse', createdAt: BEFORE };
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(NAME_ROOT);
    expect(adls.dirs).toContain(NAME_ROOT);
    expect(owned.created).toEqual([]);
  });

  // FAILS IF a missing createdAt is read as the item era; the resolver reads it
  // as the earlier era (`lakehouseUsesItemRoot(undefined) === false`).
  it('an item with no createdAt keeps the name root, as the resolver does', async () => {
    cosmos.doc = { id: ID, itemType: 'lakehouse' };
    const r = await run();
    expect(r.secondaryIds?.rootPath).toBe(NAME_ROOT);
  });

  // FAILS IF an unreadable item falls back to a guessed era (status 'created')
  // or writes any directory before the era is known.
  it('an unreadable item fails with the cause and writes nothing', async () => {
    cosmos.fail = Object.assign(new Error('Request rate is large (429)'), { code: 429 });
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Request rate is large \(429\)/);
    expect(adls.dirs).toEqual([]);
    expect(owned.created).toEqual([]);
  });

  // FAILS IF a missing item document is read as "no createdAt" (the name root
  // would be written and status 'created' returned) instead of failing.
  it('an item document that is not found fails and writes nothing', async () => {
    cosmos.doc = null;
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.error).toContain(`${ID} was not found in workspace ws-9`);
    expect(adls.dirs).toEqual([]);
  });

  // FAILS IF a 409 from the conditional create is treated as an error when the
  // directory is already this item's (a second install run of the same item).
  it('an existing item root marked for this item is reused', async () => {
    owned.existing = { owner: ID };
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(ITEM_ROOT);
  });

  // FAILS IF an existing directory with a different marker (or none) is adopted:
  // the status would be 'created' and the folder writes would land in it.
  it('an existing item root not marked for this item is not used', async () => {
    owned.existing = { owner: null };
    const r = await run();
    expect(r.status).not.toBe('created');
    expect(adls.dirs).toEqual([]);
    expect(JSON.stringify(r)).toContain(ITEM_ROOT);
  });
});
