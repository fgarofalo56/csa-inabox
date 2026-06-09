/**
 * Cloud-matrix tests for the mirror → Synapse Serverless SQL analytics endpoint
 * pairing (Paired SQL analytics endpoint over the mirror).
 *
 * Two cloud-portable surfaces must resolve sovereign-cloud-correctly:
 *   1. The abfss Bronze root the pairing targets — derived from LOOM_BRONZE_URL
 *      by adls-client.resolveAbfssRoot() (dfs.core.windows.net in Commercial/GCC
 *      vs dfs.core.usgovcloudapi.net in GCC-High/IL5).
 *   2. The Serverless SQL endpoint suffix — getSynapseSqlSuffix() (sql.azuresynapse.net
 *      vs sql.azuresynapse.usgovcloudapi.net).
 *
 * It also pins the install-engine pairing rule (registry.ts) deriveContent:
 *   - returns null on the opt-in Fabric backend (no adlsRoot → no Fabric dep),
 *   - normalizes the mirror table list (string 'schema.table' + {schema,table}),
 *   - drops wildcards, and stamps the per-mirror loom_mirror_<name> database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub the credential chain so importing adls-client / synapse-sql-client never
// reaches Azure at module load.
vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() {
      return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { resolveAbfssRoot } from '../adls-client';
import { getSynapseSqlSuffix } from '../synapse-sql-client';
import { ITEM_PAIRING_RULES } from '@/lib/items/registry';

const SAVED = {
  AZURE_CLOUD: process.env.AZURE_CLOUD,
  LOOM_CLOUD: process.env.LOOM_CLOUD,
  LOOM_BRONZE_URL: process.env.LOOM_BRONZE_URL,
  LOOM_SYNAPSE_HOST_SUFFIX: process.env.LOOM_SYNAPSE_HOST_SUFFIX,
};

beforeEach(() => {
  delete process.env.LOOM_SYNAPSE_HOST_SUFFIX;
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

const ROOT_PATH = 'mirrors/ws1/mirror1';

describe('mirror SQL endpoint — abfss Bronze root matrix', () => {
  it('Commercial: dfs.core.windows.net', () => {
    process.env.LOOM_BRONZE_URL = 'https://stloom.dfs.core.windows.net/bronze';
    expect(resolveAbfssRoot('bronze', ROOT_PATH)).toBe(
      'abfss://bronze@stloom.dfs.core.windows.net/mirrors/ws1/mirror1',
    );
  });

  it('GCC-High / IL5: dfs.core.usgovcloudapi.net', () => {
    process.env.LOOM_BRONZE_URL = 'https://stloom.dfs.core.usgovcloudapi.net/bronze';
    expect(resolveAbfssRoot('bronze', ROOT_PATH)).toBe(
      'abfss://bronze@stloom.dfs.core.usgovcloudapi.net/mirrors/ws1/mirror1',
    );
  });

  it('returns null when LOOM_BRONZE_URL is unset (pairing skips → no Fabric/Azure gate)', () => {
    delete process.env.LOOM_BRONZE_URL;
    expect(resolveAbfssRoot('bronze', ROOT_PATH)).toBeNull();
  });
});

describe('mirror SQL endpoint — Synapse suffix matrix', () => {
  it('Commercial (AZURE_CLOUD=AzureCloud) → sql.azuresynapse.net', () => {
    delete process.env.LOOM_CLOUD;
    process.env.AZURE_CLOUD = 'AzureCloud';
    expect(getSynapseSqlSuffix()).toBe('sql.azuresynapse.net');
  });

  it('GCC-High / IL5 (AZURE_CLOUD=AzureUSGovernment) → sql.azuresynapse.usgovcloudapi.net', () => {
    delete process.env.LOOM_CLOUD;
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(getSynapseSqlSuffix()).toBe('sql.azuresynapse.usgovcloudapi.net');
  });
});

describe('ITEM_PAIRING_RULES.mirrored-database — deriveContent', () => {
  const rule = ITEM_PAIRING_RULES['mirrored-database'][0];
  const input = (content: unknown) =>
    ({ cosmosItemId: 'mirror1', displayName: 'Prod Sales Mirror', workspaceId: 'ws1', content }) as any;

  it('pairs synapse-serverless-sql-pool', () => {
    expect(rule.pairedType).toBe('synapse-serverless-sql-pool');
  });

  it('returns null when the parent has no adlsRoot (Fabric backend / no Bronze)', () => {
    const result = { status: 'created' as const, secondaryIds: { backend: 'fabric' } };
    expect(rule.deriveContent(result as any, input({ source: { tables: ['dbo.Sales'] } }))).toBeNull();
  });

  it('normalizes string + object tables, drops wildcards, stamps the per-mirror DB', () => {
    const result = {
      status: 'created' as const,
      secondaryIds: { backend: 'adf-cdc', adlsRoot: 'abfss://bronze@stloom.dfs.core.windows.net/mirrors/ws1/mirror1' },
    };
    const content = rule.deriveContent(
      result as any,
      input({ source: { tables: ['dbo.Sales', 'Ops.Orders', 'dbo.*'] } }),
    ) as any;
    expect(content.adlsRoot).toContain('mirrors/ws1/mirror1');
    expect(content.mirrorItemId).toBe('mirror1');
    expect(content.database).toBe('loom_mirror_Prod_Sales_Mirror');
    expect(content.tables).toEqual([
      { schema: 'dbo', table: 'Sales' },
      { schema: 'Ops', table: 'Orders' },
    ]);
  });

  it('reads object-shaped tables from content.tables (editor shape)', () => {
    const result = {
      status: 'created' as const,
      secondaryIds: { backend: 'adf-cdc', adlsRoot: 'abfss://bronze@stloom.dfs.core.windows.net/mirrors/ws1/mirror1' },
    };
    const content = rule.deriveContent(
      result as any,
      input({ tables: [{ schema: 'dbo', table: 'Customer' }] }),
    ) as any;
    expect(content.tables).toEqual([{ schema: 'dbo', table: 'Customer' }]);
  });
});
