/**
 * #2977 — route-level proof that `databricks-notebook/[id]` authorizes the
 * caller AND binds the caller-supplied `path` to the item's own scope.
 *
 * WHAT SHIPPED. The GET's live-Databricks branch (`?path=…`) ran NO workspace
 * authorization — `[id]` was decorative and the path went straight to
 * `workspace/export` under the Console's workspace-wide UAMI. PUT and DELETE in
 * the same file had no authorization at all, so the same caller could OVERWRITE
 * (`workspace/import` overwrite=true) or DELETE (`workspace/delete`
 * recursive=true) another tenant's notebook. `scripts/ci/check-route-guards.mjs`
 * did not catch it because it matches a guard signal ANYWHERE IN THE FILE and
 * the unrelated Cosmos-fallback branch supplied one.
 *
 * WHY `toHaveBeenCalledWith` AND NOT `expect.objectContaining`. The security
 * property under test on PUT/DELETE is the ABSENCE of one key.
 * `objectContaining` ignores extra keys, so a one-word change adding
 * `allowReadRoles: true` to a write guard — which would let a read-only Viewer
 * overwrite or recursively delete a notebook — would leave such an assertion
 * GREEN. That is exactly how an `allowReadRoles: true` slipped past a suite
 * earlier in this program. `toHaveBeenCalledWith` is deep equality over the
 * whole argument, so an added key fails. Do not loosen these.
 *
 * MUTATION PROOF — each of these is tsc-valid (`allowUnreachableCode:false`
 * rules out `if (false && …)`) and turns this file RED:
 *   1. `_lib/notebook-path-scope.ts` — drop the `..` rejection
 *      (`if (segments.some((s) => s === '..')) return null;`)
 *        → "refuses a traversal attempt" fails.
 *   2. `_lib/notebook-path-scope.ts` — weaken the boundary prefix check to a
 *      bare `clean.startsWith(root)`
 *        → "refuses a sibling folder that merely shares a string prefix" fails.
 *   3. `_lib/notebook-path-scope.ts` — return `{ ok: true, path: clean, root }`
 *      unconditionally
 *        → every refusal test fails.
 *   4. `[id]/route.ts` — drop the `if (denied) return denied;` in `authorize()`
 *        → "a denied caller never reaches Databricks" fails.
 *   5. `[id]/route.ts` — add `allowReadRoles: true` to the PUT/DELETE guard
 *      (i.e. make `authorize()` always pass it)
 *        → the strict-shape write assertions fail on the extra key.
 *   6. `[id]/route.ts` — return `{ item: null as any }` instead of the 404 when
 *      `loadNotebookItemRaw` finds nothing
 *        → "an id naming no item is refused, not fallen through" fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;

vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

/**
 * The item under test is a bundle-installed notebook at
 * `/Shared/loom-installs/app-a/Silver`, so its authorized scope is the app's
 * own folder `/Shared/loom-installs/app-a`.
 */
const ITEM = {
  id: 'nb-1',
  itemType: 'databricks-notebook',
  workspaceId: 'ws-1',
  displayName: 'Silver',
  state: {
    cells: [{ type: 'code', lang: 'python', source: 'print(1)' }],
    provisioning: { secondaryIds: { notebookPath: '/Shared/loom-installs/app-a/Silver' } },
  },
};

const cosmos = vi.hoisted(() => ({ fetchAll: vi.fn(async () => ({ resources: [] as any[] })) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: cosmos.fetchAll }) } }),
}));

const dbx = vi.hoisted(() => ({
  getNotebook: vi.fn(async (path: string) => ({ path, language: 'PYTHON', content: 'print(1)' })),
  importNotebook: vi.fn(async () => undefined),
  deleteWorkspaceObject: vi.fn(async () => undefined),
  mkdirsWorkspace: vi.fn(async () => undefined),
}));
vi.mock('@/lib/azure/databricks-client', () => dbx);
vi.mock('@/lib/install/provisioners/_seed-databricks', () => ({
  buildDatabricksSource: () => '# Databricks notebook source\nprint(1)',
}));

import { GET, PUT, DELETE } from '../route';

const ctx = { params: Promise.resolve({ id: 'nb-1' }) } as any;

/** A request whose query string carries `path` (and optionally workspaceId). */
function req(query: Record<string, string> = {}, body?: any) {
  const url = new URL('https://loom.test/api/items/databricks-notebook/nb-1');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { nextUrl: url, url: url.toString(), json: async () => body ?? {} } as any;
}

/** The guard shape every handler must produce, minus the read/write scope key. */
const BASE = {
  workspaceId: null,
  itemId: 'nb-1',
  itemType: 'databricks-notebook',
  notFound: 'notebook not found',
};

/** Every call that reaches the shared Databricks workspace. */
function dbxCalls() {
  return (
    dbx.getNotebook.mock.calls.length +
    dbx.importNotebook.mock.calls.length +
    dbx.deleteWorkspaceObject.mock.calls.length
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null);
  cosmos.fetchAll.mockResolvedValue({ resources: [ITEM] } as any);
});

describe('#2977 databricks-notebook/[id] — authorization runs and the path is bound to the item', () => {
  // ── The three refusals the issue requires ────────────────────────────────

  it('refuses a path belonging to a DIFFERENT workspace (another app folder)', async () => {
    const foreign = '/Shared/loom-installs/app-b/Secret';
    const res = await GET(req({ path: foreign }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "path is outside this notebook's workspace scope.",
    });
    // The point of the fix: Databricks is never asked for the foreign path.
    expect(dbx.getNotebook).not.toHaveBeenCalled();
  });

  it('refuses the same foreign path on the WRITE handlers too (import/delete)', async () => {
    const foreign = '/Shared/loom-installs/app-b/Secret';
    const put = await PUT(req({}, { path: foreign, language: 'PYTHON', content: 'x' }), ctx);
    expect(put.status).toBe(403);
    const del = await DELETE(req({ path: foreign, recursive: 'true' }), ctx);
    expect(del.status).toBe(403);
    expect(dbx.importNotebook).not.toHaveBeenCalled();
    expect(dbx.deleteWorkspaceObject).not.toHaveBeenCalled();
  });

  it('refuses a traversal attempt that would escape the item folder', async () => {
    for (const evil of [
      '/Shared/loom-installs/app-a/../app-b/Secret',
      '/Shared/loom-installs/app-a/sub/../../app-b/Secret',
      '/Shared/loom-installs/app-a/..',
    ]) {
      const res = await GET(req({ path: evil }), ctx);
      expect(res.status, evil).toBe(400);
      expect((await res.json()).error, evil).toMatch(/path is invalid/);
    }
    // Backslash + relative + NUL forms are rejected by the same normalizer.
    for (const evil of ['Shared/loom-installs/app-a/x', '\\Shared\\loom-installs\\app-a\\x', '/']) {
      expect((await GET(req({ path: evil }), ctx)).status, evil).toBe(400);
    }
    expect(dbxCalls()).toBe(0);
  });

  it('omitting `path` still authorizes — the guard is not skippable', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    // Authorization ran even with NO path and NO workspaceId: the canonical
    // guard resolves the workspace from the item, so dropping a parameter
    // cannot skip the check (the #2723 / #2941 class).
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      ...BASE,
      allowReadRoles: true,
    });
    const body = await res.json();
    expect(body.source).toBe('cosmos');
    // The editor is handed the scope it must stay inside.
    expect(body.root).toBe('/Shared/loom-installs/app-a');
  });

  // ── Scope shape: read vs write, boundary, fail-closed ────────────────────

  it('GET is READ-scoped — exactly { …, allowReadRoles: true } and nothing more', async () => {
    const res = await GET(req({ path: '/Shared/loom-installs/app-a/Silver' }), ctx);
    expect(res.status).toBe(200);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      ...BASE,
      allowReadRoles: true,
    });
    expect(dbx.getNotebook).toHaveBeenCalledWith('/Shared/loom-installs/app-a/Silver');
  });

  it('PUT and DELETE are WRITE-scoped — the exact opts, WITHOUT allowReadRoles', async () => {
    const inScope = '/Shared/loom-installs/app-a/Silver';
    const put = await PUT(req({}, { path: inScope, language: 'PYTHON', content: 'y' }), ctx);
    expect(put.status).toBe(200);
    // Deep equality: an added `allowReadRoles` key fails here. That key would
    // let a read-only Viewer overwrite the notebook in the live workspace.
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, BASE);
    // The item's folder is created before import (workspace/import does not
    // create parents), so a first save inside the authorized scope works.
    expect(dbx.mkdirsWorkspace).toHaveBeenCalledWith('/Shared/loom-installs/app-a');
    expect(dbx.importNotebook).toHaveBeenCalledWith(inScope, 'PYTHON', 'y', true);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null);
    cosmos.fetchAll.mockResolvedValue({ resources: [ITEM] } as any);
    const del = await DELETE(req({ path: inScope }), ctx);
    expect(del.status).toBe(200);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, BASE);
    expect(dbx.deleteWorkspaceObject).toHaveBeenCalledWith(inScope, false);
  });

  it('refuses a sibling folder that merely shares a string prefix', async () => {
    // A substring check would admit this; the boundary check (`${root}/`) does
    // not. `/Shared/loom-installs/app-a` must not admit `…/app-a-evil/…`.
    const res = await GET(req({ path: '/Shared/loom-installs/app-a-evil/Secret' }), ctx);
    expect(res.status).toBe(403);
    expect(dbx.getNotebook).not.toHaveBeenCalled();
  });

  it('a denied caller gets the route wording and Databricks is never reached', async () => {
    // A FRESH response per call — one shared NextResponse can only be read once.
    guard.authorizeItemWorkspace.mockImplementation(
      async () => NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 }) as any,
    );
    const inScope = '/Shared/loom-installs/app-a/Silver';
    for (const [name, call] of [
      ['GET', () => GET(req({ path: inScope }), ctx)],
      ['GET(no path)', () => GET(req(), ctx)],
      ['PUT', () => PUT(req({}, { path: inScope, language: 'PYTHON', content: 'z' }), ctx)],
      ['DELETE', () => DELETE(req({ path: inScope }), ctx)],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(404);
      expect(await res.json(), name).toEqual({ ok: false, error: 'notebook not found' });
    }
    expect(dbxCalls()).toBe(0);
    expect(dbx.mkdirsWorkspace).not.toHaveBeenCalled();
  });

  it('an id naming no item is refused, not fallen through', async () => {
    // `authorizeItemWorkspace` deliberately returns null (authorized) when the
    // id names no item — there is no other tenant's workspace to gate. That is
    // safe for routes whose remaining reads are partition-scoped, but NOT here:
    // with no item there is no scope root, so an unbound path would reach the
    // shared workspace. The route must fail closed instead of inheriting it.
    cosmos.fetchAll.mockResolvedValue({ resources: [] } as any);
    for (const call of [
      () => GET(req({ path: '/Shared/loom-installs/app-b/Secret' }), ctx),
      () => PUT(req({}, { path: '/Shared/loom-installs/app-b/Secret', language: 'PYTHON', content: 'x' }), ctx),
      () => DELETE(req({ path: '/Shared/loom-installs/app-b/Secret' }), ctx),
    ]) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: 'notebook not found' });
    }
    expect(dbxCalls()).toBe(0);
  });

  it('an item that declares NO path is scoped to its own deterministic folder', async () => {
    cosmos.fetchAll.mockResolvedValue({
      resources: [{ ...ITEM, state: { cells: ITEM.state.cells } }],
    } as any);
    const mine = '/Shared/loom-notebooks/nb-1/draft';
    const ok = await GET(req({ path: mine }), ctx);
    expect(ok.status).toBe(200);
    expect(dbx.getNotebook).toHaveBeenCalledWith(mine);
    // …and still cannot reach another item's folder.
    const nope = await GET(req({ path: '/Shared/loom-notebooks/nb-2/draft' }), ctx);
    expect(nope.status).toBe(403);
  });

  it('401s before the guard, the item read, or Databricks when there is no session', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/session', () => ({ getSession: () => null }));
    const fresh = await import('../route');
    const res = await fresh.GET(req({ path: '/Shared/loom-installs/app-a/Silver' }), ctx);
    expect(res.status).toBe(401);
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(dbxCalls()).toBe(0);
    vi.doUnmock('@/lib/auth/session');
    vi.resetModules();
  });
});
