/**
 * Regression: workspace-scoped item pickers (data-plane isolation).
 *
 * The bug: /api/items/by-type ran an unscoped cross-partition query and
 * owner-filtered per item, so a picker opened in Workspace A listed items that
 * live in Workspace B. These tests lock in the fix: with `?workspaceId=A` the
 * route authorizes A once and returns ONLY A's items — never a B item — and 404s
 * when the caller has no access to the requested workspace.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

// authorizeWorkspaceList: the caller owns ws-A, has NO access to ws-Z.
vi.mock('@/lib/auth/workspace-list-access', () => ({
  authorizeWorkspaceList: vi.fn(async (_s: any, wsId: string) =>
    wsId === 'ws-A' || wsId === 'ws-B'
      ? { workspace: { id: wsId, domain: `dom-${wsId}` }, role: 'Owner', via: 'owner', canWrite: true }
      : null),
}));

// Fake items container that SIMULATES Cosmos partition-key + WHERE filtering, so
// the assertion "a ws-A request never returns a ws-B item" is meaningful.
const ALL_ITEMS = [
  { id: 'a1', itemType: 'lakehouse', workspaceId: 'ws-A', displayName: 'A lakehouse', state: {}, updatedAt: '2026-01-02' },
  { id: 'b1', itemType: 'lakehouse', workspaceId: 'ws-B', displayName: 'B lakehouse', state: {}, updatedAt: '2026-01-03' },
  { id: 'a2', itemType: 'warehouse', workspaceId: 'ws-A', displayName: 'A warehouse', state: {}, updatedAt: '2026-01-01' },
];
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: {
      query: (spec: any, opts?: any) => ({
        fetchAll: async () => {
          const types = spec.parameters
            .filter((p: any) => /^@t\d+$/.test(p.name))
            .map((p: any) => p.value);
          const wParam = spec.parameters.find((p: any) => p.name === '@w')?.value;
          let rows = ALL_ITEMS.filter((it) => types.includes(it.itemType));
          // Cosmos would only ever return the partition asked for.
          if (opts?.partitionKey) rows = rows.filter((it) => it.workspaceId === opts.partitionKey);
          if (wParam) rows = rows.filter((it) => it.workspaceId === wParam);
          return { resources: rows.map((r) => ({ ...r })) };
        },
      }),
    },
  })),
  workspacesContainer: vi.fn(async () => ({ item: vi.fn() })),
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';

const sess = { claims: { oid: 'user-1', tid: 'tenant-1', groups: [] } };
function req(qs: string) {
  // Faithful NextRequest surface: the route also reads the continuation header.
  return {
    url: `http://x/api/items/by-type?${qs}`,
    headers: { get: () => null },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
});

describe('GET /api/items/by-type — workspace scoping', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(req('types=lakehouse&workspaceId=ws-A'))).status).toBe(401);
  });

  it('workspace-scoped: returns ONLY the requested workspace’s items — never a sibling’s', async () => {
    const res = await GET(req('types=lakehouse,warehouse&workspaceId=ws-A'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    const ids = j.items.map((i: any) => i.id).sort();
    expect(ids).toEqual(['a1', 'a2']);
    // The Workspace-B lakehouse must NEVER leak into a Workspace-A picker.
    expect(j.items.some((i: any) => i.workspaceId === 'ws-B')).toBe(false);
    expect(j.items.some((i: any) => i.id === 'b1')).toBe(false);
  });

  it('a different workspace returns only its own items', async () => {
    const j = await (await GET(req('types=lakehouse&workspaceId=ws-B'))).json();
    expect(j.items.map((i: any) => i.id)).toEqual(['b1']);
  });

  it('404 when the caller has no access to the requested workspace', async () => {
    const res = await GET(req('types=lakehouse&workspaceId=ws-Z'));
    expect(res.status).toBe(404);
  });
});
