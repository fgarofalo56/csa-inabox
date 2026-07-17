/**
 * Regression: the TENANT/BROWSE path of /api/items/by-type (the /browse
 * "All items" explorer).
 *
 * The bug this locks in: Browse rendered ZERO counts ("Items 0 / Types 0 /
 * Categories 0 / Workspaces 0") on a tenant that HAS items, because the client
 * fanned out ~130 repeated `?type=` params and the route then awaited a
 * per-workspace authz resolver SEQUENTIALLY per distinct workspace — slow
 * enough to outrun the client budget, whose swallowing catch turned any
 * failure into `[]`. These tests lock in the fixed contract:
 *
 *   - `types=all` scans every item type (no type predicate) and returns
 *     { ok: true, items: [...] } with REAL items — the response-shape guard
 *     that keeps silent 0-counts from coming back
 *   - workspace visibility is resolved in BATCH (listAccessibleWorkspaces +
 *     admin projection) with a bounded-parallel ACL fallback for group-shared
 *     workspaces; inaccessible workspaces' items are filtered out
 *   - `workspaceDomain` is attached from the visible workspace's domain
 *   - paging: `pageSize` + the base64url continuation header round-trip
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/auth/workspace-access', () => ({ listAccessibleWorkspaces: vi.fn() }));
vi.mock('@/lib/auth/workspace-list-access', () => ({ authorizeWorkspaceList: vi.fn() }));

const ALL_ITEMS = [
  { id: 'a1', itemType: 'lakehouse', workspaceId: 'ws-A', displayName: 'A lakehouse', updatedAt: '2026-01-02' },
  { id: 'a2', itemType: 'warehouse', workspaceId: 'ws-A', displayName: 'A warehouse', updatedAt: '2026-01-01' },
  { id: 'b1', itemType: 'notebook', workspaceId: 'ws-B', displayName: 'B notebook', updatedAt: '2026-01-03' },
  { id: 'z1', itemType: 'lakehouse', workspaceId: 'ws-Z', displayName: 'Z lakehouse', updatedAt: '2026-01-04' },
];

/** Simulates the items container incl. WHERE-type filtering + paging. */
function makeItemsContainer() {
  return {
    items: {
      query: (spec: any, opts?: any) => {
        const typeParams = (spec.parameters || [])
          .filter((p: any) => /^@t\d+$/.test(p.name))
          .map((p: any) => p.value);
        let rows = ALL_ITEMS.filter(
          (it) => typeParams.length === 0 || typeParams.includes(it.itemType),
        );
        if (opts?.partitionKey) rows = rows.filter((it) => it.workspaceId === opts.partitionKey);
        return {
          fetchAll: async () => ({ resources: rows.map((r) => ({ ...r })) }),
          fetchNext: async () => {
            const size = opts?.maxItemCount ?? rows.length;
            const start = opts?.continuationToken ? Number(opts.continuationToken) : 0;
            const page = rows.slice(start, start + size);
            const next = start + size < rows.length ? String(start + size) : undefined;
            return { resources: page.map((r) => ({ ...r })), continuationToken: next };
          },
        };
      },
    },
  };
}

const ALL_WORKSPACE_DOCS = [
  { id: 'ws-A', domain: 'dom-a' },
  { id: 'ws-B', domain: 'dom-b' },
  { id: 'ws-Z', domain: 'dom-z' },
];

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => makeItemsContainer()),
  workspacesContainer: vi.fn(async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: ALL_WORKSPACE_DOCS.map((w) => ({ ...w })) }) }),
    },
  })),
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { listAccessibleWorkspaces } from '@/lib/auth/workspace-access';
import { authorizeWorkspaceList } from '@/lib/auth/workspace-list-access';

const sess = { claims: { oid: 'user-1', tid: 'tenant-1', groups: [] } };

function req(qs: string, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    url: `http://x/api/items/by-type?${qs}`,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
  (isTenantAdmin as any).mockReturnValue(false);
  // Caller OWNS ws-A; ws-B is group-shared (resolves via the ACL fallback);
  // ws-Z is invisible.
  (listAccessibleWorkspaces as any).mockResolvedValue([{ id: 'ws-A', domain: 'dom-a' }]);
  (authorizeWorkspaceList as any).mockImplementation(async (_s: any, wsId: string) =>
    wsId === 'ws-B' ? { workspace: { id: 'ws-B', domain: 'dom-b' }, role: 'Viewer', via: 'acl', canWrite: false } : null,
  );
});

describe('GET /api/items/by-type — tenant/browse path', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(req('types=all'))).status).toBe(401);
  });

  it('types=all returns REAL items with the {ok, items} shape — the 0-counts regression guard', async () => {
    const j = await (await GET(req('types=all'))).json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.items)).toBe(true);
    // Every accessible item of EVERY type, without any ?type= fan-out.
    expect(j.items.map((i: any) => i.id).sort()).toEqual(['a1', 'a2', 'b1']);
    // The tenant genuinely has items → the route must never say "none".
    expect(j.items.length).toBeGreaterThan(0);
  });

  it('filters out items from workspaces the caller cannot see', async () => {
    const j = await (await GET(req('types=all'))).json();
    expect(j.items.some((i: any) => i.workspaceId === 'ws-Z')).toBe(false);
  });

  it('attaches workspaceDomain from batch + ACL-fallback resolution', async () => {
    const j = await (await GET(req('types=all'))).json();
    const byId = new Map(j.items.map((i: any) => [i.id, i]));
    expect((byId.get('a1') as any).workspaceDomain).toBe('dom-a');
    expect((byId.get('b1') as any).workspaceDomain).toBe('dom-b');
    // Group-shared ws-B resolved through the fallback resolver — once.
    const fallbackIds = (authorizeWorkspaceList as any).mock.calls.map((c: any[]) => c[1]);
    expect(fallbackIds).toContain('ws-B');
    expect(fallbackIds).not.toContain('ws-A'); // covered by the batch — no per-workspace authz
  });

  it('explicit type list still filters types on the tenant path', async () => {
    const j = await (await GET(req('types=lakehouse'))).json();
    expect(j.items.map((i: any) => i.id)).toEqual(['a1']);
  });

  it('tenant admin sees every in-tenant workspace (admin-open batch)', async () => {
    (isTenantAdmin as any).mockReturnValue(true);
    const j = await (await GET(req('types=all'))).json();
    expect(j.items.map((i: any) => i.id).sort()).toEqual(['a1', 'a2', 'b1', 'z1']);
    // Admin visibility comes from ONE projected workspaces query, not N authz calls.
    expect((authorizeWorkspaceList as any).mock.calls.length).toBe(0);
  });

  it('pages with pageSize + base64url continuation and terminates', async () => {
    (isTenantAdmin as any).mockReturnValue(true);
    const first = await (await GET(req('types=all&pageSize=3'))).json();
    expect(first.ok).toBe(true);
    expect(first.items.length).toBe(3);
    expect(typeof first.continuation).toBe('string');
    // The continuation is OPAQUE base64url — decodes to the raw Cosmos token.
    expect(Buffer.from(first.continuation, 'base64url').toString('utf-8')).toBe('3');

    const second = await (
      await GET(req('types=all&pageSize=3', { 'x-loom-continuation': first.continuation }))
    ).json();
    expect(second.ok).toBe(true);
    expect(second.items.length).toBe(1);
    expect(second.continuation).toBeUndefined();

    const ids = [...first.items, ...second.items].map((i: any) => i.id).sort();
    expect(ids).toEqual(['a1', 'a2', 'b1', 'z1']);
  });

  it('400 when no type at all is requested', async () => {
    expect((await GET(req(''))).status).toBe(400);
  });
});
