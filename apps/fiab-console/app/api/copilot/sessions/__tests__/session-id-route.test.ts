/**
 * BFF route tests for /api/copilot/sessions/[id] — the session detail, rename /
 * pin, Feedback (thumbs) and clear-chat surfaces.
 *
 *   GET    → session detail. 404 missing, 403 cross-user, 403 UNOWNED (#3943).
 *   PATCH  → rename / pin via the real `updateSessionMeta`. 403 cross-user,
 *            403 UNOWNED (#3943).
 *   DELETE → "Clear chat": deletes this user's session doc (idempotent;
 *            ownership-checked). 401 unauthed, 403 cross-user, 403 UNOWNED
 *            (#3943), 204 happy/missing.
 *   PATCH  → per-message thumbs up/down: writes a real Cosmos feedback doc to
 *            copilot-feedback (PK /sessionId). 400 on bad rating / missing index.
 *
 * #3943: every one of these ownership guards was `doc.userOid && doc.userOid
 * !== caller`, which SHORT-CIRCUITS TO A PASS when the doc carries no
 * `userOid`. The mismatched-owner cases below were already here and stayed
 * green over that hole — the UNOWNED cases are the ones that catch it.
 *
 * Cosmos + identity are mocked — no live Azure. Asserts the real Cosmos calls
 * (delete / replace / items.create) fire with the right partition key + payload.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' } }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// getSession from the orchestrator is only used by the GET handler. Everything
// else (notably `updateSessionMeta`, whose ownership guard the PATCH rename
// branch delegates to) stays REAL and runs against the Cosmos mock below.
const orchestratorGetSessionMock = vi.fn(async (_id: string): Promise<any> => null);
vi.mock('@/lib/azure/copilot-orchestrator', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/copilot-orchestrator');
  return { ...actual, getSession: (id: string) => orchestratorGetSessionMock(id) };
});

const deleteMock = vi.fn(async () => ({}));
const replaceMock = vi.fn(async (doc: any): Promise<any> => ({ resource: doc }));
// `resource: any` on purpose — fixtures deliberately OMIT `userOid` to exercise
// the unowned-doc case, which a narrowly inferred shape would reject.
const readMock = vi.fn(async (): Promise<{ resource: any }> => ({ resource: { id: 'sess-1', sessionId: 'sess-1', userOid: 'oid-test' } }));
const feedbackCreateMock = vi.fn(async () => ({ resource: {} }));

const sessionsContainerMock = vi.fn(async () => ({
  item: () => ({ read: readMock, delete: deleteMock, replace: replaceMock }),
}));
const feedbackContainerMock = vi.fn(async () => ({
  items: { create: feedbackCreateMock },
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  copilotSessionsContainer: () => sessionsContainerMock(),
  copilotFeedbackContainer: () => feedbackContainerMock(),
}));

// `NextRequest`, not a bare `Request`: the handlers are `RouteHandler<P>`
// (route-toolkit), whose first parameter is typed `NextRequest`.
function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/copilot/sessions/sess-1', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Pay the COLD TS transform of the route + its (now real) copilot-orchestrator
// dependency graph ONCE, in a hook with its own generous ceiling, instead of
// inside whichever test happens to import first. Measured here: ~30s cold, then
// ~200ms per test — over the 30s `testTimeout`, so without this warm-up the
// first test in the file fails as a spurious "Test timed out in 30000ms".
// vi.resetModules() clears the module registry per test but NOT vite's
// transform cache, so the cost is genuinely paid once.
beforeAll(async () => {
  await import('@/app/api/copilot/sessions/[id]/route');
}, 180_000);

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' } } as any);
  readMock.mockResolvedValue({ resource: { id: 'sess-1', sessionId: 'sess-1', userOid: 'oid-test' } });
  deleteMock.mockResolvedValue({});
  replaceMock.mockImplementation(async (doc: any) => ({ resource: doc }));
  orchestratorGetSessionMock.mockResolvedValue(null as any);
  feedbackCreateMock.mockResolvedValue({ resource: {} });
});
afterEach(() => { vi.clearAllMocks(); vi.resetModules(); });

describe('GET /api/copilot/sessions/[id] — session detail', () => {
  it('404 when the session does not exist', async () => {
    orchestratorGetSessionMock.mockResolvedValueOnce(null as any);
    const { GET } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await GET(req('GET'), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(404);
  });

  it('200 for the owner', async () => {
    orchestratorGetSessionMock.mockResolvedValueOnce({ id: 'sess-1', sessionId: 'sess-1', userOid: 'oid-test', steps: [] } as any);
    const { GET } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await GET(req('GET'), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.session.id).toBe('sess-1');
  });

  it('403 when the session belongs to another user', async () => {
    orchestratorGetSessionMock.mockResolvedValueOnce({ id: 'sess-1', sessionId: 'sess-1', userOid: 'someone-else', steps: [] } as any);
    const { GET } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await GET(req('GET'), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(403);
  });

  // #3943 — the NARROW case. `doc.userOid && doc.userOid !== userOid` passed on
  // any doc missing the field, so an ownerless transcript was readable by any
  // authenticated caller. The 403 must NOT leak the doc.
  it('403 when the session doc carries NO userOid (transcript not returned)', async () => {
    orchestratorGetSessionMock.mockResolvedValueOnce({
      id: 'sess-1', sessionId: 'sess-1', prompt: 'secret prompt', steps: [{ kind: 'final', content: 'secret answer' }],
    } as any);
    const { GET } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await GET(req('GET'), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.session).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('secret');
  });
});

describe('PATCH /api/copilot/sessions/[id] — rename / pin (updateSessionMeta)', () => {
  it('renames for the owner (real Cosmos replace)', async () => {
    const { PATCH } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await PATCH(req('PATCH', { title: 'Renamed' }), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(200);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect((replaceMock.mock.calls[0][0] as any).title).toBe('Renamed');
  });

  it('403 when the session belongs to another user (no replace)', async () => {
    readMock.mockResolvedValueOnce({ resource: { id: 'sess-1', sessionId: 'sess-1', userOid: 'someone-else' } });
    const { PATCH } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await PATCH(req('PATCH', { title: 'Renamed' }), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(403);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // #3943 — same NARROW shape inside `updateSessionMeta`.
  it('403 when the session doc carries NO userOid (no replace)', async () => {
    readMock.mockResolvedValueOnce({ resource: { id: 'sess-1', sessionId: 'sess-1' } });
    const { PATCH } = await import('@/app/api/copilot/sessions/[id]/route');
    const r = await PATCH(req('PATCH', { title: 'Renamed' }), { params: Promise.resolve({ id: 'sess-1' }) });
    expect(r.status).toBe(403);
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

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

  // #3943 — the NARROW case the mismatched-owner test above cannot catch. The
  // guard used to read `existing.resource.userOid && … !== userOid`, so a doc
  // with NO `userOid` short-circuited to a PASS and any caller deleted it.
  it('403 when the session doc carries NO userOid (no delete)', async () => {
    readMock.mockResolvedValueOnce({ resource: { id: 'sess-1', sessionId: 'sess-1' } });
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
