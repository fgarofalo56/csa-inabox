/**
 * BFF route test for POST /api/notebook/[id]/wrangler-ai (FGC-16).
 * Asserts: auth gate, action validation, rule-only suggestions, AOAI-augmented
 * suggestions (gallery-validated), NL codegen (gallery-validated steps), and the
 * honest 503 no_aoai gate for codegen. AOAI + session are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

class NoAoaiDeploymentError extends Error {
  constructor(m: string) { super(m); this.name = 'NoAoaiDeploymentError'; }
}
const resolveAoaiTargetMock = vi.fn(async () => ({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' }));
vi.mock('@/lib/azure/copilot-orchestrator', async (importOriginal) => ({
  ...(await importOriginal() as any),
  resolveAoaiTarget: (...a: any[]) => resolveAoaiTargetMock(...(a as [])),
  NoAoaiDeploymentError,
}));
vi.mock('@/lib/azure/copilot-config-store', () => ({ loadTenantCopilotConfig: vi.fn(async () => null) }));

const aoaiChatJsonMock = vi.fn();
vi.mock('@/lib/azure/aoai-chat-client', () => ({ aoaiChatJson: (...a: any[]) => aoaiChatJsonMock(...a) }));

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/notebook/nb-1/wrangler-ai', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: 'nb-1' }) };

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  resolveAoaiTargetMock.mockResolvedValue({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' });
  aoaiChatJsonMock.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe('POST /api/notebook/[id]/wrangler-ai', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/notebook/[id]/wrangler-ai/route');
    const r = await POST(post({ action: 'suggest', columns: ['a'] }), ctx);
    expect(r.status).toBe(401);
  });

  it('400 on an unknown action', async () => {
    const { POST } = await import('@/app/api/notebook/[id]/wrangler-ai/route');
    const r = await POST(post({ action: 'nope', columns: ['a'] }), ctx);
    expect(r.status).toBe(400);
  });

  it('returns rule-based suggestions without AOAI (useAi:false)', async () => {
    const { POST } = await import('@/app/api/notebook/[id]/wrangler-ai/route');
    const r = await POST(post({
      action: 'suggest',
      columns: ['Age'],
      rows: [{ Age: '1' }, { Age: '' }],
      summary: [{ name: 'Age', dtype: 'object', missing: 1, unique: 1 }],
      rowCount: 2,
      useAi: false,
    }), ctx);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.aiUsed).toBe(false);
    expect(j.suggestions.length).toBeGreaterThan(0);
    expect(aoaiChatJsonMock).not.toHaveBeenCalled();
  });

  it('merges gallery-validated AOAI suggestions when useAi:true', async () => {
    aoaiChatJsonMock.mockResolvedValue({
      suggestions: [
        { title: 'One-hot City', rationale: 'low cardinality', category: 'Schema', step: { op: 'one_hot_encode', columns: ['City'] } },
        { title: 'bad', rationale: 'x', category: 'Schema', step: { op: 'made_up_op' } }, // dropped by validation
      ],
    });
    const { POST } = await import('@/app/api/notebook/[id]/wrangler-ai/route');
    const r = await POST(post({
      action: 'suggest',
      columns: ['City'],
      rows: [{ City: 'A' }, { City: 'B' }],
      summary: [{ name: 'City', dtype: 'object', missing: 0, unique: 2 }],
      rowCount: 2,
      useAi: true,
    }), ctx);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.aiUsed).toBe(true);
    const ai = j.suggestions.filter((x: any) => x.source === 'ai');
    expect(ai).toHaveLength(1);
    expect(ai[0].step.op).toBe('one_hot_encode');
  });

  it('degrades to rule-only with a gate note when AOAI is unconfigured (suggest)', async () => {
    resolveAoaiTargetMock.mockRejectedValue(new NoAoaiDeploymentError('no model'));
    const { POST } = await import('@/app/api/notebook/[id]/wrangler-ai/route');
    const r = await POST(post({
      action: 'suggest', columns: ['Age'], rows: [{ Age: '' }],
      summary: [{ name: 'Age', dtype: 'object', missing: 1, unique: 0 }], rowCount: 1, useAi: true,
    }), ctx);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.aiUsed).toBe(false);
    expect(j.aiGate).toMatch(/not configured/i);
  });

  it('codegen returns gallery-validated steps + explanation', async () => {
    aoaiChatJsonMock.mockResolvedValue({
      steps: [
        { op: 'drop_missing', columns: ['Age'], how: 'any' },
        { op: 'change_case', column: 'Name', mode: 'title' },
        { op: 'not_a_real_op' }, // dropped
      ],
      explanation: 'Drop missing ages, then title-case names.',
    });
    const { POST } = await import('@/app/api/notebook/[id]/wrangler-ai/route');
    const r = await POST(post({
      action: 'codegen', prompt: 'drop rows missing age then title-case name',
      columns: ['Age', 'Name'], rows: [{ Age: '1', Name: 'bob' }], summary: [],
    }), ctx);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.steps.map((s: any) => s.op)).toEqual(['drop_missing', 'change_case']);
    expect(j.rejected).toHaveLength(1);
    expect(j.explanation).toMatch(/title-case/);
  });

  it('codegen honest 503 gate when AOAI is unconfigured', async () => {
    resolveAoaiTargetMock.mockRejectedValue(new NoAoaiDeploymentError('no model'));
    const { POST } = await import('@/app/api/notebook/[id]/wrangler-ai/route');
    const r = await POST(post({ action: 'codegen', prompt: 'x', columns: ['a'] }), ctx);
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.code).toBe('no_aoai');
  });

  it('codegen 400 without a prompt', async () => {
    const { POST } = await import('@/app/api/notebook/[id]/wrangler-ai/route');
    const r = await POST(post({ action: 'codegen', columns: ['a'] }), ctx);
    expect(r.status).toBe(400);
  });
});
