/**
 * The Azure-native lakehouse installer writes into the location the RESOLVER
 * decides, and a recorded location is decided by the record, not by the item's
 * age (the same rule `resolveLakehouseStorage` applies).
 *
 * Instrument: the REAL installer, the REAL resolver and the REAL marker
 * functions in `lib/azure/lakehouse-abfss.ts`. Only Cosmos (an in-memory doc
 * map plus the lakehouse query) and the storage account (directory properties,
 * create, metadata, folder and file writes) are faked. So an installer that
 * picks its root by `createdAt`, or refuses a root the resolver adopts, is seen
 * here as a different `rootPath`, a different create list, or a failed status.
 *
 * Every `it` names the value that breaks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LAKEHOUSE_ITEM_ROOT_SINCE, lakehouseItemRootPath, lakehouseRootPath } from '@/lib/azure/backing-name';

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

const DOCS = new Map<string, any>();
const dkey = (id: string, pk: string) => `${pk}::${id}`;
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [...DOCS.values()].filter((d) => d.itemType === 'lakehouse').map((d) => ({
            id: d.id,
            workspaceId: d.workspaceId,
            displayName: d.displayName,
            createdAt: d.createdAt,
            lakehouseRoot: d.state?.lakehouseRoot,
            adlsContainer: d.state?.adlsContainer,
            storageAccount: d.state?.storageAccount,
            provAdlsRoot: d.state?.provisioning?.secondaryIds?.adlsRoot,
            provContainer: d.state?.provisioning?.secondaryIds?.container,
            provRootPath: d.state?.provisioning?.secondaryIds?.rootPath,
            recycled: d.state?._recycled,
          })),
        }),
      }),
    },
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: DOCS.has(dkey(id, pk)) ? structuredClone(DOCS.get(dkey(id, pk))) : undefined }),
      replace: async (doc: any) => {
        DOCS.set(dkey(id, pk), structuredClone(doc));
        return { resource: doc };
      },
    }),
  }),
}));

/** `<container>/<path>` of every directory that exists, and its marker. */
const EXISTING = new Set<string>();
const OWNERS = new Map<string, string>();
/** Every successful owned-root create: `<container>/<path> <marker>`. */
const CREATED: string[] = [];
/** Every marker written onto an existing directory: `<container>/<path> <marker>`. */
const STAMPED: string[] = [];
/** Every folder and file the install writes under a root. */
const WRITES: string[] = [];
const DIR_ETAG = '"dir"';

vi.mock('@/lib/azure/adls-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/azure/adls-client')>();
  return {
    ...real,
    getAccountName: () => 'dlzacct',
    listContainers: async () => [{ name: 'landing', url: '' }, { name: 'bronze', url: '' }],
    createDirectory: async (c: string, p: string) => { WRITES.push(`${c}/${p}`); EXISTING.add(`${c}/${p}`); return { ok: true }; },
    uploadFile: async (c: string, p: string, body: Buffer) => { WRITES.push(`${c}/${p}`); return { ok: true, size: body.length }; },
    getServiceClient: () => ({
      getFileSystemClient: (c: string) => ({
        getDirectoryClient: (p: string) => ({
          create: async (opts?: { metadata?: Record<string, string>; conditions?: { ifNoneMatch?: string } }) => {
            const at = `${c}/${p}`;
            if (EXISTING.has(at) && opts?.conditions?.ifNoneMatch === '*') {
              throw Object.assign(new Error('PathAlreadyExists'), { statusCode: 409 });
            }
            EXISTING.add(at);
            const marker = opts?.metadata?.loomitemid;
            if (marker) OWNERS.set(at, marker);
            CREATED.push(`${at} ${marker ?? '-'}`);
            return {};
          },
          setMetadata: async (md: Record<string, string>, opts?: { conditions?: { ifMatch?: string } }) => {
            const at = `${c}/${p}`;
            if (!EXISTING.has(at) || opts?.conditions?.ifMatch !== DIR_ETAG) {
              throw Object.assign(new Error('ConditionNotMet'), { statusCode: 412 });
            }
            if (md.loomitemid) OWNERS.set(at, md.loomitemid);
            STAMPED.push(`${at} ${md.loomitemid}`);
            return {};
          },
        }),
        getFileClient: (p: string) => ({
          getProperties: async () => {
            const at = `${c}/${p}`;
            if (!EXISTING.has(at)) throw Object.assign(new Error('not found'), { statusCode: 404 });
            return { metadata: OWNERS.has(at) ? { loomitemid: OWNERS.get(at) } : {}, etag: DIR_ETAG };
          },
        }),
      }),
    }),
  };
});

import { lakehouseProvisioner } from '../lakehouse';
import { lakehouseStorageWithheldMessage } from '@/lib/azure/lakehouse-abfss';

const ID = 'lh-7f3a';
const WS = 'ws-9';
const NAME = 'Sales Lakehouse';
const AFTER = new Date(Date.parse(LAKEHOUSE_ITEM_ROOT_SINCE) + 60_000).toISOString();
const BEFORE = new Date(Date.parse(LAKEHOUSE_ITEM_ROOT_SINCE) - 60_000).toISOString();
const ITEM_ROOT = lakehouseItemRootPath(NAME, ID);
const NAME_ROOT = lakehouseRootPath(NAME, ID);
const URLS: Record<string, string> = { LOOM_LANDING_URL: 'landing', LOOM_BRONZE_URL: 'bronze' };
const SAVED: Record<string, string | undefined> = {};

function putItem(state: Record<string, unknown>, createdAt = AFTER, id = ID, ws = WS) {
  DOCS.set(dkey(id, ws), { id, workspaceId: ws, itemType: 'lakehouse', displayName: NAME, createdAt, state, _etag: '"e1"' });
}

function run() {
  return lakehouseProvisioner({
    session: { claims: { oid: 'o' } } as any,
    target: { mode: 'shared' as const, lakehouseBackend: 'adls' as const },
    cosmosItemId: ID,
    workspaceId: WS,
    displayName: NAME,
    appId: 'app-test',
    content: { folders: [{ path: 'Files/raw' }] },
  } as any);
}

beforeEach(() => {
  for (const [k, c] of Object.entries(URLS)) {
    SAVED[k] = process.env[k];
    process.env[k] = `https://dlzacct.dfs.core.windows.net/${c}`;
  }
  DOCS.clear();
  EXISTING.clear();
  OWNERS.clear();
  CREATED.length = 0;
  STAMPED.length = 0;
  WRITES.length = 0;
});
afterEach(() => {
  for (const k of Object.keys(URLS)) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('installer: a recorded location is kept, whatever the item age', () => {
  // Fixture arithmetic, so the assertions below can tell the two roots apart.
  // FAILS IF the two roots were equal.
  it('fixture: the item root and the name root differ', () => {
    expect(ITEM_ROOT).not.toBe(NAME_ROOT);
  });

  // The reviewer's probe: created after the cutover by an older build, which
  // recorded the name-only root (state and receipt both), with its files there.
  // FAILS IF the installer picks the root by `createdAt`: rootPath would be
  // ITEM_ROOT and a new item root would be created (CREATED non-empty).
  it('a re-install keeps the recorded name root of an item created after the cutover', async () => {
    EXISTING.add(`landing/${NAME_ROOT}`);
    putItem({
      adlsContainer: 'landing',
      lakehouseRoot: NAME_ROOT,
      provisioning: { secondaryIds: { container: 'landing', rootPath: NAME_ROOT } },
    });
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(NAME_ROOT);
    expect(r.secondaryIds?.container).toBe('landing');
    expect(CREATED).toEqual([]);
    expect(WRITES).toContain(`landing/${NAME_ROOT}/Files/raw`);
    expect(WRITES.some((w) => w.includes(ITEM_ROOT))).toBe(false);
    // The root is now marked for the item, so later resolves read no other item.
    expect(OWNERS.get(`landing/${NAME_ROOT}`)).toBe(ID);
  });

  // A re-provision reads only the earlier receipt (no state binding). FAILS IF
  // the receipt is not read as a record: rootPath would be ITEM_ROOT.
  it('a re-provision keeps the root the earlier receipt records', async () => {
    EXISTING.add(`bronze/${NAME_ROOT}`);
    putItem({ provisioning: { secondaryIds: { container: 'bronze', rootPath: NAME_ROOT } } });
    const r = await run();
    expect(r.status).toBe('created');
    expect([r.secondaryIds?.container, r.secondaryIds?.rootPath]).toEqual(['bronze', NAME_ROOT]);
    expect(CREATED).toEqual([]);
  });

  // FAILS IF a recorded root another lakehouse also records is written into
  // (status 'created', folder writes under it). The message is lifted from the
  // resolver module.
  it('a recorded root another lakehouse also records fails the install, and nothing is written', async () => {
    EXISTING.add(`landing/${NAME_ROOT}`);
    putItem({ adlsContainer: 'landing', lakehouseRoot: NAME_ROOT });
    putItem({ adlsContainer: 'landing', lakehouseRoot: NAME_ROOT }, BEFORE, 'lh-twin', 'ws-twin');
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.error).toContain(lakehouseStorageWithheldMessage('root-shared')!);
    expect(WRITES).toEqual([]);
    expect(CREATED).toEqual([]);
  });

  // An older item with nothing recorded, and its files under the name root.
  // FAILS IF the installer ignores the existing name root (rootPath ITEM_ROOT).
  it('an older unrecorded item uses the name root its files are under', async () => {
    EXISTING.add(`landing/${NAME_ROOT}`);
    putItem({}, BEFORE);
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(NAME_ROOT);
  });

  // An older unrecorded item with no directory anywhere gets its own item root,
  // as the resolver would open it. FAILS IF the installer writes a name-only
  // root the resolver would not open (rootPath NAME_ROOT).
  it('an older unrecorded item with nothing on storage gets its own item root', async () => {
    putItem({}, BEFORE);
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(ITEM_ROOT);
    expect(OWNERS.get(`landing/${ITEM_ROOT}`)).toBe(ID);
  });
});

describe('installer: the item\'s own item root', () => {
  // A receipt that names ANOTHER storage account. The installer writes only to
  // the primary DLZ account. FAILS IF it writes the folders anyway (into the
  // primary account, at a root the item does not use), or reports 'created'.
  it('a recorded location on another storage account fails the install, and nothing is written', async () => {
    putItem({
      provisioning: { secondaryIds: { adlsRoot: `abfss://landing@otheracct.dfs.core.windows.net/${NAME_ROOT}` } },
    });
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.error).toContain('otheracct');
    expect(WRITES).toEqual([]);
    expect(CREATED).toEqual([]);
  });
  // A new item with nothing recorded: its own item root, created marked.
  // FAILS IF it is created without the marker, or elsewhere.
  it('a new item gets its own item root, created with its marker', async () => {
    putItem({});
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(ITEM_ROOT);
    expect(CREATED).toEqual([`landing/${ITEM_ROOT} ${ID}`]);
  });

  // The directory exists unmarked (a first write created it before any marker
  // was written). The resolver and auto-bind adopt it; so must the installer.
  // FAILS IF the installer refuses it (status 'failed') or uses it without
  // marking it (no STAMPED entry).
  it('an existing unmarked item root is adopted and marked', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    putItem({});
    const r = await run();
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.rootPath).toBe(ITEM_ROOT);
    expect(STAMPED).toEqual([`landing/${ITEM_ROOT} ${ID}`]);
    expect(WRITES).toContain(`landing/${ITEM_ROOT}/Files/raw`);
  });

  // Paired refusal. FAILS IF a directory marked for ANOTHER item is adopted
  // (status 'created', folder writes land in it, or its marker is replaced).
  it('an existing item root marked for another item is not used', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    OWNERS.set(`landing/${ITEM_ROOT}`, 'lh-other');
    putItem({});
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.error).toContain('marked for another item');
    expect(WRITES).toEqual([]);
    expect(OWNERS.get(`landing/${ITEM_ROOT}`)).toBe('lh-other');
  });
});
