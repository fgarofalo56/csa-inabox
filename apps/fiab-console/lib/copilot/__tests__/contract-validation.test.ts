/**
 * B-N14c — copilot proposal ↔ N6 data-contract validation tests. Pure.
 */
import { describe, it, expect } from 'vitest';
import {
  bareIdentifier,
  contractDatasetNames,
  contractGoverns,
  extractDataflowTargets,
  extractPipelineTargets,
  extractSqlTargets,
  validateProposal,
} from '@/lib/copilot/contract-validation';
import type { DataContractDoc } from '@/lib/azure/data-contract-model';

/** A REAL-shaped contract doc: Orders(order_id required, email PII, amount). */
function ordersContract(overrides: Partial<DataContractDoc> = {}): DataContractDoc {
  return {
    id: 'contract:orders',
    docType: 'data-contract',
    tenantId: 't1',
    itemId: 'orders',
    displayName: 'Orders contract',
    schemaVersion: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    createdBy: 'op@contoso.com',
    updatedAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'op@contoso.com',
    enforcement: { enabled: true, mode: 'warn-quarantine' },
    bindings: [{ id: 'b1', kind: 'data-pipeline', targetItemId: 'p1', dataset: 'Orders', boundAt: '2026-07-01T00:00:00.000Z', boundBy: 'op@contoso.com' }],
    runs: [],
    odcs: {
      apiVersion: 'v3.1.0',
      kind: 'DataContract',
      id: 'orders',
      version: '1.0.0',
      status: 'active',
      name: 'Orders',
      schema: [
        {
          name: 'Orders',
          logicalType: 'object',
          properties: [
            { name: 'order_id', logicalType: 'string', required: true },
            { name: 'email', logicalType: 'string', classification: 'PII' },
            { name: 'amount', logicalType: 'number' },
          ],
        },
      ],
    },
    ...overrides,
  } as DataContractDoc;
}

describe('identifier + target extraction', () => {
  it('normalizes bracketed / schema-qualified identifiers', () => {
    expect(bareIdentifier('[dbo].[Orders]')).toBe('Orders');
    expect(bareIdentifier('"sales"."orders";')).toBe('orders');
    expect(bareIdentifier('  Orders ')).toBe('Orders');
  });

  it('reads an INSERT column list as a WRITE target', () => {
    const t = extractSqlTargets('INSERT INTO dbo.Orders (order_id, amount) SELECT a, b FROM staging');
    const write = t.find((x) => x.access === 'write')!;
    expect(write.dataset).toBe('Orders');
    expect(write.columns).toEqual(['order_id', 'amount']);
    expect(write.columnsUnknown).toBeUndefined();
  });

  it('marks an unlisted INSERT / MERGE as columnsUnknown instead of guessing', () => {
    expect(extractSqlTargets('INSERT INTO Orders SELECT * FROM stg').find((x) => x.access === 'write')!.columnsUnknown).toBe(true);
    expect(extractSqlTargets('MERGE INTO Orders USING stg ON 1=1').find((x) => x.access === 'write')!.columnsUnknown).toBe(true);
  });

  it('reads CREATE TABLE columns and UPDATE SET columns', () => {
    expect(extractSqlTargets('CREATE TABLE Orders (order_id varchar(10), email varchar(200));')
      .find((x) => x.access === 'write')!.columns).toEqual(['order_id', 'email']);
    expect(extractSqlTargets('UPDATE Orders SET email = @e, amount = 1 WHERE order_id = 2')
      .find((x) => x.access === 'write')!.columns).toEqual(['email', 'amount']);
  });

  it('reads SELECT columns as a READ target and flags SELECT *', () => {
    const named = extractSqlTargets('SELECT order_id, email FROM Orders').find((x) => x.access === 'read')!;
    expect(named.columns).toEqual(['order_id', 'email']);
    expect(extractSqlTargets('SELECT * FROM Orders').find((x) => x.access === 'read')!.columnsUnknown).toBe(true);
  });

  it('is not fooled by identifiers inside comments or string literals', () => {
    const t = extractSqlTargets("-- INSERT INTO Secrets (k)\nSELECT 'INSERT INTO Secrets (k)' AS note, order_id FROM Orders");
    expect(t.some((x) => x.dataset.toLowerCase() === 'secrets')).toBe(false);
  });

  it('reads a pipeline Copy sink with its translator mappings, plus embedded SQL', () => {
    const targets = extractPipelineTargets({
      properties: {
        activities: [
          {
            name: 'Copy', type: 'Copy',
            typeProperties: {
              source: { sqlReaderQuery: 'SELECT email FROM Customers' },
              sink: { tableName: 'dbo.Orders' },
              translator: { mappings: [{ sink: { name: 'order_id' } }, { sink: { name: 'amount' } }] },
            },
          },
        ],
      },
    });
    const sink = targets.find((t) => t.access === 'write' && t.dataset === 'Orders')!;
    expect(sink.columns).toEqual(['order_id', 'amount']);
    expect(targets.some((t) => t.dataset === 'Customers' && t.access === 'read')).toBe(true);
  });

  it('returns nothing for a malformed pipeline spec instead of throwing', () => {
    expect(extractPipelineTargets(null)).toEqual([]);
    expect(extractPipelineTargets({ properties: {} })).toEqual([]);
  });

  it('reads a Power Query navigation table + selected columns', () => {
    const t = extractDataflowTargets('let Source = Sql.Database("h","d"), Nav = Source{[Item="Orders"]}[Data], Sel = Table.SelectColumns(Nav, {"order_id", "email"}) in Sel');
    expect(t[0].dataset).toBe('Orders');
    expect(t[0].columns).toEqual(['order_id', 'email']);
  });

  it('delegates an embedded M Query= string to the SQL extractor', () => {
    const t = extractDataflowTargets('let S = Sql.Database("h","d",[Query="INSERT INTO Orders (order_id) VALUES (1)"]) in S');
    expect(t.some((x) => x.dataset === 'Orders' && x.access === 'write')).toBe(true);
  });
});

describe('contract matching', () => {
  it('collects dataset names from both bindings and the ODCS schema', () => {
    expect(contractDatasetNames(ordersContract())).toEqual(expect.arrayContaining(['orders']));
  });

  it('matches case-insensitively through schema qualification', () => {
    expect(contractGoverns(ordersContract(), { dataset: 'dbo.ORDERS', access: 'write', columns: [] })).toBe(true);
    expect(contractGoverns(ordersContract(), { dataset: 'Customers', access: 'write', columns: [] })).toBe(false);
  });
});

describe('validateProposal', () => {
  it('flags a contracted column the proposal omits as an ERROR', () => {
    const r = validateProposal(
      { kind: 'sql', text: 'INSERT INTO Orders (order_id, amount) VALUES (1, 2)' },
      [ordersContract()],
    );
    expect(r.ok).toBe(false);
    const missing = r.violations.find((v) => v.rule === 'missingColumn')!;
    expect(missing.column).toBe('email');
    expect(missing.severity).toBe('error');
    // warn-quarantine (the default) must NEVER block.
    expect(r.blocked).toBe(false);
    expect(r.note).toMatch(/warn-quarantine/);
  });

  it('BLOCKS the same proposal under a hard-reject contract', () => {
    const doc = ordersContract({ enforcement: { enabled: true, mode: 'hard-reject' } });
    const r = validateProposal({ kind: 'sql', text: 'INSERT INTO Orders (order_id, amount) VALUES (1,2)' }, [doc]);
    expect(r.blocked).toBe(true);
    expect(r.note).toMatch(/BLOCKED/);
  });

  it('flags an undeclared written column as a drift WARNING, not an error', () => {
    const r = validateProposal(
      { kind: 'sql', text: 'INSERT INTO Orders (order_id, email, amount, nickname) VALUES (1,2,3,4)' },
      [ordersContract()],
    );
    expect(r.ok).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.violations.find((v) => v.column === 'nickname')!.severity).toBe('warning');
  });

  it('passes a conforming write with zero violations', () => {
    const r = validateProposal(
      { kind: 'sql', text: 'INSERT INTO Orders (order_id, email, amount) VALUES (1,2,3)' },
      [ordersContract()],
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.contractsChecked.map((c) => c.id)).toEqual(['orders']);
    expect(r.note).toMatch(/Conforms/);
  });

  it('surfaces a classified column a READ would expose', () => {
    const r = validateProposal({ kind: 'sql', text: 'SELECT order_id, email FROM Orders' }, [ordersContract()]);
    const v = r.violations.find((x) => x.rule === 'classifiedColumnExposed')!;
    expect(v.column).toBe('email');
    expect(v.detail).toContain('PII');
    expect(r.ok).toBe(true);
  });

  it('warns that SELECT * MAY expose every classified column', () => {
    const r = validateProposal({ kind: 'sql', text: 'SELECT * FROM Orders' }, [ordersContract()]);
    expect(r.violations.some((v) => v.rule === 'classifiedColumnMayBeExposed' && v.column === 'email')).toBe(true);
  });

  it('reports an unknown write shape as INFO naming the required columns', () => {
    const r = validateProposal({ kind: 'sql', text: 'MERGE INTO Orders USING s ON 1=1' }, [ordersContract()]);
    const v = r.violations.find((x) => x.rule === 'writeShapeUnknown')!;
    expect(v.severity).toBe('info');
    expect(v.detail).toContain('order_id');
    expect(r.ok).toBe(true);
  });

  it('warns when the governing contract is deprecated', () => {
    const doc = ordersContract();
    doc.odcs.status = 'deprecated';
    const r = validateProposal({ kind: 'sql', text: 'SELECT order_id FROM Orders' }, [doc]);
    expect(r.violations.some((v) => v.rule === 'contractNotActive')).toBe(true);
  });

  it('ignores a DISABLED contract entirely', () => {
    const doc = ordersContract({ enforcement: { enabled: false, mode: 'hard-reject' } });
    const r = validateProposal({ kind: 'sql', text: 'INSERT INTO Orders (order_id) VALUES (1)' }, [doc]);
    expect(r.contractsChecked).toHaveLength(0);
    expect(r.violations).toHaveLength(0);
    expect(r.ungovernedDatasets).toContain('Orders');
  });

  it('reports ungoverned datasets without inventing a violation', () => {
    const r = validateProposal({ kind: 'sql', text: 'INSERT INTO Widgets (a) VALUES (1)' }, [ordersContract()]);
    expect(r.ok).toBe(true);
    expect(r.contractsChecked).toHaveLength(0);
    expect(r.ungovernedDatasets).toEqual(['Widgets']);
    expect(r.note).toMatch(/No data contract governs/);
  });

  it('grades a pipeline proposal through the same rules as SQL', () => {
    const r = validateProposal(
      {
        kind: 'pipeline',
        spec: {
          properties: {
            activities: [
              {
                name: 'Copy', type: 'Copy',
                typeProperties: {
                  sink: { tableName: 'Orders' },
                  translator: { mappings: [{ sink: { name: 'order_id' } }] },
                },
              },
            ],
          },
        },
      },
      [ordersContract()],
    );
    expect(r.kind).toBe('pipeline');
    expect(r.violations.filter((v) => v.severity === 'error').map((v) => v.column).sort()).toEqual(['amount', 'email']);
  });

  it('does nothing when there are no contracts at all', () => {
    const r = validateProposal({ kind: 'sql', text: 'SELECT * FROM Orders' }, []);
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });
});
