/**
 * BFF route test for /api/items/scorecard/[id]/goals (task #17).
 * Verifies goal create/update/delete authoring into state.content.okrs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

let currentState: any = { content: { kind: 'scorecard', okrs: [] } };
const loadOwnedItemMock = vi.fn(async (..._a: any[]) => ({
  id: 'sc-1', workspaceId: 'ws-1', itemType: 'scorecard', displayName: 'Revenue KPI', state: currentState,
} as any));
const updateOwnedItemMock = vi.fn(async (_id: string, _t: string, _oid: string, patch: any) => {
  currentState = patch.state; // reflect the write so GET/subsequent reads see it
  return { id: 'sc-1', workspaceId: 'ws-1', itemType: 'scorecard', displayName: 'Revenue KPI', state: patch.state } as any;
});
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
  updateOwnedItem: (...a: any[]) => updateOwnedItemMock(...a),
}));

import { GET, POST, DELETE } from '../route';

const ctx = (id = 'sc-1') => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) =>
  new NextRequest('http://localhost/api/items/scorecard/sc-1/goals', {
    method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json' },
  });

describe('scorecard goals route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
    currentState = { content: { kind: 'scorecard', okrs: [] } };
    // Restore the closure-backed default (a prior test may have set null for 404).
    loadOwnedItemMock.mockImplementation(async () => ({
      id: 'sc-1', workspaceId: 'ws-1', itemType: 'scorecard', displayName: 'Revenue KPI', state: currentState,
    } as any));
  });

  it('creates a goal (mints id) into content.okrs', async () => {
    const res = await POST(req('POST', { goal: { name: 'Total Revenue', metric: 'USD', target: 100000 } }), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.goals).toHaveLength(1);
    expect(j.goals[0].id).toMatch(/^goal-/);
    expect(j.goals[0].name).toBe('Total Revenue');
    expect(currentState.content.okrs).toHaveLength(1);
  });

  it('updates an existing goal by id (merge)', async () => {
    currentState = { content: { kind: 'scorecard', okrs: [{ id: 'g1', name: 'Rev', metric: 'USD', target: 100 }] } };
    const res = await POST(req('POST', { goal: { id: 'g1', target: 250, owner: 'cfo@x.com' } }), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.goals).toHaveLength(1);
    expect(j.goals[0].target).toBe(250);
    expect(j.goals[0].owner).toBe('cfo@x.com');
    expect(j.goals[0].name).toBe('Rev'); // preserved
  });

  it('rejects a goal with no name (400)', async () => {
    const res = await POST(req('POST', { goal: { metric: 'USD', target: 1 } }), ctx());
    expect(res.status).toBe(400);
  });

  it('rejects a goal with no target (400)', async () => {
    const res = await POST(req('POST', { goal: { name: 'X', metric: 'USD' } }), ctx());
    expect(res.status).toBe(400);
  });

  it('deletes a goal by id', async () => {
    currentState = { content: { kind: 'scorecard', okrs: [{ id: 'g1', name: 'A', metric: 'x', target: 1 }, { id: 'g2', name: 'B', metric: 'x', target: 2 }] } };
    const res = await DELETE(req('DELETE', { goalId: 'g1' }), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.goals).toHaveLength(1);
    expect(j.goals[0].id).toBe('g2');
  });

  it('404 deleting an unknown goal', async () => {
    currentState = { content: { kind: 'scorecard', okrs: [{ id: 'g1', name: 'A', metric: 'x', target: 1 }] } };
    const res = await DELETE(req('DELETE', { goalId: 'nope' }), ctx());
    expect(res.status).toBe(404);
  });

  it('404 when scorecard item not found', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const res = await POST(req('POST', { goal: { name: 'X', metric: 'USD', target: 1 } }), ctx());
    expect(res.status).toBe(404);
  });

  it('GET lists current goals', async () => {
    currentState = { content: { kind: 'scorecard', okrs: [{ id: 'g1', name: 'A', metric: 'x', target: 1 }] } };
    const res = await GET(req('GET'), ctx());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.goals).toHaveLength(1);
  });
});
