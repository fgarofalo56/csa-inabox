import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OntoObjectType } from '@/lib/editors/ontology-model';
import { LIVE, parseAsOf, resolveTimeTravel } from '@/lib/time-machine/time-machine';

// ── Mocks for the #3959 sink control at the bottom of this file ─────────────
// Only Azure EGRESS is mocked. `isMintedEngineObject` — the predicate under
// test — is the REAL one, so a change to SYNAPSE_MINTED_SCHEMAS moves these
// cases rather than leaving a transcribed copy behind.
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTarget: vi.fn((db: string) => ({ db })),
  dedicatedTarget: vi.fn(() => ({ kind: 'dedicated' })),
  executeQuery: vi.fn(async () => ({ columns: [], rows: [] })),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  listWarehouses: vi.fn(async () => []),
  executeStatement: vi.fn(async () => ({})),
  databricksConfigGate: vi.fn(() => null),
  writeUcVolumesFile: vi.fn(async () => {}),
  deleteUcVolumesFile: vi.fn(async () => {}),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: vi.fn(),
  defaultDatabase: vi.fn(() => 'loom'),
  kustoConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/tabular-eval-client', () => ({
  evalDax: vi.fn(),
  TabularError: class TabularError extends Error {
    backend = 'loom-native';
  },
}));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({ getShortcut: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn() }));
vi.mock('@/lib/auth/workspace-access', () => ({ resolveWorkspaceAccessByOid: vi.fn() }));

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
import { resolveBindingInstances } from '../ontology-resolver';
import { executeQuery as synapseExecute } from '@/lib/azure/synapse-sql-client';
import { getShortcut } from '@/lib/azure/lakehouse-shortcuts';

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

/**
 * #3959 — THE SHORTCUT SINK IS NAME-SPACE-GUARDED, NOT SHAPE-GUARDED.
 *
 * `ontology-resolver`'s `case 'shortcut'` interpolates an engine-object name
 * into `SELECT TOP n * FROM …` and runs it on Synapse Serverless as the Console
 * UAMI — a Synapse SQL admin. It used to validate that name against `SQL_REF_RE`
 * only, which is a SHAPE check: `master.sys.sql_logins` and
 * `finance_db.dbo.payroll` are both well-formed references and both passed.
 * `binding.source.ref` is caller-authored (`ref` is not in
 * `SERVER_OWNED_STATE_KEYS`, and `createOwnedItem` passes `state` through
 * wholesale), so the reach was every object that principal can see.
 *
 * These cases drive the REAL resolver and the REAL `isMintedEngineObject`; only
 * `executeQuery` is mocked, so "no SQL was built" is a statement about the
 * production path. The `toHaveBeenCalledTimes(0)` assertions are the
 * load-bearing half — a guard that returned a gate AFTER querying would still
 * fail them.
 */
describe('#3959 — shortcut resolution refuses an engine object outside the minted name-space', () => {
  const ONE_COL = { columns: ['customerId'], rows: [['C1']] };

  function shortcutBinding(ref: string, over: Partial<OntologyBinding['source']> = {}): OntologyBinding {
    return {
      ontologyId: 'onto-1',
      objectType: 'Customer',
      columnMap: { customerId: 'customerId' },
      keyColumn: 'customerId',
      source: { kind: 'shortcut', ref, ...over },
    };
  }

  beforeEach(() => {
    vi.mocked(synapseExecute).mockReset();
    vi.mocked(getShortcut).mockReset();
    process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
    delete process.env.LOOM_SERVERLESS_DB;
  });

  it.each([
    ['master.sys.sql_logins', 'a system catalog view in another database'],
    ['finance_db.dbo.payroll', 'a well-formed reference to another database'],
    ['loom_lakehouse.dbo.someone_elses_view', 'the right DB, a schema Loom never mints into'],
    ['dbo.Customer', 'a 2-part ref outside the minted schemas'],
  ])('refuses %s (%s) and builds NO SQL', async (ref) => {
    const out = await resolveBindingInstances(shortcutBinding(ref), CUSTOMER, { top: 10 });
    expect(out.gated).toBe(true);
    if (out.gated) expect(out.code).toBe('shortcut_engine_object_namespace');
    expect(vi.mocked(synapseExecute)).toHaveBeenCalledTimes(0);
  });

  it('CONTROL — a name Loom actually mints still resolves and DOES query', async () => {
    vi.mocked(synapseExecute).mockResolvedValue(ONE_COL as any);
    const out = await resolveBindingInstances(
      shortcutBinding('loom_lakehouse.shortcuts.sales'), CUSTOMER, { top: 10 },
    );
    expect(out.gated).toBe(false);
    if (!out.gated) expect(out.executedQuery).toBe('SELECT TOP 10 * FROM loom_lakehouse.shortcuts.sales');
    expect(vi.mocked(synapseExecute)).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — the install provisioner mint `lakehouse.<leaf>` is accepted', async () => {
    vi.mocked(synapseExecute).mockResolvedValue(ONE_COL as any);
    const out = await resolveBindingInstances(shortcutBinding('lakehouse.sales'), CUSTOMER, { top: 5 });
    expect(out.gated).toBe(false);
    expect(vi.mocked(synapseExecute)).toHaveBeenCalledTimes(1);
  });

  it('a REGISTRY-supplied engineObject outside the name-space is refused too', async () => {
    // The registry path is not a trusted bypass: `sc.engineObject` is stored
    // state, so it gets the same predicate the literal `ref` gets.
    vi.mocked(getShortcut).mockResolvedValue({
      name: 'sc', status: 'ready', engine: 'synapse', engineObject: 'master.sys.sql_logins',
    } as any);
    const out = await resolveBindingInstances(
      shortcutBinding('', { lakehouseId: 'lh-1', shortcutId: 'sc-1' }), CUSTOMER, { top: 10 },
    );
    expect(out.gated).toBe(true);
    if (out.gated) expect(out.code).toBe('shortcut_engine_object_namespace');
    expect(vi.mocked(synapseExecute)).toHaveBeenCalledTimes(0);
  });

  it('the refusal message names the name-space and asserts nothing it did not establish', async () => {
    const out = await resolveBindingInstances(shortcutBinding('master.sys.sql_logins'), CUSTOMER);
    expect(out.gated).toBe(true);
    if (out.gated) {
      expect(out.hint).toContain('outside the name-space');
      // deploy-integrity R7 — it must NOT claim the caller wrote the value or
      // that Loom did not create the object; neither is knowable at this sink.
      expect(out.hint).not.toMatch(/you (typed|supplied)|does not exist/i);
    }
  });
});
