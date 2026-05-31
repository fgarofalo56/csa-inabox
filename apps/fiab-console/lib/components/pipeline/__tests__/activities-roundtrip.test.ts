import { describe, it, expect } from 'vitest';
import { extractActivities, writeActivitiesToSpec, type PipelineActivity } from '../pipeline-dag-view';
import { ACTIVITY_CATALOG, ACTIVITY_CATEGORY_ORDER, byCategory, findByKey } from '../activity-catalog';
import { CONNECTOR_COLORS, type ConnectorCondition } from '../connector';

// ----------------------------------------------------------------------------
// Cards/edges <-> properties.activities[] round-trip. The ADF-parity canvas
// renders cards from activities[] and edges from each activity's dependsOn[]
// (with dependencyConditions). Save serialises the canvas model straight back
// to properties.activities[]. These assert the data contract that round-trip
// depends on, without needing a DOM.
// ----------------------------------------------------------------------------

describe('activities <-> pipeline JSON round-trip', () => {
  it('extractActivities reads properties.activities[] in the ADF shape', () => {
    const spec = JSON.stringify({
      name: 'p',
      properties: {
        activities: [
          { name: 'Copy1', type: 'Copy', typeProperties: { source: {}, sink: {} }, dependsOn: [] },
          { name: 'Wait1', type: 'Wait', typeProperties: { waitTimeInSeconds: 5 },
            dependsOn: [{ activity: 'Copy1', dependencyConditions: ['Succeeded'] }] },
        ],
      },
    });
    const acts = extractActivities(spec);
    expect(acts).toHaveLength(2);
    expect(acts[1].dependsOn?.[0]).toEqual({ activity: 'Copy1', dependencyConditions: ['Succeeded'] });
  });

  it('extractActivities is tolerant of malformed / empty specs', () => {
    expect(extractActivities('not json')).toEqual([]);
    expect(extractActivities('{}')).toEqual([]);
    expect(extractActivities('{"properties":{}}')).toEqual([]);
  });

  it('writeActivitiesToSpec replaces activities[] but preserves siblings', () => {
    const before = JSON.stringify({
      name: 'p',
      properties: {
        description: 'keep me',
        concurrency: 3,
        parameters: { windowStart: { type: 'string', defaultValue: '' } },
        annotations: ['prod'],
        activities: [{ name: 'Old', type: 'Wait' }],
      },
    });
    const next: PipelineActivity[] = [
      { name: 'Copy1', type: 'Copy', typeProperties: { source: {}, sink: {} }, dependsOn: [] },
    ];
    const after = JSON.parse(writeActivitiesToSpec(before, next));
    expect(after.properties.activities).toHaveLength(1);
    expect(after.properties.activities[0].name).toBe('Copy1');
    // siblings preserved
    expect(after.properties.description).toBe('keep me');
    expect(after.properties.concurrency).toBe(3);
    expect(after.properties.parameters.windowStart.type).toBe('string');
    expect(after.properties.annotations).toEqual(['prod']);
  });

  it('round-trips a full canvas model (cards + 4-condition edges) losslessly', () => {
    const model: PipelineActivity[] = [
      { name: 'Copy1', type: 'Copy', typeProperties: { source: {}, sink: {} }, dependsOn: [] },
      { name: 'Notify', type: 'WebActivity', typeProperties: { url: 'https://x', method: 'POST' },
        dependsOn: [{ activity: 'Copy1', dependencyConditions: ['Succeeded', 'Completed'] }] },
      { name: 'OnFail', type: 'Fail', typeProperties: { message: 'boom', errorCode: '1' },
        dependsOn: [{ activity: 'Copy1', dependencyConditions: ['Failed'] }] },
      { name: 'OnSkip', type: 'Wait', typeProperties: { waitTimeInSeconds: 1 },
        dependsOn: [{ activity: 'Notify', dependencyConditions: ['Skipped'] }] },
    ];
    const spec = writeActivitiesToSpec('{"properties":{}}', model);
    const back = extractActivities(spec);
    expect(back).toEqual(model);
    // every one of the four ADF conditions survives the trip
    const conds = back.flatMap((a) => a.dependsOn || []).flatMap((d) => d.dependencyConditions || []);
    for (const c of ['Succeeded', 'Failed', 'Completed', 'Skipped'] as ConnectorCondition[]) {
      expect(conds).toContain(c);
    }
  });
});

// ----------------------------------------------------------------------------
// Palette catalog — the left "Activities" pane groups + the per-type default
// typeProperties stamped when an activity is dropped onto the canvas.
// ----------------------------------------------------------------------------

describe('activity palette catalog', () => {
  it('declares the three ADF/Fabric palette categories in order', () => {
    expect(ACTIVITY_CATEGORY_ORDER.map((c) => c.id)).toEqual(['move-transform', 'orchestration', 'control-flow']);
    for (const c of ACTIVITY_CATEGORY_ORDER) expect(byCategory(c.id).length).toBeGreaterThan(0);
  });

  it('covers the four ADF dependency-condition colours used by the canvas edges', () => {
    const required: ConnectorCondition[] = ['Succeeded', 'Failed', 'Completed', 'Skipped'];
    for (const c of required) expect(CONNECTOR_COLORS[c]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('every catalog build() yields a valid ADF activity with default typeProperties', () => {
    for (const def of ACTIVITY_CATALOG) {
      const a = def.build(`${def.namePrefix}1`);
      expect(a.name).toBe(`${def.namePrefix}1`);
      expect(a.type).toBe(def.type);
      expect(Array.isArray(a.dependsOn)).toBe(true);
      expect(a.typeProperties && typeof a.typeProperties).toBe('object');
    }
  });

  it('stamps the expected default typeProperties for representative types', () => {
    const copy = findByKey('Copy')!.build('Copy1');
    expect(copy.typeProperties).toHaveProperty('source');
    expect(copy.typeProperties).toHaveProperty('sink');

    const wait = findByKey('Wait')!.build('Wait1');
    expect((wait.typeProperties as any).waitTimeInSeconds).toBe(5);

    const forEach = findByKey('ForEach')!.build('ForEach1');
    expect((forEach.typeProperties as any).activities).toEqual([]);
    expect((forEach.typeProperties as any).items).toHaveProperty('type', 'Expression');

    const ifc = findByKey('IfCondition')!.build('If1');
    expect((ifc.typeProperties as any).ifTrueActivities).toEqual([]);
    expect((ifc.typeProperties as any).ifFalseActivities).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Connect logic — the canvas's dependency-edge merge. We test the pure model
// transform that the designer applies when a coloured output port is dragged
// onto a target node: it appends a dependsOn entry (or merges the condition
// into an existing edge) and refuses cycles.
// ----------------------------------------------------------------------------

// Mirror of PipelineDesigner.connect — kept as a pure function so we can unit
// test the contract the canvas relies on without mounting the DOM.
function connect(activities: PipelineActivity[], from: string, to: string, cond: ConnectorCondition): PipelineActivity[] {
  if (from === to) return activities;
  const ancestors = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    const node = activities.find((a) => a.name === cur);
    for (const d of node?.dependsOn || []) {
      if (!ancestors.has(d.activity)) { ancestors.add(d.activity); stack.push(d.activity); }
    }
  }
  if (ancestors.has(to)) return activities; // cycle
  return activities.map((a) => {
    if (a.name !== to) return a;
    const deps = a.dependsOn || [];
    const existing = deps.find((d) => d.activity === from);
    if (existing) {
      const conds = new Set(existing.dependencyConditions || []);
      conds.add(cond);
      return { ...a, dependsOn: deps.map((d) => d.activity === from ? { ...d, dependencyConditions: [...conds] } : d) };
    }
    return { ...a, dependsOn: [...deps, { activity: from, dependencyConditions: [cond] }] };
  });
}

describe('canvas connect (dependsOn edge model)', () => {
  const base: PipelineActivity[] = [
    { name: 'A', type: 'Wait', dependsOn: [] },
    { name: 'B', type: 'Wait', dependsOn: [] },
  ];

  it('adds a new dependsOn edge with the dragged condition', () => {
    const next = connect(base, 'A', 'B', 'Succeeded');
    expect(next.find((a) => a.name === 'B')!.dependsOn).toEqual([
      { activity: 'A', dependencyConditions: ['Succeeded'] },
    ]);
  });

  it('merges a second condition into an existing edge (no duplicate edge)', () => {
    const once = connect(base, 'A', 'B', 'Succeeded');
    const twice = connect(once, 'A', 'B', 'Completed');
    const dep = twice.find((a) => a.name === 'B')!.dependsOn!;
    expect(dep).toHaveLength(1);
    expect(dep[0].dependencyConditions).toEqual(['Succeeded', 'Completed']);
  });

  it('refuses a self-edge and a cycle', () => {
    expect(connect(base, 'A', 'A', 'Succeeded')).toEqual(base); // self
    const ab = connect(base, 'A', 'B', 'Succeeded');
    const cyc = connect(ab, 'B', 'A', 'Succeeded'); // would loop A->B->A
    expect(cyc.find((a) => a.name === 'A')!.dependsOn).toEqual([]);
  });
});
