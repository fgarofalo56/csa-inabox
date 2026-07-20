/**
 * BFF route test for /api/items/semantic-model/[id]/dax-query (FGC-21).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const evalDaxMock = vi.fn(async (..._a: any[]) => ({ columns: ['Amount'], rows: [{ Amount: 10 }], backend: 'loom-native' }));
// Default: a model WITH authored content, so the empty-model 412 gate does not
// fire and the pre-gate tests exercise the same paths as before.
const getModelItemMock = vi.fn(async (..._a: any[]) => ({
  id: 'model-1',
  displayName: 'Model 1',
  state: { content: { kind: 'semantic-model', tables: [{ name: 'Sales', columns: [{ name: 'Amount', dataType: 'decimal' }] }] } },
} as any));
vi.mock('@/lib/azure/tabular-eval-client', () => {
  class TabularError extends Error {
    status?: number; backend?: string; hint?: string;
    constructor(message: string, status?: number, backend?: string, hint?: string) {
      super(message); this.name = 'TabularError'; this.status = status; this.backend = backend; this.hint = hint;
    }
  }
  return {
    evalDax: (...a: any[]) => evalDaxMock(...a),
    resolveBackend: () => 'loom-native',
    getModelItem: (...a: any[]) => getModelItemMock(...a),
    TabularError,
  };
});
import { TabularError } from '@/lib/azure/tabular-eval-client';

const writeModelStateMock = vi.fn(async (..._a: any[]) => true);
vi.mock('@/app/api/items/_lib/model-store', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual, // keep the real normalizeMeasure / upsertMeasure (pure)
    readModelState: vi.fn(async (..._a: any[]) => ({ state: { relationships: [], measures: [] }, itemFound: true })),
    writeModelState: (...a: any[]) => writeModelStateMock(...a),
  };
});

import { POST } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'model-1' }) };
function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/semantic-model/model-1/dax-query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
beforeEach(() => { getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any); evalDaxMock.mockClear(); writeModelStateMock.mockClear(); getModelItemMock.mockClear(); });

describe('dax-query route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ op: 'run', dax: 'EVALUATE Sales' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('rejects a non-DAX query', async () => {
    const res = await POST(post({ op: 'run', dax: 'SELECT 1' }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('runs a DAX query through evalDax', async () => {
    const res = await POST(post({ op: 'run', dax: 'EVALUATE Sales' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.rows[0].Amount).toBe(10);
  });

  it('saves a measure to the model store', async () => {
    const res = await POST(post({ op: 'save-measure', name: 'Total_Sales', expression: 'SUM(Sales[Amount])' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.measure.name).toBe('Total_Sales');
    expect(writeModelStateMock).toHaveBeenCalledOnce();
  });

  it('400s an invalid measure name', async () => {
    const res = await POST(post({ op: 'save-measure', name: '1bad name', expression: 'SUM(x)' }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('412 honest gate on an EMPTY model (0 tables/measures, no AAS binding) — never the DAX-patterns help', async () => {
    getModelItemMock.mockResolvedValueOnce({ id: 'model-1', displayName: 'Empty Model', state: {} } as any);
    const res = await POST(post({ op: 'run', dax: 'EVALUATE Sales' }), PARAMS);
    expect(res.status).toBe(412);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('unbound');
    expect(j.error).toBe(
      'Semantic model "Empty Model" has no Loom-native content or AAS binding to query. ' +
        'Open it and define tables/measures (or bind it to Azure Analysis Services), then retry.',
    );
    expect(j.gate.reason).toContain('no tables or measures yet');
    expect(j.gate.remediation).toContain('define tables/measures');
    expect(evalDaxMock).not.toHaveBeenCalled();
  });

  it('does NOT gate an AAS-bound model with no Loom-native content', async () => {
    getModelItemMock.mockResolvedValueOnce({ id: 'model-1', displayName: 'AAS Model', state: { aasServer: 'asazure://x/y' } } as any);
    const res = await POST(post({ op: 'run', dax: 'EVALUATE Sales' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(evalDaxMock).toHaveBeenCalledOnce();
  });

  it('404 when the model item is not found/owned', async () => {
    getModelItemMock.mockResolvedValueOnce(null as any);
    const res = await POST(post({ op: 'run', dax: 'EVALUATE Sales' }), PARAMS);
    expect(res.status).toBe(404);
    expect(evalDaxMock).not.toHaveBeenCalled();
  });

  it('surfaces a TabularError honestly', async () => {
    evalDaxMock.mockRejectedValueOnce(new TabularError('unsupported', 400, 'loom-native'));
    const res = await POST(post({ op: 'run', dax: 'EVALUATE FILTER(x)' }), PARAMS);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('unsupported');
  });
});
