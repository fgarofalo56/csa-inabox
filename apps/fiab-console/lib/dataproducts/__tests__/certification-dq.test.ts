/**
 * Unit spec for the certification DQ input (#3493).
 *
 * The defect this pins: the three certification routes each scored
 * `enabled ÷ total` over the tenant's DQ-rule document without ever executing a
 * rule, so a product whose every rule was failing scored 100 and certified.
 *
 * These tests drive the REAL scorer (`data-quality-client.computeDqScore`) —
 * only the leaf boundaries (Kusto `executeQuery`, the Cosmos rule store) are
 * mocked — so a regression in the scoring path moves the verdict here.
 *
 * Pinned behaviour:
 *   - enabled-but-FAILING rules score 0, not 100;
 *   - a mean per-rule percentage above the bar with ZERO rules passing still
 *     scores 0 (certification consumes the passing-rule RATIO, never the mean);
 *   - the population floor — no measurable rule NEVER yields a number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeQuery = vi.fn();
const tenantRead = vi.fn();

vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: (...a: any[]) => executeQuery(...a),
  getTableCslSchema: vi.fn(),
  kustoConfigGate: () => (process.env.LOOM_KUSTO_CLUSTER_URI ? null : { missing: 'LOOM_KUSTO_CLUSTER_URI' }),
  defaultDatabase: () => 'loomdb-default',
  qName: (n: string) => `["${n}"]`,
  KustoError: class KustoError extends Error {},
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: async () => ({ item: () => ({ read: tenantRead }) }),
}));

import { measureCertificationDq, DQ_GATE } from '../certification-dq';

/** Single-row KQL result in the shape `firstNumber` reads. */
function oneRow(map: Record<string, unknown>) {
  const columns = Object.keys(map);
  return {
    columns,
    columnTypes: columns.map(() => 'real'),
    rows: [columns.map((c) => map[c])],
    rowCount: 1,
    executionMs: 1,
    truncated: false,
  };
}

/** A data product bound to the `sales` ADX table. */
const PRODUCT = { state: { datasets: [{ name: 'sales' }], databaseName: 'salesdb' } };

/** Two ENABLED rules scoped to the product's table. */
const TWO_RULES = [
  { id: 'r1', name: 'amount not null', scope: 'column:sales.amount', check: 'not-null', threshold: 95, enabled: true },
  { id: 'r2', name: 'id unique', scope: 'column:sales.id', check: 'unique', threshold: 99, enabled: true },
];

function stubRules(items: unknown[]) {
  tenantRead.mockResolvedValue({ resource: { items } });
}

beforeEach(() => {
  executeQuery.mockReset();
  tenantRead.mockReset();
  process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
});

describe('measureCertificationDq — the score reflects PASSING rules', () => {
  it('scores 0 when every enabled rule is measured as FAILING (was 100)', async () => {
    stubRules(TWO_RULES);
    // r1 measured 10% against a 95% threshold; r2 20% against 99% — both fail.
    executeQuery.mockResolvedValueOnce(oneRow({ pct: 10 })).mockResolvedValueOnce(oneRow({ pct: 20 }));

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBe(0);
    expect(dq.dqGate).toBeNull();
    expect(dq.dqResult!.ruleCount).toBe(2);
    expect(dq.dqResult!.passingRules).toBe(0);
    // The rules WERE executed — the old code never issued a query.
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });

  it('scores 100 only when every rule clears its own threshold', async () => {
    stubRules(TWO_RULES);
    executeQuery.mockResolvedValueOnce(oneRow({ pct: 99 })).mockResolvedValueOnce(oneRow({ pct: 100 }));

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBe(100);
    expect(dq.dqResult!.passingRules).toBe(2);
  });

  it('scores the passing RATIO, not the mean percentage', async () => {
    stubRules(TWO_RULES);
    // Mean = 80 (above the 70 certification bar) but NEITHER rule meets its own
    // threshold (95 / 99). Scoring the mean would certify a product with zero
    // passing rules — the same defect in a different coat.
    executeQuery.mockResolvedValueOnce(oneRow({ pct: 80 })).mockResolvedValueOnce(oneRow({ pct: 80 }));

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqResult!.score).toBe(80); // the measured mean
    expect(dq.dqScore).toBe(0); // what certification consumes
  });

  it('a rule that errors counts as NOT passing and drags the ratio down', async () => {
    stubRules(TWO_RULES);
    executeQuery.mockResolvedValueOnce(oneRow({ pct: 100 })).mockRejectedValueOnce(new Error('table not found'));

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBe(50); // 1 of 2 rules passing
    expect(dq.dqResult!.breakdown[1].detail).toMatch(/error: table not found/);
  });

  it('excludes disabled rules from the population', async () => {
    stubRules([...TWO_RULES, { id: 'r3', name: 'off', scope: 'column:sales.x', check: 'not-null', threshold: 50, enabled: false }]);
    executeQuery.mockResolvedValueOnce(oneRow({ pct: 99 })).mockResolvedValueOnce(oneRow({ pct: 100 }));

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqResult!.ruleCount).toBe(2);
    expect(dq.dqScore).toBe(100);
  });
});

describe('measureCertificationDq — population floor (no measurement is NEVER a pass)', () => {
  it('zero rules → null + the no-rules gate, never 100', async () => {
    stubRules([]);

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGate).toBe(DQ_GATE.noRules);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('no rule doc at all (404) → null + the no-rules gate', async () => {
    tenantRead.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGate).toBe(DQ_GATE.noRules);
  });

  it('rules exist but none apply to this product → null + the no-rules gate', async () => {
    stubRules([{ id: 'r9', name: 'other', scope: 'column:other_table.col', check: 'not-null', threshold: 90, enabled: true }]);

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGate).toBe(DQ_GATE.noRules);
  });

  it('rules ran but none produced a measurement → null, and the gate says so (not "no rules")', async () => {
    // A column-scoped check with a table-only scope can never be measured.
    stubRules([{ id: 'r1', name: 'bad scope', scope: 'table:sales', check: 'not-null', threshold: 90, enabled: true }]);

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGate).toBe(DQ_GATE.unscoreable);
    expect(dq.dqResult!.ruleCount).toBe(1);
  });

  it('ADX not provisioned → null + the ADX gate, never a silent pass', async () => {
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    stubRules(TWO_RULES);

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGate).toMatch(/LOOM_KUSTO_CLUSTER_URI/);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('a rule-store failure reports the real cause, never "no rules" (R7)', async () => {
    tenantRead.mockRejectedValue(Object.assign(new Error('Cosmos 503'), { code: 503 }));

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGate).toMatch(/Cosmos 503/);
    expect(dq.dqGate).not.toBe(DQ_GATE.noRules);
  });
});

describe('measureCertificationDq — target resolution', () => {
  it('runs against the product bound database + dataset tables', async () => {
    stubRules(TWO_RULES);
    executeQuery.mockResolvedValue(oneRow({ pct: 100 }));

    await measureCertificationDq('tenant-1', PRODUCT);

    expect(executeQuery.mock.calls[0][0]).toBe('salesdb');
  });

  it('falls back to the default ADX database when the product declares none', async () => {
    stubRules(TWO_RULES);
    executeQuery.mockResolvedValue(oneRow({ pct: 100 }));

    await measureCertificationDq('tenant-1', { state: { datasets: [{ name: 'sales' }] } });

    expect(executeQuery.mock.calls[0][0]).toBe('loomdb-default');
  });
});
