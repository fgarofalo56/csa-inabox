/**
 * BFF route tests for /api/copilot/sessions/[id] — the Feedback (thumbs) +
 * clear-chat surface.
 *
 *   DELETE → "Clear chat": deletes this user's session doc (idempotent;
 *            ownership-checked). 401 unauthed, 403 cross-user, 204 happy/missing.
 *   PATCH  → per-message thumbs up/down: writes a real Cosmos feedback doc to
 *            copilot-feedback (PK /sessionId). 400 on bad rating / missing index.
 *
 * Cosmos + identity are mocked — no live Azure. Asserts the real Cosmos calls
 * (delete / items.create) fire with the right partition key + payload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' } }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// getSession from the orchestrator is only used by the GET handler.
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  getSession: vi.fn(async () => null),
}));

const deleteMock = vi.fn(async () => ({}));
const readMock = vi.fn(async () => ({ resource: { id: 'sess-1', sessionId: 'sess-1', userOid: 'oid-test' } }));
const feedbackCreateMock = vi.fn(async () => ({ resource: {} }));

const sessionsContainerMock = vi.fn(async () => ({
  item: () => ({ read: readMock, delete: deleteMock }),
}));
const feedbackContainerMock = vi.fn(async () => ({
  items: { create: feedbackCreateMock },
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  copilotSessionsContainer: () => sessionsContainerMock(),
  copilotFeedbackContainer: () => feedbackContainerMock(),
}));

function req(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/copilot/sessions/sess-1', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' } } as any);
  readMock.mockResolvedValue({ resource: { id: 'sess-1', sessionId: 'sess-1', userOid: 'oid-test' } });
  deleteMock.mockResolvedValue({});
  feedbackCreateMock.mockResolvedValue({ resource: {} });
});
afterEach(() => { vi.clearAllMocks(); vi.resetModules(); });

describe('DELETE /api/copilot/sessions/[id] — clear chat', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { DELETE } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await DELETE(req('DELETE'), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(401);
  });

  it('204 + real Cosmos delete on the owner happy path', async () => {
    const { DELETE } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await DELETE(req('DELETE'), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(204);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('403 when the session belongs to another user (no delete)', async () => {
    readMock.mockResolvedValueOnce({ resource: { id: 'sess-1', sessionId: 'sess-1', userOid: 'someone-else' } });
    const { DELETE } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await DELETE(req('DELETE'), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('204 (idempotent) when the session does not exist', async () => {
    readMock.mockResolvedValueOnce({ resource: null });
    const { DELETE } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await DELETE(req('DELETE'), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(204);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/copilot/sessions/[id] — thumbs feedback', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { PATCH } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await PATCH(req('PATCH', { rating: 'up', messageIndex: 0 }), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(401);
  });

  it('writes a real feedback doc with sessionId PK + rating on thumbs-down', async () => {
    const { PATCH } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await PATCH(req('PATCH', { rating: 'down', messageIndex: 1, improvement: 'wrong KQL' }), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(typeof j.feedbackId).toBe('string');
    expect(feedbackCreateMock).toHaveBeenCalledTimes(1);
    const doc = feedbackCreateMock.mock.calls[0][0] as any;
    expect(doc.sessionId).toBe('sess-1');
    expect(doc.rating).toBe('down');
    expect(doc.messageIndex).toBe(1);
    expect(doc.userOid).toBe('oid-test');
    expect(doc.improvement).toBe('wrong KQL');
  });

  it('400 on an invalid rating', async () => {
    const { PATCH } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await PATCH(req('PATCH', { rating: 'meh', messageIndex: 0 }), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(400);
    expect(feedbackCreateMock).not.toHaveBeenCalled();
  });

  it('400 when messageIndex is missing', async () => {
    const { PATCH } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await PATCH(req('PATCH', { rating: 'up' }), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(400);
    expect(feedbackCreateMock).not.toHaveBeenCalled();
  });
});
