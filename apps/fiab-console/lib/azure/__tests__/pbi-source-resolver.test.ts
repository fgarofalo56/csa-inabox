/**
 * Unit tests for the Weave → Power BI connection-coordinate resolver
 * (lib/azure/pbi-source-resolver.ts).
 *
 * Pure: item state + env are supplied directly; no network. The @azure/identity
 * chain is stubbed so importing synapse-sql-client / kusto-client (for the FQDN /
 * cluster-URI helpers the resolver reuses) never reaches Azure at module load.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() {
      return { token: 'test-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  resolvePbiSource,
  isPbiSourceGate,
  type PbiSourceBinding,
} from '../pbi-source-resolver';
import type { WorkspaceItem } from '@/lib/types/workspace';

const SAVED = {
  LOOM_SYNAPSE_WORKSPACE: process.env.LOOM_SYNAPSE_WORKSPACE,
  LOOM_SYNAPSE_DEDICATED_POOL: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
  LOOM_SYNAPSE_HOST_SUFFIX: process.env.LOOM_SYNAPSE_HOST_SUFFIX,
  LOOM_SYNAPSE_LAKEHOUSE_DB: process.env.LOOM_SYNAPSE_LAKEHOUSE_DB,
};

beforeEach(() => {
  process.env.LOOM_SYNAPSE_WORKSPACE = 'testws';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'testpool';
  process.env.LOOM_SYNAPSE_HOST_SUFFIX = 'sql.azuresynapse.net';
  delete process.env.LOOM_SYNAPSE_LAKEHOUSE_DB;
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
  vi.restoreAllMocks();
});

function item(partial: Partial<WorkspaceItem> & Pick<WorkspaceItem, 'itemType'>): WorkspaceItem {
  return {
    id: partial.id || 'item-1',
    workspaceId: partial.workspaceId || 'ws-1',
    itemType: partial.itemType,
    displayName: partial.displayName || 'Source Item',
    state: partial.state,
    createdBy: 'u', createdAt: 'now', updatedAt: 'now',
  };
}

/** Narrow the resolver result to a binding (fails the test if it gated). */
async function asBinding(it: WorkspaceItem, opts?: Parameters<typeof resolvePbiSource>[1]): Promise<PbiSourceBinding> {
  const r = await resolvePbiSource(it, opts);
  if (isPbiSourceGate(r)) throw new Error(`expected a binding, got gate: ${r.gate}`);
  return r;
}

describe('resolvePbiSource — lakehouse', () => {
  it('resolves the shared serverless endpoint + loom_lakehouse DB + default table', async () => {
    const b = await asBinding(item({
      itemType: 'lakehouse',
      state: { content: { kind: 'lakehouse', deltaTables: [{ name: 'sales', schema: 'gold' }] } },
    }));
    expect(b.connector).toBe('synapse-sql');
    expect(b.server).toBe('testws-ondemand.sql.azuresynapse.net');
    expect(b.database).toBe('loom_lakehouse');
    expect(b.defaultTable).toBe('gold.sales');
    expect(b.behindPrivateEndpoint).toBe(true);
    expect(b.loomNativeDataSource).toMatchObject({ kind: 'direct-query', target: 'lakehouse', database: 'loom_lakehouse' });
    expect((b.loomNativeDataSource as any).sql).toContain('[gold].[sales]');
  });

  it('honest-gates when no Synapse workspace is configured', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const r = await resolvePbiSource(item({ itemType: 'lakehouse', state: {} }));
    expect(isPbiSourceGate(r)).toBe(true);
    if (isPbiSourceGate(r)) expect(r.gate).toMatch(/LOOM_SYNAPSE_WORKSPACE/);
  });
});

describe('resolvePbiSource — warehouse / dedicated pool', () => {
  it('reads the server FQDN from resourceId + database from secondaryIds', async () => {
    const b = await asBinding(item({
      itemType: 'warehouse',
      state: {
        provisioning: {
          status: 'created',
          resourceId: 'testws.sql.azuresynapse.net/testpool/MyWarehouse',
          secondaryIds: { backend: 'synapse-dedicated', database: 'testpool' },
        },
        content: { kind: 'warehouse', ddl: 'CREATE TABLE [dbo].[Orders] (id int)' },
      },
    }));
    expect(b.connector).toBe('synapse-sql');
    expect(b.server).toBe('testws.sql.azuresynapse.net');
    expect(b.database).toBe('testpool');
    expect(b.defaultTable).toBe('dbo.Orders');
    expect(b.loomNativeDataSource).toMatchObject({ kind: 'direct-query', target: 'warehouse' });
    expect((b.loomNativeDataSource as any).sql).toContain('[dbo].[Orders]');
  });

  it('reconstructs the dedicated pool from env for synapse-dedicated-sql-pool', async () => {
    const b = await asBinding(item({ itemType: 'synapse-dedicated-sql-pool', state: {} }));
    expect(b.server).toBe('testws.sql.azuresynapse.net');
    expect(b.database).toBe('testpool');
  });
});

describe('resolvePbiSource — eventhouse / kql-database (ADX)', () => {
  it('resolves the cluster URI + database + default table from state', async () => {
    const b = await asBinding(item({
      itemType: 'kql-database',
      state: {
        provisioning: { status: 'created', secondaryIds: { cluster: 'https://adx-loom.eastus2.kusto.windows.net', database: 'Ops' } },
        content: { kind: 'kql-database', tables: [{ name: 'Events', columns: [{ name: 'ts', type: 'datetime' }] }] },
      },
    }));
    expect(b.connector).toBe('adx');
    expect(b.clusterUri).toBe('https://adx-loom.eastus2.kusto.windows.net');
    expect(b.database).toBe('Ops');
    expect(b.defaultTable).toBe('Events');
    expect(b.behindPrivateEndpoint).toBe(false);
    expect(b.loomNativeDataSource).toMatchObject({ kind: 'connection', connType: 'adx' });
  });

  it('treats eventhouse the same as kql-database', async () => {
    const b = await asBinding(item({
      itemType: 'eventhouse',
      state: { provisioning: { status: 'created', secondaryIds: { cluster: 'https://c.kusto.windows.net', database: 'Db1' } } },
    }));
    expect(b.connector).toBe('adx');
    expect(b.clusterUri).toBe('https://c.kusto.windows.net');
  });
});

describe('resolvePbiSource — mirrored-database', () => {
  it('resolves the per-mirror serverless database (loom_mirror_<name>)', async () => {
    const b = await asBinding(item({
      itemType: 'mirrored-database',
      displayName: 'Sales Mirror',
      state: { content: { kind: 'mirrored-database', source: { tables: ['dbo.Customers'] } } },
    }));
    expect(b.connector).toBe('synapse-sql');
    expect(b.server).toBe('testws-ondemand.sql.azuresynapse.net');
    expect(b.database).toBe('loom_mirror_Sales_Mirror');
    expect(b.defaultTable).toBe('dbo.Customers');
  });
});

describe('resolvePbiSource — semantic-model', () => {
  it('binds a report directly to the model item', async () => {
    const b = await asBinding(item({
      id: 'model-9', itemType: 'semantic-model',
      state: { content: { kind: 'semantic-model', tables: [{ name: 'Sales', columns: [] }] } },
    }));
    expect(b.loomNativeDataSource).toEqual({ kind: 'semantic-model', itemId: 'model-9' });
    expect(b.defaultTable).toBe('Sales');
  });
});

describe('resolvePbiSource — synapse-serverless-sql-pool', () => {
  it('reads the endpoint + database from its own secondaryIds', async () => {
    const b = await asBinding(item({
      itemType: 'synapse-serverless-sql-pool',
      state: { provisioning: { status: 'created', secondaryIds: { endpoint: 'testws-ondemand.sql.azuresynapse.net', database: 'loom_lakehouse' } } },
    }));
    expect(b.server).toBe('testws-ondemand.sql.azuresynapse.net');
    expect(b.database).toBe('loom_lakehouse');
  });
});

describe('resolvePbiSource — dataset (Foundry)', () => {
  it('resolves an ADLS binding from an abfss path in state', async () => {
    const b = await asBinding(item({
      itemType: 'dataset',
      state: { storageUri: 'abfss://landing@acct.dfs.core.windows.net/foundry/ds1/data.parquet' },
    }));
    expect(b.connector).toBe('adls');
    expect(b.database).toBe('landing');
    expect(b.loomNativeDataSource).toMatchObject({ kind: 'adls-file', container: 'landing', format: 'parquet' });
  });

  it('honest-gates a dataset with no queryable storage path', async () => {
    const r = await resolvePbiSource(item({ itemType: 'dataset', state: { note: 'metadata only' } }));
    expect(isPbiSourceGate(r)).toBe(true);
    if (isPbiSourceGate(r)) expect(r.gate).toMatch(/no Power BI-queryable storage path/i);
  });
});

describe('resolvePbiSource — data-product', () => {
  it('recurses into a referenced lakehouse and re-stamps sourceItemId', async () => {
    const lake = item({
      id: 'lake-1', itemType: 'lakehouse',
      state: { content: { kind: 'lakehouse', deltaTables: [{ name: 't', schema: 'dbo' }] } },
    });
    const dp = item({ id: 'dp-1', itemType: 'data-product', state: { content: { datasets: [{ itemId: 'lake-1' }] } } });
    const b = await asBinding(dp, { loadItem: async (id) => (id === 'lake-1' ? lake : null) });
    expect(b.connector).toBe('synapse-sql');
    expect(b.sourceItemId).toBe('dp-1'); // lineage points at the data product
  });

  it('honest-gates when no loader is supplied', async () => {
    const dp = item({ itemType: 'data-product', state: { content: { datasets: [{ itemId: 'lake-1' }] } } });
    const r = await resolvePbiSource(dp);
    expect(isPbiSourceGate(r)).toBe(true);
    if (isPbiSourceGate(r)) expect(r.gate).toMatch(/does not reference a Power BI-queryable/i);
  });
});

describe('resolvePbiSource — unsupported', () => {
  it('honest-gates an unknown item type', async () => {
    const r = await resolvePbiSource(item({ itemType: 'notebook', state: {} }));
    expect(isPbiSourceGate(r)).toBe(true);
    if (isPbiSourceGate(r)) expect(r.gate).toMatch(/not a supported Power BI source/i);
  });
});
