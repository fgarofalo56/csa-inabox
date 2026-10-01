/**
 * #3669 — which Databricks SQL warehouse may a caller run AI functions on?
 *
 *   POST /api/items/[type]/[id]/ai-function  { fn, column, table, warehouseId }
 *
 * The route used to run on ANY `warehouseId` a signed-in caller named. It now
 * runs only when the warehouse's live `loom_item_id` tag links it to a SQL
 * warehouse item in a workspace the caller can READ; an untagged or orphaned
 * warehouse is for tenant admins only (`_lib/warehouse-item-binding.ts`).
 *
 * THE LADDER IS MODELLED, NOT STUBBED TO ALLOW. `authorizeItemWorkspace` is
 * replaced by `ladder()` below, which reproduces the two properties of the real
 * function (`lib/auth/workspace-guard.ts:229-266`) these tests depend on:
 *   1. a READ-ONLY role (`Viewer`) passes only with `allowReadRoles: true`;
 *   2. with no `workspaceId` it falls back to the item's own workspace, and
 *      ALLOWS when that is empty too (`:244-248`).
 * Property 2 is why the binding module refuses an item with no workspace before
 * calling the ladder — the "empty workspace" test below fails if that check goes.
 *
 * Every `it` names the value that would turn it red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn() }));

/** Warehouse items. `wh-item-nows` has no workspace (the fail-closed case). */
const ITEMS = [
  { id: 'wh-item-read', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-read' },
  { id: 'wh-item-hidden', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-hidden' },
  { id: 'wh-item-tenant', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-other-tenant' },
  { id: 'wh-item-nows', itemType: 'databricks-sql-warehouse', workspaceId: '' },
  // Same id shape, WRONG type — a tag naming it must not resolve.
  { id: 'nb-item', itemType: 'notebook', workspaceId: 'ws-read' },
  // ONE id, TWO warehouse items (ids are unique per partition only). One is in
  // the Viewer's `ws-read`, so returning the first row would admit a 200.
  { id: 'wh-item-dup', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-read' },
  { id: 'wh-item-dup', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-hidden' },
];
// The container EVALUATES the query text (`cosmos-query-model.ts`): only the
// predicates the production query writes are applied. The previous mock filtered
// on the `@t` parameter itself, so dropping `AND c.itemType = @t` from the query
// was invisible to it.
let cosmos: ItemsModel;
vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: async () => cosmos.container }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: vi.fn(() => null),
  executeStatement: vi.fn(),
  getWarehouse: vi.fn(),
}));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  isGovCloud: vi.fn(() => false),
}));
vi.mock('@/lib/azure/ai-functions-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/ai-functions-client')>()),
  callAiFn: vi.fn(),
  callAiFnBatch: vi.fn(),
  emitAiFnUsage: vi.fn(async () => undefined),
}));
vi.mock('@/lib/azure/copilot-config-store', () => ({ loadTenantCopilotConfig: vi.fn(async () => null) }));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { callAiFn } from '@/lib/azure/ai-functions-client';
import { makeItemsModel, type ItemsModel } from '../../../../_lib/__tests__/cosmos-query-model';

const USER = { claims: { upn: 'u@contoso.com', oid: 'oid-user', tid: 'tid-1' }, exp: 9_999_999_999 };
const ADMIN = { claims: { upn: 'a@contoso.com', oid: 'oid-admin', tid: 'tid-1' }, exp: 9_999_999_999 };

/** Roles the NON-admin holds. `Viewer` is read-only. */
const USER_ROLES: Record<string, 'Viewer' | 'Member'> = { 'ws-read': 'Viewer' };

/** Live warehouse tags, keyed by warehouse id. */
const tag = (v: string) => ({ key: 'loom_item_id', value: v });
const WAREHOUSES: Record<string, any> = {
  'wh-bound': { id: 'wh-bound', state: 'RUNNING', tags: { custom_tags: [{ key: 'env', value: 'dev' }, tag('wh-item-read')] } },
  'wh-bound-case': { id: 'wh-bound-case', state: 'RUNNING', tags: { custom_tags: [{ key: ' LOOM_Item_ID ', value: 'wh-item-read' }] } },
  'wh-hidden': { id: 'wh-hidden', state: 'RUNNING', tags: { custom_tags: [tag('wh-item-hidden')] } },
  'wh-tenant': { id: 'wh-tenant', state: 'RUNNING', tags: { custom_tags: [tag('wh-item-tenant')] } },
  'wh-nows': { id: 'wh-nows', state: 'RUNNING', tags: { custom_tags: [tag('wh-item-nows')] } },
  'wh-untagged': { id: 'wh-untagged', state: 'RUNNING', tags: { custom_tags: [{ key: 'env', value: 'dev' }] } },
  'wh-orphan': { id: 'wh-orphan', state: 'RUNNING', tags: { custom_tags: [tag('item-deleted')] } },
  'wh-wrongtype': { id: 'wh-wrongtype', state: 'RUNNING', tags: { custom_tags: [tag('nb-item')] } },
  'wh-conflict': { id: 'wh-conflict', state: 'RUNNING', tags: { custom_tags: [tag('wh-item-read'), tag('wh-item-hidden')] } },
  'wh-cosmos': { id: 'wh-cosmos', state: 'RUNNING', tags: { custom_tags: [tag('cosmos-down')] } },
  'wh-stopped': { id: 'wh-stopped', state: 'STOPPED', tags: { custom_tags: [tag('wh-item-read')] } },
  'wh-dup': { id: 'wh-dup', state: 'RUNNING', tags: { custom_tags: [tag('wh-item-dup')] } },
};

const notFound = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 404 });

/** Model of `authorizeItemWorkspace` — see the header for the two properties. */
async function ladder(session: any, opts: any) {
  let ws = (opts.workspaceId || '').trim();
  if (!ws) {
    ws = ITEMS.find((i) => i.id === opts.itemId && i.itemType === opts.itemType)?.workspaceId || '';
    if (!ws) return null; // the real function's permissive case
  }
  if (session.claims.oid === 'oid-admin') {
    if (ws === 'ws-other-tenant') {
      return NextResponse.json({ ok: false, code: 'tenant_unconfirmed', error: 'tenant not confirmed' }, { status: 409 });
    }
    return null;
  }
  const role = USER_ROLES[ws];
  if (!role) return notFound(opts.notFound);
  if (role === 'Viewer' && !opts.allowReadRoles) return notFound(opts.notFound);
  return null;
}

function req(body: any) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
const ctx = { params: Promise.resolve({ type: 'lakehouse', id: 'item-1' }) } as any;
const run = (warehouseId: string) =>
  POST(req({ fn: 'sentiment', column: 'review', table: 'main.sales.reviews', warehouseId }), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  cosmos = makeItemsModel(ITEMS, {
    failQuery: (s) => s.parameters?.some((p) => p.name === '@id' && p.value === 'cosmos-down') ?? false,
  });
  vi.stubEnv('LOOM_TENANT_ADMIN_OID', 'oid-admin');
  (getSession as any).mockReturnValue(USER);
  (isGovCloud as any).mockReturnValue(false);
  (authorizeItemWorkspace as any).mockImplementation(ladder);
  (getWarehouse as any).mockImplementation(async (id: string) => {
    if (id === 'wh-dbx-down') throw Object.assign(new Error('upstream 500'), { status: 500 });
    const w = WAREHOUSES[id];
    if (!w) throw Object.assign(new Error('not found'), { status: 404 });
    return w;
  });
  (executeStatement as any).mockResolvedValue({ columns: ['review', 'ai_result'], rows: [['ok', 'positive']], rowCount: 1 });
  (callAiFn as any).mockResolvedValue({ result: 'positive', model: 'gpt-4o', usage: {} });
});
afterEach(() => vi.unstubAllEnvs());

describe('a non-admin caller', () => {
  // RED if `allowReadRoles: true` is dropped (the Viewer is then refused), or
  // if the tag is read off the wrong field.
  it('runs on a warehouse linked to an item in a workspace they can only READ', async () => {
    const res = await run('wh-bound');
    expect(res.status).toBe(200);
    expect(executeStatement).toHaveBeenCalledTimes(1);
    expect((executeStatement as any).mock.calls[0][0]).toBe('wh-bound');
  });

  // RED if the ladder is handed anything but the item's own workspace and read scope.
  it('is checked against the linked item\'s workspace, read-scoped, by explicit id', async () => {
    await run('wh-bound');
    expect(authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    expect((authorizeItemWorkspace as any).mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws-read',
      itemId: 'wh-item-read',
      itemType: 'databricks-sql-warehouse',
      allowReadRoles: true,
    });
  });

  // RED if the owner key is matched case- or whitespace-sensitively.
  it('accepts the owner tag in any case and padding', async () => {
    const res = await run('wh-bound-case');
    expect(res.status).toBe(200);
  });

  // RED if the route runs on the caller-named warehouse without the check.
  it('is refused a warehouse linked to an item in a workspace they hold no role in', async () => {
    const res = await run('wh-hidden');
    const j = await res.json();
    expect(res.status).toBe(404);
    expect(j.code).toBe('warehouse_not_available');
    // RED if the remediation stops naming the in-product action (G2), or goes back
    // to sending the caller to an admin API path.
    expect(j.remediation).toContain('Link to this item');
    expect(j.remediation).not.toContain('/api/admin/');
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // RED if Databricks' 404 is treated as "untagged" (admin-only access),
  // or as a 502.
  it('is refused an unknown warehouse with the same 404', async () => {
    const res = await run('wh-nope');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('warehouse_not_available');
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // RED if an untagged warehouse is open to everyone (the previous behaviour).
  it('is refused an untagged warehouse', async () => {
    const res = await run('wh-untagged');
    expect(res.status).toBe(404);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // RED if a tag naming no item, or an item of another type, counts as bound.
  // `wh-wrongtype` names `nb-item`, a NOTEBOOK in `ws-read` where this caller is
  // a Viewer — so if the lookup query loses `AND c.itemType = @t`, the notebook
  // resolves, the read-scoped ladder admits it, and this becomes a 200.
  it('is refused an orphaned warehouse and one tagged with a non-warehouse item', async () => {
    for (const id of ['wh-orphan', 'wh-wrongtype']) {
      const res = await run(id);
      expect(res.status, id).toBe(404);
    }
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // RED if the item lookup stops filtering on type in the QUERY TEXT (the mock
  // applies only what the text says), or binds `@t` to anything but the
  // warehouse item type. Positive pair: the same lookup resolves `wh-item-read`.
  it('looks the linked item up by id AND item type, in the query itself', async () => {
    await run('wh-wrongtype');
    const q = cosmos.queries.find((s) => s.parameters?.some((p) => p.name === '@id' && p.value === 'nb-item'));
    expect(q, 'no item lookup was issued for nb-item').toBeDefined();
    expect(q!.query).toMatch(/\bc\.itemType\s*=\s*@t\b/);
    expect(q!.parameters?.find((p) => p.name === '@t')?.value).toBe('databricks-sql-warehouse');
    expect((await run('wh-bound')).status).toBe(200);
  });

  // RED if the empty-workspace fail-closed check is removed: the ladder model
  // then ALLOWS (property 2), and this becomes a 200.
  it('is refused a warehouse whose linked item has no workspace', async () => {
    const res = await run('wh-nows');
    expect(res.status).toBe(404);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // RED if any refusal body differs — e.g. an "untagged" or "unreadable" wording
  // would tell the caller which case applied.
  it('gets byte-identical refusals for unknown, untagged, orphaned and unreadable', async () => {
    const bodies = [];
    for (const id of ['wh-nope', 'wh-untagged', 'wh-orphan', 'wh-hidden', 'wh-nows']) {
      bodies.push(JSON.stringify(await (await run(id)).json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]).ok).toBe(false);
  });
});

describe('a tenant admin', () => {
  beforeEach(() => (getSession as any).mockReturnValue(ADMIN));

  // RED if the unbound branch refuses admins too (the shared `loom-default`
  // warehouse would then be unusable for everyone until adopted).
  it('may target untagged and orphaned warehouses', async () => {
    for (const id of ['wh-untagged', 'wh-orphan']) {
      const res = await run(id);
      expect(res.status, id).toBe(200);
    }
    expect(executeStatement).toHaveBeenCalledTimes(2);
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
  });

  // RED if admins short-circuit BEFORE the tagged branch: the resolver's 409
  // tenancy refusal is then skipped and this becomes a 200.
  it('goes through the ladder for a tagged warehouse, and its 409 passes through', async () => {
    const res = await run('wh-tenant');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('tenant_unconfirmed');
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // Positive pair for the 409: the same path admits an admin in-tenant.
  it('runs on a tagged warehouse in a workspace the resolver grants', async () => {
    const res = await run('wh-hidden');
    expect(res.status).toBe(200);
    expect((authorizeItemWorkspace as any).mock.calls[0][1].workspaceId).toBe('ws-hidden');
  });

  // RED if a Databricks 404 is admitted for admins as though it were untagged.
  it('is refused an unknown warehouse', async () => {
    const res = await run('wh-nope');
    expect(res.status).toBe(404);
    expect(executeStatement).not.toHaveBeenCalled();
  });
});

describe('when the link cannot be read', () => {
  // RED if a read failure is treated as "untagged" (admit admins) or "unknown".
  it('502s with a code, and runs nothing, for a Databricks error, a Cosmos error, or two owner values', async () => {
    (getSession as any).mockReturnValue(ADMIN);
    for (const id of ['wh-dbx-down', 'wh-cosmos', 'wh-conflict']) {
      const res = await run(id);
      const j = await res.json();
      expect(res.status, id).toBe(502);
      expect(j.code, id).toBe('warehouse_unverifiable');
    }
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // RED if `loadWarehouseItemRaw` returns the first of two matching rows instead
  // of failing closed: the first row is in `ws-read`, where this NON-admin is a
  // Viewer, so the read-scoped ladder would admit it and this becomes a 200.
  it('502s, and runs nothing, when the linked id matches two warehouse items', async () => {
    const res = await run('wh-dup');
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.code).toBe('warehouse_unverifiable');
    expect(j.error).toContain('more than one item');
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(executeStatement).not.toHaveBeenCalled();
    // Positive pair: a single-row id on the same path still runs.
    expect((await run('wh-bound')).status).toBe(200);
  });
});

describe('unchanged paths', () => {
  // RED if the state pre-check stops reading the resolved warehouse.
  it('still 409s on a linked but stopped warehouse', async () => {
    const res = await run('wh-stopped');
    expect(res.status).toBe(409);
    expect((await res.json()).state).toBe('STOPPED');
    expect(executeStatement).not.toHaveBeenCalled();
  });

  // RED if the warehouse check runs on the Gov AOAI path, which takes no warehouse.
  it('Gov: the AOAI path runs with no warehouse lookup, even for an unknown id', async () => {
    (isGovCloud as any).mockReturnValue(true);
    vi.stubEnv('LOOM_AOAI_ENDPOINT', 'https://aoai.example');
    const res = await POST(req({ fn: 'sentiment', column: 'review', table: 't', warehouseId: 'wh-nope', input: 'great' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).engine).toBe('aoai');
    expect(getWarehouse).not.toHaveBeenCalled();
    expect(callAiFn).toHaveBeenCalledTimes(1);
  });

  // RED if `withSession` is lost in the migration.
  it('401s with no session and reads no warehouse', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await run('wh-bound');
    expect(res.status).toBe(401);
    expect(getWarehouse).not.toHaveBeenCalled();
  });
});
