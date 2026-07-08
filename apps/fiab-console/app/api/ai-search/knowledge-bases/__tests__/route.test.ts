/**
 * BFF contract tests for the agentic-retrieval routes:
 *   /api/ai-search/knowledge-bases            (GET list / POST create / DELETE)
 *   /api/ai-search/knowledge-bases/{name}/retrieve (POST)
 *
 * Pins: 401 unauthenticated, 503 honest-gate when AI Search unconfigured,
 * 400 validation, and that the route delegates to the real client with the
 * expected shape (per no-vaporware.md — the route calls a real backend, never
 * returns mock data).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const listBasesMock = vi.fn();
const createBaseMock = vi.fn();
const deleteBaseMock = vi.fn();
const retrieveMock = vi.fn();
let configured = true;

vi.mock('@/lib/azure/aisearch-knowledge', async (orig) => {
  const actual = await (orig as any)();
  return {
    ...actual,
    listKnowledgeBases: (...a: unknown[]) => listBasesMock(...a),
    createKnowledgeBase: (...a: unknown[]) => createBaseMock(...a),
    deleteKnowledgeBase: (...a: unknown[]) => deleteBaseMock(...a),
    retrieveKnowledge: (...a: unknown[]) => retrieveMock(...a),
    knowledgeGovGate: () => null,
    searchConfigGate: () => (configured ? null : { missing: 'LOOM_AI_SEARCH_SERVICE' }),
  };
});

import { GET, POST, DELETE } from '../route';
import { POST as RETRIEVE } from '../[name]/retrieve/route';

function jsonReq(body: unknown, search = '') {
  return {
    json: async () => body,
    nextUrl: { searchParams: new URLSearchParams(search) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  configured = true;
  getSessionMock.mockReturnValue({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 } as any);
});

describe('GET /api/ai-search/knowledge-bases', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('503 honest-gate when AI Search unconfigured', async () => {
    configured = false;
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code: 'not_configured', missing: 'LOOM_AI_SEARCH_SERVICE' });
  });

  it('lists knowledge bases from the real client', async () => {
    listBasesMock.mockResolvedValue([{ name: 'kb1', knowledgeSources: ['ks1'] }]);
    const res = await GET();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.knowledgeBases[0].name).toBe('kb1');
  });
});

describe('POST /api/ai-search/knowledge-bases', () => {
  it('400 when name or sources missing', async () => {
    const res = await POST(jsonReq({ name: '' }));
    expect(res.status).toBe(400);
  });

  it('creates a base via the real client (extractive default)', async () => {
    createBaseMock.mockResolvedValue({ name: 'kb1' });
    const res = await POST(jsonReq({ name: 'kb1', knowledgeSources: ['ks1', 'ks2'], reasoningEffort: 'low' }));
    expect(res.status).toBe(200);
    expect(createBaseMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'kb1', knowledgeSources: ['ks1', 'ks2'], outputMode: 'extractiveData', reasoningEffort: 'low',
    }));
  });
});

describe('DELETE /api/ai-search/knowledge-bases', () => {
  it('400 without a name param', async () => {
    const res = await DELETE(jsonReq({}, ''));
    expect(res.status).toBe(400);
  });

  it('deletes by name', async () => {
    deleteBaseMock.mockResolvedValue(undefined);
    const res = await DELETE(jsonReq({}, 'name=kb1'));
    expect(res.status).toBe(200);
    expect(deleteBaseMock).toHaveBeenCalledWith('kb1');
  });
});

describe('POST /api/ai-search/knowledge-bases/{name}/retrieve', () => {
  const params = { params: Promise.resolve({ name: 'kb1' }) };

  it('400 when query is empty', async () => {
    const res = await RETRIEVE(jsonReq({ query: '  ' }), params);
    expect(res.status).toBe(400);
  });

  it('runs retrieval via the real client and returns the normalized result', async () => {
    retrieveMock.mockResolvedValue({ answer: 'grounding', answerIsExtractive: true, subqueries: [], citations: [], partial: false, apiVersion: '2026-04-01' });
    const res = await RETRIEVE(jsonReq({ query: 'why is X', synthesize: false }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.answer).toBe('grounding');
    expect(retrieveMock).toHaveBeenCalledWith('kb1', expect.objectContaining({ query: 'why is X', synthesize: false }));
  });

  it('503 honest-gate on retrieve when unconfigured', async () => {
    configured = false;
    const res = await RETRIEVE(jsonReq({ query: 'q' }), params);
    expect(res.status).toBe(503);
  });
});
