import { describe, it, expect } from 'vitest';
import type { OntoObjectType } from '@/lib/editors/ontology-model';
import { LIVE, parseAsOf, resolveTimeTravel } from '@/lib/time-machine/time-machine';
import {
  normalizeOntologyBinding,
  resolveColumnMap,
  mapRowToInstance,
  mapRowsToInstances,
  buildSqlSelect,
  buildKql,
  buildDax,
  clampTop,
  BindingQueryError,
  ONTOLOGY_BINDING_SOURCE_KINDS,
  type OntologyBinding,
} from '../ontology-binding';

const CUSTOMER: OntoObjectType = {
  apiName: 'Customer',
  displayName: 'Customer',
  primaryKey: 'customerId',
  properties: [
    { apiName: 'customerId', baseType: 'string' },
    { apiName: 'name', baseType: 'string' },
    { apiName: 'revenue', baseType: 'double' },
    { apiName: 'active', baseType: 'boolean' },
  ],
};

function binding(over: Partial<OntologyBinding> = {}): OntologyBinding {
  return {
    ontologyId: 'onto-1',
    objectType: 'Customer',
    source: { kind: 'lakehouse-table', ref: 'dbo.Customer' },
    ...over,
  };
}

describe('normalizeOntologyBinding', () => {
  it('accepts a valid binding and drops junk columnMap entries', () => {
    const b = normalizeOntologyBinding({
      ontologyId: 'onto-1',
      ontologyName: 'Sales',
      objectType: 'Customer',
      keyColumn: 'CustomerId',
      columnMap: { CustomerId: 'customerId', Bad: '1nope', Name: 'name' },
      source: { kind: 'kql', ref: 'Customers', database: 'sales' },
      boundAt: '2026-07-20T00:00:00Z',
    });
    expect(b).not.toBeNull();
    expect(b!.objectType).toBe('Customer');
    expect(b!.source.kind).toBe('kql');
    expect(b!.source.database).toBe('sales');
    expect(b!.columnMap).toEqual({ CustomerId: 'customerId', Name: 'name' });
  });

  it('rejects missing ids, bad kind, and non-shortcut empty ref', () => {
    expect(normalizeOntologyBinding(null)).toBeNull();
    expect(normalizeOntologyBinding({ objectType: 'X', source: { kind: 'kql', ref: 'T' } })).toBeNull();
    expect(normalizeOntologyBinding({ ontologyId: 'o', objectType: 'X', source: { kind: 'nope', ref: 'T' } })).toBeNull();
    expect(normalizeOntologyBinding({ ontologyId: 'o', objectType: 'X', source: { kind: 'lakehouse-table', ref: '' } })).toBeNull();
  });

  it('allows a shortcut binding with registry coordinates and no literal ref', () => {
    const b = normalizeOntologyBinding({
      ontologyId: 'o', objectType: 'X',
      source: { kind: 'shortcut', ref: '', lakehouseId: 'lh-1', shortcutId: 'sc-1' },
    });
    expect(b).not.toBeNull();
    expect(b!.source.lakehouseId).toBe('lh-1');
    expect(b!.source.shortcutId).toBe('sc-1');
  });

  it('exposes exactly the six source kinds', () => {
    expect([...ONTOLOGY_BINDING_SOURCE_KINDS]).toEqual([
      'lakehouse-table', 'warehouse-table', 'kql', 'semantic-measure', 'shortcut', 'azure-sql',
    ]);
  });
});

describe('resolveColumnMap precedence', () => {
  it('prefers the binding columnMap', () => {
    const map = resolveColumnMap(binding({ columnMap: { c_id: 'customerId' } }), CUSTOMER);
    expect(map).toEqual({ c_id: 'customerId' });
  });

  it('falls back to the object type datasource columnMap', () => {
    const ot: OntoObjectType = { ...CUSTOMER, datasource: { kind: 'lakehouse', sourceItemId: 'lh', columnMap: { CID: 'customerId' } } };
    expect(resolveColumnMap(binding(), ot)).toEqual({ CID: 'customerId' });
  });

  it('falls back to identity-by-name over declared properties', () => {
    expect(resolveColumnMap(binding(), CUSTOMER)).toEqual({
      customerId: 'customerId', name: 'name', revenue: 'revenue', active: 'active',
    });
  });
});

describe('mapRowToInstance — column→property mapping + coercion', () => {
  const colMap = { CustomerId: 'customerId', Name: 'name', Revenue: 'revenue', Active: 'active' };
  const columns = ['CustomerId', 'Name', 'Revenue', 'Active'];

  it('maps a row to a typed instance and coerces numeric/boolean', () => {
    const inst = mapRowToInstance(
      binding({ columnMap: colMap, keyColumn: 'CustomerId' }),
      CUSTOMER, colMap, columns, ['C1', 'Acme', '1234.5', 'true'], 0,
    );
    expect(inst.id).toBe('C1');
    expect(inst.objectType).toBe('Customer');
    expect(inst.properties).toEqual({ customerId: 'C1', name: 'Acme', revenue: 1234.5, active: true });
    expect(inst.sourceKind).toBe('lakehouse-table');
  });

  it('drops source columns that map to no declared property', () => {
    const cm = { ...colMap, Secret: 'notDeclared' };
    const inst = mapRowToInstance(
      binding({ columnMap: cm }), CUSTOMER, cm,
      ['CustomerId', 'Secret'], ['C9', 'leak'], 3,
    );
    expect(inst.properties).not.toHaveProperty('notDeclared');
    expect(inst.properties.customerId).toBe('C9');
  });

  it('derives id from the key property when no keyColumn is set', () => {
    const inst = mapRowToInstance(binding({ columnMap: colMap }), CUSTOMER, colMap, columns, ['C7', 'X', '0', 'false'], 2);
    expect(inst.id).toBe('C7'); // customerId is the primaryKey
  });

  it('synthesizes an ordinal id when no key is resolvable', () => {
    const otNoKey: OntoObjectType = { apiName: 'Blob', properties: [{ apiName: 'v', baseType: 'string' }] };
    const inst = mapRowToInstance(
      binding({ objectType: 'Blob', columnMap: { V: 'v' } }), otNoKey, { V: 'v' }, ['V'], ['x'], 5,
    );
    expect(inst.id).toBe('Blob#5');
  });
});

describe('query builders — pure + injection-guarded', () => {
  it('buildSqlSelect projects * with a clamped TOP', () => {
    expect(buildSqlSelect('dbo.Customer', 100)).toBe('SELECT TOP 100 * FROM dbo.Customer');
    expect(buildSqlSelect('[loom_lakehouse].[shortcuts].[t]', 5000)).toBe('SELECT TOP 1000 * FROM [loom_lakehouse].[shortcuts].[t]');
  });

  it('buildSqlSelect rejects an injection attempt', () => {
    expect(() => buildSqlSelect('Customer; DROP TABLE x', 10)).toThrow(BindingQueryError);
    expect(() => buildSqlSelect("Customer WHERE 1=1", 10)).toThrow(BindingQueryError);
  });

  it('buildKql projects a validated table with take', () => {
    expect(buildKql('Signals', 50)).toBe('Signals | take 50');
    expect(() => buildKql('Signals | where x', 10)).toThrow(BindingQueryError);
  });

  it('WS-10.3 buildSqlSelect threads a Delta time-travel clause after the ref', () => {
    const delta = resolveTimeTravel('delta', parseAsOf('2026-07-01T00:00:00Z'));
    expect(buildSqlSelect('dbo.Customer', 100, delta))
      .toBe("SELECT TOP 100 * FROM dbo.Customer TIMESTAMP AS OF '2026-07-01T00:00:00.000Z'");
    // A live/no-op resolution leaves the query byte-identical.
    const live = resolveTimeTravel('delta', LIVE);
    expect(buildSqlSelect('dbo.Customer', 100, live)).toBe('SELECT TOP 100 * FROM dbo.Customer');
  });

  it('WS-10.3 buildKql threads an ADX ingestion-time filter before take', () => {
    const adx = resolveTimeTravel('adx', parseAsOf('2026-07-01T00:00:00Z'));
    expect(buildKql('Signals', 50, adx))
      .toBe('Signals | where ingestion_time() <= datetime(2026-07-01T00:00:00.000Z) | take 50');
  });

  it('buildDax handles a table (TOPN) and a measure (ROW)', () => {
    expect(buildDax('Sales', 10)).toBe("EVALUATE TOPN(10, 'Sales')");
    expect(buildDax('', 10, 'Total Revenue')).toBe('EVALUATE ROW("Total Revenue", [Total Revenue])');
    expect(() => buildDax("Sales'; evil", 10)).toThrow(BindingQueryError);
  });

  it('clampTop bounds to [1,1000]', () => {
    expect(clampTop(0)).toBe(100);
    expect(clampTop(-5)).toBe(1);
    expect(clampTop(999999)).toBe(1000);
    expect(clampTop(42)).toBe(42);
  });
});

describe('mapRowsToInstances — the substrate join', () => {
  it('resolves a full result set to typed instances of one object type', () => {
    const b = binding({ columnMap: { id: 'customerId', nm: 'name', rev: 'revenue', act: 'active' }, keyColumn: 'id' });
    const insts = mapRowsToInstances(b, CUSTOMER, {
      columns: ['id', 'nm', 'rev', 'act'],
      rows: [['C1', 'Acme', '10', 'true'], ['C2', 'Globex', '20', 'false']],
    });
    expect(insts).toHaveLength(2);
    expect(insts[0]).toMatchObject({ id: 'C1', objectType: 'Customer', properties: { revenue: 10, active: true } });
    expect(insts[1].properties).toMatchObject({ customerId: 'C2', revenue: 20, active: false });
  });
});
