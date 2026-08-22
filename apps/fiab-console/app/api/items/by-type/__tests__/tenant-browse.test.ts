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
  // #3843 — a workspace in ANOTHER Entra tenant, and a LEGACY workspace whose
  // tenancy was never stamped. Both carry items, so if the admin sweep lets
  // either through it shows up in the response and these specs say so.
  { id: 'f1', itemType: 'lakehouse', workspaceId: 'ws-FOREIGN', displayName: 'Foreign lakehouse', updatedAt: '2026-01-05' },
  { id: 'l1', itemType: 'lakehouse', workspaceId: 'ws-LEGACY', displayName: 'Legacy lakehouse', updatedAt: '2026-01-06' },
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
  { id: 'ws-A', domain: 'dom-a', tid: 'tenant-1' },
  { id: 'ws-B', domain: 'dom-b', tid: 'tenant-1' },
  { id: 'ws-Z', domain: 'dom-z', tid: 'tenant-1' },
  { id: 'ws-FOREIGN', domain: 'dom-f', tid: 'tenant-OTHER' },
  { id: 'ws-LEGACY', domain: 'dom-l' }, // pre-rel-T11: no `tid` was ever stamped
];

/**
 * The workspaces container, modelling COSMOS rather than the route.
 *
 * #3843 — this fixture used to ignore the query entirely and hand back every
 * document with no `tid` on any of them, so it could not have distinguished a
 * tenant-scoped sweep from an unscoped one: the old truthiness-guarded filter
 * and a correct positive match both returned all five. A fixture that models the
 * CODE cannot fail when the code is wrong, so this one applies the `WHERE`
 * predicate the route actually sends — `c.tid = @tid` — the way the database
 * would, and a document with no `tid` matches no equality.
 */
/** Every query spec the route sends to the WORKSPACES container, in order. */
const workspaceQuerySpecs: any[] = [];

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => makeItemsContainer()),
  workspacesContainer: vi.fn(async () => ({
    items: {
      query: (spec: any) => {
        workspaceQuerySpecs.push(spec);
        return {
          fetchAll: async () => {
            const wantedTid = (spec?.parameters ?? []).find((p: any) => p.name === '@tid')?.value;
            const scoped = /c\.tid\s*=\s*@tid/.test(spec?.query ?? '');
            const rows = scoped
              ? ALL_WORKSPACE_DOCS.filter((w) => (w as { tid?: string }).tid === wantedTid)
              : ALL_WORKSPACE_DOCS;
            return { resources: rows.map((w) => ({ ...w })) };
          },
        };
      },
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
  workspaceQuerySpecs.length = 0;
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
    // Admin visibility comes from ONE tenant-scoped workspaces query, not N authz
    // calls: none of the in-tenant workspaces is re-resolved per workspace.
    const fallbackIds = (authorizeWorkspaceList as any).mock.calls.map((c: any[]) => c[1]);
    expect(fallbackIds).not.toContain('ws-A');
    expect(fallbackIds).not.toContain('ws-B');
    expect(fallbackIds).not.toContain('ws-Z');
  });

  // ── #3843 — the admin sweep is a CACHE of the canonical decision ──────────
  //
  // What it replaced: `if (s.claims.tid && w.tid && w.tid !== s.claims.tid)
  // continue;` over an UNSCOPED `SELECT c.id, c.domain, c.tid FROM c`. That is a
  // non-contradiction test, so it decided nothing whenever either side was
  // absent and fell straight through to `isTenantAdmin(s)` alone.
  describe('the admin sweep requires a POSITIVE tenant match (#3843)', () => {
    it('never returns items from a workspace in ANOTHER Entra tenant', async () => {
      (isTenantAdmin as any).mockReturnValue(true);
      const j = await (await GET(req('types=all'))).json();
      expect(j.items.some((i: any) => i.workspaceId === 'ws-FOREIGN')).toBe(false);
      expect(j.items.some((i: any) => i.id === 'f1')).toBe(false);
    });

    it('withholds a LEGACY tid-less workspace from the sweep — unconfirmed is not a grant', async () => {
      (isTenantAdmin as any).mockReturnValue(true);
      const j = await (await GET(req('types=all'))).json();
      expect(j.items.some((i: any) => i.id === 'l1')).toBe(false);
    });

    it('scopes the sweep IN THE QUERY, so another tenant\'s document is never read', async () => {
      (isTenantAdmin as any).mockReturnValue(true);
      await GET(req('types=all'));
      // The boundary is in the WHERE clause, not only in a caller-side filter:
      // the sweep asks for THIS tenant's documents and no others.
      expect(workspaceQuerySpecs.length).toBe(1);
      expect(workspaceQuerySpecs[0].query).toMatch(/c\.tid\s*=\s*@tid/);
      expect(workspaceQuerySpecs[0].parameters).toEqual([{ name: '@tid', value: 'tenant-1' }]);
      // …and the workspaces it withheld fall to the canonical resolver, which is
      // what makes withholding them cost no legitimate access.
      const fallbackIds = (authorizeWorkspaceList as any).mock.calls.map((c: any[]) => c[1]);
      expect(fallbackIds).toContain('ws-FOREIGN');
      expect(fallbackIds).toContain('ws-LEGACY');
    });

    it('an admin with NO tid claim issues NO workspaces query at all (fail closed)', async () => {
      (isTenantAdmin as any).mockReturnValue(true);
      (getSession as any).mockReturnValue({ claims: { oid: 'user-1', tid: undefined, groups: [] } });
      const j = await (await GET(req('types=all'))).json();
      expect(workspaceQuerySpecs.length).toBe(0);
      // Only what `listAccessibleWorkspaces` (owned + direct-shared) and the ACL
      // fallback grant — ws-Z is admin-only and must disappear.
      expect(j.items.map((i: any) => i.id).sort()).toEqual(['a1', 'a2', 'b1']);
      expect(j.items.some((i: any) => i.id === 'z1')).toBe(false);
    });

    // THE CONTROL. Without this pair the four refusals above could equally be
    // explained by the sweep being dead. Same fixture, tid present, admin true:
    // ws-Z is admin-only and it comes back.
    it('CONTROL — with a tid present the sweep still grants the admin-only workspace', async () => {
      (isTenantAdmin as any).mockReturnValue(true);
      const j = await (await GET(req('types=all'))).json();
      expect(j.items.some((i: any) => i.id === 'z1')).toBe(true);
    });

    // A non-admin must be unaffected by all of the above.
    it('a NON-admin is unchanged — owned + ACL only, no sweep', async () => {
      (isTenantAdmin as any).mockReturnValue(false);
      const j = await (await GET(req('types=all'))).json();
      expect(j.items.map((i: any) => i.id).sort()).toEqual(['a1', 'a2', 'b1']);
    });
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
