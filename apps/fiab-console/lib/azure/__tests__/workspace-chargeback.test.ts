import { describe, it, expect } from 'vitest';
import {
  allocateWorkspaceCosts,
  type WorkspaceAllocInput,
} from '@/lib/azure/workspace-chargeback';

const domainNames = { finance: 'Finance', sales: 'Sales' };

describe('WS-CHGBK allocateWorkspaceCosts — usage-weighted (preferred basis)', () => {
  it('splits a domain\'s real spend by recorded LCU share', () => {
    const domainRows = [{ domainId: 'finance', cost: 100 }];
    const workspaces: WorkspaceAllocInput[] = [
      { workspaceId: 'w1', name: 'WS One', domainId: 'finance', itemCount: 5 },
      { workspaceId: 'w2', name: 'WS Two', domainId: 'finance', itemCount: 1 },
    ];
    const usage = { w1: 75, w2: 25 }; // usage share overrides item share
    const out = allocateWorkspaceCosts(domainRows, workspaces, usage, domainNames);
    const w1 = out.rows.find((r) => r.workspaceId === 'w1')!;
    const w2 = out.rows.find((r) => r.workspaceId === 'w2')!;
    expect(w1.cost).toBe(75);
    expect(w2.cost).toBe(25);
    expect(w1.basis).toBe('usage');
    expect(w1.pctOfDomain).toBe(75);
    expect(w1.domainName).toBe('Finance');
    expect(out.totalCost).toBe(100);
    expect(out.unallocatedCost).toBe(0);
    // Sorted by cost descending.
    expect(out.rows[0].workspaceId).toBe('w1');
  });
});

describe('WS-CHGBK allocateWorkspaceCosts — item-weighted fallback', () => {
  it('falls back to item count when no usage is recorded', () => {
    const domainRows = [{ domainId: 'finance', cost: 90 }];
    const workspaces: WorkspaceAllocInput[] = [
      { workspaceId: 'w1', name: 'WS One', domainId: 'finance', itemCount: 2 },
      { workspaceId: 'w2', name: 'WS Two', domainId: 'finance', itemCount: 1 },
    ];
    const out = allocateWorkspaceCosts(domainRows, workspaces, {}, domainNames);
    expect(out.rows.every((r) => r.basis === 'items')).toBe(true);
    expect(out.rows.find((r) => r.workspaceId === 'w1')!.cost).toBe(60);
    expect(out.rows.find((r) => r.workspaceId === 'w2')!.cost).toBe(30);
    expect(out.totalCost).toBe(90);
  });
});

describe('WS-CHGBK allocateWorkspaceCosts — even split when no signal', () => {
  it('splits evenly when a domain\'s workspaces have neither usage nor items', () => {
    const domainRows = [{ domainId: 'sales', cost: 50 }];
    const workspaces: WorkspaceAllocInput[] = [
      { workspaceId: 'w1', name: 'A', domainId: 'sales', itemCount: 0 },
      { workspaceId: 'w2', name: 'B', domainId: 'sales', itemCount: 0 },
    ];
    const out = allocateWorkspaceCosts(domainRows, workspaces, {}, domainNames);
    expect(out.rows.every((r) => r.basis === 'even')).toBe(true);
    expect(out.rows[0].cost).toBe(25);
    expect(out.rows[1].cost).toBe(25);
    expect(out.totalCost).toBe(50);
  });
});

describe('WS-CHGBK allocateWorkspaceCosts — honesty guarantees', () => {
  it('keeps domain spend with no workspaces in unallocatedCost (never hidden)', () => {
    const domainRows = [
      { domainId: 'finance', cost: 100 },
      { domainId: 'sales', cost: 40 }, // no workspaces mapped to sales
    ];
    const workspaces: WorkspaceAllocInput[] = [
      { workspaceId: 'w1', name: 'WS One', domainId: 'finance', itemCount: 1 },
    ];
    const out = allocateWorkspaceCosts(domainRows, workspaces, {}, domainNames);
    expect(out.totalCost).toBe(100);
    expect(out.unallocatedCost).toBe(40);
    expect(out.rows).toHaveLength(1);
  });

  it('ignores workspaces whose domain has no spend', () => {
    const domainRows = [{ domainId: 'finance', cost: 100 }];
    const workspaces: WorkspaceAllocInput[] = [
      { workspaceId: 'w1', name: 'WS One', domainId: 'finance', itemCount: 1 },
      { workspaceId: 'w2', name: 'Orphan', domainId: '(no domain)', itemCount: 9 },
    ];
    const out = allocateWorkspaceCosts(domainRows, workspaces, {}, domainNames);
    expect(out.rows.map((r) => r.workspaceId)).toEqual(['w1']);
  });

  it('falls back to the domain id as the display name when unknown', () => {
    const out = allocateWorkspaceCosts(
      [{ domainId: 'mystery', cost: 10 }],
      [{ workspaceId: 'w1', name: 'WS', domainId: 'mystery', itemCount: 1 }],
      {},
      domainNames,
    );
    expect(out.rows[0].domainName).toBe('mystery');
  });

  it('is empty + zeroed for no domain spend (honest empty state)', () => {
    const out = allocateWorkspaceCosts([], [{ workspaceId: 'w1', name: 'WS', domainId: 'finance', itemCount: 3 }], {}, domainNames);
    expect(out.rows).toEqual([]);
    expect(out.totalCost).toBe(0);
    expect(out.unallocatedCost).toBe(0);
  });
});
