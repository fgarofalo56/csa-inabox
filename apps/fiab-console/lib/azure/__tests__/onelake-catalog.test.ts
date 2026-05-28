/**
 * Unit tests for onelake-catalog-client. Stubs @azure/identity + global.fetch
 * so the tests don't hit Fabric REST.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

import {
  listOneLakeWorkspaces,
  listAllOneLakeItems,
  searchOneLake,
  addWorkspaceRoleAssignment,
  OneLakeLineageNotSupportedError,
  getWorkspaceLineage,
} from '../onelake-catalog-client';

const realFetch = global.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    return new Response(JSON.stringify(out), { status });
  }) as any;
}

beforeEach(() => { /* no env to reset */ });
afterEach(() => { global.fetch = realFetch; });

describe('listOneLakeWorkspaces', () => {
  it('hits /v1/workspaces and unwraps `value`', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { value: [{ id: 'w1', displayName: 'WS1' }] }; });
    const ws = await listOneLakeWorkspaces();
    expect(url).toContain('/v1/workspaces');
    expect(ws).toEqual([{ id: 'w1', displayName: 'WS1' }]);
  });
});

describe('listAllOneLakeItems', () => {
  it('federates items across workspaces and decorates with workspaceName', async () => {
    mockFetch((url) => {
      if (url.endsWith('/workspaces')) return { value: [{ id: 'w1', displayName: 'WS1' }, { id: 'w2', displayName: 'WS2' }] };
      if (url.includes('/workspaces/w1/items')) return { value: [{ id: 'i1', displayName: 'lh-a', type: 'Lakehouse' }] };
      if (url.includes('/workspaces/w2/items')) return { value: [{ id: 'i2', displayName: 'wh-b', type: 'Warehouse' }] };
      return {};
    });
    const items = await listAllOneLakeItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'i1', workspaceName: 'WS1', workspaceId: 'w1' });
    expect(items[1]).toMatchObject({ id: 'i2', workspaceName: 'WS2', workspaceId: 'w2' });
  });
});

describe('searchOneLake', () => {
  it('filters by query and returns federated hits', async () => {
    mockFetch((url) => {
      if (url.endsWith('/workspaces')) return { value: [{ id: 'w1', displayName: 'Customer Analytics' }] };
      if (url.includes('/workspaces/w1/items')) return { value: [{ id: 'i1', displayName: 'customers-lh', type: 'Lakehouse' }, { id: 'i2', displayName: 'orders-wh', type: 'Warehouse' }] };
      return {};
    });
    const hits = await searchOneLake('customer');
    expect(hits.some((h) => h.display_name === 'Customer Analytics')).toBe(true);
    expect(hits.some((h) => h.display_name === 'customers-lh')).toBe(true);
    expect(hits.find((h) => h.display_name === 'orders-wh')).toBeUndefined();
  });
});

describe('addWorkspaceRoleAssignment', () => {
  it('POSTs the role payload to /workspaces/{id}/roleAssignments', async () => {
    let observedUrl = ''; let observedBody = '';
    mockFetch((url, init) => {
      observedUrl = url; observedBody = (init?.body as string) || '';
      return {};
    });
    await addWorkspaceRoleAssignment('w1', { principal: { id: 'alice@contoso.com', type: 'User' }, role: 'Contributor' });
    expect(observedUrl).toContain('/workspaces/w1/roleAssignments');
    expect(JSON.parse(observedBody)).toEqual({ principal: { id: 'alice@contoso.com', type: 'User' }, role: 'Contributor' });
  });
});

describe('getWorkspaceLineage', () => {
  it('throws OneLakeLineageNotSupportedError when admin scan returns 501', async () => {
    mockFetch(() => new Response('{"message":"FeatureNotAvailable"}', { status: 501 }));
    await expect(getWorkspaceLineage('w1')).rejects.toBeInstanceOf(OneLakeLineageNotSupportedError);
  });
});
