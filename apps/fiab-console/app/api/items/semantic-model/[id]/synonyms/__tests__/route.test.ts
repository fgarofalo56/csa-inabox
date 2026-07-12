/**
 * BFF route test for /api/items/semantic-model/[id]/synonyms
 * (OPEN-REGISTER P1-8a wiring).
 *
 * Proves the route no longer inlines its own normalizer/Cosmos calls but
 * delegates to `lib/azure/linguistic-schema.ts` (`validateSynonyms` /
 * `readSynonyms` / `writeSynonyms`) as the single source of truth — by
 * asserting behavior that ONLY the shared module exhibits (weight clamped to
 * [0,1] rather than dropped out-of-range; an invalid objectType throws the
 * module's own message rather than silently defaulting to 'column').
 *
 * Mocks the underlying `item-crud` Cosmos helpers (real linguistic-schema.ts
 * + real route code run on top of an in-memory fake item) — no real Cosmos.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WorkspaceItem } from '@/lib/types/workspace';

let fakeItem: WorkspaceItem | null = null;

const loadOwnedItemMock = vi.fn(async (_id: string, _type: string, _tenant: string) => fakeItem);
const updateOwnedItemMock = vi.fn(async (_id: string, _type: string, _tenant: string, patch: { state?: Record<string, unknown> }) => {
  if (!fakeItem) return null;
  fakeItem = { ...fakeItem, state: patch.state ?? fakeItem.state };
  return fakeItem;
});
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...(a as [string, string, string])),
  updateOwnedItem: (...a: any[]) => updateOwnedItemMock(...(a as [string, string, string, any])),
}));

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

import { GET, PUT } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'model-1' }) };
function putReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/semantic-model/model-1/synonyms', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
function getReq(): NextRequest {
  return new NextRequest('http://localhost/api/items/semantic-model/model-1/synonyms');
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  fakeItem = {
    id: 'model-1',
    workspaceId: 'ws-1',
    itemType: 'semantic-model',
    displayName: 'Sales model',
    state: { model: {} },
    createdBy: 'u',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as WorkspaceItem;
  loadOwnedItemMock.mockClear();
  updateOwnedItemMock.mockClear();
});

describe('synonyms route (wired to lib/azure/linguistic-schema)', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await PUT(putReq({ synonyms: [] }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('GET 404s when the item is not found (readSynonyms itemFound=false)', async () => {
    fakeItem = null;
    const res = await GET(getReq(), PARAMS);
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.ok).toBe(false);
  });

  it('GET returns an empty list for an item with no synonyms yet', async () => {
    const res = await GET(getReq(), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.synonyms).toEqual([]);
  });

  it('PUT clamps an out-of-range weight to 1 (module behavior, not the old route drop)', async () => {
    const res = await PUT(
      putReq({ synonyms: [{ objectType: 'measure', object: 'Total Sales', terms: ['revenue'], weight: 1.5 }] }),
      PARAMS,
    );
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.synonyms[0].weight).toBe(1);
  });

  it('PUT persists onto state.model.synonyms via writeSynonyms (updateOwnedItem called)', async () => {
    const res = await PUT(
      putReq({ synonyms: [{ objectType: 'column', table: 'Sales', object: 'Amount', terms: ['revenue', 'turnover'] }] }),
      PARAMS,
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.persisted).toBe(true);
    expect(j.count).toBe(1);
    expect(updateOwnedItemMock).toHaveBeenCalledOnce();
    expect((fakeItem!.state as any).model.synonyms).toEqual(j.synonyms);
  });

  it('PUT 400s with the shared module\'s validation message on an invalid objectType', async () => {
    const res = await PUT(
      putReq({ synonyms: [{ objectType: 'bogus', object: 'X', terms: ['x'] }] }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/invalid objectType/i);
  });

  it('PUT 404s when the item does not resolve (writeSynonyms → loadOwnedItem null)', async () => {
    fakeItem = null;
    const res = await PUT(putReq({ synonyms: [] }), PARAMS);
    expect(res.status).toBe(404);
  });
});
