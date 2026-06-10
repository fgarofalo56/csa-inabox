/**
 * Backend contract tests for the vector-store BFF routes — the surface behind
 * the Vector store editor's three tabs (Index schema / Add documents / Vector
 * search), all dispatching to Azure AI Search via foundry-client.
 *
 * GET  /index  → live index schema (or exists:false)
 * POST /index  → create/update vector index (buildVectorIndexDefinition + upsertIndex)
 * POST /search → k-NN / hybrid similarity search (vectorSearch)
 *
 * For each we assert: 401 (no session), 400 (bad input), 503 honest gate when
 * LOOM_AI_SEARCH_SERVICE is unset (NotDeployedError), the happy path, and a
 * 502 on a generic backend failure. The real NotDeployedError / FoundryError
 * classes are preserved via importActual so the routes' `instanceof` branches
 * are exercised.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/foundry-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/foundry-client');
  return {
    ...actual,
    getIndex: vi.fn(),
    upsertIndex: vi.fn(),
    uploadDocuments: vi.fn(),
    vectorSearch: vi.fn(),
    // keep the real buildVectorIndexDefinition + error classes
  };
});

import { GET as INDEX_GET, POST as INDEX_POST } from '../[id]/index/route';
import { POST as SEARCH_POST } from '../[id]/search/route';
import { getSession } from '@/lib/auth/session';
import {
  getIndex, upsertIndex, vectorSearch, NotDeployedError, FoundryError,
} from '@/lib/azure/foundry-client';

function postReq(body: any) {
  return { json: async () => body } as any;
}
function getReq(name?: string) {
  const params = new URLSearchParams();
  if (name !== undefined) params.set('name', name);
  return { nextUrl: { searchParams: params } } as any;
}

const auth = () => (getSession as any).mockReturnValue({ claims: { upn: 'u@x' } });

beforeEach(() => {
  vi.resetAllMocks();
  process.env.LOOM_AI_SEARCH_SERVICE = 'search-loom-test';
});

describe('GET /api/items/vector-store/[id]/index', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await INDEX_GET(getReq('idx'));
    expect(res.status).toBe(401);
  });

  it('400 when name missing', async () => {
    auth();
    const res = await INDEX_GET(getReq());
    expect(res.status).toBe(400);
  });

  it('503 honest gate when LOOM_AI_SEARCH_SERVICE unset', async () => {
    auth();
    (getIndex as any).mockRejectedValue(
      new NotDeployedError('Azure AI Search', 'Set LOOM_AI_SEARCH_SERVICE ...'));
    const res = await INDEX_GET(getReq('idx'));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.deferred).toBe(true);
  });

  it('returns exists:false when index not found', async () => {
    auth();
    (getIndex as any).mockResolvedValue(null);
    const res = await INDEX_GET(getReq('idx'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.exists).toBe(false);
    expect(j.index).toBeNull();
  });

  it('returns the live index on happy path', async () => {
    auth();
    (getIndex as any).mockResolvedValue({ name: 'idx', fields: [{ name: 'id' }] });
    const res = await INDEX_GET(getReq('idx'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.exists).toBe(true);
    expect(j.index.name).toBe('idx');
  });
});

describe('POST /api/items/vector-store/[id]/index', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await INDEX_POST(postReq({ indexName: 'idx', dim: 1536 }));
    expect(res.status).toBe(401);
  });

  it('400 when indexName missing', async () => {
    auth();
    const res = await INDEX_POST(postReq({ dim: 1536 }));
    expect(res.status).toBe(400);
  });

  it('400 when dim < 1', async () => {
    auth();
    const res = await INDEX_POST(postReq({ indexName: 'idx', dim: 0 }));
    expect(res.status).toBe(400);
  });

  it('503 honest gate when backend not deployed', async () => {
    auth();
    (upsertIndex as any).mockRejectedValue(
      new NotDeployedError('Azure AI Search', 'Set LOOM_AI_SEARCH_SERVICE ...'));
    const res = await INDEX_POST(postReq({ indexName: 'idx', dim: 1536 }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.deferred).toBe(true);
  });

  it('creates the index on happy path', async () => {
    auth();
    (upsertIndex as any).mockResolvedValue({ name: 'idx', fields: [{ name: 'id' }, { name: 'embedding' }] });
    const res = await INDEX_POST(postReq({ indexName: 'idx', dim: 1536, metric: 'cosine' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.index.name).toBe('idx');
    expect(upsertIndex).toHaveBeenCalledTimes(1);
    // the real buildVectorIndexDefinition ran and produced a definition
    expect(j.definition).toBeTruthy();
    expect(Array.isArray(j.definition.fields)).toBe(true);
  });
});

describe('POST /api/items/vector-store/[id]/search', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await SEARCH_POST(postReq({ indexName: 'idx', vector: [0.1, 0.2] }));
    expect(res.status).toBe(401);
  });

  it('400 when indexName missing', async () => {
    auth();
    const res = await SEARCH_POST(postReq({ vector: [0.1, 0.2] }));
    expect(res.status).toBe(400);
  });

  it('400 when vector is non-numeric / empty', async () => {
    auth();
    const res = await SEARCH_POST(postReq({ indexName: 'idx', vector: ['a', 'b'] }));
    expect(res.status).toBe(400);
  });

  it('503 honest gate when LOOM_AI_SEARCH_SERVICE unset', async () => {
    auth();
    (vectorSearch as any).mockRejectedValue(
      new NotDeployedError('Azure AI Search', 'Set LOOM_AI_SEARCH_SERVICE ...'));
    const res = await SEARCH_POST(postReq({ indexName: 'idx', vector: [0.1, 0.2] }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.deferred).toBe(true);
  });

  it('returns ranked matches on happy path', async () => {
    auth();
    (vectorSearch as any).mockResolvedValue({
      value: [
        { id: 'a', '@search.score': 0.92, content: 'closest' },
        { id: 'b', '@search.score': 0.71, content: 'next' },
      ],
    });
    const res = await SEARCH_POST(postReq({ indexName: 'idx', vector: [0.1, 0.2, 0.3], k: 5 }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.count).toBe(2);
    expect(j.result.value[0].id).toBe('a');
    expect(vectorSearch).toHaveBeenCalledWith('idx', expect.objectContaining({
      vector: [0.1, 0.2, 0.3], field: 'embedding', k: 5,
    }));
  });

  it('502 on a generic backend failure', async () => {
    auth();
    (vectorSearch as any).mockRejectedValue(new Error('boom'));
    const res = await SEARCH_POST(postReq({ indexName: 'idx', vector: [0.1, 0.2] }));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('boom');
  });

  it('propagates a FoundryError status', async () => {
    auth();
    (vectorSearch as any).mockRejectedValue(new FoundryError(403, 'denied', 'forbidden'));
    const res = await SEARCH_POST(postReq({ indexName: 'idx', vector: [0.1, 0.2] }));
    expect(res.status).toBe(403);
  });
});
