/**
 * #5046 - the per-type teardown registry used by the generic item DELETE.
 *
 * REAL `teardownItemBackend` + REAL registry; only the Azure clients are mocked.
 * Each test names the input that breaks it:
 *
 *   - lakehouse, NO recorded rootPath      -> fails if the `lakehouses/<displayName>`
 *     fallback is reachable in recorded-only mode (deletePath would be called
 *     with a guessed path: the blind recursive delete).
 *   - lakehouse, recorded rootPath         -> positive pair: deletePath IS called
 *     with exactly the recorded path (a registry that never deletes passes the
 *     negative test above but fails this one).
 *   - ml-model, NO recorded modelName      -> fails if the display name is used.
 *   - mirrored-database, no adlsRoot       -> fails if bronze/mirrors/<ws>/<id> is
 *     rebuilt from ids; with adlsRoot -> deletes exactly the recorded root.
 *   - warehouse, shared-pool env unset     -> fails if an unverifiable pool is
 *     deleted. warehouse, per-item pool      -> deleted (positive pair).
 *   - kql-database whose recorded db is the shared monitor db -> fails if the
 *     shared-database guard is removed.
 *   - type not in the registry (workspace-monitor) -> `not_applicable` and NO
 *     client call; fails if the type is added to the set.
 *   - an error row                         -> orphans + warning, and the report is
 *     returned (the route deletes the doc); fails if errors are folded into
 *     `removed`/dropped.
 *   - a teardown that THROWS                -> an `unknown` orphan, not a thrown
 *     exception; fails if the catch is removed (route would 500 pre-delete).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const deletePath = vi.fn(async (..._a: any[]) => undefined);
const deleteDedicatedSqlPool = vi.fn(async (..._a: any[]) => undefined);
const deleteKustoDatabase = vi.fn(async (..._a: any[]) => undefined);
const deleteRegisteredModel = vi.fn(async (..._a: any[]) => undefined);
const deleteServingEndpoint = vi.fn(async (..._a: any[]) => undefined);
const deleteEventHub = vi.fn(async (..._a: any[]) => undefined);

vi.mock('@/lib/azure/adls-client', () => ({ deletePath: (...a: any[]) => deletePath(...a) }));
vi.mock('@/lib/azure/synapse-dev-client', () => ({
  deleteDedicatedSqlPool: (...a: any[]) => deleteDedicatedSqlPool(...a),
  deletePipeline: vi.fn(),
}));
vi.mock('@/lib/azure/kusto-arm-client', () => ({ deleteKustoDatabase: (...a: any[]) => deleteKustoDatabase(...a) }));
vi.mock('@/lib/azure/eventhubs-client', () => ({ deleteEventHub: (...a: any[]) => deleteEventHub(...a) }));
const deleteStreamingJob = vi.fn(async (..._a: any[]) => undefined);
const getJobTags = vi.fn(async (..._a: any[]): Promise<Record<string, string> | null> => null);
vi.mock('@/lib/azure/stream-analytics-client', () => ({
  deleteStreamingJob: (...a: any[]) => deleteStreamingJob(...a),
  getJobTags: (...a: any[]) => getJobTags(...a),
  readAsaConfig: () => ({ subscriptionId: 's', resourceGroup: 'rg' }),
}));

// Cross-item lookup (Cosmos). `world.other` is the item another workspace owns
// that records the same ref; `world.throws` makes the lookup itself fail.
const world: { other: any | null; throws: Error | null; queries: any[] } = { other: null, throws: null, queries: [] };
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (q: any) => ({
        fetchAll: async () => {
          world.queries.push(q);
          if (world.throws) throw world.throws;
          return { resources: world.other ? [world.other] : [] };
        },
      }),
    },
  }),
}));
vi.mock('@/lib/azure/activator-monitor', () => ({ deleteMonitorActivatorRule: vi.fn() }));
vi.mock('@/lib/azure/adf-client', () => ({ deletePipeline: vi.fn(), deleteAdfCdc: vi.fn(async () => undefined) }));
vi.mock('@/lib/azure/databricks-client', () => ({
  deleteUcCatalog: vi.fn(), deleteJob: vi.fn(), deleteWarehouse: vi.fn(), permanentDeleteCluster: vi.fn(),
  deleteWorkspaceObject: vi.fn(),
  deleteRegisteredModel: (...a: any[]) => deleteRegisteredModel(...a),
  deleteServingEndpoint: (...a: any[]) => deleteServingEndpoint(...a),
}));
vi.mock('@/lib/azure/synapse-artifacts-client', () => ({ deleteNotebook: vi.fn() }));
vi.mock('@/lib/azure/search-index-client', () => ({ deleteIndex: vi.fn() }));
vi.mock('@/lib/azure/foundry-client', () => ({ deletePromptFlow: vi.fn() }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({ executeQuery: vi.fn(), serverlessTarget: vi.fn() }));

import { teardownForItemDelete, TEARDOWN_ITEM_TYPES } from '../item-teardown-registry';

const prov = (secondaryIds: Record<string, string>, resourceId?: string) => ({
  provisioning: { status: 'created', ...(resourceId ? { resourceId } : {}), secondaryIds },
});
const item = (itemType: string, state: Record<string, unknown> | null, displayName = 'My Item') =>
  ({ id: 'item-1', workspaceId: 'ws-1', itemType, displayName, state });

beforeEach(() => {
  vi.clearAllMocks();
  world.other = null; world.throws = null; world.queries = [];
  getJobTags.mockResolvedValue(null);
  delete process.env.LOOM_SYNAPSE_DEDICATED_POOL;
  delete process.env.LOOM_WORKSPACE_MONITOR_DB;
});

describe('registry membership', () => {
  it('registers every type whose provisioner records a backing ref, and not the shared-resource or catalog-only ones', () => {
    for (const t of ['lakehouse', 'warehouse', 'kql-database', 'eventhouse', 'eventstream', 'mirrored-database', 'ml-model']) {
      expect(TEARDOWN_ITEM_TYPES.has(t), `${t} must be registered`).toBe(true);
    }
    for (const t of ['workspace-monitor', 'report', 'semantic-model', 'kql-dashboard', 'dataset']) {
      expect(TEARDOWN_ITEM_TYPES.has(t), `${t} must NOT be registered`).toBe(false);
    }
  });

  it('an unregistered type reports not_applicable and calls NO Azure client', async () => {
    const r = await teardownForItemDelete(item('workspace-monitor', prov({ database: 'loomdb_workspace_monitor' }, 'loomdb_workspace_monitor')), 't');
    expect(r.status).toBe('not_applicable');
    expect(deleteKustoDatabase).not.toHaveBeenCalled();
    expect(r.orphans).toEqual([]);
  });
});

describe('recorded-only: nothing is derived from the display name or ids', () => {
  it('lakehouse WITHOUT a recorded rootPath: skipped, deletePath NOT called', async () => {
    const r = await teardownForItemDelete(item('lakehouse', prov({ container: 'silver' }), 'Sales Lake'), 't');
    expect(deletePath).not.toHaveBeenCalled();
    expect(r.retained.map((x) => x.kind)).toContain('adls-path');
    expect(r.orphans).toEqual([]);
  });

  it('lakehouse WITH a recorded rootPath: deletes exactly that path (positive pair)', async () => {
    const r = await teardownForItemDelete(item('lakehouse', prov({ container: 'silver', rootPath: 'lakehouses/sales' })), 't');
    expect(deletePath).toHaveBeenCalledTimes(1);
    expect(deletePath).toHaveBeenCalledWith('silver', 'lakehouses/sales/', true);
    expect(r.removed.map((x) => x.ref)).toEqual(['silver/lakehouses/sales']);
  });

  it('lakehouse whose recorded rootPath is empty/dots never deletes the container root', async () => {
    await teardownForItemDelete(item('lakehouse', prov({ container: 'silver', rootPath: '/../.' })), 't');
    expect(deletePath).not.toHaveBeenCalled();
  });

  it('ml-model WITHOUT a recorded modelName: neither the model nor a serving endpoint is touched', async () => {
    const r = await teardownForItemDelete(item('ml-model', prov({ notebookPath: '/Shared/x', runId: '7' }), 'churn-model'), 't');
    expect(deleteRegisteredModel).not.toHaveBeenCalled();
    expect(deleteServingEndpoint).not.toHaveBeenCalled();
    expect(r.retained).toHaveLength(1);
  });

  it('ml-model WITH a recorded modelName deletes that name', async () => {
    await teardownForItemDelete(item('ml-model', prov({ modelName: 'cat.sch.churn' })), 't');
    expect(deleteRegisteredModel).toHaveBeenCalledWith('cat.sch.churn');
  });

  it('mirrored-database WITHOUT adlsRoot: the bronze path is NOT rebuilt from workspace/item ids', async () => {
    await teardownForItemDelete(item('mirrored-database', prov({ pipeline: 'cdc-1' })), 't');
    expect(deletePath).not.toHaveBeenCalled();
  });

  it('mirrored-database WITH adlsRoot deletes exactly the recorded root', async () => {
    await teardownForItemDelete(
      item('mirrored-database', prov({ pipeline: 'cdc-1', adlsRoot: 'abfss://bronze@acct.dfs.core.windows.net/mirrors/ws-1/item-1' })),
      't',
    );
    expect(deletePath).toHaveBeenCalledWith('bronze', 'mirrors/ws-1/item-1/', true);
  });
});

describe('shared resources are retained, not deleted', () => {
  it('warehouse with LOOM_SYNAPSE_DEDICATED_POOL unset: pool retained (cannot verify it is not shared)', async () => {
    const r = await teardownForItemDelete(item('warehouse', prov({ database: 'pool1' })), 't');
    expect(deleteDedicatedSqlPool).not.toHaveBeenCalled();
    expect(r.retained[0].error).toContain('cannot be verified');
  });

  it('warehouse on the shared pool: retained', async () => {
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool1';
    await teardownForItemDelete(item('warehouse', prov({ database: 'pool1' })), 't');
    expect(deleteDedicatedSqlPool).not.toHaveBeenCalled();
  });

  it('warehouse on a per-item pool (differs from the shared pool): deleted (positive pair)', async () => {
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'shared';
    await teardownForItemDelete(item('warehouse', prov({ database: 'own-pool' })), 't');
    expect(deleteDedicatedSqlPool).toHaveBeenCalledWith('own-pool');
  });

  it('kql-database recorded against the shared monitor database: retained; a normal database is deleted', async () => {
    await teardownForItemDelete(item('kql-database', prov({ database: 'loomdb_workspace_monitor' })), 't');
    expect(deleteKustoDatabase).not.toHaveBeenCalled();
    await teardownForItemDelete(item('kql-database', prov({ database: 'orders_db' })), 't');
    expect(deleteKustoDatabase).toHaveBeenCalledWith('orders_db');
  });
});

describe('failure is loud and does not drop the delete decision', () => {
  it('a failing delete comes back as an orphan + warning that names kind and ref, with the real error', async () => {
    deleteKustoDatabase.mockRejectedValueOnce(new Error('ARM 403 AuthorizationFailed'));
    const r = await teardownForItemDelete(item('kql-database', prov({ database: 'orders_db' })), 't');
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0]).toMatchObject({ kind: 'adx-database', ref: 'orders_db', result: 'error' });
    expect(r.removed).toEqual([]);
    expect(r.warning).toContain('adx-database orders_db');
    expect(r.warning).toContain('403');
  });

  it('a clean teardown has NO warning (pairs with the failing case)', async () => {
    const r = await teardownForItemDelete(item('kql-database', prov({ database: 'orders_db' })), 't');
    expect(r.warning).toBeUndefined();
    expect(r.orphans).toEqual([]);
  });

  it('an already-gone resource (404) counts as removed, not as an orphan', async () => {
    deleteKustoDatabase.mockRejectedValueOnce(new Error('404 not found'));
    const r = await teardownForItemDelete(item('kql-database', prov({ database: 'orders_db' })), 't');
    expect(r.orphans).toEqual([]);
    expect(r.removed[0].result).toBe('not_found');
  });

  it('a teardown that THROWS yields an unknown-orphan report, never an exception', async () => {
    // A state whose getter throws makes teardownItemBackend throw before it can classify anything.
    const bad = { id: 'i', workspaceId: 'w', itemType: 'lakehouse', displayName: 'x', get state(): never { throw new Error('boom'); } };
    const r = await teardownForItemDelete(bad as any, 't');
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].ref).toBe('(unknown)');
    expect(r.warning).toContain('unknown which backing resources remain');
    expect(r.warning).toContain('boom');
  });
});

/**
 * REVIEW BLOCKER 1 - a name two items both record must not be deleted by one.
 * Fixture: items A (ws-1) and B (ws-2) both record ADX database 'Sales'
 * (safeAdxDatabaseName(displayName) is the same for same-named items).
 */
describe('blocker 1: a ref recorded by ANOTHER item is retained', () => {
  const A = () => ({ id: 'item-A', workspaceId: 'ws-1', itemType: 'kql-database', displayName: 'Sales', state: prov({ database: 'Sales' }, 'Sales') });

  it('(a) deleting A when B records the same database: delete fn called 0 times, reason in retained', async () => {
    world.other = { id: 'item-B', workspaceId: 'ws-2', itemType: 'kql-database' };
    const r = await teardownForItemDelete(A(), 't');
    expect(deleteKustoDatabase, "B's database was deleted by A's delete").toHaveBeenCalledTimes(0);
    expect(r.removed).toEqual([]);
    expect(r.retained).toHaveLength(1);
    expect(r.retained[0].error).toContain('Shared by another item');
    expect(r.retained[0].error).toContain('item-B');
    expect(r.retained[0].error).toContain('ws-2');
    expect(r.warning).toBeUndefined(); // an intentional retain is not a failure
  });

  it('the lookup is a bound-parameter query that excludes the item itself and carries the recorded value', async () => {
    await teardownForItemDelete(A(), 't');
    const q = world.queries[0];
    expect(q.query).toContain('c.id != @self');
    expect(q.query).toContain('TOP 1');
    expect(q.parameters).toEqual(expect.arrayContaining([
      { name: '@self', value: 'item-A' },
      { name: '@vals', value: ['Sales'] },
    ]));
  });

  it('CONTROL: with no other item recording it, the SAME fixture deletes exactly once', async () => {
    const r = await teardownForItemDelete(A(), 't');
    expect(deleteKustoDatabase).toHaveBeenCalledTimes(1);
    expect(deleteKustoDatabase).toHaveBeenCalledWith('Sales');
    expect(r.retained).toEqual([]);
  });

  it('a lakehouse root recorded by another item is retained (path AND container/path are looked up)', async () => {
    world.other = { id: 'item-B', workspaceId: 'ws-2', itemType: 'lakehouse' };
    const r = await teardownForItemDelete(item('lakehouse', prov({ container: 'silver', rootPath: 'lakehouses/sales' })), 't');
    expect(deletePath).not.toHaveBeenCalled();
    expect(r.retained[0].error).toContain('Shared by another item');
    expect(world.queries[0].parameters).toContainEqual({ name: '@vals', value: ['lakehouses/sales', 'silver/lakehouses/sales'] });
  });
});

describe('blocker 1(c): a failed cross-item lookup fails CLOSED', () => {
  it('retains, flags unverified, and warns - delete fn called 0 times', async () => {
    world.throws = new Error('cosmos 429 throttled');
    const r = await teardownForItemDelete(item('kql-database', prov({ database: 'orders_db' })), 't');
    expect(deleteKustoDatabase, 'deleted although the shared-ref check could not run').toHaveBeenCalledTimes(0);
    expect(r.retained).toHaveLength(1);
    expect(r.retained[0].unverified).toBe(true);
    expect(r.retained[0].error).toContain('Could not verify');
    expect(r.retained[0].error).toContain('429');
    expect(r.warning).toContain('safety check could not be completed');
    expect(r.orphans).toEqual([]);
  });
});

/**
 * REVIEW BLOCKER 2 - plain top-level state keys are PATCH-able by any Member.
 * Fixtures: the top-level keys name VICTIM resources; the server-owned
 * provisioning receipt names the item's OWN resources. Teardown must touch only
 * the receipt's.
 */
describe('blocker 2: only the server-owned provisioning receipt is trusted', () => {
  it('(b) kql-database: PATCH-set state.databaseName="victim-db" is never deleted; the receipt\'s "own-db" is', async () => {
    // The receipt names the db ONLY via resourceId, so a trusted-top-level defect
    // (st() is consulted before resourceId) would pick 'victim-db' here.
    const it = item('kql-database', { databaseName: 'victim-db', ...prov({}, 'own-db') });
    await teardownForItemDelete(it, 't');
    expect(deleteKustoDatabase).toHaveBeenCalledTimes(1);
    expect(deleteKustoDatabase).toHaveBeenCalledWith('own-db');
    expect(deleteKustoDatabase).not.toHaveBeenCalledWith('victim-db');
  });

  it('(b) eventstream: PATCH-set transportHub="victim-hub" is ignored; receipt hub deleted; asaJobName=victim-job is NOT deleted (tag mismatch)', async () => {
    getJobTags.mockResolvedValue({ loomItemId: 'someone-elses-item' });
    const it = item('eventstream', {
      transportHub: 'victim-hub',
      asaJobName: 'victim-job',
      ...prov({ eventHub: 'own-hub' }, 'own-hub'), // receipt records NO asaJobName
    });
    const r = await teardownForItemDelete(it, 't');
    expect(deleteEventHub).toHaveBeenCalledTimes(1);
    expect(deleteEventHub).toHaveBeenCalledWith('own-hub');
    expect(deleteEventHub).not.toHaveBeenCalledWith('victim-hub');
    expect(getJobTags).toHaveBeenCalledWith('victim-job'); // looked at, as a candidate only
    expect(deleteStreamingJob, 'deleted a job named only by a user-editable key').toHaveBeenCalledTimes(0);
    expect(r.retained.map((x) => x.kind)).toContain('stream-analytics-job');
  });

  it('eventstream: asaJobName from the RECEIPT is the ownership proof (deleted, no tag lookup); a differing top-level one is ignored', async () => {
    const it = item('eventstream', { asaJobName: 'victim-job', ...prov({ eventHub: 'own-hub', asaJobName: 'own-job' }, 'own-hub') });
    await teardownForItemDelete(it, 't');
    expect(deleteStreamingJob).toHaveBeenCalledTimes(1);
    expect(deleteStreamingJob).toHaveBeenCalledWith('own-job');
    expect(getJobTags).not.toHaveBeenCalled();
  });

  it('a user-named top-level asaJobName whose tag names THIS item is deleted (the tag, not the key, is the proof)', async () => {
    getJobTags.mockResolvedValue({ loomItemId: 'item-1' });
    await teardownForItemDelete(item('eventstream', { asaJobName: 'asa-loom-item-1x', ...prov({ eventHub: 'h' }, 'h') }), 't');
    expect(deleteStreamingJob).toHaveBeenCalledWith('asa-loom-item-1x');
  });

  it('pipeline / index / notebook / activator top-level keys are ignored in the same way', async () => {
    // Receipts are shaped so the top-level key would win under the defect
    // (pipeline: st before resourceId; index: st before sid('index')).
    const pf = item('synapse-pipeline', { pipelineName: 'victim-p', ...prov({ backend: 'synapse' }, 'own-p') });
    const ix = item('ai-search-index', { indexName: 'victim-ix', ...prov({ service: 's', index: 'own-ix' }) });
    const ac = item('activator', { rules: [{ azureRuleName: 'victim-rule' }], ...prov({ backend: 'azure-monitor' }, 'own-rule') });
    const reports = [await teardownForItemDelete(pf, 't'), await teardownForItemDelete(ix, 't'), await teardownForItemDelete(ac, 't')];
    const refs = reports.flatMap((r) => r.removed.map((x) => x.ref));
    expect(refs.sort()).toEqual(['own-ix', 'own-p', 'own-rule']);
    expect(refs).not.toContain('victim-p');
    expect(refs).not.toContain('victim-ix');
    expect(refs).not.toContain('victim-rule');
  });

  it('an item with ONLY top-level refs and no server-owned receipt: retained, ZERO Azure calls', async () => {
    const it = item('kql-database', { databaseName: 'victim-db', transportHub: 'victim-hub', asaJobName: 'victim-job' });
    const r = await teardownForItemDelete(it, 't');
    expect(deleteKustoDatabase).not.toHaveBeenCalled();
    expect(deleteEventHub).not.toHaveBeenCalled();
    expect(deleteStreamingJob).not.toHaveBeenCalled();
    expect(r.retained).toHaveLength(1);
    expect(r.retained[0].error).toContain('no server-owned provisioning receipt');
  });
});

describe('non-blocking review items', () => {
  it('eventstream whose recorded hub is "ns/" (empty leaf): deleteEventHub is NOT called with an empty name', async () => {
    const r = await teardownForItemDelete(item('eventstream', prov({ eventHub: 'ns/' })), 't');
    expect(deleteEventHub).not.toHaveBeenCalled();
    expect(r.retained.some((x) => x.kind === 'event-hub' && /empty name/.test(x.error || ''))).toBe(true);
  });

  it('lakehouse: a ".." root is refused; a 1-segment root is refused; the delete gets the SANITISED path', async () => {
    await teardownForItemDelete(item('lakehouse', prov({ container: 'silver', rootPath: 'lakehouses/../other' })), 't');
    await teardownForItemDelete(item('lakehouse', prov({ container: 'silver', rootPath: 'onlyone' })), 't');
    expect(deletePath).not.toHaveBeenCalled();
    await teardownForItemDelete(item('lakehouse', prov({ container: 'silver', rootPath: '/lakehouses//sales/./' })), 't');
    expect(deletePath).toHaveBeenCalledTimes(1);
    expect(deletePath).toHaveBeenCalledWith('silver', 'lakehouses/sales/', true);
  });

  it('mirrored-database whose recorded root is another item\'s mirror root is retained', async () => {
    const r = await teardownForItemDelete(
      item('mirrored-database', prov({ pipeline: 'cdc-1', adlsRoot: 'abfss://bronze@a.dfs.core.windows.net/mirrors/ws-1/OTHER-ITEM' })),
      't',
    );
    expect(deletePath).not.toHaveBeenCalled();
    expect(r.retained.some((x) => x.kind === 'adls-path' && /own mirror root/.test(x.error || ''))).toBe(true);
  });
});
