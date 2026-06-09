/**
 * aas-client — unit tests for the pure (no-network) helpers used by the
 * Loom-native report renderer: DAX synthesis, row flattening, and binding
 * resolution. The fetch-driven executeAasQuery is covered by the BFF route
 * + the live E2E receipt; these tests lock the deterministic logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SAVED = { ...process.env };

async function load(cloud?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_AAS_SERVER;
  delete process.env.LOOM_AAS_DATABASE;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  return import('../aas-dax');
}

afterEach(() => { process.env = { ...SAVED }; });

describe('buildDaxFromVisual', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('passes through an explicit EVALUATE expression', () => {
    expect(m.buildDaxFromVisual({ type: 'table', field: 'EVALUATE Sales' })).toBe('EVALUATE Sales');
    // case-insensitive
    expect(m.buildDaxFromVisual({ type: 'table', field: 'evaluate Sales' })).toBe('evaluate Sales');
  });

  it('wraps a measure/column in ROW for a card visual', () => {
    expect(m.buildDaxFromVisual({ type: 'card', field: '[Total Sales]' })).toBe('EVALUATE ROW("Value", [Total Sales])');
  });

  it('wraps a measure/column in TOPN(ROW) for a non-card visual', () => {
    expect(m.buildDaxFromVisual({ type: 'bar', field: 'Sales[Amount]' })).toBe('EVALUATE TOPN(100, ROW("Value", Sales[Amount]))');
  });

  it('TOPN-guards a bare table name', () => {
    expect(m.buildDaxFromVisual({ type: 'table', field: 'Customers' })).toBe('EVALUATE TOPN(100, Customers)');
  });

  it('returns null for an empty field', () => {
    expect(m.buildDaxFromVisual({ type: 'card', field: '' })).toBeNull();
    expect(m.buildDaxFromVisual({ type: 'card' })).toBeNull();
  });
});

describe('flattenAasRows', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('strips the [Table].[Column] prefix', () => {
    const rows = m.flattenAasRows({
      results: [{ tables: [{ rows: [{ '[Sales].[Amount]': 10, '[Sales].[Region]': 'East' }] }] }],
    });
    expect(rows).toEqual([{ Amount: 10, Region: 'East' }]);
  });

  it('strips a bare [Column] prefix', () => {
    const rows = m.flattenAasRows({ results: [{ tables: [{ rows: [{ '[Value]': 42 }] }] }] });
    expect(rows).toEqual([{ Value: 42 }]);
  });

  it('returns [] for an empty / shapeless result', () => {
    expect(m.flattenAasRows({ results: [] })).toEqual([]);
    expect(m.flattenAasRows({ results: [{ tables: [] }] })).toEqual([]);
  });
});

describe('resolveAasBinding', () => {
  let m: typeof import('../aas-dax');
  beforeEach(async () => { m = await load('AzureCloud'); });

  it('resolves from per-item state', () => {
    expect(m.resolveAasBinding('asazure://eastus2.asazure.windows.net/my-server', 'AdventureWorks')).toEqual({
      region: 'eastus2', serverName: 'my-server', database: 'AdventureWorks',
    });
  });

  it('falls back to env defaults', async () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus2.asazure.windows.net/env-server';
    process.env.LOOM_AAS_DATABASE = 'EnvModel';
    const m2 = await import('../aas-dax');
    expect(m2.resolveAasBinding(undefined, undefined)).toEqual({
      region: 'eastus2', serverName: 'env-server', database: 'EnvModel',
    });
  });

  it('returns null when nothing is bound', () => {
    expect(m.resolveAasBinding(undefined, undefined)).toBeNull();
    expect(m.resolveAasBinding('asazure://eastus2.asazure.windows.net/my-server', undefined)).toBeNull();
    expect(m.resolveAasBinding('not-a-server', 'Model')).toBeNull();
  });
});
