/**
 * BFF route test for /api/items/report/[id]/ai-visual — Q&A mode (OPEN-REGISTER
 * P1-8a wiring).
 *
 * Proves the ADDITIVE linguistic-schema grounding: when the report's data source
 * resolves to a bound `semantic-model` item that has author-defined synonyms
 * (`state.model.synonyms`), the Q&A system prompt is enriched with a
 * "BUSINESS TERM SYNONYMS" block built by `buildLinguisticSchema`. When the bound
 * model has NO synonyms (or the lookup fails), the prompt is byte-identical to
 * the pre-wiring baseline captured in `noSynonymsPrompt` below.
 *
 * `@/lib/azure/linguistic-schema` is mocked ONLY for `readSynonyms` (via
 * importOriginal) so `buildLinguisticSchema` / `validateSynonyms` run for real —
 * this proves actual end-to-end projection, not a stubbed shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1', upn: 'u@x.com' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const aoaiCompleteJsonMock = vi.fn(async (..._a: any[]) => ({
  type: 'card',
  title: 'Total revenue',
  wells: { values: [{ measure: 'Total Sales' }] },
}));
vi.mock('@/lib/azure/copilot-orchestrator', () => {
  class NoAoaiDeploymentError extends Error {}
  return {
    resolveAoaiTarget: vi.fn(async () => ({ deployment: 'gpt' })),
    NoAoaiDeploymentError,
    aoaiCompleteJson: (...a: any[]) => aoaiCompleteJsonMock(...a),
  };
});

vi.mock('@/lib/azure/copilot-config-store', () => ({
  loadTenantCopilotConfig: vi.fn(async () => ({})),
}));

const isLoomContentIdMock = vi.fn(() => false);
vi.mock('../../../../_lib/pbi-content-fallback', () => ({
  isLoomContentId: (...a: any[]) => isLoomContentIdMock(...a),
  cosmosIdFromLoomId: (id: string) => id,
  loadContentBackedItem: vi.fn(async () => null),
}));

let fakeReportItem: any = null;
const loadModelItemMock = vi.fn(async () => fakeReportItem);
vi.mock('@/lib/azure/model-binding', () => ({
  loadModelItem: (...a: any[]) => loadModelItemMock(...a),
}));

let synonymsToReturn: Array<{ objectType: string; object: string; table?: string; terms: string[]; weight?: number }> = [];
let readSynonymsShouldThrow = false;
const readSynonymsMock = vi.fn(async () => {
  if (readSynonymsShouldThrow) throw new Error('cosmos boom');
  return { synonyms: synonymsToReturn, itemFound: true };
});
vi.mock('@/lib/azure/linguistic-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/azure/linguistic-schema')>();
  return { ...actual, readSynonyms: (...a: any[]) => readSynonymsMock(...(a as [string, string, string])) };
});

import { POST } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'report-1' }) };
function qaReq(fields: unknown, question = 'total revenue'): NextRequest {
  return new NextRequest('http://localhost/api/items/report/report-1/ai-visual', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'qa', question, fields }),
  });
}

const FIELDS = { tables: [{ name: 'Sales', columns: [{ name: 'Amount' }], measures: [{ name: 'Total Sales' }] }] };

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', upn: 'u@x.com' } } as any);
  isLoomContentIdMock.mockReturnValue(false);
  synonymsToReturn = [];
  readSynonymsShouldThrow = false;
  aoaiCompleteJsonMock.mockClear();
  readSynonymsMock.mockClear();
  fakeReportItem = {
    id: 'report-1',
    workspaceId: 'ws-1',
    itemType: 'report',
    displayName: 'Sales report',
    state: { dataSource: { kind: 'semantic-model', itemId: 'sm-1' } },
    createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
});

function systemContent(): string {
  const call = aoaiCompleteJsonMock.mock.calls[0];
  const messages = call[0] as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === 'system')!.content;
}

describe('report ai-visual Q&A — linguistic-schema grounding (additive)', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(qaReq(FIELDS), PARAMS);
    expect(res.status).toBe(401);
  });

  it('404 when the report is not owned', async () => {
    fakeReportItem = null;
    const res = await POST(qaReq(FIELDS), PARAMS);
    expect(res.status).toBe(404);
  });

  it('no synonyms on the bound model → prompt has no BUSINESS TERM SYNONYMS block (byte-identical baseline)', async () => {
    synonymsToReturn = [];
    const res = await POST(qaReq(FIELDS), PARAMS);
    expect(res.status).toBe(200);
    expect(readSynonymsMock).toHaveBeenCalledWith('sm-1', 'semantic-model', 'oid-1');
    expect(systemContent()).not.toContain('BUSINESS TERM SYNONYMS');
  });

  it('synonyms present on the bound model → prompt is enriched with the projected linguistic schema', async () => {
    synonymsToReturn = [
      { objectType: 'measure', object: 'Total Sales', terms: ['revenue', 'turnover'], weight: 0.9 },
    ];
    const res = await POST(qaReq(FIELDS), PARAMS);
    expect(res.status).toBe(200);
    const content = systemContent();
    expect(content).toContain('BUSINESS TERM SYNONYMS');
    expect(content).toContain('"revenue" → [Total Sales]');
    expect(content).toContain('"turnover" → [Total Sales]');
  });

  it('bound-model lookup failure degrades to no enrichment (never blocks Q&A)', async () => {
    readSynonymsShouldThrow = true;
    const res = await POST(qaReq(FIELDS), PARAMS);
    expect(res.status).toBe(200);
    expect(systemContent()).not.toContain('BUSINESS TERM SYNONYMS');
  });

  it('no bound semantic-model data source (e.g. a Get Data connection source) → no enrichment, no lookup', async () => {
    fakeReportItem.state = { dataSource: { kind: 'connection', connectionId: 'c1', connType: 'azure-sql', objectRef: { mode: 'table', table: 't' } } };
    const res = await POST(qaReq(FIELDS), PARAMS);
    expect(res.status).toBe(200);
    expect(readSynonymsMock).not.toHaveBeenCalled();
    expect(systemContent()).not.toContain('BUSINESS TERM SYNONYMS');
  });
});
