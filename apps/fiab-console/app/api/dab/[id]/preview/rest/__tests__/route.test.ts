/**
 * BFF route test for /api/dab/[id]/preview/rest — the DAB REST preview proxy.
 * Covers the honest 409 gate when the saved DAB config has ZERO entities
 * (previously the raw DAB 404 EntityNotFound passed through), and the
 * available-entities hint when the requested entityPath matches no entity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn(async (..._a: any[]) => null as any);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
  jerr: (error: string, status = 500) =>
    ({ status, json: async () => ({ ok: false, error }) }) as any,
}));

const proxyRestMock = vi.fn(async (..._a: any[]) => ({ status: 200, body: { value: [] }, url: '/api/book' } as any));
vi.mock('@/app/api/dab/_lib/dab-runtime', () => ({
  dabRuntimeGate: vi.fn(() => null),
  proxyRest: (...a: any[]) => proxyRestMock(...a),
}));
import { dabRuntimeGate } from '@/app/api/dab/_lib/dab-runtime';

import { POST } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'dab-1' }) };
function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/dab/dab-1/preview/rest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
function itemWithEntities(entities: unknown[]) {
  return { id: 'dab-1', displayName: 'My Data API', state: { dabConfig: { entities } } } as any;
}
beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  loadOwnedItemMock.mockClear().mockResolvedValue(null as any);
  proxyRestMock.mockClear();
  (dabRuntimeGate as any).mockReturnValue(null);
});

describe('dab preview/rest route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ entityPath: '/book' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('503 runtime gate when LOOM_DAB_PREVIEW_URL is not set', async () => {
    (dabRuntimeGate as any).mockReturnValueOnce({ missing: 'LOOM_DAB_PREVIEW_URL' });
    const res = await POST(post({ entityPath: '/book' }), PARAMS);
    expect(res.status).toBe(503);
  });

  it('400 when entityPath is missing', async () => {
    const res = await POST(post({}), PARAMS);
    expect(res.status).toBe(400);
  });

  it('409 honest gate when the DAB config has ZERO entities — never the raw EntityNotFound', async () => {
    loadOwnedItemMock.mockResolvedValueOnce(itemWithEntities([]));
    const res = await POST(post({ entityPath: '/book' }), PARAMS);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('no_entities');
    expect(j.error).toBe('This Data API has no entities yet.');
    expect(j.gate.reason).toContain('zero tables, views, or stored procedures');
    expect(j.gate.remediation).toContain('"Entities" stage');
    expect(proxyRestMock).not.toHaveBeenCalled();
  });

  it('passthrough + availableEntities hint when entities exist but the entityPath matches none', async () => {
    loadOwnedItemMock.mockResolvedValueOnce(itemWithEntities([
      { name: 'Book', rest: { enabled: true, path: '/book' } },
      { name: 'Author', rest: { enabled: true } },
    ]));
    proxyRestMock.mockResolvedValueOnce({ status: 404, body: { error: { code: 'EntityNotFound' } }, url: '/api/nope' } as any);
    const res = await POST(post({ entityPath: '/nope' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe(404); // raw DAB passthrough is kept
    expect(j.availableEntities).toEqual(['/book', '/author']);
    expect(j.hint).toContain('"/nope" does not match any configured entity');
    expect(j.hint).toContain('/book');
  });

  it('clean passthrough when the entityPath matches a configured entity', async () => {
    loadOwnedItemMock.mockResolvedValueOnce(itemWithEntities([
      { name: 'Book', rest: { enabled: true, path: '/book' } },
    ]));
    const res = await POST(post({ entityPath: '/book', first: 10 }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe(200);
    expect(j.availableEntities).toBeUndefined();
    expect(proxyRestMock).toHaveBeenCalledOnce();
  });

  it('keeps the raw passthrough when the item/config cannot be read (best-effort gate)', async () => {
    loadOwnedItemMock.mockRejectedValueOnce(new Error('cosmos down'));
    const res = await POST(post({ entityPath: '/book' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(proxyRestMock).toHaveBeenCalledOnce();
  });
});
