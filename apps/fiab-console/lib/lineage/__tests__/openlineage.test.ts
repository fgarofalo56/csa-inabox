import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ONLY the sink (recordThreadEdge). The L2 mapper (mapRunEventToEdges) runs
// for real so the emitter genuinely reuses L2's ingest pipeline + fan-out caps.
const recordThreadEdgeMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: recordThreadEdgeMock }));

import {
  buildRunEvent, emitRunLineage, unifiedGraphToOpenLineageEvents,
  LOOM_OL_PRODUCER, OL_RUNEVENT_SCHEMA_URL,
} from '@/lib/lineage/openlineage';

const session = { claims: { oid: 'owner-1', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 } as any;

beforeEach(() => { recordThreadEdgeMock.mockClear(); });

describe('buildRunEvent (OpenLineage 1.x shape, Marquez-importable)', () => {
  const event = buildRunEvent({
    runType: 'pipeline',
    runId: 'run-42',
    jobName: 'nightly-load',
    inputs: [{ itemId: 'src-in', itemType: 'lakehouse', name: 'bronze', columns: ['id', 'amount'] }],
    outputs: [{ itemId: 'gold-out', itemType: 'warehouse', name: 'gold' }],
    columnLineage: [{ toColumn: 'total', inputs: [{ inputItemId: 'src-in', column: 'amount', transform: 'SUM(amount)' }] }],
    eventTime: '2026-07-02T00:00:00Z',
  });

  it('carries the required run/job/producer/schema fields', () => {
    expect(event.eventType).toBe('COMPLETE');
    expect(event.producer).toBe(LOOM_OL_PRODUCER);
    expect(event.schemaURL).toBe(OL_RUNEVENT_SCHEMA_URL);
    expect(event.run.runId).toBe('run-42');
    expect(event.job.name).toBe('nightly-load');
    expect(event.job.facets?.jobType).toBeTruthy();
  });

  it('emits inputs/outputs with schema + loomItem facets', () => {
    expect(event.inputs).toHaveLength(1);
    expect(event.outputs).toHaveLength(1);
    const schema = (event.inputs[0].facets as any).schema;
    expect(schema.fields.map((f: any) => f.name)).toEqual(['id', 'amount']);
    expect((event.outputs[0].facets as any).loomItem.itemId).toBe('gold-out');
  });

  it('attaches a spec-shaped columnLineage facet to the output', () => {
    const cl = (event.outputs[0].facets as any).columnLineage;
    expect(cl.fields.total.inputFields[0].field).toBe('amount');
    expect(cl.fields.total.inputFields[0].transformations[0].description).toBe('SUM(amount)');
    // The input dataset name is the canonical loom:// URI (join key).
    expect(cl.fields.total.inputFields[0].name).toBe('loom://items/lakehouse/src-in');
  });
});

describe('emitRunLineage (reuses the L2 mapper + sink)', () => {
  it('writes one item→item edge with declared column mappings', async () => {
    const r = await emitRunLineage(session, {
      runType: 'notebook',
      runId: 'r1',
      jobName: 'nb',
      inputs: [{ itemId: 'a', itemType: 'lakehouse', name: 'A' }],
      outputs: [{ itemId: 'b', itemType: 'warehouse', name: 'B' }],
      columnLineage: [{ toColumn: 'y', inputs: [{ inputItemId: 'a', column: 'x' }] }],
    });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(1);
    expect(recordThreadEdgeMock).toHaveBeenCalledTimes(1);
    const arg = recordThreadEdgeMock.mock.calls[0][1] as any;
    expect(arg.fromItemId).toBe('a');
    expect(arg.toItemId).toBe('b');
    expect(arg.action).toBe('openlineage-notebook');
    expect(arg.columnMappings[0]).toMatchObject({ fromColumn: 'x', toColumn: 'y', confidence: 'declared' });
  });

  it('writes NOTHING for a non-COMPLETE (FAIL) run', async () => {
    const r = await emitRunLineage(session, {
      runType: 'pipeline', runId: 'r2', jobName: 'nb', eventType: 'FAIL',
      inputs: [{ itemId: 'a', itemType: 'lakehouse' }],
      outputs: [{ itemId: 'b', itemType: 'warehouse' }],
    });
    expect(r.written).toBe(0);
    expect(recordThreadEdgeMock).not.toHaveBeenCalled();
  });

  it('never throws — a bad input degrades to an error receipt', async () => {
    const r = await emitRunLineage(session, {
      runType: 'pipeline', runId: 'r3', jobName: 'x',
      inputs: Array.from({ length: 60 }, (_, i) => ({ itemId: `i${i}`, itemType: 'lakehouse' })),
      outputs: [{ itemId: 'o', itemType: 'warehouse' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/datasets/);
  });
});

describe('unifiedGraphToOpenLineageEvents (export)', () => {
  const nodes = [
    { id: 'a', label: 'A', identity: 'uc:cat.sch.a', type: 'table', columns: ['id'] },
    { id: 'b', label: 'B', identity: 'uc:cat.sch.b', type: 'table' },
    { id: 'col:a::id', label: 'id', type: 'column' },
  ];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'col:a::id', to: 'col:b::id', kind: 'column' },
  ];
  it('produces one COMPLETE event per table edge, folding out column edges', () => {
    const events = unifiedGraphToOpenLineageEvents(nodes, edges, '2026-07-02T00:00:00Z');
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.eventType).toBe('COMPLETE');
    expect(ev.producer).toBe(LOOM_OL_PRODUCER);
    expect(ev.inputs[0].name).toBe('uc:cat.sch.a'); // uses the canonical identity
    expect(ev.outputs[0].name).toBe('uc:cat.sch.b');
    expect((ev.inputs[0].facets as any).schema.fields[0].name).toBe('id');
  });
});
