/**
 * Unit tests for the OneLake shortcut + fabric item helpers added to
 * fabric-client.ts. Stubs @azure/identity + global.fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  createOneLakeShortcut, listOneLakeShortcuts, deleteOneLakeShortcut,
  getFabricItem, FabricError,
} from '../fabric-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    return new Response(JSON.stringify(out), { status });
  }) as any;
}
afterEach(() => { global.fetch = realFetch; });

describe('createOneLakeShortcut', () => {
  it('POSTs to /workspaces/{ws}/items/{item}/shortcuts with the right body', async () => {
    let url = '';
    let body: any;
    mockFetch((u, init) => {
      url = u;
      body = JSON.parse((init?.body as string) || '{}');
      return { name: 'bronze-cust', path: 'Files', target: body.target };
    });
    const out = await createOneLakeShortcut('ws-1', {
      itemId: 'lh-1', name: 'bronze-cust', path: 'Files',
      target: { adlsGen2: { location: 'https://acct.dfs.core.windows.net', subpath: '/bronze/customers' } },
    });
    expect(url).toContain('/workspaces/ws-1/items/lh-1/shortcuts');
    expect(body.name).toBe('bronze-cust');
    expect(body.target.adlsGen2.subpath).toBe('/bronze/customers');
    expect(out.name).toBe('bronze-cust');
  });

  it('validates required fields', async () => {
    await expect(createOneLakeShortcut('', { itemId: 'x', name: 'n', path: 'Files', target: { adlsGen2: { location: 'a', subpath: '/b' } } })).rejects.toThrow(/workspaceId/);
    await expect(createOneLakeShortcut('ws', { itemId: '', name: 'n', path: 'Files', target: { adlsGen2: { location: 'a', subpath: '/b' } } } as any)).rejects.toThrow(/itemId/);
    await expect(createOneLakeShortcut('ws', { itemId: 'x', name: '', path: 'Files', target: { adlsGen2: { location: 'a', subpath: '/b' } } } as any)).rejects.toThrow(/name/);
    await expect(createOneLakeShortcut('ws', { itemId: 'x', name: 'n', path: 'Files', target: {} } as any)).rejects.toThrow(/target/);
  });
});

describe('listOneLakeShortcuts', () => {
  it('GETs shortcuts and returns the value array', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { value: [{ name: 's1', path: 'Files', target: { adlsGen2: { location: 'a', subpath: '/b' } } }] }; });
    const out = await listOneLakeShortcuts('ws-1', 'lh-1');
    expect(url).toContain('/workspaces/ws-1/items/lh-1/shortcuts');
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('s1');
  });
});

describe('deleteOneLakeShortcut', () => {
  it('DELETEs the shortcut path', async () => {
    let method = '';
    let url = '';
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; return new Response('', { status: 204 }); });
    await deleteOneLakeShortcut('ws-1', 'lh-1', 'Files', 's1');
    expect(method).toBe('DELETE');
    expect(url).toContain('/workspaces/ws-1/items/lh-1/shortcuts/Files/s1');
  });
});

describe('getFabricItem', () => {
  it('GETs the item by id and returns it', async () => {
    mockFetch(() => ({ id: 'item-9', displayName: 'My Lakehouse', type: 'Lakehouse' }));
    const item = await getFabricItem('ws-1', 'item-9');
    expect(item.id).toBe('item-9');
    expect(item.type).toBe('Lakehouse');
  });

  it('wraps non-2xx into FabricError', async () => {
    mockFetch(() => new Response(JSON.stringify({ errorCode: 'ItemNotFound', message: 'nope' }), { status: 404 }));
    await expect(getFabricItem('ws', 'missing')).rejects.toBeInstanceOf(FabricError);
  });
});
