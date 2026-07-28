/**
 * BFF contract tests for /api/foundry/connections.
 *
 * The route was migrated onto `withSession` and given a `?refresh=1` escape
 * hatch in #2557 with no spec at all. Locked here:
 *   - 401 without a session on every verb;
 *   - GET passes `force` through ONLY when `?refresh=1` (the memo bypass);
 *   - a paging deadline surfaces as a 504-class honest error naming the
 *     deadline, not as an empty list the operator would read as "none exist";
 *   - a write invalidates the memo (delegated to the connections client).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

const listConnections = vi.fn();
class FoundryError extends Error {
  status: number;
  constructor(status: number, _body: unknown, message: string) {
    super(message);
    this.status = status;
  }
}
vi.mock('@/lib/azure/foundry-client', () => ({
  listConnections: (opts?: any) => listConnections(opts),
  FoundryError,
}));

const deleteConnection = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/azure/foundry-connections-client', () => ({
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  deleteConnection: (name: string) => deleteConnection(name),
  buildConnectionBody: vi.fn(),
  CONNECTION_CATEGORIES: [],
}));

beforeEach(() => {
  listConnections.mockReset();
  listConnections.mockResolvedValue([{ id: '/c/1', name: 'aoai', category: 'AzureOpenAI' }]);
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test' }, exp: Date.now() / 1000 + 3600 } as any);
});

afterEach(() => {
  vi.resetModules();
});

async function get(url: string) {
  const { GET } = await import('@/app/api/foundry/connections/route');
  return (GET as any)(new Request(url), {});
}

describe('GET /api/foundry/connections', () => {
  it('401s without a session', async () => {
    getSessionMock.mockReturnValue(null as any);
    const res = await get('https://x/api/foundry/connections');
    expect(res.status).toBe(401);
  });

  it('serves the memoized list by default (force NOT set)', async () => {
    const res = await get('https://x/api/foundry/connections');
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.connections).toHaveLength(1);
    expect(listConnections).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  it('?refresh=1 forces a re-walk — the escape hatch for an out-of-band change', async () => {
    await get('https://x/api/foundry/connections?refresh=1');
    expect(listConnections).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it('ignores a non-1 refresh value rather than silently re-walking', async () => {
    await get('https://x/api/foundry/connections?refresh=maybe');
    expect(listConnections).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  it('reports truncation instead of implying the hub has fewer connections', async () => {
    listConnections.mockImplementation(async (opts: any) => {
      opts?.onTruncated?.('time');
      return [{ id: '/c/1', name: 'aoai', category: 'AzureOpenAI' }];
    });
    const res = await get('https://x/api/foundry/connections');
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.truncated).toBe('time');
  });

  it('surfaces a paging deadline AS a deadline, not as an empty list', async () => {
    const { PagingDeadlineError } = await import('@/lib/azure/paging-budget');
    listConnections.mockRejectedValue(
      new PagingDeadlineError({
        label: 'foundry /connections',
        truncatedBy: 'time',
        budgetMs: 8_000,
        maxPages: 10,
        pagesFetched: 1,
        collected: 0,
      }),
    );
    const res = await get('https://x/api/foundry/connections');
    const j = await res.json();
    expect(res.status).toBe(504);
    expect(j.ok).toBe(false);
    expect(j.code).toBe('paging_deadline');
    expect(j.error).toContain('does NOT mean the resource is missing');
  });

  it('DELETE 401s without a session', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { DELETE } = await import('@/app/api/foundry/connections/route');
    const res = await (DELETE as any)(new Request('https://x/api/foundry/connections?name=a', { method: 'DELETE' }), {});
    expect(res.status).toBe(401);
  });

  it('DELETE requires a name', async () => {
    const { DELETE } = await import('@/app/api/foundry/connections/route');
    const res = await (DELETE as any)(new Request('https://x/api/foundry/connections', { method: 'DELETE' }), {});
    expect(res.status).toBe(400);
  });
});
