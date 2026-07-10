/**
 * Pure unit tests for the task-flow RUN engine (topo-sort + run-doc shaping).
 * No Azure / Cosmos / network — these exercise only the deterministic logic the
 * BFF driver relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  topoSortSteps,
  buildFlowRunSkeleton,
  isRunnableType,
  flowHasRunnableItems,
  rollupStepStatus,
  rollupFlowStatus,
  RUNNABLE_ITEM_TYPES,
  type FlowRunItem,
} from '../step-runner';
import type { TaskFlow, TaskFlowStep, TaskFlowEdge } from '@/lib/clients/taskflow-client';

function step(id: string, over: Partial<TaskFlowStep> = {}): TaskFlowStep {
  return { id, label: `Step ${id}`, x: 0, y: 0, ...over };
}
function edge(source: string, target: string): TaskFlowEdge {
  return { id: `${source}-${target}`, source, target };
}
function flow(steps: TaskFlowStep[], edges: TaskFlowEdge[]): TaskFlow {
  return {
    id: 'flow1',
    workspaceId: 'ws1',
    displayName: 'My Flow',
    steps,
    edges,
    createdBy: 'u',
    createdAt: 'now',
    updatedAt: 'now',
  };
}

describe('isRunnableType / RUNNABLE_ITEM_TYPES', () => {
  it('recognizes pipeline family + job + notebook as runnable', () => {
    for (const t of ['data-pipeline', 'adf-pipeline', 'synapse-pipeline', 'databricks-job', 'notebook']) {
      expect(isRunnableType(t)).toBe(true);
      expect(RUNNABLE_ITEM_TYPES.has(t)).toBe(true);
    }
  });
  it('treats design-time artifacts + null as not runnable', () => {
    for (const t of ['lakehouse', 'warehouse', 'semantic-model', 'report', null, undefined, '']) {
      expect(isRunnableType(t)).toBe(false);
    }
  });
});

describe('topoSortSteps', () => {
  it('orders a linear chain A→B→C', () => {
    const r = topoSortSteps([step('a'), step('b'), step('c')], [edge('a', 'b'), edge('b', 'c')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual(['a', 'b', 'c']);
  });

  it('honors a diamond A→B, A→C, B→D, C→D (A first, D last)', () => {
    const r = topoSortSteps(
      [step('a'), step('b'), step('c'), step('d')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order[0]).toBe('a');
      expect(r.order[3]).toBe('d');
      expect(r.order.indexOf('b')).toBeLessThan(r.order.indexOf('d'));
      expect(r.order.indexOf('c')).toBeLessThan(r.order.indexOf('d'));
    }
  });

  it('keeps disconnected steps (no edges) in declared order', () => {
    const r = topoSortSteps([step('x'), step('y'), step('z')], []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual(['x', 'y', 'z']);
  });

  it('detects a cycle and names the offending steps', () => {
    const r = topoSortSteps([step('a'), step('b'), step('c')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cycle.length).toBeGreaterThan(0);
      // Every id in the reported cycle is one of the looped steps.
      for (const id of r.cycle) expect(['a', 'b', 'c']).toContain(id);
      // A closed cycle repeats its entry node.
      expect(r.cycle[0]).toBe(r.cycle[r.cycle.length - 1]);
    }
  });

  it('detects a self-loop as a cycle', () => {
    const r = topoSortSteps([step('a'), step('b')], [edge('a', 'b'), edge('b', 'b')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cycle).toContain('b');
  });

  it('ignores edges referencing unknown steps + duplicate edges', () => {
    const r = topoSortSteps(
      [step('a'), step('b')],
      [edge('a', 'b'), edge('a', 'b'), edge('a', 'ghost'), edge('ghost', 'b')],
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order).toEqual(['a', 'b']);
  });
});

describe('buildFlowRunSkeleton (shaping)', () => {
  it('classifies runnable vs non-runnable vs empty steps', () => {
    const f = flow(
      [
        step('a', { itemId: 'i1', itemType: 'data-pipeline' }),   // runnable
        step('b', { itemId: 'i2', itemType: 'lakehouse' }),       // not runnable
        step('c'),                                                // no linked item
      ],
      [edge('a', 'b'), edge('b', 'c')],
    );
    const doc = buildFlowRunSkeleton({ runId: 'run1', flow: f, order: ['a', 'b', 'c'], startedAt: 't0', startedBy: 'u@x' });
    expect(doc.id).toBe('run1');
    expect(doc.runId).toBe('run1');
    expect(doc.status).toBe('running');
    expect(doc.flowName).toBe('My Flow');
    expect(doc.startedBy).toBe('u@x');
    expect(doc.steps.map((s) => s.stepId)).toEqual(['a', 'b', 'c']);

    const [sa, sb, sc] = doc.steps;
    expect(sa.status).toBe('pending');
    expect(sa.itemRuns[0]).toMatchObject({ itemId: 'i1', itemType: 'data-pipeline', status: 'pending', runId: null });

    expect(sb.status).toBe('skipped');
    expect(sb.itemRuns[0]).toMatchObject({ itemType: 'lakehouse', status: 'skipped', reason: 'not runnable' });

    expect(sc.status).toBe('skipped');
    expect(sc.itemRuns).toHaveLength(0);
  });

  it('emits steps in the provided topological order', () => {
    const f = flow([step('a'), step('b')], []);
    const doc = buildFlowRunSkeleton({ runId: 'r', flow: f, order: ['b', 'a'], startedAt: 't' });
    expect(doc.steps.map((s) => s.stepId)).toEqual(['b', 'a']);
    expect(doc.startedBy).toBeUndefined();
  });
});

describe('flowHasRunnableItems', () => {
  it('is true when any step links a runnable item', () => {
    expect(flowHasRunnableItems(flow([step('a', { itemType: 'notebook' })], []))).toBe(true);
  });
  it('is false when no step links a runnable item', () => {
    expect(flowHasRunnableItems(flow([step('a', { itemType: 'lakehouse' }), step('b')], []))).toBe(false);
  });
});

describe('rollupStepStatus', () => {
  const it0 = (status: FlowRunItem['status']): FlowRunItem => ({ itemId: 'i', itemType: 'notebook', runId: null, status });
  it('skips a step whose items are all skipped/empty', () => {
    expect(rollupStepStatus([])).toBe('skipped');
    expect(rollupStepStatus([it0('skipped')])).toBe('skipped');
  });
  it('fails if any active item failed', () => {
    expect(rollupStepStatus([it0('succeeded'), it0('failed')])).toBe('failed');
  });
  it('succeeds only when all active items succeeded', () => {
    expect(rollupStepStatus([it0('succeeded'), it0('skipped')])).toBe('succeeded');
  });
  it('is running while any active item is pending/running', () => {
    expect(rollupStepStatus([it0('running'), it0('succeeded')])).toBe('running');
    expect(rollupStepStatus([it0('pending')])).toBe('running');
  });
});

describe('rollupFlowStatus', () => {
  const st = (status: any) => ({ stepId: 's', label: 'l', status, itemRuns: [] });
  it('running while any step active', () => {
    expect(rollupFlowStatus([st('running'), st('succeeded')] as any)).toBe('running');
  });
  it('partial when some succeeded and some failed', () => {
    expect(rollupFlowStatus([st('succeeded'), st('failed')] as any)).toBe('partial');
  });
  it('failed when a step failed and none succeeded', () => {
    expect(rollupFlowStatus([st('failed'), st('skipped')] as any)).toBe('failed');
  });
  it('succeeded when nothing failed', () => {
    expect(rollupFlowStatus([st('succeeded'), st('skipped')] as any)).toBe('succeeded');
  });
});
