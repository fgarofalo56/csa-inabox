/**
 * Eventstream Copilot builder config — pure normalizeOps / applyOps tests (G1).
 *
 * These exercise the REAL validation + apply logic (no AOAI, no Cosmos): the
 * planner only accepts ops that reference names present in the live topology,
 * and applyOps mutates the transform/sink arrays deterministically.
 */
import { describe, it, expect } from 'vitest';
import { EVENTSTREAM_BUILDER_CONFIG, type EventstreamDoc } from '../copilot-personas-eventstream';

const { normalizeOps, applyOps, readDoc, computeStats, groundingText } = EVENTSTREAM_BUILDER_CONFIG as any;

function docWith(over: Partial<EventstreamDoc> = {}): EventstreamDoc {
  return {
    source: { kind: 'eventhub', name: 'orders-in' },
    sink: { kind: 'kusto', name: 'adx-out' },
    sources: [],
    sinks: [{ kind: 'kusto', name: 'adx-out' }],
    transforms: [{ kind: 'filter', name: 'only-errors' }],
    ...over,
  };
}

describe('eventstream builder — readDoc', () => {
  it('reads topology arrays out of item.state with defaults', () => {
    const doc = readDoc({ source: { kind: 'eventhub', name: 's1' }, transforms: [{ kind: 'filter', name: 'f1' }] });
    expect(doc.source.name).toBe('s1');
    expect(doc.transforms).toHaveLength(1);
    expect(doc.sinks).toEqual([]);
  });
});

describe('eventstream builder — normalizeOps', () => {
  it('accepts add-transform with a valid kind + unique name', () => {
    const ops = normalizeOps([{ kind: 'add-transform', transformKind: 'aggregate', name: 'count-1m' }], docWith());
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'add-transform', transformKind: 'aggregate', name: 'count-1m', badge: 'Add transform' });
  });

  it('drops add-transform with an invalid kind or duplicate name', () => {
    expect(normalizeOps([{ kind: 'add-transform', transformKind: 'nope', name: 'x' }], docWith())).toHaveLength(0);
    expect(normalizeOps([{ kind: 'add-transform', transformKind: 'filter', name: 'only-errors' }], docWith())).toHaveLength(0);
  });

  it('accepts rename-transform only for an existing source name and a free target', () => {
    expect(normalizeOps([{ kind: 'rename-transform', from: 'only-errors', to: 'errors' }], docWith())).toHaveLength(1);
    expect(normalizeOps([{ kind: 'rename-transform', from: 'ghost', to: 'errors' }], docWith())).toHaveLength(0);
  });

  it('accepts remove-transform only for an existing transform', () => {
    expect(normalizeOps([{ kind: 'remove-transform', name: 'only-errors' }], docWith())).toHaveLength(1);
    expect(normalizeOps([{ kind: 'remove-transform', name: 'ghost' }], docWith())).toHaveLength(0);
  });

  it('accepts add-destination with a valid sink kind + unique name', () => {
    const ops = normalizeOps([{ kind: 'add-destination', sinkKind: 'lakehouse', name: 'gold-lh' }], docWith());
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'add-destination', sinkKind: 'lakehouse', name: 'gold-lh' });
    expect(normalizeOps([{ kind: 'add-destination', sinkKind: 'kusto', name: 'adx-out' }], docWith())).toHaveLength(0);
  });
});

describe('eventstream builder — applyOps', () => {
  it('appends a transform and reports it applied', () => {
    const doc = docWith();
    const ops = normalizeOps([{ kind: 'add-transform', transformKind: 'aggregate', name: 'count-1m' }], doc);
    const { patch, applied, skipped } = applyOps(doc, ops, {});
    expect(patch.transforms).toHaveLength(2);
    expect((patch.transforms as any[]).map((t) => t.name)).toContain('count-1m');
    expect(applied).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('renames a transform in place', () => {
    const doc = docWith();
    const ops = normalizeOps([{ kind: 'rename-transform', from: 'only-errors', to: 'errors' }], doc);
    const { patch } = applyOps(doc, ops, {});
    expect((patch.transforms as any[])[0].name).toBe('errors');
  });

  it('adds a destination into the sinks array', () => {
    const doc = docWith();
    const ops = normalizeOps([{ kind: 'add-destination', sinkKind: 'lakehouse', name: 'gold-lh' }], doc);
    const { patch } = applyOps(doc, ops, {});
    expect((patch.sinks as any[]).map((s) => s.name)).toEqual(['adx-out', 'gold-lh']);
  });
});

describe('eventstream builder — stats + grounding', () => {
  it('computes stats and grounds on real names', () => {
    const doc = docWith();
    expect(computeStats(doc)).toEqual({ sources: 1, transforms: 1, destinations: 1 });
    const g = groundingText(doc);
    expect(g).toContain('only-errors');
    expect(g).toContain('adx-out');
  });
});
