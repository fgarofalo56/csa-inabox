/**
 * Unit tests for the KQL Copilot tool registry (lib/copilot/kql-tools.ts).
 *
 * Mocks:
 *  - @azure/identity            — inert credential (kusto-client imports it)
 *  - @/lib/azure/kusto-client   — stub every function the tools/handlers call
 *  - @/lib/azure/copilot-orchestrator — minimal LoomToolRegistry so the test
 *    does not pull the full orchestrator import graph (cosmos, all clients).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// Minimal LoomToolRegistry — same shape kql-tools depends on (register/list/get).
vi.mock('@/lib/azure/copilot-orchestrator', () => {
  class LoomToolRegistry {
    private tools = new Map<string, any>();
    register(t: any) { this.tools.set(t.name, t); }
    list() { return Array.from(this.tools.values()); }
    get(name: string) { return this.tools.get(name); }
  }
  return { LoomToolRegistry };
});

const kusto = vi.hoisted(() => ({
  executeQuery: vi.fn(async () => ({ columns: ['c'], columnTypes: ['long'], rows: [[1]], rowCount: 1 })),
  executeMgmtCommand: vi.fn(async () => ({ columns: ['ok'], columnTypes: ['string'], rows: [['done']], rowCount: 1 })),
  listDatabases: vi.fn(async () => [{ name: 'loomdb-default' }]),
  listTables: vi.fn(async () => [{ name: 'Events' }]),
  getDatabaseSchemaJson: vi.fn(async () => ({ Databases: { 'loomdb-default': { Tables: { Events: {} } } } })),
  kustoConfigGate: vi.fn(() => null as { missing: string } | null),
}));
vi.mock('@/lib/azure/kusto-client', () => kusto);

import {
  buildKqlToolRegistry,
  buildSchemaContext,
  KQL_TOOL_NAMES,
} from '../kql-tools';

beforeEach(() => {
  kusto.kustoConfigGate.mockReturnValue(null);
  kusto.getDatabaseSchemaJson.mockResolvedValue({ Databases: { 'loomdb-default': { Tables: { Events: {} } } } });
});
afterEach(() => { vi.clearAllMocks(); });

const reg = () => buildKqlToolRegistry();
const tool = (name: string) => reg().get(name)!;

describe('buildKqlToolRegistry', () => {
  it('registers exactly the four KQL tools', () => {
    const names = reg().list().map((t: any) => t.name).sort();
    expect(names).toEqual([...KQL_TOOL_NAMES].sort());
  });

  it('kql_list_databases calls listDatabases()', async () => {
    const out = await tool('kql_list_databases').handler({}, {} as any);
    expect(kusto.listDatabases).toHaveBeenCalled();
    expect(out).toEqual([{ name: 'loomdb-default' }]);
  });

  it('kql_list_tables passes the database through to listTables()', async () => {
    await tool('kql_list_tables').handler({ database: 'mydb' }, {} as any);
    expect(kusto.listTables).toHaveBeenCalledWith('mydb');
  });

  it('kql_get_schema calls getDatabaseSchemaJson(database)', async () => {
    await tool('kql_get_schema').handler({ database: 'mydb' }, {} as any);
    expect(kusto.getDatabaseSchemaJson).toHaveBeenCalledWith('mydb');
  });

  it('kql_execute routes plain queries to executeQuery', async () => {
    await tool('kql_execute').handler({ database: 'mydb', kql: 'Events | take 5' }, {} as any);
    expect(kusto.executeQuery).toHaveBeenCalledWith('mydb', 'Events | take 5');
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
  });

  it('kql_execute routes dot-commands to executeMgmtCommand', async () => {
    await tool('kql_execute').handler({ database: 'mydb', kql: '  .show tables' }, {} as any);
    expect(kusto.executeMgmtCommand).toHaveBeenCalledWith('mydb', '  .show tables');
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('returns an honest { gated, missing } when the cluster URI is unset', async () => {
    kusto.kustoConfigGate.mockReturnValue({ missing: 'LOOM_KUSTO_CLUSTER_URI' });
    const out = await tool('kql_list_databases').handler({}, {} as any);
    expect(out).toEqual({ gated: true, missing: 'LOOM_KUSTO_CLUSTER_URI' });
    expect(kusto.listDatabases).not.toHaveBeenCalled();
  });
});

describe('buildSchemaContext', () => {
  it('stringifies the live schema for non-empty results', async () => {
    const s = await buildSchemaContext('loomdb-default');
    expect(s).toContain('Events');
    expect(kusto.getDatabaseSchemaJson).toHaveBeenCalledWith('loomdb-default');
  });

  it('soft-fails to empty string when schema fetch throws', async () => {
    kusto.getDatabaseSchemaJson.mockRejectedValueOnce(new Error('cold cluster'));
    expect(await buildSchemaContext('loomdb-default')).toBe('');
  });

  it('returns empty string when schema is null', async () => {
    kusto.getDatabaseSchemaJson.mockResolvedValueOnce(null);
    expect(await buildSchemaContext('loomdb-default')).toBe('');
  });

  it('truncates schema strings longer than 8 000 chars', async () => {
    kusto.getDatabaseSchemaJson.mockResolvedValueOnce('x'.repeat(20_000));
    const s = await buildSchemaContext('loomdb-default');
    expect(s.length).toBeLessThan(9_000);
    expect(s).toContain('schema truncated');
  });
});
