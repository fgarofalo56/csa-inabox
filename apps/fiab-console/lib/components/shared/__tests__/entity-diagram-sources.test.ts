/**
 * entity-diagram-sources — normalization + honest-gate contract.
 *
 * Pure (node env) tests: each reader is driven with an injected fetch stub that
 * returns the SHAPE the real BFF route returns, asserting we (a) normalize into
 * the single EntityGraph contract, (b) key tables so relationship endpoints
 * resolve, and (c) surface an honest `gate` string (never throw) when the
 * backing store is unreachable.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyColumnType, parseKqlSchema, cardinalityMarkers,
  readSemanticModelGraph, readLakehouseGraph, readKqlDatabaseGraph,
  type EntityFetch,
} from '../entity-diagram-sources';

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body } as unknown as Response;
}

describe('classifyColumnType', () => {
  it('maps backend-native type vocabularies to coarse kinds', () => {
    expect(classifyColumnType('nvarchar')).toBe('text');
    expect(classifyColumnType('string')).toBe('text');
    expect(classifyColumnType('int64')).toBe('number');
    expect(classifyColumnType('bigint')).toBe('number');
    expect(classifyColumnType('datetime2')).toBe('datetime');
    expect(classifyColumnType('bool')).toBe('bool');
    expect(classifyColumnType('dynamic')).toBe('json');
    expect(classifyColumnType('geography')).toBe('geo');
    expect(classifyColumnType('uniqueidentifier')).toBe('guid');
    expect(classifyColumnType('varbinary')).toBe('binary');
    expect(classifyColumnType(undefined)).toBe('unknown');
    expect(classifyColumnType('weirdtype')).toBe('unknown');
  });
});

describe('cardinalityMarkers', () => {
  it('emits the 1/* end markers Fabric draws', () => {
    expect(cardinalityMarkers('many-to-one')).toEqual({ from: '*', to: '1' });
    expect(cardinalityMarkers('one-to-many')).toEqual({ from: '1', to: '*' });
    expect(cardinalityMarkers('one-to-one')).toEqual({ from: '1', to: '1' });
    expect(cardinalityMarkers('many-to-many')).toEqual({ from: '*', to: '*' });
  });
});

describe('parseKqlSchema', () => {
  it('parses .show database schema as json (Databases → Tables → OrderedColumns)', () => {
    const schema = {
      Databases: {
        casino: {
          Tables: {
            Events: { Name: 'Events', OrderedColumns: [{ Name: 'ts', CslType: 'datetime' }, { Name: 'value', CslType: 'long' }] },
            Users: { Name: 'Users', OrderedColumns: [{ Name: 'id', CslType: 'string' }] },
          },
        },
      },
    };
    const tables = parseKqlSchema(schema, 'casino');
    expect(tables).toHaveLength(2);
    const events = tables.find((t) => t.name === 'Events')!;
    expect(events.id).toBe('Events');
    expect(events.columns.map((c) => c.name)).toEqual(['ts', 'value']);
    expect(events.columns[0].kind).toBe('datetime');
    expect(events.columns[1].kind).toBe('number');
  });

  it('falls back to a db-scoped { Tables } payload and empty for junk', () => {
    expect(parseKqlSchema({ Tables: { T: { OrderedColumns: [] } } })).toHaveLength(1);
    expect(parseKqlSchema(null)).toEqual([]);
    expect(parseKqlSchema('nope')).toEqual([]);
  });
});

describe('readSemanticModelGraph', () => {
  it('normalizes TMSL tables + relationships, keying tables by name', async () => {
    const fetchImpl: EntityFetch = vi.fn(async () => jsonResponse({
      ok: true,
      modelName: 'Sales',
      tables: [
        { name: 'Fact', columns: [{ name: 'k', type: 'int64', isPk: true }, { name: 'amt', type: 'double' }] },
        { name: 'Dim', columns: [{ name: 'k', type: 'int64' }] },
      ],
      relationships: [
        { id: 'r1', fromTable: 'Fact', fromColumn: 'k', toTable: 'Dim', toColumn: 'k', cardinality: 'many-to-one', active: true },
      ],
    }));
    const g = await readSemanticModelGraph({ kind: 'semantic-model', itemId: 'ds1', workspaceId: '' }, fetchImpl);
    expect(g.gate).toBeUndefined();
    expect(g.modelName).toBe('Sales');
    expect(g.tables.map((t) => t.id)).toEqual(['Fact', 'Dim']);
    // isPk column resolves to the 'key' kind + isKey flag.
    expect(g.tables[0].columns[0]).toMatchObject({ name: 'k', kind: 'key', isKey: true });
    // relationship endpoints reference the table ids (names).
    expect(g.relationships[0]).toMatchObject({ fromTable: 'Fact', toTable: 'Dim', cardinality: 'many-to-one' });
  });

  it('returns an honest gate on !ok', async () => {
    const fetchImpl: EntityFetch = vi.fn(async () => jsonResponse({ ok: false, error: 'Select a Power BI workspace' }, 200));
    const g = await readSemanticModelGraph({ kind: 'semantic-model', itemId: 'ds1' }, fetchImpl);
    expect(g.gate).toBe('Select a Power BI workspace');
    expect(g.tables).toEqual([]);
  });

  it('gates without an itemId (no network call)', async () => {
    const fetchImpl = vi.fn();
    const g = await readSemanticModelGraph({ kind: 'semantic-model', itemId: '' }, fetchImpl as unknown as EntityFetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(g.gate).toContain('Select a dataset');
  });
});

describe('readKqlDatabaseGraph', () => {
  it('reads ADX schema via /api/adx/overview', async () => {
    const fetchImpl: EntityFetch = vi.fn(async () => jsonResponse({
      ok: true,
      database: 'casino',
      schema: { Databases: { casino: { Tables: { Events: { OrderedColumns: [{ Name: 'ts', CslType: 'datetime' }] } } } } },
    }));
    const g = await readKqlDatabaseGraph({ kind: 'kql-database', itemId: 'kdb1' }, fetchImpl);
    expect(g.modelName).toBe('casino');
    expect(g.tables).toHaveLength(1);
    expect(g.relationships).toEqual([]); // KQL has no FKs — empty by design
  });

  it('surfaces the 503 honest gate', async () => {
    const fetchImpl: EntityFetch = vi.fn(async () => jsonResponse({ ok: false, error: 'Set LOOM_KUSTO_CLUSTER_URI' }, 503));
    const g = await readKqlDatabaseGraph({ kind: 'kql-database', itemId: 'kdb1' }, fetchImpl);
    expect(g.gate).toBe('Set LOOM_KUSTO_CLUSTER_URI');
  });
});

describe('readLakehouseGraph', () => {
  it('lists Delta tables and enriches columns via INFORMATION_SCHEMA', async () => {
    const fetchImpl: EntityFetch = vi.fn(async (input: string) => {
      if (input.startsWith('/api/lakehouse/tables')) {
        return jsonResponse({ ok: true, tables: [{ schema: 'gold', name: 'sales', rowCount: 100 }] });
      }
      // INFORMATION_SCHEMA.COLUMNS enrichment
      return jsonResponse({
        ok: true,
        columns: [{ name: 'TABLE_SCHEMA' }, { name: 'TABLE_NAME' }, { name: 'COLUMN_NAME' }, { name: 'DATA_TYPE' }, { name: 'ORDINAL_POSITION' }],
        rows: [['gold', 'sales', 'id', 'int', 1], ['gold', 'sales', 'amt', 'decimal', 2]],
      });
    });
    const g = await readLakehouseGraph({ kind: 'lakehouse', itemId: 'lh1', workspaceId: 'ws-1' }, fetchImpl);
    expect(g.tables).toHaveLength(1);
    expect(g.tables[0]).toMatchObject({ id: 'gold.sales', name: 'sales', schema: 'gold', rowCount: 100 });
    expect(g.tables[0].columns.map((c) => c.name)).toEqual(['id', 'amt']);
    expect(g.tables[0].columns[1].kind).toBe('number');
    expect(g.relationships).toEqual([]); // Delta has no declared FKs
  });

  it('returns the storage gate when no lakehouse storage is configured', async () => {
    const fetchImpl: EntityFetch = vi.fn(async () => jsonResponse({ ok: true, tables: [], gate: 'No lakehouse storage configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL' }));
    const g = await readLakehouseGraph({ kind: 'lakehouse', itemId: 'lh1', workspaceId: 'ws-1' }, fetchImpl);
    expect(g.gate).toContain('No lakehouse storage configured');
    expect(g.tables).toEqual([]);
  });

  it('degrades column enrichment to a notice (not a gate) when the SQL endpoint is down', async () => {
    const fetchImpl: EntityFetch = vi.fn(async (input: string) => {
      if (input.startsWith('/api/lakehouse/tables')) {
        return jsonResponse({ ok: true, tables: [{ schema: 'gold', name: 'sales', rowCount: null }] });
      }
      return jsonResponse({ ok: false, error: 'Synapse not provisioned' }, 503);
    });
    const g = await readLakehouseGraph({ kind: 'lakehouse', itemId: 'lh1', workspaceId: 'ws-1' }, fetchImpl);
    expect(g.gate).toBeUndefined();
    expect(g.tables).toHaveLength(1);
    expect(g.notice).toContain('Column details unavailable');
  });
});
