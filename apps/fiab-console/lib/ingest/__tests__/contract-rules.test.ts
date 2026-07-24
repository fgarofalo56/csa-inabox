/**
 * N6 — the enforcement DECISION MATRIX.
 *
 * The single most important assertion in this file is the DEFAULT: enforcement
 * is default-ON in `warn-quarantine` mode — a violating row is quarantined and
 * the conforming remainder of the batch STILL LANDS. `hard-reject` (block the
 * whole batch) only happens when the contract explicitly opts in. A regression
 * here would let a newly authored contract silently drop a production load.
 *
 * Pure module (node env) — no Cosmos, no ADLS, no Azure Monitor.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENFORCEMENT_MODE,
  conformsToLogicalType,
  deadLetterBody,
  deadLetterPath,
  evaluateBatch,
  evaluateRow,
  evaluateSchemaConformance,
  parseDuration,
  safeDatasetSegment,
  safePattern,
} from '../contract-rules';
import { toOdcs, type OdcsContract } from '@/lib/azure/data-contract-model';
import type { DataContract } from '@/lib/dataproducts/contract';

const LOOM: DataContract = {
  version: '1.0.0',
  schema: [
    { name: 'order_id', type: 'bigint', primaryKey: true },
    { name: 'email', type: 'string' },
    { name: 'amount', type: 'decimal' },
    { name: 'status', type: 'string' },
  ],
  quality: [
    { id: 'q1', column: 'order_id', rule: 'primary_key', severity: 'error' },
    { id: 'q2', column: 'email', rule: 'regex', value: '^[^@]+@[^@]+$', severity: 'error' },
    { id: 'q3', column: 'amount', rule: 'min', value: '0', severity: 'error' },
    { id: 'q4', column: 'status', rule: 'accepted_values', value: 'new,paid', severity: 'warning' },
  ],
};

const ODCS: OdcsContract = toOdcs(LOOM, { id: 'c1', name: 'Orders', objectName: 'dbo.Orders' });

const GOOD = { order_id: 1, email: 'a@b.com', amount: 10, status: 'new' };
const BAD_EMAIL = { order_id: 2, email: 'nope', amount: 10, status: 'new' };
const BAD_AMOUNT = { order_id: 3, email: 'c@d.com', amount: -5, status: 'paid' };

describe('evaluateRow', () => {
  it('passes a fully conforming row', () => {
    expect(evaluateRow(ODCS.schema![0], GOOD)).toEqual([]);
  });

  it('flags a missing required value', () => {
    const v = evaluateRow(ODCS.schema![0], { ...GOOD, email: '' });
    expect(v.map((x) => x.rule)).toContain('required');
    expect(v[0].severity).toBe('error');
    expect(v[0].detail).toMatch(/'email' is required/);
  });

  it('flags a value that cannot be read as its declared logical type', () => {
    const v = evaluateRow(ODCS.schema![0], { ...GOOD, order_id: 'not-a-number' });
    const hit = v.find((x) => x.rule === 'invalidType')!;
    expect(hit).toBeDefined();
    expect(hit.column).toBe('order_id');
    expect(hit.detail).toMatch(/bigint/);
  });

  it('flags a regex and a min violation with the offending value in the detail', () => {
    expect(evaluateRow(ODCS.schema![0], BAD_EMAIL).map((x) => x.rule)).toContain('regex');
    const min = evaluateRow(ODCS.schema![0], BAD_AMOUNT).find((x) => x.rule === 'min')!;
    expect(min.detail).toMatch(/below the contract minimum 0/);
  });

  it('treats an accepted-values breach at warning severity as a WARNING, not a rejection', () => {
    const v = evaluateRow(ODCS.schema![0], { ...GOOD, status: 'refunded' });
    const hit = v.find((x) => x.rule === 'invalidValues')!;
    expect(hit.severity).toBe('warning');
  });

  it('reports an undeclared extra column as schema drift (warning, never dropped)', () => {
    const v = evaluateRow(ODCS.schema![0], { ...GOOD, surprise: 'x' });
    const hit = v.find((x) => x.rule === 'undeclaredColumn')!;
    expect(hit.severity).toBe('warning');
    expect(hit.column).toBe('surprise');
  });
});

describe('evaluateBatch — the decision matrix', () => {
  it('DEFAULTS to warn-quarantine when no mode is supplied', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [GOOD, BAD_EMAIL] });
    expect(DEFAULT_ENFORCEMENT_MODE).toBe('warn-quarantine');
    expect(r.mode).toBe('warn-quarantine');
  });

  it('lands conforming rows and quarantines only the violators (the DEFAULT)', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [GOOD, BAD_EMAIL, BAD_AMOUNT] });
    expect(r.decision).toBe('landed-with-quarantine');
    expect(r.accepted).toEqual([GOOD]);
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2]);
    expect(r.evaluated).toBe(3);
    // The load is NOT dropped — this is the whole point of the default.
    expect(r.accepted.length).toBeGreaterThan(0);
    expect(r.note).toMatch(/was NOT dropped/);
  });

  it('lands everything and raises no alert when the whole batch conforms', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [GOOD] });
    expect(r.decision).toBe('landed');
    expect(r.rejected).toEqual([]);
    expect(r.alert).toBe(false);
  });

  it('lands a warning-only row and reports it without quarantining it', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [{ ...GOOD, status: 'refunded' }] });
    expect(r.decision).toBe('landed');
    expect(r.rejected).toEqual([]);
    expect(r.warned).toHaveLength(1);
    expect(r.alert).toBe(true);
    expect(r.alertSeverity).toBe('P3');
  });

  it('hard-reject (OPT-IN) blocks the WHOLE batch and dead-letters every row', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [GOOD, BAD_EMAIL], mode: 'hard-reject' });
    expect(r.decision).toBe('rejected-batch');
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(2);
    expect(r.alertSeverity).toBe('P1');
    // The conforming row is preserved verbatim with an honest reason.
    const collateral = r.rejected.find((x) => x.index === 0)!;
    expect(collateral.row).toEqual(GOOD);
    expect(collateral.violations[0].rule).toBe('batchRejected');
  });

  it('hard-reject still lands a fully conforming batch', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [GOOD], mode: 'hard-reject' });
    expect(r.decision).toBe('landed');
    expect(r.accepted).toEqual([GOOD]);
  });

  it('quarantines duplicate values on a unique/primary-key property', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [GOOD, { ...GOOD, email: 'z@z.com' }] });
    expect(r.decision).toBe('landed-with-quarantine');
    expect(r.rejected[0].violations.map((v) => v.rule)).toContain('duplicateValues');
  });

  it('treats a declared column missing from the batch header as an error on every row', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [GOOD], columns: ['order_id', 'email', 'amount'] });
    expect(r.decision).toBe('landed-with-quarantine');
    expect(r.rejected[0].violations.map((v) => v.rule)).toContain('missingColumn');
  });

  it('ranks the top violations for the alert body and the trend', () => {
    const r = evaluateBatch({ odcs: ODCS, rows: [BAD_EMAIL, { ...BAD_EMAIL, order_id: 9 }, BAD_AMOUNT] });
    expect(r.topViolations[0]).toMatchObject({ rule: 'regex', column: 'email', count: 2 });
  });

  it('passes rows straight through when the contract declares no schema object', () => {
    const r = evaluateBatch({ odcs: { apiVersion: 'v3.1.0', kind: 'DataContract', id: 'x', version: '1.0.0', status: 'draft' }, rows: [BAD_EMAIL] });
    expect(r.decision).toBe('landed');
    expect(r.accepted).toEqual([BAD_EMAIL]);
  });
});

describe('logical-type conformance', () => {
  it('reads ingestion values as their declared type (CSV strings included)', () => {
    expect(conformsToLogicalType('42', 'integer')).toBe(true);
    expect(conformsToLogicalType('42.5', 'integer')).toBe(false);
    expect(conformsToLogicalType('42.5', 'number')).toBe(true);
    expect(conformsToLogicalType('yes', 'boolean')).toBe(true);
    expect(conformsToLogicalType('maybe', 'boolean')).toBe(false);
    expect(conformsToLogicalType('2026-07-23T00:00:00Z', 'date')).toBe(true);
    expect(conformsToLogicalType('not-a-date', 'date')).toBe(false);
  });

  it('never fails a null — that is the `required` rule\'s job', () => {
    expect(conformsToLogicalType(null, 'integer')).toBe(true);
    expect(conformsToLogicalType('', 'date')).toBe(true);
  });
});

describe('safety guards', () => {
  it('refuses a catastrophic-backtracking pattern rather than compiling it', () => {
    expect(safePattern('^[a-z]+$')).toBeInstanceOf(RegExp);
    expect(safePattern('(a+)+$')).toBeNull();
    expect(safePattern('x'.repeat(500))).toBeNull();
    expect(safePattern('([')).toBeNull();
  });

  it('records a refused pattern as a warning instead of rejecting the row', () => {
    const odcs = toOdcs(
      { version: '1.0.0', schema: [{ name: 'c', type: 'string' }], quality: [{ id: 'q', column: 'c', rule: 'regex', value: '(a+)+', severity: 'error' }] },
      { id: 'x', name: 'x', objectName: 't' },
    );
    const r = evaluateBatch({ odcs, rows: [{ c: 'aaaa' }] });
    expect(r.decision).toBe('landed');
    expect(r.warned[0].violations[0].detail).toMatch(/refused/);
  });

  it('parses freshness durations', () => {
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('soon')).toBeNull();
  });
});

describe('dead-letter path + body', () => {
  it('places rejects in a sibling `_rejected` folder, never inside the clean data folder', () => {
    const p = deadLetterPath('mirrors/ws1/mir1', 'dbo.Orders', new Date('2026-07-23T10:11:12.345Z'));
    expect(p).toBe('mirrors/ws1/mir1/_rejected/dbo.Orders/rejected-2026-07-23T10-11-12-345Z.jsonl');
    // The clean read is folder-scoped to `<basePath>/<dataset>/`, so `_rejected`
    // can never be picked up by the consumption query.
    expect(p.startsWith('mirrors/ws1/mir1/dbo.Orders/')).toBe(false);
  });

  it('sanitises a hostile dataset name out of the path', () => {
    expect(safeDatasetSegment('../../etc/passwd')).toBe('etc_passwd');
    expect(safeDatasetSegment('')).toBe('dataset');
    expect(safeDatasetSegment('dbo.Orders')).toBe('dbo.Orders');
  });

  it('writes one replayable JSONL record per quarantined row, with the reason', () => {
    const evaluation = evaluateBatch({ odcs: ODCS, rows: [GOOD, BAD_EMAIL] });
    const body = deadLetterBody(evaluation.rejected, {
      contractId: 'c1', contractVersion: '1.0.0', dataset: 'dbo.Orders',
      source: 'mirrored-database', mode: 'warn-quarantine', at: '2026-07-23T00:00:00.000Z',
    });
    const lines = body.split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.row).toEqual(BAD_EMAIL);
    expect(rec._contractId).toBe('c1');
    expect(rec._mode).toBe('warn-quarantine');
    expect(rec._violations.map((v: { rule: string }) => v.rule)).toContain('regex');
  });
});

describe('evaluateSchemaConformance — the pipeline-sink pre-flight', () => {
  const sink = [
    { name: 'order_id', type: 'bigint' },
    { name: 'email', type: 'nvarchar' },
    { name: 'amount', type: 'decimal' },
    { name: 'status', type: 'nvarchar' },
  ];

  it('passes a conforming sink', () => {
    const r = evaluateSchemaConformance(ODCS, sink);
    expect(r.ok).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.alert).toBe(false);
  });

  it('does NOT block the run under the default mode when a column is missing', () => {
    const r = evaluateSchemaConformance(ODCS, sink.filter((c) => c.name !== 'amount'));
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.alertSeverity).toBe('P2');
    expect(r.note).toMatch(/was NOT dropped/);
  });

  it('blocks the run only when the contract opts into hard-reject', () => {
    const r = evaluateSchemaConformance(ODCS, sink.filter((c) => c.name !== 'amount'), 'hard-reject');
    expect(r.blocked).toBe(true);
    expect(r.alertSeverity).toBe('P1');
  });

  it('reports an extra sink column as drift, not a failure', () => {
    const r = evaluateSchemaConformance(ODCS, [...sink, { name: 'etl_loaded_at', type: 'datetime2' }]);
    expect(r.ok).toBe(true);
    expect(r.violations.map((v) => v.rule)).toContain('undeclaredColumn');
    expect(r.alertSeverity).toBe('P3');
  });
});
