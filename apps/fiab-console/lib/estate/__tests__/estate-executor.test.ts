import { describe, it, expect, vi } from 'vitest';
import { executeEstatePlan, type CreateDispatch, type WeaveDispatch } from '../estate-executor';
import { deriveEdges, type EstatePlan, type EstatePlanNode } from '../estate-plan-model';

function chainPlan(): EstatePlan {
  const nodes: EstatePlanNode[] = [
    { id: 'a', op: 'create', itemType: 'lakehouse', title: 'LH' },
    { id: 'b', op: 'weave', itemType: 'notebook', title: 'Silver', action: 'promote-medallion', fromNodeId: 'a', values: { targetLayer: 'silver' } },
    { id: 'c', op: 'weave', itemType: 'report', title: 'Report', action: 'build-loom-report', fromNodeId: 'a', values: {} },
  ];
  return { id: 'p', nodes, edges: deriveEdges(nodes) };
}

describe('executeEstatePlan', () => {
  it('runs the chain: create root, then weave from the created item id', async () => {
    let created = 0;
    const createDispatch: CreateDispatch = vi.fn(async ({ itemType, title }) => {
      created += 1;
      return { ok: true, itemId: `id_${itemType}_${created}`, itemType, name: title, link: `/items/${itemType}/id_${itemType}_${created}` };
    });
    const weaveCalls: Array<{ action: string; fromId: string }> = [];
    const weaveDispatch: WeaveDispatch = vi.fn(async ({ action, from }) => {
      weaveCalls.push({ action, fromId: from.id });
      const type = action === 'promote-medallion' ? 'notebook' : 'report';
      return { ok: true, itemId: `w_${action}`, itemType: type, link: `/items/${type}/w_${action}` };
    });

    const res = await executeEstatePlan(chainPlan(), { createDispatch, weaveDispatch });

    expect(res.ok).toBe(true);
    expect(res.createdCount).toBe(3);
    expect(createDispatch).toHaveBeenCalledTimes(1);
    expect(weaveDispatch).toHaveBeenCalledTimes(2);
    // Both weave bridges ran FROM the real created lakehouse id (chaining works).
    expect(weaveCalls.every((c) => c.fromId === 'id_lakehouse_1')).toBe(true);
    const root = res.plan.nodes.find((n) => n.id === 'a')!;
    expect(root.status).toBe('created');
    expect(root.resultItemId).toBe('id_lakehouse_1');
  });

  it('skips a weave node when its upstream source failed (no phantom source)', async () => {
    const createDispatch: CreateDispatch = vi.fn(async () => ({ ok: false, error: 'ADLS not configured' }));
    const weaveDispatch: WeaveDispatch = vi.fn(async () => ({ ok: true, itemId: 'x', link: '/items/report/x' }));

    const res = await executeEstatePlan(chainPlan(), { createDispatch, weaveDispatch });

    expect(res.ok).toBe(false);
    expect(res.failedCount).toBe(1); // the create root
    expect(res.skippedCount).toBe(2); // both downstream weaves skipped
    expect(weaveDispatch).not.toHaveBeenCalled();
    const root = res.plan.nodes.find((n) => n.id === 'a')!;
    expect(root.status).toBe('failed');
    expect(root.error).toMatch(/ADLS not configured/);
    expect(res.plan.nodes.find((n) => n.id === 'b')!.status).toBe('skipped');
  });

  it('marks a weave node failed when its bridge returns not-ok', async () => {
    const createDispatch: CreateDispatch = vi.fn(async ({ itemType, title }) => ({
      ok: true, itemId: 'lh1', itemType, name: title, link: `/items/${itemType}/lh1`,
    }));
    const weaveDispatch: WeaveDispatch = vi.fn(async ({ action }) =>
      action === 'promote-medallion'
        ? { ok: false, error: 'Spark pool not available' }
        : { ok: true, itemId: 'r1', itemType: 'report', link: '/items/report/r1' });

    const res = await executeEstatePlan(chainPlan(), { createDispatch, weaveDispatch });
    expect(res.ok).toBe(false);
    expect(res.plan.nodes.find((n) => n.id === 'b')!.status).toBe('failed');
    // Sibling weave (c, also from the created lakehouse) still succeeds.
    expect(res.plan.nodes.find((n) => n.id === 'c')!.status).toBe('created');
  });

  it('never mutates the input plan', async () => {
    const plan = chainPlan();
    const snapshot = JSON.stringify(plan);
    const createDispatch: CreateDispatch = vi.fn(async ({ itemType }) => ({ ok: true, itemId: 'x', itemType, link: `/items/${itemType}/x` }));
    const weaveDispatch: WeaveDispatch = vi.fn(async () => ({ ok: true, itemId: 'y', link: '/items/report/y' }));
    await executeEstatePlan(plan, { createDispatch, weaveDispatch });
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});
