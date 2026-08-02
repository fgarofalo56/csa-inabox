/**
 * BFF route tests for the two SIBLING routes that shared the report `…/pages`
 * conflation — #2830's class sweep.
 *
 * `…/pages` 404'd a present report because `state.content` had not been written
 * yet. The detail routes for `report` and `scorecard` collapsed the same two
 * distinct outcomes into one 404 on their `loom:` branch:
 *
 *   report/[id]     `if (!detail) return null` → 404
 *   scorecard/[id]  `if (!goals || !scorecard) return null` → 404
 *
 * Both are `resolve-and-serve` concepts: the item's IDENTITY (id, display name,
 * description) comes from the Cosmos item, not from its content, and the
 * plain-Cosmos-id branch of the report route already tolerated a null detail
 * (`...(detail ?? {})`). The `loom:` branches now behave the same way, so a
 * freshly created report/scorecard opens clean (`ux-baseline.md`) instead of
 * with an error banner.
 *
 * CONTROLS: a `loom:` id with no backing item still 404s on both routes; a saved
 * item still serves its persisted content; unauthenticated is still 401.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WorkspaceItem } from '@/lib/types/workspace';

const h = vi.hoisted(() => ({
  store: new Map<string, any>(),
  session: vi.fn(() => ({ claims: { oid: 'oid-1' } }) as any),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: () => h.session() }));
vi.mock('@/lib/azure/powerbi-client', () => ({
  getReport: vi.fn(async () => { throw new Error('Power BI must not be called on the default path'); }),
  PowerBiError: class extends Error { status = 500; },
  addScorecardGoalValue: vi.fn(),
}));
vi.mock('@/lib/admin/platform-settings', () => ({ resolveBiBackendMode: vi.fn(async () => 'loom-native') }));
vi.mock('@/lib/azure/model-binding', () => ({ loadModelItem: vi.fn(async () => null) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  scorecardGoalsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }), upsert: async (d: any) => ({ resource: d }) },
    item: () => ({ read: async () => ({ resource: undefined }) }),
  }),
  scorecardCheckinsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }), upsert: async (d: any) => ({ resource: d }) },
  }),
}));
vi.mock('../scorecard/config-store', () => ({
  loadScorecardConfig: vi.fn(async () => []),
  mergeConfigOntoLiveGoals: vi.fn((g: any) => g),
}));

// Real keyed lookup — mirrors Cosmos `WHERE c.id = @id AND c.itemType = @t`.
const loadContentBackedItem = vi.fn(async (id: string, type: string) => {
  const hit = h.store.get(id);
  return hit && hit.itemType === type ? hit : null;
});
vi.mock('../_lib/pbi-content-fallback', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  loadContentBackedItem: (...a: any[]) => loadContentBackedItem(...(a as [string, string, string])),
}));

import { GET as reportGet } from '../report/[id]/route';
import { GET as scorecardGet } from '../scorecard/[id]/route';

const COSMOS_ID = '8872fd18-f6a8-4a08-aade-7ee7dc3960d3';
const LOOM_ID = `loom:${COSMOS_ID}`;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (type: string, id: string, qs = '') =>
  new NextRequest(`http://localhost/api/items/${type}/${encodeURIComponent(id)}${qs}`);

function seed(itemType: string, content?: Record<string, unknown>) {
  h.store.set(COSMOS_ID, {
    id: COSMOS_ID,
    workspaceId: 'ws-1',
    itemType,
    displayName: `uat-pubver-${itemType}`,
    description: 'created by the publish-version walk',
    state: content ? { content } : {},
    createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as WorkspaceItem);
}

beforeEach(() => {
  h.store.clear();
  vi.clearAllMocks();
  h.session.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
});

describe('#2830 sibling — report detail on a `loom:` id', () => {
  it('serves a created-but-unsaved report instead of 404ing', async () => {
    seed('report');
    const res = await reportGet(req('report', LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    // Identity comes from the ITEM — available with or without state.content.
    expect(j.report.id).toBe(LOOM_ID);
    expect(j.report.name).toBe('uat-pubver-report');
    expect(j.pages).toEqual([]);
  });

  it('still serves a SAVED report\'s persisted pages + theme', async () => {
    seed('report', { kind: 'report', pages: [{ name: 'Overview', visuals: [] }], theme: { name: 'Loom' } });
    const res = await reportGet(req('report', LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.pages[0].displayName).toBe('Overview');
    expect(j.theme).toEqual({ name: 'Loom' });
    expect(j.report.id).toBe(LOOM_ID);
  });

  it('CONTROL: a `loom:` id with no backing item still 404s', async () => {
    const res = await reportGet(req('report', LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(404);
  });

  it('CONTROL: unauthenticated is still 401', async () => {
    h.session.mockReturnValueOnce(null as any);
    const res = await reportGet(req('report', LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(401);
  });
});

describe('#2830 sibling — scorecard detail on a `loom:` id', () => {
  it('serves a created-but-unsaved scorecard instead of 404ing', async () => {
    seed('scorecard');
    const res = await scorecardGet(req('scorecard', LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.scorecard.displayName).toBe('uat-pubver-scorecard');
    expect(j.goals).toEqual([]);
  });

  it('still serves a bundle scorecard\'s OKRs', async () => {
    seed('scorecard', {
      kind: 'scorecard',
      okrs: [{ id: 'g1', name: 'Onboard 10 agencies', metric: 'count', target: 10, currentValue: 4 }],
    });
    const res = await scorecardGet(req('scorecard', LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.goals.map((g: any) => g.name)).toEqual(['Onboard 10 agencies']);
  });

  it('CONTROL: a `loom:` id with no backing item still 404s', async () => {
    const res = await scorecardGet(req('scorecard', LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(404);
  });

  it('CONTROL: unauthenticated is still 401', async () => {
    h.session.mockReturnValueOnce(null as any);
    const res = await scorecardGet(req('scorecard', LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(401);
  });
});
