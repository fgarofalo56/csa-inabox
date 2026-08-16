/**
 * BFF route test for /api/items/graphql-api/[id]/query — the APIM GraphQL test
 * console proxy. Covers the honest 409 gate for an API with no resolvers/
 * backend service URL (raw "Resolvers are not defined…" previously passed
 * through as ok:true).
 *
 * GHSA-hf73-rp4q-66pf moved this handler onto `withWorkspaceOwner`, so
 * `loadOwnedItem` is stubbed here to the AUTHORIZED answer — these cases are
 * about the APIM proxy contract, not the boundary. The boundary itself is
 * covered in `graphql-api/[id]/__tests__/ghsa-item-authz.test.ts`, which stubs
 * the same call to null and asserts the 404.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<any>('@/lib/auth/session');
  return { ...actual, getSession: () => getSessionMock() };
});

// The wrapper runs for real; only the owner lookup beneath it is stubbed.
const loadOwnedItemMock = vi.fn(async (..._a: any[]) =>
  ({ id: 'gql-1', workspaceId: 'ws-1', itemType: 'graphql-api', state: {} } as any));
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));

const getApiMock = vi.fn(async (..._a: any[]) => ({ id: 'gql-1', name: 'gql-1', path: 'gql-1' } as any));
const testApiCallMock = vi.fn(async (..._a: any[]) => ({ status: 200, body: '{"data":{"books":[]}}' } as any));
vi.mock('@/lib/azure/apim-client', () => {
  class ApimError extends Error {
    status: number; body: unknown;
    constructor(status: number, body: unknown, message?: string) {
      super(message || `APIM call failed (${status})`); this.name = 'ApimError'; this.status = status; this.body = body;
    }
  }
  return {
    getApi: (...a: any[]) => getApiMock(...a),
    testApiCall: (...a: any[]) => testApiCallMock(...a),
    ApimError,
  };
});

import { POST } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'gql-1' }) };
function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/graphql-api/gql-1/query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  loadOwnedItemMock.mockClear();
  loadOwnedItemMock.mockResolvedValue({ id: 'gql-1', workspaceId: 'ws-1', itemType: 'graphql-api', state: {} } as any);
  getApiMock.mockClear();
  testApiCallMock.mockClear();
});

describe('graphql-api query route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ query: '{ books { id } }' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('400 when query is missing', async () => {
    const res = await POST(post({}), PARAMS);
    expect(res.status).toBe(400);
  });

  it('409 when the API is not published to APIM yet', async () => {
    getApiMock.mockResolvedValueOnce(null as any);
    const res = await POST(post({ query: '{ books { id } }' }), PARAMS);
    expect(res.status).toBe(409);
  });

  it('runs a query through the APIM gateway (passthrough)', async () => {
    const res = await POST(post({ query: '{ books { id } }' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe(200);
    expect(j.body).toContain('books');
  });

  it('409 honest gate when the API has no resolvers/backend service URL — never the raw DAB error as ok:true', async () => {
    testApiCallMock.mockResolvedValueOnce({
      status: 400,
      body: '{"errors":[{"message":"Resolvers are not defined and a service url is not configured"}]}',
    } as any);
    const res = await POST(post({ query: '{ books { id } }' }), PARAMS);
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('no_resolvers');
    expect(j.error).toBe('This GraphQL API has no entities/resolvers defined yet.');
    expect(j.gate.reason).toContain('no entities/resolvers defined yet');
    expect(j.gate.remediation).toContain('Edit resolver policies');
    expect(j.gate.remediation).toContain('Backend service URL');
  });

  it('keeps the passthrough for a genuine downstream 4xx that is NOT the missing-resolvers class', async () => {
    testApiCallMock.mockResolvedValueOnce({ status: 400, body: '{"errors":[{"message":"syntax error"}]}' } as any);
    const res = await POST(post({ query: '{ nope }' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.status).toBe(400);
  });
});
