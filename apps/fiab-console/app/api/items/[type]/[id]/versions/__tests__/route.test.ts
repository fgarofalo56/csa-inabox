/**
 * BFF route tests for item version history (Wave-2 W6):
 *   - GET  /versions            — list (ACL, change summaries, current flag)
 *   - GET  /versions/[versionId] — single version content
 *   - POST /versions/[versionId]/restore — restore (write ACL, re-save, re-version)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// --- item-access ACL --------------------------------------------------------
const liveItem = {
  id: 'item-1', workspaceId: 'ws-1', itemType: 'warehouse', displayName: 'WH',
  state: { content: { n: 3 } }, createdBy: 'oid-1', createdAt: 'c', updatedAt: 'u3',
};
let access: any = { item: liveItem, role: 'Owner', via: 'owner', canWrite: true };
vi.mock('@/lib/auth/item-access', () => ({
  resolveItemAccessByOid: vi.fn(async () => access),
}));

// --- version store ----------------------------------------------------------
const versionDocs = [
  { id: 'ver:item-1:c', docType: 'item-version', itemId: 'item-1', itemType: 'warehouse', workspaceId: 'ws-1',
    savedAt: '2026-03-01T00:00:00.000Z', savedBy: 'oid-1', savedByName: 'U',
    content: { displayName: 'WH', state: { content: { n: 3 } } } },
  { id: 'ver:item-1:b', docType: 'item-version', itemId: 'item-1', itemType: 'warehouse', workspaceId: 'ws-1',
    savedAt: '2026-02-01T00:00:00.000Z', savedBy: 'oid-1', savedByName: 'U',
    content: { displayName: 'WH', state: { content: { n: 2 } } } },
  { id: 'ver:item-1:a', docType: 'item-version', itemId: 'item-1', itemType: 'warehouse', workspaceId: 'ws-1',
    baseline: true, savedAt: '2026-01-01T00:00:00.000Z', savedBy: 'creator',
    content: { displayName: 'WH', state: { content: { n: 1 } } } },
];
const listItemVersions = vi.fn(async () => versionDocs);
const getItemVersion = vi.fn(async (_itemId: string, versionId: string) => versionDocs.find((v) => v.id === versionId) ?? null);
const recordItemVersion = vi.fn(async () => 1);
vi.mock('@/lib/versions/item-version-store', () => ({
  listItemVersions: (...a: any[]) => (listItemVersions as any)(...a),
  getItemVersion: (...a: any[]) => (getItemVersion as any)(...a),
  recordItemVersion: (...a: any[]) => (recordItemVersion as any)(...a),
}));

// --- itemsContainer (restore path) -----------------------------------------
const replaceMock = vi.fn(async (doc: any) => ({ resource: doc }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ item: () => ({ replace: replaceMock }) }),
}));

const ctx = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ type: 'warehouse', id: 'item-1', ...extra }) });

beforeEach(() => {
  access = { item: liveItem, role: 'Owner', via: 'owner', canWrite: true };
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 } as any);
});
afterEach(() => vi.clearAllMocks());

describe('GET /versions', () => {
  it('401 unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx());
    expect(r.status).toBe(401);
  });

  it('404 when the caller has no access', async () => {
    access = null;
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx());
    expect(r.status).toBe(404);
  });

  it('200 lists newest-first with current flag, baseline, and real change summaries', async () => {
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx());
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.versions).toHaveLength(3);
    // newest first
    expect(j.versions[0].id).toBe('ver:item-1:c');
    expect(j.versions[0].current).toBe(true);
    // summary = diff of this vs next-older (n:2 → n:3) → "1 field changed"
    expect(j.versions[0].changeSummary).toBe('1 field changed');
    // baseline row labelled Initial
    expect(j.versions[2].baseline).toBe(true);
    expect(j.versions[2].changeSummary).toBe('Initial version');
  });
});

describe('GET /versions/[versionId]', () => {
  it('200 returns full version content', async () => {
    const { GET } = await import('../[versionId]/route');
    const r = await GET({} as any, ctx({ versionId: 'ver:item-1:b' }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.version.content.state).toEqual({ content: { n: 2 } });
  });

  it('404 for an unknown version', async () => {
    const { GET } = await import('../[versionId]/route');
    const r = await GET({} as any, ctx({ versionId: 'ver:item-1:zzz' }));
    expect(r.status).toBe(404);
  });
});

describe('POST /versions/[versionId]/restore', () => {
  it('403 for read-only access', async () => {
    access = { item: liveItem, role: 'ItemViewer', via: 'item-grant', canWrite: false };
    const { POST } = await import('../[versionId]/restore/route');
    const r = await POST({} as any, ctx({ versionId: 'ver:item-1:a' }));
    expect(r.status).toBe(403);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('404 for a missing version', async () => {
    const { POST } = await import('../[versionId]/restore/route');
    const r = await POST({} as any, ctx({ versionId: 'ver:item-1:zzz' }));
    expect(r.status).toBe(404);
  });

  it('200 writes the old content back and records a new version', async () => {
    const { POST } = await import('../[versionId]/restore/route');
    const r = await POST({} as any, ctx({ versionId: 'ver:item-1:a' }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.restoredFrom).toBe('ver:item-1:a');
    // live item state replaced with the baseline (n:1) content
    const written = replaceMock.mock.calls.at(-1)?.[0];
    expect(written.state).toEqual({ content: { n: 1 } });
    // the restore is itself versioned
    expect(recordItemVersion).toHaveBeenCalledOnce();
  });
});
