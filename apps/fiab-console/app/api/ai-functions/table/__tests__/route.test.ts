/**
 * Contract tests for POST /api/ai-functions/table — the G2 table/column batch
 * surface (Add-AI-column + Dataflow AI step + schema builder backend).
 *
 *   - 401 unauthenticated
 *   - 400 on an invalid fn / no input rows
 *   - single-column batch: rows + inputColumns → callAiFnBatch over cell values
 *   - multi-column join: inputColumns[] joined as labeled lines
 *   - schema mode: callCustomPromptBatch + JSON split into one column per field
 *   - honest gate: NoAoaiDeploymentError → 501 not_configured (LOOM_AOAI_DEPLOYMENT)
 *   - multimodal gate: image input + no LOOM_AOAI_VISION_DEPLOYMENT → 501
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/copilot-config-store', () => ({
  loadTenantCopilotConfig: vi.fn(async () => null),
}));
vi.mock('@/lib/azure/ai-functions-client', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/ai-functions-client');
  return {
    ...actual,
    callAiFnBatch: vi.fn(),
    callCustomPromptBatch: vi.fn(),
    emitAiFnUsage: vi.fn(async () => {}),
  };
});

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import {
  callAiFnBatch, callCustomPromptBatch, NoAoaiDeploymentError,
} from '@/lib/azure/ai-functions-client';

const req = (body: any) => ({ json: async () => body }) as any;

function batchResult(inputs: string[], make: (s: string) => string) {
  return {
    rows: inputs.map((input, index) => ({ index, input, result: make(input) })),
    model: 'gpt-4o-test',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    failed: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'user-oid' } });
  delete process.env.LOOM_AOAI_VISION_DEPLOYMENT;
});

describe('POST /api/ai-functions/table', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ fn: 'summarize', inputs: ['x'] }));
    expect(res.status).toBe(401);
  });

  it('400 on an invalid fn', async () => {
    const res = await POST(req({ fn: 'nope', inputs: ['x'] }));
    expect(res.status).toBe(400);
  });

  it('400 when there are no input rows', async () => {
    const res = await POST(req({ fn: 'summarize' }));
    expect(res.status).toBe(400);
  });

  it('runs a single-column batch over the cell values', async () => {
    (callAiFnBatch as any).mockImplementation(async (_fn: string, inputs: string[]) =>
      batchResult(inputs, (s) => `S:${s}`),
    );
    const res = await POST(req({
      fn: 'summarize',
      rows: [{ text: 'hello', n: 1 }, { text: 'world', n: 2 }],
      inputColumns: ['text'],
      outputColumn: 'ai_sum',
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.outputColumn).toBe('ai_sum');
    // The batch received the raw cell values, not the whole row object.
    const passedInputs = (callAiFnBatch as any).mock.calls[0][1];
    expect(passedInputs).toEqual(['hello', 'world']);
    expect(j.rows.map((r: any) => r.result)).toEqual(['S:hello', 'S:world']);
  });

  it('joins multiple input columns as labeled lines', async () => {
    (callAiFnBatch as any).mockImplementation(async (_fn: string, inputs: string[]) =>
      batchResult(inputs, (s) => s),
    );
    await POST(req({
      fn: 'classify',
      rows: [{ a: 'x', b: 'y' }],
      inputColumns: ['a', 'b'],
    }));
    const passedInputs = (callAiFnBatch as any).mock.calls[0][1];
    expect(passedInputs).toEqual(['a: x\nb: y']);
  });

  it('schema mode splits the JSON into one column per field', async () => {
    (callCustomPromptBatch as any).mockImplementation(async (_p: string, inputs: string[]) =>
      batchResult(inputs, () => JSON.stringify({ company: 'Acme', amount: '10' })),
    );
    const res = await POST(req({
      fn: 'extract',
      rows: [{ text: 'invoice from Acme for 10' }],
      inputColumns: ['text'],
      schema: [
        { field: 'company', type: 'string', prompt: 'the company' },
        { field: 'amount', type: 'number', prompt: 'the amount' },
      ],
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.outputColumns).toEqual(['company', 'amount']);
    expect(j.rows[0].values).toEqual({ company: 'Acme', amount: '10' });
    expect((callCustomPromptBatch as any)).toHaveBeenCalled();
  });

  it('surfaces the honest gate when no AOAI is deployed', async () => {
    (callAiFnBatch as any).mockImplementation(async () => {
      throw new NoAoaiDeploymentError('no model');
    });
    const res = await POST(req({ fn: 'summarize', inputs: ['x'] }));
    const j = await res.json();
    expect(res.status).toBe(501);
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_AOAI_DEPLOYMENT');
  });

  it('honest-gates a multimodal request with no vision deployment', async () => {
    const res = await POST(req({
      fn: 'classify', inputs: ['https://x/y.png'], inputType: 'image',
    }));
    const j = await res.json();
    expect(res.status).toBe(501);
    expect(j.missing).toBe('LOOM_AOAI_VISION_DEPLOYMENT');
    expect(callAiFnBatch).not.toHaveBeenCalled();
  });

  it('rejects a non-vision function for an image input', async () => {
    const res = await POST(req({ fn: 'translate', inputs: ['x'], inputType: 'image' }));
    expect(res.status).toBe(400);
  });
});
