/**
 * #2625 — the lineage-harvest honest gate must be RENDERABLE and RESOLVABLE.
 *
 * The defect this locks down: `harvestSparkBatchLineage` returned an exact,
 * actionable remediation for a succeeded Spark batch that declared no dataset
 * pair, the run route returned it as `lineage.reason`, and NOTHING in the
 * product rendered it. Per `ux-baseline.md` G2 that is not a compliant gate.
 *
 * These are the pure halves of the fix:
 *   1. the harvest stamps a STABLE `code` beside the prose reason, so the UI
 *      never has to pattern-match a sentence someone may re-word;
 *   2. `classifyHarvestReceipt` turns a receipt into the notice to render —
 *      warning + inline Fix-it for the one resolvable outcome, a neutral note
 *      for the facts-about-the-run outcomes, silence for pure noise, and an
 *      honest fallback for a code it has never seen;
 *   3. `applyLineageConf` writes exactly the two Spark conf keys
 *      `parseSparkDatasets` reads, preserving every other key;
 *   4. the gate registry maps the resolvable code to `svc-openlineage`, so
 *      Copilot and /admin/gates can discover it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  classifyHarvestReceipt,
  SPARK_LINEAGE_GATE_ID,
} from '../harvest-receipt';
import { applyLineageConf, selectedFromConf } from '../lineage-conf';
import { SPARK_CONF_INPUTS, SPARK_CONF_OUTPUTS } from '@/lib/lineage/synapse-emitters';
import { gateForLegacyCode, getGate } from '@/lib/gates/registry';

// The harvest reaches Cosmos + the thread-edge sink on its WRITING path only;
// the no-dataset case returns before any of that. Stub them anyway so the
// module graph loads under vitest without a live backend.
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: async () => undefined }));
vi.mock('@/lib/lineage/lineage-audit', () => ({
  auditCrossWorkspaceDenial: async () => undefined,
  auditLineageWrite: async () => undefined,
}));

import {
  harvestSparkBatchLineage,
  __resetHarvestDedupe,
} from '@/lib/lineage/synapse-lineage-harvest';

const session = { claims: { oid: 'oid-1', upn: 'a@b.c' } } as any;

function sparkInput(over: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    synapseWorkspaceName: 'syn',
    poolName: 'pool1',
    batchId: 7,
    jobName: 'loom-job-1',
    state: 'success',
    attributed: true,
    eventTime: '2026-08-01T00:00:00Z',
    ...over,
  } as any;
}

beforeEach(() => __resetHarvestDedupe());

describe('#2625 backend — the harvest stamps a stable code beside the prose', () => {
  it('a succeeded, attributed batch with no declared datasets reports spark_lineage_not_declared', async () => {
    const r = await harvestSparkBatchLineage(session, sparkInput({ conf: {}, args: [] }));
    expect(r.written).toBe(0);
    expect(r.code).toBe('spark_lineage_not_declared');
    // CONTROL — the human prose is unchanged by this fix and must stay honest.
    // This assertion holds both WITH and WITHOUT the code field, so it catches
    // an over-broad "fix" that rewrote the remediation instead of tagging it.
    expect(r.reason).toContain('spark.loom.lineage.inputs/outputs');
  });

  it('an unattributed batch reports batch_unattributed, NOT the config gate', async () => {
    const r = await harvestSparkBatchLineage(session, sparkInput({ attributed: false }));
    expect(r.code).toBe('batch_unattributed');
    // The security boundary is unchanged: still no write, still explained.
    expect(r.written).toBe(0);
    expect(r.reason).toContain('pool-scoped');
  });

  it('a non-success batch reports run_not_succeeded', async () => {
    const r = await harvestSparkBatchLineage(session, sparkInput({ state: 'dead' }));
    expect(r.code).toBe('run_not_succeeded');
  });

  it('a repeat poll for the same batch reports already_harvested', async () => {
    await harvestSparkBatchLineage(session, sparkInput({ conf: {}, args: [] }));
    const again = await harvestSparkBatchLineage(session, sparkInput({ conf: {}, args: [] }));
    expect(again.code).toBe('already_harvested');
  });
});

describe('#2625 classifier — a remediation the user never sees is not a gate', () => {
  it('surfaces the declaration gap as a WARNING carrying an inline Fix-it', () => {
    const n = classifyHarvestReceipt({
      ok: true, events: 0, written: 0, skipped: 0, denied: 0,
      code: 'spark_lineage_not_declared',
      reason: 'the batch declared no storage input+output (set spark.loom.lineage.inputs/outputs, …)',
    });
    expect(n).not.toBeNull();
    expect(n!.intent).toBe('warning');
    expect(n!.fixit).toBe(true);
    expect(n!.gateId).toBe(SPARK_LINEAGE_GATE_ID);
    // The backend's own words reach the user verbatim — not a generic stub.
    expect(n!.body).toContain('the batch declared no storage input+output');
  });

  it('never offers a Fix-it for an outcome the operator cannot fix', () => {
    for (const code of ['batch_unattributed', 'harvest_budget_exhausted', 'harvest_rate_limited',
      'pipeline_no_activities', 'pipeline_no_copy_activity']) {
      const n = classifyHarvestReceipt({ code, reason: `because ${code}` });
      expect(n, code).not.toBeNull();
      expect(n!.fixit, code).toBe(false);
      expect(n!.body, code).toContain(code);
    }
  });

  it('stays silent for receipts that only restate the run status', () => {
    expect(classifyHarvestReceipt({ code: 'already_harvested', reason: 'already harvested in this replica' })).toBeNull();
    expect(classifyHarvestReceipt({ code: 'run_not_succeeded', reason: 'batch state dead — …' })).toBeNull();
    expect(classifyHarvestReceipt({ code: 'no_run', reason: 'no pipeline run to harvest' })).toBeNull();
    expect(classifyHarvestReceipt(null)).toBeNull();
    expect(classifyHarvestReceipt(undefined)).toBeNull();
    // A clean, silent receipt with nothing to say renders nothing.
    expect(classifyHarvestReceipt({ ok: true, events: 0, written: 0, skipped: 0, denied: 0 })).toBeNull();
  });

  it('reports a successful harvest, and says how many edges were refused', () => {
    const n = classifyHarvestReceipt({ ok: true, events: 1, written: 2, skipped: 0, denied: 1 });
    expect(n!.intent).toBe('success');
    expect(n!.title).toContain('2 edges');
    expect(n!.body).toContain('1 edge refused');
    expect(n!.fixit).toBe(false);
  });

  it('surfaces a thrown harvest honestly instead of swallowing it', () => {
    const n = classifyHarvestReceipt({ ok: false, code: 'harvest_error', error: 'ARM 429' });
    expect(n!.intent).toBe('warning');
    expect(n!.body).toContain('ARM 429');
  });

  it('fails OPEN on an unknown future code — never back to silence', () => {
    const n = classifyHarvestReceipt({ code: 'some_code_added_next_year', reason: 'a brand new honest reason' });
    expect(n).not.toBeNull();
    expect(n!.body).toBe('a brand new honest reason');
  });
});

describe('#2625 Fix-it write — exactly the two keys parseSparkDatasets reads', () => {
  it('writes the picked roots and preserves unrelated conf', () => {
    const next = applyLineageConf(
      { 'spark.sql.shuffle.partitions': '200' },
      ['abfss://bronze@acct.dfs.core.windows.net/sales'],
      ['abfss://silver@acct.dfs.core.windows.net/sales'],
    );
    expect(next['spark.sql.shuffle.partitions']).toBe('200');
    expect(next[SPARK_CONF_INPUTS]).toBe('abfss://bronze@acct.dfs.core.windows.net/sales');
    expect(next[SPARK_CONF_OUTPUTS]).toBe('abfss://silver@acct.dfs.core.windows.net/sales');
  });

  it('joins multiple roots with the comma parseSparkDatasets splits on', () => {
    const next = applyLineageConf({}, ['abfss://a@x.dfs.core.windows.net/1', 'abfss://a@x.dfs.core.windows.net/2'], ['abfss://b@x.dfs.core.windows.net/3']);
    expect(next[SPARK_CONF_INPUTS]).toBe('abfss://a@x.dfs.core.windows.net/1,abfss://a@x.dfs.core.windows.net/2');
    expect(selectedFromConf(next, SPARK_CONF_INPUTS)).toHaveLength(2);
  });

  it('DELETES a key when its selection is cleared (no stale empty declaration)', () => {
    const next = applyLineageConf({ [SPARK_CONF_INPUTS]: 'abfss://a@x.dfs.core.windows.net/1' }, [], ['abfss://b@x.dfs.core.windows.net/3']);
    expect(SPARK_CONF_INPUTS in next).toBe(false);
  });
});

describe('#2625 declared datasets actually close the gate (round trip)', () => {
  it('a batch whose conf carries the Fix-it output no longer reports the gate', async () => {
    const conf = applyLineageConf(
      {},
      ['abfss://bronze@acct.dfs.core.windows.net/sales'],
      ['abfss://silver@acct.dfs.core.windows.net/sales'],
    );
    const r = await harvestSparkBatchLineage(session, sparkInput({ conf, args: [] }));
    expect(r.code).not.toBe('spark_lineage_not_declared');
    expect(r.events).toBe(1);
  });
});

describe('#2625 gate registry (G2) — discoverable + surfaced', () => {
  it('maps the resolvable harvest code to the OpenLineage gate', () => {
    expect(gateForLegacyCode('spark_lineage_not_declared')?.id).toBe(SPARK_LINEAGE_GATE_ID);
  });

  it('names the Spark Runs tab and the pipeline Output pane as owning surfaces', () => {
    const paths = (getGate(SPARK_LINEAGE_GATE_ID)?.surfaces || []).map((s) => s.path);
    expect(paths).toContain('/items/spark-job-definition');
    expect(paths).toContain('/items/data-pipeline');
    // CONTROL — the pre-existing surfaces are still registered. An over-broad
    // edit that REPLACED the list instead of extending it fails here.
    expect(paths).toContain('/items/lakehouse');
    expect(paths).toContain('/catalog');
  });
});
