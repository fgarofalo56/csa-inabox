import { describe, it, expect } from 'vitest';
import { LoomClient, LoomApiError, ITEM_TYPES, isKnownItemType } from '../src/index.js';

/** A recorded fetch call. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Build a fake `fetch` that records calls and replies from a route map keyed by
 * `"<METHOD> <pathname>"`. The handler returns `{ status, body }`.
 */
function fakeFetch(routes: Record<string, (call: Call) => { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const call: Call = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${u.pathname}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ ok: false, error: `no route ${key}` }), { status: 404 });
    const { status, body } = handler(call);
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch, extra: Partial<{ token: string; cookie: string }> = {}) {
  return new LoomClient({ baseUrl: 'https://loom.example.com/', fetch: fetchImpl, ...extra });
}

describe('auth headers', () => {
  it('sends a bearer Authorization header when constructed with a token', async () => {
    const { impl, calls } = fakeFetch({ 'GET /api/v1/whoami': () => ({ status: 200, body: { ok: true, oid: 'x', tenantId: 't', auth: 'pat' } }) });
    await client(impl, { token: 'loom_pat_abc_secret' }).whoami();
    expect(calls[0].headers.Authorization).toBe('Bearer loom_pat_abc_secret');
    expect(calls[0].headers.Cookie).toBeUndefined();
  });

  it('sends a Cookie header when constructed with a cookie', async () => {
    const { impl, calls } = fakeFetch({ 'GET /api/v1/whoami': () => ({ status: 200, body: { ok: true, oid: 'x', tenantId: 't', auth: 'cookie' } }) });
    await client(impl, { cookie: 'cookie-value' }).whoami();
    expect(calls[0].headers.Cookie).toBe('loom_session=cookie-value');
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('normalizes the base URL (strips trailing slash)', () => {
    const c = new LoomClient({ baseUrl: 'https://loom.example.com///', fetch: (async () => new Response('')) as unknown as typeof fetch });
    expect(c.baseUrl).toBe('https://loom.example.com');
  });
});

describe('workspaces', () => {
  it('list → GET /api/workspaces (bare array)', async () => {
    const { impl, calls } = fakeFetch({ 'GET /api/workspaces': () => ({ status: 200, body: [{ id: 'w1', name: 'A' }] }) });
    const out = await client(impl).workspaces.list();
    expect(out).toEqual([{ id: 'w1', name: 'A' }]);
    expect(calls[0].method).toBe('GET');
  });

  it('list({count:true}) adds ?count=true', async () => {
    const { impl, calls } = fakeFetch({ 'GET /api/workspaces': () => ({ status: 200, body: [] }) });
    await client(impl).workspaces.list({ count: true });
    expect(calls[0].url).toContain('count=true');
  });

  it('create → POST with body', async () => {
    const { impl, calls } = fakeFetch({ 'POST /api/workspaces': (c) => ({ status: 201, body: { id: 'w2', name: (c.body as any).name } }) });
    const ws = await client(impl).workspaces.create({ name: 'New' });
    expect(ws.id).toBe('w2');
    expect(calls[0].body).toEqual({ name: 'New' });
  });

  it('get / delete hit the /{id} route', async () => {
    const { impl, calls } = fakeFetch({
      'GET /api/workspaces/w1': () => ({ status: 200, body: { id: 'w1', name: 'A' } }),
      'DELETE /api/workspaces/w1': () => ({ status: 200, body: { ok: true } }),
    });
    const c = client(impl);
    await c.workspaces.get('w1');
    await c.workspaces.delete('w1');
    expect(calls.map((x) => x.method)).toEqual(['GET', 'DELETE']);
  });
});

describe('items', () => {
  it('create validates the item type before any request', async () => {
    const { impl, calls } = fakeFetch({});
    await expect(client(impl).items.create('w1', { itemType: 'not-a-type', displayName: 'x' })).rejects.toBeInstanceOf(LoomApiError);
    expect(calls.length).toBe(0); // failed fast, no round-trip
  });

  it('create posts to the workspace items collection', async () => {
    const { impl, calls } = fakeFetch({ 'POST /api/workspaces/w1/items': (c) => ({ status: 201, body: { id: 'i1', workspaceId: 'w1', itemType: (c.body as any).itemType, displayName: 'L' } }) });
    const item = await client(impl).items.create('w1', { itemType: 'lakehouse', displayName: 'L' });
    expect(item.id).toBe('i1');
    expect(calls[0].url).toContain('/api/workspaces/w1/items');
  });

  it('get/update/delete use the cosmos-items typed CRUD path', async () => {
    const { impl, calls } = fakeFetch({
      'GET /api/cosmos-items/lakehouse/i1': () => ({ status: 200, body: { id: 'i1', workspaceId: 'w1', itemType: 'lakehouse', displayName: 'L' } }),
      'PATCH /api/cosmos-items/lakehouse/i1': () => ({ status: 200, body: { id: 'i1', workspaceId: 'w1', itemType: 'lakehouse', displayName: 'L2' } }),
      'DELETE /api/cosmos-items/lakehouse/i1': () => ({ status: 200, body: { ok: true } }),
    });
    const c = client(impl);
    await c.items.get('lakehouse', 'i1');
    const upd = await c.items.update('lakehouse', 'i1', { displayName: 'L2' });
    await c.items.delete('lakehouse', 'i1');
    expect(upd.displayName).toBe('L2');
    expect(calls.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual([
      'GET /api/cosmos-items/lakehouse/i1',
      'PATCH /api/cosmos-items/lakehouse/i1',
      'DELETE /api/cosmos-items/lakehouse/i1',
    ]);
  });
});

describe('catalog + thread', () => {
  it('search builds q/source/limit query params', async () => {
    const { impl, calls } = fakeFetch({ 'GET /api/catalog/search': () => ({ status: 200, body: { ok: true, hits: [] } }) });
    await client(impl).catalog.search('sales', { source: ['purview', 'onelake'], limit: 10 });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('q')).toBe('sales');
    expect(u.searchParams.get('source')).toBe('purview,onelake');
    expect(u.searchParams.get('limit')).toBe('10');
  });

  it('thread.edges unwraps the { ok, edges } envelope', async () => {
    const { impl } = fakeFetch({ 'GET /api/thread/edges': () => ({ status: 200, body: { ok: true, edges: [{ from: 'a', to: 'b' }] } }) });
    const edges = await client(impl).thread.edges();
    expect(edges).toEqual([{ from: 'a', to: 'b' }]);
  });
});

describe('error handling', () => {
  it('throws LoomApiError with status + code on a non-2xx response', async () => {
    const { impl } = fakeFetch({ 'GET /api/workspaces': () => ({ status: 401, body: { ok: false, error: 'Unauthorized', code: 'unauthorized' } }) });
    await expect(client(impl).workspaces.list()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('honors a 200 body carrying { ok:false } as an error', async () => {
    const { impl } = fakeFetch({ 'GET /api/thread/edges': () => ({ status: 200, body: { ok: false, error: 'degraded', code: 'x' } }) });
    await expect(client(impl).thread.edges()).rejects.toBeInstanceOf(LoomApiError);
  });

  it('surfaces the honest-gate hint on a 503', async () => {
    const { impl } = fakeFetch({ 'GET /api/catalog/search': () => ({ status: 503, body: { ok: false, error: 'not configured', code: 'gate', hint: 'set LOOM_X' } }) });
    await expect(client(impl).catalog.search('x')).rejects.toMatchObject({ status: 503, hint: 'set LOOM_X' });
  });
});

describe('service-principal login', () => {
  it('mints a cookie and uses it on subsequent calls', async () => {
    const { impl, calls } = fakeFetch({
      'POST /api/auth/cli-session': () => ({ status: 200, body: { ok: true, cookie: 'minted-cookie', expiresAt: 9999999999 } }),
      'GET /api/workspaces': () => ({ status: 200, body: [] }),
    });
    const c = client(impl);
    const session = await c.loginServicePrincipal({ clientId: 'a', clientSecret: 'b', tenantId: 't' });
    expect(session.cookie).toBe('minted-cookie');
    await c.workspaces.list();
    expect(calls[1].headers.Cookie).toBe('loom_session=minted-cookie');
  });
});

describe('item-type taxonomy', () => {
  it('exposes the shared taxonomy', () => {
    expect(ITEM_TYPES).toContain('lakehouse');
    expect(ITEM_TYPES).toContain('notebook');
    expect(isKnownItemType('warehouse')).toBe(true);
    expect(isKnownItemType('nope')).toBe(false);
  });
});
