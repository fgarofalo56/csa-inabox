/**
 * N6 — the enforcement HOOK the three ingestion paths call.
 *
 * Exercises the REAL orchestration (lookup → decide → quarantine → alert →
 * record) against injected fakes for Cosmos / ADLS / Azure Monitor, so the
 * behaviour the mirroring engine, pipeline sinks, and eventstream rely on is
 * asserted without a live cloud:
 *
 *   • no bound contract        → rows pass through untouched, zero side effects
 *   • conforming batch         → lands, no dead-letter file, no alert
 *   • violating batch, DEFAULT → conforming rows land, violators are written to
 *                                the Bronze `_rejected` dead-letter path, a P2
 *                                alert fires, and the run joins the trend
 *   • violating batch, opt-in  → hard-reject blocks the whole batch (P1)
 *   • broken registry / ADLS   → fail-open, honest note, ingestion continues
 */
import { describe, it, expect } from 'vitest';
import {
  enforceBeforeLanding, enforceSinkSchema, DEAD_LETTER_CONTAINER,
  type EnforcementDeps,
} from '../contract-enforcement';
import {
  emptyDataContractDoc, toOdcs,
  type DataContractDoc, type EnforcementMode,
} from '@/lib/azure/data-contract-model';
import type { DataContract } from '@/lib/dataproducts/contract';

const LOOM: DataContract = {
  version: '1.0.0',
  schema: [
    { name: 'id', type: 'integer' },
    { name: 'email', type: 'string' },
  ],
  quality: [{ id: 'q', column: 'email', rule: 'regex', value: '^[^@]+@[^@]+$', severity: 'error' }],
};

function doc(mode: EnforcementMode = 'warn-quarantine', enabled = true): DataContractDoc {
  const d = emptyDataContractDoc('oid-1', 'contract-1', 'Orders contract', 'a@b.c');
  d.odcs = toOdcs(LOOM, { id: 'contract-1', name: 'Orders contract', objectName: 'dbo.Orders' });
  d.enforcement = { enabled, mode };
  return d;
}

const GOOD = { id: 1, email: 'a@b.com' };
const BAD = { id: 2, email: 'nope' };

function harness(docs: DataContractDoc[]) {
  const writes: Array<{ container: string; path: string; body: string }> = [];
  const alerts: Array<{ severity: string; title: string; body: string; dedupKey?: string }> = [];
  const runs: Array<{ itemId: string; decision: string; rejected: number; deadLetterPath?: string }> = [];
  const deps: EnforcementDeps = {
    lookup: async () => docs,
    writeDeadLetter: async (container, path, body) => { writes.push({ container, path, body }); },
    alert: async (a) => { alerts.push(a); return { ok: true }; },
    record: async (_tenantId, itemId, run) => {
      runs.push({ itemId, decision: run.decision, rejected: run.rejected, deadLetterPath: run.deadLetterPath });
    },
  };
  return { writes, alerts, runs, deps };
}

const INPUT = {
  tenantId: 'oid-1',
  source: 'mirrored-database' as const,
  targetItemId: 'mir-1',
  dataset: 'dbo.Orders',
  basePath: 'mirrors/ws1/mir1',
};

describe('enforceBeforeLanding', () => {
  it('passes rows through untouched when no contract is bound', async () => {
    const h = harness([]);
    const out = await enforceBeforeLanding({ ...INPUT, rows: [GOOD, BAD] }, h.deps);
    expect(out.enforced).toBe(false);
    expect(out.rows).toEqual([GOOD, BAD]);
    expect(h.writes).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  });

  it('lands a conforming batch with no dead-letter file and no alert', async () => {
    const h = harness([doc()]);
    const out = await enforceBeforeLanding({ ...INPUT, rows: [GOOD] }, h.deps);
    expect(out.enforced).toBe(true);
    expect(out.decision).toBe('landed');
    expect(out.rows).toEqual([GOOD]);
    expect(out.blocked).toBe(false);
    expect(h.writes).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.runs[0]).toMatchObject({ itemId: 'contract-1', decision: 'landed', rejected: 0 });
  });

  it('DEFAULT warn-quarantine: lands the good rows, dead-letters the bad ones, alerts P2', async () => {
    const h = harness([doc()]);
    const out = await enforceBeforeLanding({ ...INPUT, rows: [GOOD, BAD] }, h.deps);

    expect(out.mode).toBe('warn-quarantine');
    expect(out.decision).toBe('landed-with-quarantine');
    expect(out.blocked).toBe(false);
    // The load was NOT dropped — the conforming row still lands.
    expect(out.rows).toEqual([GOOD]);
    expect(out.rejected).toBe(1);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].container).toBe(DEAD_LETTER_CONTAINER);
    expect(h.writes[0].path).toMatch(/^mirrors\/ws1\/mir1\/_rejected\/dbo\.Orders\/rejected-.*\.jsonl$/);
    const record = JSON.parse(h.writes[0].body);
    expect(record.row).toEqual(BAD);
    expect(record._violations.map((v: { rule: string }) => v.rule)).toContain('regex');

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].severity).toBe('P2');
    expect(h.alerts[0].dedupKey).toBe('data-contract:contract-1:dbo.Orders');
    expect(h.alerts[0].body).toContain('mirrors/ws1/mir1/_rejected');
    expect(out.deadLetterPath).toBe(h.writes[0].path);
    expect(h.runs[0]).toMatchObject({ decision: 'landed-with-quarantine', rejected: 1 });
  });

  it('hard-reject (OPT-IN) blocks the whole batch and escalates to P1', async () => {
    const h = harness([doc('hard-reject')]);
    const out = await enforceBeforeLanding({ ...INPUT, rows: [GOOD, BAD] }, h.deps);
    expect(out.decision).toBe('rejected-batch');
    expect(out.blocked).toBe(true);
    expect(out.rows).toEqual([]);
    expect(h.alerts[0].severity).toBe('P1');
    // Every row is recoverable from the dead-letter file, including the good one.
    expect(h.writes[0].body.split('\n')).toHaveLength(2);
  });

  it('lets the STRICTEST bound contract decide when several govern the same target', async () => {
    const h = harness([doc('warn-quarantine'), doc('hard-reject')]);
    const out = await enforceBeforeLanding({ ...INPUT, rows: [GOOD, BAD] }, h.deps);
    expect(out.mode).toBe('hard-reject');
    expect(out.blocked).toBe(true);
  });

  it('fails OPEN with an honest note when the registry cannot be read', async () => {
    const out = await enforceBeforeLanding({ ...INPUT, rows: [GOOD, BAD] }, {
      lookup: async () => { throw new Error('cosmos down'); },
    });
    expect(out.enforced).toBe(false);
    expect(out.rows).toEqual([GOOD, BAD]);
    expect(out.blocked).toBe(false);
    expect(out.note).toMatch(/landed unenforced/);
  });

  it('keeps the bad rows out and discloses the failure when the dead-letter write fails', async () => {
    const h = harness([doc()]);
    h.deps.writeDeadLetter = async () => { throw new Error('403 from ADLS'); };
    const out = await enforceBeforeLanding({ ...INPUT, rows: [GOOD, BAD] }, h.deps);
    expect(out.rows).toEqual([GOOD]);
    expect(out.deadLetterPath).toBeUndefined();
    expect(out.note).toMatch(/dead-letter write failed/i);
    expect(out.note).toMatch(/403 from ADLS/);
  });

  it('never lets a failing alert channel break the ingestion', async () => {
    const h = harness([doc()]);
    h.deps.alert = async () => { throw new Error('action group unreachable'); };
    const out = await enforceBeforeLanding({ ...INPUT, rows: [GOOD, BAD] }, h.deps);
    expect(out.decision).toBe('landed-with-quarantine');
    expect(out.alerted).toBe(false);
    expect(out.rows).toEqual([GOOD]);
  });

  it('skips a contract whose enforcement is switched off', async () => {
    // The store filters disabled contracts out of the lookup, so an empty
    // lookup result is the observable contract-disabled behaviour.
    const h = harness([]);
    const out = await enforceBeforeLanding({ ...INPUT, rows: [BAD] }, h.deps);
    expect(out.enforced).toBe(false);
    expect(out.rows).toEqual([BAD]);
  });
});

describe('enforceSinkSchema (pipeline sinks)', () => {
  const SINK = { tenantId: 'oid-1', targetItemId: 'pipe-1', dataset: 'dbo.Orders' };

  it('no bound contract → no-op', async () => {
    const h = harness([]);
    const out = await enforceSinkSchema({ ...SINK, sinkColumns: [{ name: 'id' }] }, h.deps);
    expect(out.enforced).toBe(false);
    expect(out.blocked).toBe(false);
  });

  it('DEFAULT mode alerts on a missing contracted column but does NOT block the run', async () => {
    const h = harness([doc()]);
    const out = await enforceSinkSchema({ ...SINK, sinkColumns: [{ name: 'id', type: 'int' }] }, h.deps);
    expect(out.enforced).toBe(true);
    expect(out.blocked).toBe(false);
    expect(out.violations.map((v) => v.rule)).toContain('missingColumn');
    expect(h.alerts[0].severity).toBe('P2');
    expect(h.runs[0].decision).toBe('landed-with-quarantine');
  });

  it('hard-reject blocks the dispatch before any data moves', async () => {
    const h = harness([doc('hard-reject')]);
    const out = await enforceSinkSchema({ ...SINK, sinkColumns: [{ name: 'id', type: 'int' }] }, h.deps);
    expect(out.blocked).toBe(true);
    expect(h.alerts[0].severity).toBe('P1');
    expect(h.runs[0].decision).toBe('rejected-batch');
  });

  it('a conforming sink raises nothing', async () => {
    const h = harness([doc()]);
    const out = await enforceSinkSchema({
      ...SINK,
      sinkColumns: [{ name: 'id', type: 'int' }, { name: 'email', type: 'nvarchar' }],
    }, h.deps);
    expect(out.blocked).toBe(false);
    expect(out.violations).toEqual([]);
    expect(h.alerts).toHaveLength(0);
  });
});
