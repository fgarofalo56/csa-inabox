import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OntoObjectType } from '@/lib/editors/ontology-model';

vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTarget: vi.fn(() => ({ kind: 'serverless' })),
  dedicatedTarget: vi.fn(() => ({ kind: 'dedicated' })),
  executeQuery: vi.fn(),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: vi.fn(),
  defaultDatabase: vi.fn(() => 'loom'),
  kustoConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/tabular-eval-client', () => ({
  evalDax: vi.fn(),
  TabularError: class TabularError extends Error {
    backend: string;
    constructor(m: string, _s?: number, b = 'loom-native') { super(m); this.backend = b; }
  },
}));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({ getShortcut: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn() }));
vi.mock('@/lib/auth/workspace-access', () => ({ resolveWorkspaceAccessByOid: vi.fn() }));

import {
  resolveBindingInstances, resolveOntologyObjectInstances, resolveOntologyObjectForGrounding,
} from '../ontology-resolver';
import type { OntologyBinding } from '../ontology-binding';
import { executeQuery as synapseExecute } from '@/lib/azure/synapse-sql-client';
import { executeQuery as kustoExecute, kustoConfigGate } from '@/lib/azure/kusto-client';
import { evalDax } from '@/lib/azure/tabular-eval-client';
import { getShortcut } from '@/lib/azure/lakehouse-shortcuts';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';

const CUSTOMER: OntoObjectType = {
  apiName: 'Customer',
  primaryKey: 'customerId',
  properties: [
    { apiName: 'customerId', baseType: 'string' },
    { apiName: 'revenue', baseType: 'double' },
  ],
};

const IDENTITY_MAP = { customerId: 'customerId', revenue: 'revenue' };

function b(kind: OntologyBinding['source']['kind'], over: Partial<OntologyBinding> = {}): OntologyBinding {
  return {
    ontologyId: 'onto-1', objectType: 'Customer',
    columnMap: IDENTITY_MAP, keyColumn: 'customerId',
    source: { kind, ref: 'Customer' },
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  (kustoConfigGate as any).mockReturnValue(null);
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool1';
});

describe('resolveBindingInstances — per source-kind dispatch to real backends', () => {
  it('lakehouse-table → Synapse Serverless', async () => {
    (synapseExecute as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [['C1', '10'], ['C2', '20']] });
    const out = await resolveBindingInstances(b('lakehouse-table', { source: { kind: 'lakehouse-table', ref: 'dbo.Customer' } }), CUSTOMER, { top: 100 });
    expect(out.gated).toBe(false);
    if (!out.gated) {
      expect(out.executedQuery).toBe('SELECT TOP 100 * FROM dbo.Customer');
      expect(out.instances).toHaveLength(2);
      expect(out.instances[0]).toMatchObject({ id: 'C1', objectType: 'Customer', properties: { revenue: 10 }, sourceKind: 'lakehouse-table' });
    }
  });

  it('warehouse-table → Synapse Dedicated', async () => {
    (synapseExecute as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [['C3', '30']] });
    const out = await resolveBindingInstances(b('warehouse-table', { source: { kind: 'warehouse-table', ref: 'dbo.Cust' } }), CUSTOMER);
    expect(out.gated).toBe(false);
    if (!out.gated) expect(out.instances[0].properties.revenue).toBe(30);
  });

  it('kql → Azure Data Explorer', async () => {
    (kustoExecute as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [['C4', 40]] });
    const out = await resolveBindingInstances(b('kql', { source: { kind: 'kql', ref: 'Customers', database: 'sales' } }), CUSTOMER);
    expect(out.gated).toBe(false);
    if (!out.gated) {
      expect(out.executedQuery).toBe('Customers | take 100');
      expect(out.instances[0]).toMatchObject({ id: 'C4', sourceKind: 'kql' });
    }
  });

  it('semantic-measure → Azure-native DAX (owner-scoped)', async () => {
    (evalDax as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [{ customerId: 'C5', revenue: 50 }], backend: 'loom-native' });
    const out = await resolveBindingInstances(
      b('semantic-measure', { source: { kind: 'semantic-measure', ref: 'CustomerTable', sourceItemId: 'model-1' } }),
      CUSTOMER, { tenantId: 'oid-1' },
    );
    expect(out.gated).toBe(false);
    if (!out.gated) {
      expect(out.executedQuery).toBe("EVALUATE TOPN(100, 'CustomerTable')");
      expect(out.instances[0]).toMatchObject({ id: 'C5', properties: { revenue: 50 }, sourceKind: 'semantic-measure' });
    }
  });

  it('shortcut → resolves engineObject from the registry (Synapse engine)', async () => {
    (getShortcut as any).mockResolvedValue({ name: 'partner', engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.partner', status: 'active' });
    (synapseExecute as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [['C6', 60]] });
    const out = await resolveBindingInstances(
      b('shortcut', { source: { kind: 'shortcut', ref: '', lakehouseId: 'lh-1', shortcutId: 'sc-1' } }),
      CUSTOMER,
    );
    expect(out.gated).toBe(false);
    if (!out.gated) expect(out.executedQuery).toBe('SELECT TOP 100 * FROM loom_lakehouse.shortcuts.partner');
  });
});

describe('resolveBindingInstances — honest gates (no vaporware)', () => {
  it('gates lakehouse when Synapse Serverless is unconfigured', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const out = await resolveBindingInstances(b('lakehouse-table'), CUSTOMER);
    expect(out.gated).toBe(true);
    if (out.gated) expect(out.code).toBe('serverless_not_configured');
  });

  it('gates kql when ADX is unconfigured', async () => {
    (kustoConfigGate as any).mockReturnValue({ missing: 'LOOM_ADX_CLUSTER_URI' });
    const out = await resolveBindingInstances(b('kql'), CUSTOMER);
    expect(out.gated).toBe(true);
    if (out.gated) expect(out.hint).toContain('LOOM_ADX_CLUSTER_URI');
  });

  it('gates semantic-measure without owner context', async () => {
    const out = await resolveBindingInstances(b('semantic-measure'), CUSTOMER, {});
    expect(out.gated).toBe(true);
    if (out.gated) expect(out.code).toBe('no_owner_context');
  });

  it('honest-gates azure-sql this slice (named)', async () => {
    const out = await resolveBindingInstances(b('azure-sql'), CUSTOMER);
    expect(out.gated).toBe(true);
    if (out.gated) expect(out.code).toBe('azure_sql_unwired');
  });
});

describe('resolveOntologyObjectInstances — THREE sources → ONE object type (acceptance)', () => {
  it('a lakehouse table, a KQL stream, and a semantic measure all resolve as Customer instances', async () => {
    (synapseExecute as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [['LH1', 1]] });
    (kustoExecute as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [['KQL1', 2]] });
    (evalDax as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [{ customerId: 'SEM1', revenue: 3 }], backend: 'loom-native' });

    const bindings = [
      { itemId: 'lh', itemName: 'Lake', binding: b('lakehouse-table', { source: { kind: 'lakehouse-table', ref: 'dbo.Customer' } }) },
      { itemId: 'kq', itemName: 'Stream', binding: b('kql', { source: { kind: 'kql', ref: 'Customers' } }) },
      { itemId: 'sm', itemName: 'Model', binding: b('semantic-measure', { source: { kind: 'semantic-measure', ref: 'CustomerTable', sourceItemId: 'model-1' } }) },
    ];
    const { sources, instances } = await resolveOntologyObjectInstances(bindings, 'Customer', CUSTOMER, { tenantId: 'oid-1' });

    expect(sources).toHaveLength(3);
    expect(sources.every((s) => s.resolved)).toBe(true);
    // One merged instance from EACH backend, all typed as Customer.
    expect(instances.map((i) => i.id).sort()).toEqual(['KQL1', 'LH1', 'SEM1']);
    expect(new Set(instances.map((i) => i.objectType))).toEqual(new Set(['Customer']));
    expect(new Set(instances.map((i) => i.sourceKind))).toEqual(new Set(['lakehouse-table', 'kql', 'semantic-measure']));
  });

  it('skips bindings for a different object type', async () => {
    const bindings = [{ itemId: 'x', binding: b('lakehouse-table', { objectType: 'Order' }) }];
    const { sources, instances } = await resolveOntologyObjectInstances(bindings, 'Customer', CUSTOMER, {});
    expect(sources).toHaveLength(0);
    expect(instances).toHaveLength(0);
  });
});

describe('resolveOntologyObjectForGrounding — copilot grounds through the ontology graph', () => {
  function mockOntologyItem() {
    const onto = {
      id: 'onto-1', itemType: 'ontology', workspaceId: 'ws-1', displayName: 'Sales',
      state: { objectTypes: [CUSTOMER] },
    };
    const boundItem = {
      id: 'lh', workspaceId: 'ws-1', displayName: 'Lake',
      state: { ontologyBinding: { ontologyId: 'onto-1', objectType: 'Customer', columnMap: IDENTITY_MAP, keyColumn: 'customerId', source: { kind: 'lakehouse-table', ref: 'dbo.Customer' } } },
    };
    (itemsContainer as any).mockResolvedValue({
      items: {
        query: (spec: any) => ({
          fetchAll: async () => {
            const q = String(spec.query || '');
            if (q.includes('c.id = @id')) return { resources: [onto] };
            if (q.includes('ontologyBinding')) return { resources: [boundItem] };
            return { resources: [] };
          },
        }),
      },
    });
  }

  it('resolves the object type to its bound sources and returns typed instance rows', async () => {
    mockOntologyItem();
    (resolveWorkspaceAccessByOid as any).mockResolvedValue({ canWrite: true });
    (synapseExecute as any).mockResolvedValue({ columns: ['customerId', 'revenue'], rows: [['C1', 100], ['C2', 200]] });

    const out = await resolveOntologyObjectForGrounding('onto-1', 'Customer', 'oid-1', 25);
    expect('gate' in out).toBe(false);
    if (!('gate' in out)) {
      expect(out.columns).toEqual(['id', 'customerId', 'revenue']);
      expect(out.rowCount).toBe(2);
      expect(out.rows[0]).toEqual(['C1', 'C1', 100]);
      expect(out.sources.some((s) => s.resolved)).toBe(true);
    }
  });

  it('gates when the caller cannot access the ontology workspace', async () => {
    mockOntologyItem();
    (resolveWorkspaceAccessByOid as any).mockResolvedValue(null);
    const out = await resolveOntologyObjectForGrounding('onto-1', 'Customer', 'intruder', 25);
    expect('gate' in out).toBe(true);
  });

  it('gates when the object type is undeclared', async () => {
    mockOntologyItem();
    (resolveWorkspaceAccessByOid as any).mockResolvedValue({ canWrite: true });
    const out = await resolveOntologyObjectForGrounding('onto-1', 'Ghost', 'oid-1', 25);
    expect('gate' in out).toBe(true);
    if ('gate' in out) expect(out.gate).toContain('not a declared object type');
  });
});
