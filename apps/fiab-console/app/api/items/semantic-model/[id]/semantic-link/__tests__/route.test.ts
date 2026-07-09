/**
 * BFF route test for /api/items/semantic-model/[id]/semantic-link (FGC-17).
 * All Azure/Cosmos deps are mocked — no live backend.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const listTablesMock = vi.fn(async (..._a: any[]) => [
  { name: 'Sales', columns: [{ name: 'CustomerKey', dataType: 'int64' }, { name: 'Amount', dataType: 'double' }], measureNames: ['Total Sales'] },
  { name: 'Customer', columns: [{ name: 'CustomerKey', dataType: 'int64' }], measureNames: [] },
]);
const listMeasuresMock = vi.fn(async (..._a: any[]) => [
  { name: 'Total Sales', table: 'Sales', expression: 'SUM(Sales[Amount])' },
]);
const evalDaxMock = vi.fn(async (..._a: any[]) => ({ columns: ['Total Sales'], rows: [{ 'Total Sales': 42 }], backend: 'loom-native', sql: 'SELECT ...' }));
vi.mock('@/lib/azure/tabular-eval-client', () => {
  class TabularError extends Error {
    status?: number; backend?: string; hint?: string;
    constructor(message: string, status?: number, backend?: string, hint?: string) {
      super(message); this.name = 'TabularError'; this.status = status; this.backend = backend; this.hint = hint;
    }
  }
  return {
    listTables: (...a: any[]) => listTablesMock(...a),
    listMeasures: (...a: any[]) => listMeasuresMock(...a),
    evalDax: (...a: any[]) => evalDaxMock(...a),
    resolveBackend: () => 'loom-native',
    TabularError,
  };
});
import { TabularError } from '@/lib/azure/tabular-eval-client';

const readModelStateMock = vi.fn(async (..._a: any[]) => ({
  state: { relationships: [], measures: [], dateTables: [] },
  itemFound: true,
}));
vi.mock('@/app/api/items/_lib/model-store', () => ({
  readModelState: (...a: any[]) => readModelStateMock(...a),
}));

import { GET, POST } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'model-1' }) };
function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/semantic-model/model-1/semantic-link', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
function get(): NextRequest {
  return new NextRequest('http://localhost/api/items/semantic-model/model-1/semantic-link');
}

beforeEach(() => { getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any); evalDaxMock.mockClear(); });

describe('semantic-link route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await GET(get(), PARAMS);
    expect(res.status).toBe(401);
  });

  it('GET returns tables, measures and relationships', async () => {
    const res = await GET(get(), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.tables).toHaveLength(2);
    expect(j.measures[0].name).toBe('Total Sales');
    expect(j.backend).toBe('loom-native');
  });

  it('POST evaluate-dax runs the query through evalDax', async () => {
    const res = await POST(post({ op: 'evaluate-dax', dax: 'EVALUATE Sales' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.rows[0]['Total Sales']).toBe(42);
    expect(evalDaxMock).toHaveBeenCalledWith('model-1', 'EVALUATE Sales', 'oid-1', undefined);
  });

  it('POST add-measure resolves the measure and builds ROW DAX', async () => {
    const res = await POST(post({ op: 'add-measure', measure: 'Total Sales' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.dax).toBe('EVALUATE ROW("Total Sales", CALCULATE(SUM(Sales[Amount])))');
    expect(j.measure).toBe('Total Sales');
  });

  it('POST add-measure 404s for an unknown measure', async () => {
    const res = await POST(post({ op: 'add-measure', measure: 'Nope' }), PARAMS);
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.available).toContain('Total Sales');
  });

  it('POST validate-relationships reports the analyzer findings', async () => {
    const res = await POST(post({ op: 'validate-relationships' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true); // missing FK is a warning, not an error
    // Sales + Customer share CustomerKey with no relationship → a missing-FK finding.
    expect(j.findings.some((f: any) => f.rule === 'missing-relationship')).toBe(true);
  });

  it('surfaces a TabularError with its status and hint (honest gate)', async () => {
    evalDaxMock.mockRejectedValueOnce(new TabularError('unsupported DAX', 400, 'loom-native', 'use AAS'));
    const res = await POST(post({ op: 'evaluate-dax', dax: 'EVALUATE FILTER(x)' }), PARAMS);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('unsupported DAX');
    expect(j.hint).toBe('use AAS');
  });

  it('400 for an unknown op', async () => {
    const res = await POST(post({ op: 'bogus' }), PARAMS);
    expect(res.status).toBe(400);
  });
});
