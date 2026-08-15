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
 *   - the population floor — no measurable rule NEVER yields a number;
 *   - the READ half: `readCertificationDq` answers from the persisted record
 *     with ZERO I/O, so the GET paths never execute a rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import {
  measureCertificationDq, readCertificationDq, toDqMeasurement, resolveDqTarget,
  isDqMeasurementStale, DQ_GATE, DQ_ADX_GATE_ID, DQ_MEASUREMENT_KEY,
  DQ_MEASUREMENT_STALE_MS, DQ_MAX_PERSISTED_BREAKDOWN,
} from '../certification-dq';

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

// The suite mutates LOOM_KUSTO_CLUSTER_URI (one case DELETES it to exercise the
// ADX gate). vitest shares a process across files in a worker, so leaving it
// deleted silently re-gates unrelated specs — restore whatever was there.
const SAVED_ADX_URI = process.env.LOOM_KUSTO_CLUSTER_URI;

beforeEach(() => {
  executeQuery.mockReset();
  tenantRead.mockReset();
  process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
});

afterEach(() => {
  if (SAVED_ADX_URI === undefined) delete process.env.LOOM_KUSTO_CLUSTER_URI;
  else process.env.LOOM_KUSTO_CLUSTER_URI = SAVED_ADX_URI;
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
    // Registry-resolvable, so the UI renders a real Fix-it and not a dead sentence.
    expect(dq.dqGateId).toBe(DQ_ADX_GATE_ID);
    expect(dq.dqMissing).toEqual(['LOOM_KUSTO_CLUSTER_URI']);
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

describe('resolveDqTarget — ONE derivation, shared with /observability + /health-actions', () => {
  it('trims the bound database and the table names', () => {
    expect(resolveDqTarget({ state: { databaseName: '  salesdb  ', datasets: [{ name: '  sales  ' }] } }))
      .toEqual({ database: 'salesdb', tableNames: ['sales'] });
  });

  it('a whitespace-only database falls back instead of reaching KQL', () => {
    // The sibling routes each carried `(state.databaseName as string) || default`,
    // which passes '   ' straight through as a database name.
    expect(resolveDqTarget({ state: { databaseName: '   ' } }).database).toBe('loomdb-default');
  });

  it('drops unnamed datasets rather than emitting empty table names', () => {
    expect(resolveDqTarget({ state: { datasets: [{ name: 'a' }, {}, { name: '' }] } }).tableNames).toEqual(['a']);
  });

  it('no state at all resolves to the default database and no tables', () => {
    expect(resolveDqTarget(null)).toEqual({ database: 'loomdb-default', tableNames: [] });
  });
});

/**
 * The READ half of #3493. Executing the rules is N live ADX queries; the GET
 * paths must answer from the record the owner-gated writes persisted, with no
 * I/O at all — so these assert the leaves were never touched.
 */
describe('readCertificationDq — the GET path answer, with zero I/O', () => {
  const MEASUREMENT = {
    score: 50, meanPercentage: 72.5, gate: null, gateId: null, missing: [],
    ruleCount: 4, passingRules: 2, breakdown: [], measuredAt: '2026-08-14T00:00:00.000Z',
  };

  it('returns the persisted score without executing a rule or reading the store', () => {
    const dq = readCertificationDq({ state: { [DQ_MEASUREMENT_KEY]: MEASUREMENT } });

    expect(dq.dqScore).toBe(50);
    expect(dq.dqGate).toBeNull();
    expect(dq.measuredAt).toBe(MEASUREMENT.measuredAt);
    expect(dq.dqResult!.passingRules).toBe(2);
    // The measured MEAN is preserved distinctly from the ratio certification uses.
    expect(dq.dqResult!.score).toBe(72.5);
    expect(executeQuery).not.toHaveBeenCalled();
    expect(tenantRead).not.toHaveBeenCalled();
  });

  it('a never-measured product gates with the exact action that measures it', () => {
    const dq = readCertificationDq({ state: {} });

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGate).toBe(DQ_GATE.notMeasured);
    expect(dq.measuredAt).toBeNull();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('a persisted GATE is replayed with its reason and registry id', () => {
    const dq = readCertificationDq({
      state: {
        [DQ_MEASUREMENT_KEY]: {
          ...MEASUREMENT, score: null, meanPercentage: null,
          gate: `${DQ_GATE.adx} (missing LOOM_KUSTO_CLUSTER_URI)`,
          gateId: DQ_ADX_GATE_ID, missing: ['LOOM_KUSTO_CLUSTER_URI'],
        },
      },
    });

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGateId).toBe(DQ_ADX_GATE_ID);
    expect(dq.dqMissing).toEqual(['LOOM_KUSTO_CLUSTER_URI']);
  });

  it('a record with no score AND no reason reads as unmeasured, never as a pass', () => {
    // A record written by an older build. Fabricating a pass here would be the
    // original defect; so would asserting a cause we never established (R7).
    const dq = readCertificationDq({ state: { [DQ_MEASUREMENT_KEY]: { measuredAt: MEASUREMENT.measuredAt } } });

    expect(dq.dqScore).toBeNull();
    expect(dq.dqGate).toBe(DQ_GATE.notMeasured);
  });

  it('flags a measurement older than the freshness window as stale (never silently "now")', () => {
    const old = new Date(Date.now() - DQ_MEASUREMENT_STALE_MS - 1000).toISOString();
    const dq = readCertificationDq({ state: { [DQ_MEASUREMENT_KEY]: { ...MEASUREMENT, measuredAt: old } } });

    expect(dq.stale).toBe(true);
    expect(dq.dqScore).toBe(50); // still shown — flagged, not withheld
    expect(isDqMeasurementStale(MEASUREMENT.measuredAt, Date.parse(MEASUREMENT.measuredAt) + 1000)).toBe(false);
  });
});

describe('toDqMeasurement — what the write persists', () => {
  it('round-trips a measured score through the record', async () => {
    stubRules(TWO_RULES);
    executeQuery.mockResolvedValueOnce(oneRow({ pct: 99 })).mockResolvedValueOnce(oneRow({ pct: 100 }));

    const measured = await measureCertificationDq('tenant-1', PRODUCT);
    const back = readCertificationDq({ state: { [DQ_MEASUREMENT_KEY]: toDqMeasurement(measured, 'oid-1') } });

    expect(back.dqScore).toBe(measured.dqScore);
    expect(back.dqResult!.ruleCount).toBe(2);
    expect(back.dqResult!.passingRules).toBe(2);
  });

  it('caps the persisted breakdown but never the counts', async () => {
    const many = Array.from({ length: DQ_MAX_PERSISTED_BREAKDOWN + 25 }, (_, i) => ({
      id: `r${i}`, name: `rule ${i}`, scope: `column:sales.c${i}`, check: 'not-null', threshold: 90, enabled: true,
    }));
    stubRules(many);
    executeQuery.mockResolvedValue(oneRow({ pct: 100 }));

    const rec = toDqMeasurement(await measureCertificationDq('tenant-1', PRODUCT));

    expect(rec.ruleCount).toBe(many.length);
    expect(rec.passingRules).toBe(many.length);
    expect(rec.breakdown).toHaveLength(DQ_MAX_PERSISTED_BREAKDOWN);
    expect(rec.breakdownTruncated).toBe(true);
  });

  it('persists a GATED outcome with its reason — "no score" is never indistinguishable from "never ran"', async () => {
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    stubRules(TWO_RULES);

    const rec = toDqMeasurement(await measureCertificationDq('tenant-1', PRODUCT), 'oid-1');

    expect(rec.score).toBeNull();
    expect(rec.gateId).toBe(DQ_ADX_GATE_ID);
    expect(rec.gate).toMatch(/LOOM_KUSTO_CLUSTER_URI/);
    expect(rec.measuredAt).toBeTruthy();
    expect(rec.measuredBy).toBe('oid-1');
  });
});

describe('the measurement is bounded — the write path cannot serialise N × 30 s', () => {
  it('issues the rules in scope order and keeps the breakdown index-ordered', async () => {
    const rules = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`, name: `rule ${i}`, scope: `column:sales.c${i}`, check: 'not-null', threshold: 50, enabled: true,
    }));
    stubRules(rules);
    // Resolve out of order: later rules settle FIRST. A breakdown built by
    // push() would come back scrambled once the lanes overlap.
    executeQuery.mockImplementation(async (_db: string, kql: string) => {
      const idx = Number(/c(\d+)/.exec(kql)![1]);
      await new Promise((r) => setTimeout(r, (rules.length - idx) * 2));
      return oneRow({ pct: idx * 5 });
    });

    const dq = await measureCertificationDq('tenant-1', PRODUCT);

    expect(dq.dqResult!.breakdown.map((b) => b.ruleId)).toEqual(rules.map((r) => r.id));
    expect(dq.dqResult!.breakdown.map((b) => b.percentage)).toEqual(rules.map((_, i) => i * 5));
    expect(executeQuery).toHaveBeenCalledTimes(rules.length);
  });

  it('runs more than one rule at a time (a serial run would deadlock this gate)', async () => {
    const rules = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`, name: `rule ${i}`, scope: `column:sales.c${i}`, check: 'not-null', threshold: 50, enabled: true,
    }));
    stubRules(rules);
    let inFlight = 0;
    let peak = 0;
    executeQuery.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return oneRow({ pct: 100 });
    });

    await measureCertificationDq('tenant-1', PRODUCT);

    expect(peak).toBeGreaterThan(1);
  });
});
