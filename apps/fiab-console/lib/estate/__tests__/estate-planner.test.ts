import { describe, it, expect } from 'vitest';
import { parseEstatePlan, buildEstatePlanPrompt, MAX_ESTATE_NODES } from '../estate-planner';
import { validatePlan } from '../estate-plan-model';

describe('buildEstatePlanPrompt', () => {
  it('advertises only real Weave bridges + root kinds', () => {
    const p = buildEstatePlanPrompt();
    expect(p).toMatch(/promote-medallion/);
    expect(p).toMatch(/build-loom-report/);
    expect(p).toMatch(/publish-as-api/);
    // Roots the planner may create directly.
    expect(p).toMatch(/lakehouse/);
    // It must NOT invent a non-existent action name.
    expect(p).not.toMatch(/create-magic-estate/);
  });
});

describe('parseEstatePlan', () => {
  it('maps a model plan into a validated DAG, remapping from-references', () => {
    const raw = {
      title: 'Sales estate',
      nodes: [
        { id: 'L', op: 'create', itemType: 'lakehouse', title: 'Sales LH', rationale: 'ingest root' },
        { id: 'S', op: 'weave', action: 'promote-medallion', from: 'L', itemType: 'notebook', title: 'Silver', values: { targetLayer: 'silver' } },
        { id: 'R', op: 'weave', action: 'build-loom-report', from: 'L', title: 'Report', values: { sourceMode: 'table' } },
      ],
    };
    const plan = parseEstatePlan(raw, { prompt: 'build sales estate' });
    expect(plan.nodes).toHaveLength(3);
    expect(plan.prompt).toBe('build sales estate');
    // The model's ids ('L','S','R') were remapped to plan-local ids, but the
    // from-references still resolve, so edges are derived.
    expect(plan.edges).toHaveLength(2);
    const report = plan.nodes.find((n) => n.title === 'Report')!;
    // itemType defaulted from the bridge's produced type (report).
    expect(report.itemType).toBe('report');
    expect(report.op).toBe('weave');
    // A weave node's fromNodeId points at the (remapped) lakehouse node.
    const lh = plan.nodes.find((n) => n.op === 'create')!;
    expect(report.fromNodeId).toBe(lh.id);
    expect(validatePlan(plan).ok).toBe(true);
  });

  it('drops weave nodes that name a hallucinated (non-existent) bridge', () => {
    const raw = {
      nodes: [
        { id: 'a', op: 'create', itemType: 'lakehouse', title: 'LH' },
        { id: 'b', op: 'weave', action: 'summon-dashboard', from: 'a', itemType: 'report', title: 'ghost' },
      ],
    };
    const plan = parseEstatePlan(raw);
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0].op).toBe('create');
  });

  it('caps the node count', () => {
    const nodes = Array.from({ length: MAX_ESTATE_NODES + 5 }, (_, i) => ({
      id: `n${i}`, op: 'create', itemType: 'lakehouse', title: `LH ${i}`,
    }));
    const plan = parseEstatePlan({ nodes });
    expect(plan.nodes.length).toBeLessThanOrEqual(MAX_ESTATE_NODES);
  });

  it('tolerates empty / malformed input', () => {
    expect(parseEstatePlan(null).nodes).toHaveLength(0);
    expect(parseEstatePlan({ nodes: 'nope' as unknown as [] }).nodes).toHaveLength(0);
  });
});
