/**
 * BFF route test for /api/items/semantic-model/[id]/model-health (FGC-22).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const listTablesMock = vi.fn(async (..._a: any[]) => [
  { name: 'Sales', columns: [{ name: 'CustomerKey', dataType: 'int64' }, { name: 'Amount', dataType: 'double' }], measureNames: [] },
  { name: 'Customer', columns: [{ name: 'CustomerKey', dataType: 'int64' }, { name: 'Name', dataType: 'string' }], measureNames: [] },
  { name: 'Calendar', columns: [{ name: 'Date', dataType: 'dateTime' }], measureNames: [] },
]);
vi.mock('@/lib/azure/tabular-eval-client', () => ({
  listTables: (...a: any[]) => listTablesMock(...a),
  resolveBackend: () => 'loom-native',
}));

const readModelStateMock = vi.fn(async (..._a: any[]) => ({
  state: {
    relationships: [],
    measures: [{ id: 'm1', name: 'Total Sales', expression: 'SUM(Sales[Amount])', description: '', kind: 'cosmos', createdAt: '', updatedAt: '' }],
    dateTables: [],
  },
  itemFound: true,
}));
const writeModelStateMock = vi.fn(async (..._a: any[]) => true);
vi.mock('@/app/api/items/_lib/model-store', () => ({
  readModelState: (...a: any[]) => readModelStateMock(...a),
  writeModelState: (...a: any[]) => writeModelStateMock(...a),
}));

const captureCheckpointMock = vi.fn(async (..._a: any[]) => ({ id: 'cp-1', label: 'before', createdAt: new Date().toISOString(), source: 'copilot', stats: { measures: 1, relationships: 0 } }));
const listCheckpointsMock = vi.fn(async (..._a: any[]) => [{ id: 'cp-1', label: 'before', createdAt: new Date().toISOString() }]);
const restoreCheckpointMock = vi.fn(async (..._a: any[]) => ({ model: { measures: [], relationships: [] }, restoredFrom: { label: 'before', stats: { measures: 1, relationships: 0 } } }));
vi.mock('@/app/api/items/_lib/semantic-model-checkpoints', () => ({
  captureCheckpoint: (...a: any[]) => captureCheckpointMock(...a),
  listCheckpoints: (...a: any[]) => listCheckpointsMock(...a),
  restoreCheckpoint: (...a: any[]) => restoreCheckpointMock(...a),
}));

const aoaiChatMock = vi.fn(async (..._a: any[]) => JSON.stringify({ descriptions: { 'Total Sales': 'Sum of sales amount across all orders.' } }));
vi.mock('@/lib/azure/aoai-chat-client', () => ({ aoaiChat: (...a: any[]) => aoaiChatMock(...a) }));
vi.mock('@/lib/azure/copilot-config-store', () => ({ loadTenantCopilotConfig: vi.fn(async (..._a: any[]) => null) }));

import { GET, POST } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'model-1' }) };
function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/semantic-model/model-1/model-health', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
function getReq(action: string): NextRequest {
  return new NextRequest(`http://localhost/api/items/semantic-model/model-1/model-health?action=${action}`);
}
beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  aoaiChatMock.mockClear(); captureCheckpointMock.mockClear(); writeModelStateMock.mockClear();
});

describe('model-health route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ action: 'scan' }), PARAMS);
    expect(res.status).toBe(401);
  });

  it('scan returns findings + a fixable count', async () => {
    const res = await POST(post({ action: 'scan' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.findings.some((f: any) => f.rule === 'missing-relationship')).toBe(true);
    expect(j.findings.some((f: any) => f.rule === 'unmarked-date-table')).toBe(true);
    expect(j.fixable).toBeGreaterThan(0);
  });

  it('scan enriches a measure description via AOAI', async () => {
    const res = await POST(post({ action: 'scan' }), PARAMS);
    const j = await res.json();
    const desc = j.findings.find((f: any) => f.rule === 'measure-no-description');
    expect(desc.fix.description).toContain('Sum of sales');
    expect(aoaiChatMock).toHaveBeenCalled();
  });

  it('scan degrades to a rule-only result with a gate when AOAI fails', async () => {
    aoaiChatMock.mockRejectedValueOnce(new Error('no aoai'));
    const res = await POST(post({ action: 'scan' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.gate).toBeTruthy();
    // The description fix is dropped (no text) but the rule findings remain.
    const desc = j.findings.find((f: any) => f.rule === 'measure-no-description');
    expect(desc.fix).toBeUndefined();
  });

  it('apply captures a checkpoint then writes the model', async () => {
    const fixes = [{ kind: 'mark-date-table', table: 'Calendar', dateColumn: 'Date' }];
    const res = await POST(post({ action: 'apply', fixes }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(captureCheckpointMock).toHaveBeenCalledOnce();
    expect(writeModelStateMock).toHaveBeenCalledOnce();
    expect(j.applied.length).toBe(1);
  });

  it('apply 400s when no valid fixes are supplied', async () => {
    const res = await POST(post({ action: 'apply', fixes: [{ kind: 'bogus' }] }), PARAMS);
    expect(res.status).toBe(400);
    expect(captureCheckpointMock).not.toHaveBeenCalled();
  });

  it('restore delegates to restoreCheckpoint', async () => {
    const res = await POST(post({ action: 'restore', checkpointId: 'cp-1' }), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(restoreCheckpointMock).toHaveBeenCalledWith('model-1', 'semantic-model', 'oid-1', 'cp-1');
  });

  it('GET ?action=checkpoints lists checkpoints', async () => {
    const res = await GET(getReq('checkpoints'), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.checkpoints).toHaveLength(1);
  });
});
