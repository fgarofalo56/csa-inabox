import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataContract } from '../contract';

// Mock the ADX validator + config gate + default database the gate depends on.
const runContractQuality = vi.fn();
const adxConfigGate = vi.fn();
vi.mock('@/lib/azure/data-quality-client', () => ({
  runContractQuality: (...a: any[]) => runContractQuality(...a),
  adxConfigGate: () => adxConfigGate(),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  defaultDatabase: () => 'loomdb',
}));

import {
  evaluateContractGate, contractHasBlockingExpectations, resolveContractTable, blockingExpectations,
} from '../contract-gate';

const errorContract: DataContract = {
  quality: [
    { id: 'e1', column: 'id', rule: 'not_null', severity: 'error' },
    { id: 'w1', column: 'name', rule: 'not_null', severity: 'warning' },
  ],
};

function runResult(over: Partial<any> = {}) {
  return {
    results: [], passed: 0, failed: 0, warnings: 0, errored: 0, evaluated: 0, score: 100, computedAt: 'now',
    ...over,
  };
}

describe('contract-gate — BR-CONTRACT-GATE', () => {
  beforeEach(() => { runContractQuality.mockReset(); adxConfigGate.mockReset(); adxConfigGate.mockReturnValue(null); });

  it('blockingExpectations keeps only error-severity', () => {
    expect(blockingExpectations(errorContract).map((e) => e.id)).toEqual(['e1']);
    expect(contractHasBlockingExpectations(errorContract)).toBe(true);
    expect(contractHasBlockingExpectations({ quality: [{ id: 'w', rule: 'not_null', severity: 'warning' }] })).toBe(false);
  });

  it('resolveContractTable prefers databaseTable then datasets[0], defaults the database', () => {
    expect(resolveContractTable({ databaseTable: 'T', databaseName: 'D' })).toEqual({ database: 'D', tableName: 'T' });
    expect(resolveContractTable({ datasets: [{ name: 'ds1' }] })).toEqual({ database: 'loomdb', tableName: 'ds1' });
    expect(resolveContractTable({})).toEqual({ database: 'loomdb', tableName: '' });
  });

  it('does not evaluate when there are no error-severity expectations', async () => {
    const out = await evaluateContractGate({ contract: { quality: [{ id: 'w', rule: 'not_null', severity: 'warning' }] }, tableName: 'T' });
    expect(out).toMatchObject({ blocked: false, evaluated: false, skippedReason: 'no_error_expectations' });
    expect(runContractQuality).not.toHaveBeenCalled();
  });

  it('does not block (or run) when no table is bound', async () => {
    const out = await evaluateContractGate({ contract: errorContract, tableName: '' });
    expect(out).toMatchObject({ blocked: false, evaluated: false, skippedReason: 'no_bound_table' });
    expect(runContractQuality).not.toHaveBeenCalled();
  });

  it('does not block when ADX is not configured (honest infra gap, not a violation)', async () => {
    adxConfigGate.mockReturnValue({ missing: 'LOOM_KUSTO_CLUSTER_URI' });
    const out = await evaluateContractGate({ contract: errorContract, tableName: 'T' });
    expect(out).toMatchObject({ blocked: false, evaluated: false, skippedReason: 'adx_not_configured' });
  });

  it('passes when the validator reports zero failures', async () => {
    runContractQuality.mockResolvedValue(runResult({ failed: 0, passed: 1 }));
    const out = await evaluateContractGate({ contract: errorContract, database: 'D', tableName: 'T' });
    expect(out).toMatchObject({ blocked: false, evaluated: true });
    expect(runContractQuality).toHaveBeenCalledWith('D', 'T', errorContract.quality);
  });

  it('BLOCKS with a message naming the failed error-severity expectation', async () => {
    runContractQuality.mockResolvedValue(runResult({
      failed: 1,
      results: [
        { expectationId: 'e1', column: 'id', rule: 'not_null', severity: 'error', percentage: 87.5, pass: false, detail: '12.5% null' },
        { expectationId: 'w1', column: 'name', rule: 'not_null', severity: 'warning', percentage: 90, pass: false, detail: 'warn' },
      ],
      score: 60,
    }));
    const out = await evaluateContractGate({ contract: errorContract, tableName: 'orders' });
    expect(out.blocked).toBe(true);
    expect(out.evaluated).toBe(true);
    expect(out.block?.reason).toBe('contract_validation_failed');
    expect(out.block?.message).toContain('not_null');
    expect(out.block?.message).toContain('id');
    // Only the error-severity failure counts as a blocker (warning excluded).
    expect(out.block?.failed).toHaveLength(1);
    expect(out.block?.failed[0]).toMatchObject({ rule: 'not_null', column: 'id' });
  });

  it('does not block when the validator throws (infra error, not a violation)', async () => {
    runContractQuality.mockRejectedValue(new Error('kusto 503'));
    const out = await evaluateContractGate({ contract: errorContract, tableName: 'T' });
    expect(out).toMatchObject({ blocked: false, evaluated: false, skippedReason: 'validator_error' });
  });
});
