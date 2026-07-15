/**
 * Backend contract tests for /api/lakehouse/ai-clean-suggest (G4 Data Wrangler
 * AI cleaning-suggestion generator). Real Azure OpenAI only, honest no_aoai gate.
 *
 *   POST  401 (no session) / 400 (no columns) / 503 no_aoai gate /
 *         happy path (validates + sanitizes model suggestions) /
 *         drops suggestions with unknown kinds, unknown columns, or empty code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/copilot-config-store', () => ({ loadTenantCopilotConfig: vi.fn(async () => null) }));
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: vi.fn(),
  NoAoaiDeploymentError: class NoAoaiDeploymentError extends Error {},
}));
vi.mock('@/lib/azure/aoai-chat-client', () => ({ aoaiChatJson: vi.fn() }));

import { POST } from '../ai-clean-suggest/route';
import { getSession } from '@/lib/auth/session';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';

function postReq(body: any) { return { json: async () => body } as any; }
const sess = { claims: { oid: 'o1', upn: 'u@x' } };

beforeEach(() => {
  vi.clearAllMocks();
  (loadTenantCopilotConfig as any).mockResolvedValue(null);
  (resolveAoaiTarget as any).mockResolvedValue({ endpoint: 'https://x', deployment: 'gpt-4o-mini' });
});

describe('POST /api/lakehouse/ai-clean-suggest', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(postReq({ columns: ['a'] }))).status).toBe(401);
  });

  it('400 without columns', async () => {
    (getSession as any).mockReturnValue(sess);
    expect((await POST(postReq({}))).status).toBe(400);
  });

  it('503 no_aoai when no chat deployment', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveAoaiTarget as any).mockRejectedValue(new (NoAoaiDeploymentError as any)('no deployment'));
    const res = await POST(postReq({ columns: ['a'] }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('no_aoai');
    expect(j.hint).toBeTruthy();
  });

  it('returns validated + sanitized suggestions on the happy path', async () => {
    (getSession as any).mockReturnValue(sess);
    (aoaiChatJson as any).mockResolvedValue({
      suggestions: [
        { kind: 'trim', column: 'name', title: 'Trim name', rationale: 'spaces', severity: 'info',
          code: '```python\ndf = df.withColumn("name", F.trim(F.col("name")))\n```' },
        { kind: 'fill-null', column: 'age', title: 'Fill age', severity: 'warning',
          code: 'df = df.fillna({"age": 0})' },
        // dropped — unknown kind
        { kind: 'nonsense', column: 'name', code: 'df = df' },
        // dropped — unknown column
        { kind: 'cast', column: 'ghost', code: 'df = df' },
        // dropped — empty code
        { kind: 'dedupe', column: 'name', code: '' },
      ],
    });
    const res = await POST(postReq({ columns: ['name', 'age'], stats: { age: { nullCount: 3 } } }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.engine).toBe('aoai');
    expect(j.suggestions).toHaveLength(2);
    // fences stripped from the first suggestion's code
    expect(j.suggestions[0].code).not.toContain('```');
    expect(j.suggestions[0].kind).toBe('trim');
    expect(j.suggestions[1].kind).toBe('fill-null');
  });

  it('rewrites the DataFrame variable when dataframeVar != df', async () => {
    (getSession as any).mockReturnValue(sess);
    (aoaiChatJson as any).mockResolvedValue({
      suggestions: [{ kind: 'trim', column: 'name', code: 'df = df.withColumn("name", F.trim(F.col("name")))' }],
    });
    const res = await POST(postReq({ columns: ['name'], dataframeVar: 'sales' }));
    const j = await res.json();
    expect(j.dataframeVar).toBe('sales');
    expect(j.suggestions[0].code).toContain('sales = sales.withColumn');
    expect(j.suggestions[0].code).not.toMatch(/\bdf\b/);
  });
});
