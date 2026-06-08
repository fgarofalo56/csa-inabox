/**
 * Vitest specs for the Governance Domains (F4) DomainStore adapters.
 *
 * Verifies:
 *   - getDomainsStore() defaults to the Cosmos adapter (no Fabric dependency)
 *     and routes to the Fabric adapter only when LOOM_DOMAINS_BACKEND=fabric.
 *   - getDomainsStore() throws DomainsBackendGateError at IL5 + backend=fabric.
 *   - cosmosDomainStore create/update/delete round-trip against a fake Cosmos
 *     container and mirror to Purview when configured — with ZERO Fabric API
 *     calls on the default path (no-fabric-dependency rule).
 *   - assignWorkspaces patches workspace docs to set `domain`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// @azure/identity is imported at module top-level by domains-client for the
// opt-in Fabric credential. Mock it so the Cosmos default path under test never
// pulls the real ESM (which fails to resolve through the shared pnpm store).
vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-token', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ManagedIdentityCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ChainedTokenCredential: class {
      constructor(..._creds: any[]) {}
      async getToken() { return { token: 'fake-token', expiresOnTimestamp: Date.now() + 60_000 }; }
    },
  };
});

// --- Fakes for the Cosmos + Purview backends -------------------------------

const domainDocs = new Map<string, any>();
const workspaceDocs = new Map<string, any>();

function fakeItem(store: Map<string, any>, id: string) {
  return {
    read: async () => ({ resource: store.get(id) }),
    replace: async (doc: any) => {
      store.set(id, doc);
      return { resource: doc };
    },
    delete: async () => {
      store.delete(id);
      return {};
    },
  };
}

const fakeDomainsContainer = {
  items: {
    create: async (doc: any) => {
      domainDocs.set(doc.id, doc);
      return { resource: doc };
    },
    query: () => ({
      fetchAll: async () => ({ resources: Array.from(domainDocs.values()) }),
    }),
  },
  item: (id: string, _pk: string) => fakeItem(domainDocs, id),
};

const fakeWorkspacesContainer = {
  item: (id: string, _pk: string) => fakeItem(workspaceDocs, id),
};

const purviewCalls: any[] = [];

vi.mock('../cosmos-client', () => ({
  governanceDomainsContainer: async () => fakeDomainsContainer,
  workspacesContainer: async () => fakeWorkspacesContainer,
}));

vi.mock('../purview-client', () => ({
  isPurviewConfigured: () => !!process.env.LOOM_PURVIEW_ACCOUNT,
  createBusinessDomain: async (body: any) => {
    purviewCalls.push(['create', body]);
    return { id: `col-${body.id}`, name: body.name, description: body.description };
  },
  updateBusinessDomain: async (id: string, body: any) => {
    purviewCalls.push(['update', id, body]);
    return { id, name: body.name, description: body.description };
  },
  deleteBusinessDomain: async (id: string) => {
    purviewCalls.push(['delete', id]);
  },
}));

describe('domains-client — DomainStore adapters (F4)', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    domainDocs.clear();
    workspaceDocs.clear();
    purviewCalls.length = 0;
    delete process.env.LOOM_DOMAINS_BACKEND;
    delete process.env.LOOM_CLOUD_TIER;
    delete process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    // Any Fabric API call on the default path is a rule violation — make fetch
    // throw so the test fails loudly if the Cosmos path ever reaches the network.
    fetchMock = vi.fn(() => {
      throw new Error('NO network call expected on the Cosmos default path');
    });
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('getDomainsStore() defaults to the Cosmos adapter when LOOM_DOMAINS_BACKEND is unset', async () => {
    const mod = await import('../domains-client');
    expect(mod.getDomainsStore()).toBe(mod.cosmosDomainStore);
  });

  it('getDomainsStore() returns the Fabric adapter only when explicitly opted in', async () => {
    process.env.LOOM_DOMAINS_BACKEND = 'fabric';
    const mod = await import('../domains-client');
    expect(mod.getDomainsStore()).toBe(mod.fabricAdminDomainStore);
  });

  it('getDomainsStore() throws DomainsBackendGateError at IL5 + backend=fabric', async () => {
    process.env.LOOM_DOMAINS_BACKEND = 'fabric';
    process.env.LOOM_CLOUD_TIER = 'IL5';
    const mod = await import('../domains-client');
    expect(() => mod.getDomainsStore()).toThrow(mod.DomainsBackendGateError);
  });

  it('cosmosDomainStore create→update→delete round-trips in Cosmos + mirrors to Purview, NO Fabric call', async () => {
    const mod = await import('../domains-client');
    const store = mod.cosmosDomainStore;

    const created = await store.createDomain(
      'tenant-1',
      { id: 'finance', name: 'Finance', description: 'Money' },
      'alice@contoso.com',
    );
    expect(created).toMatchObject({ id: 'finance', tenantId: 'tenant-1', name: 'Finance' });
    expect(created.purviewCollectionId).toBe('col-finance');
    expect(domainDocs.get('finance')).toBeTruthy();

    const updated = await store.updateDomain(
      'tenant-1',
      'finance',
      { name: 'Finance & Risk', description: 'Money + risk' },
      'bob@contoso.com',
    );
    expect(updated.name).toBe('Finance & Risk');
    expect(domainDocs.get('finance').name).toBe('Finance & Risk');

    await store.deleteDomain('tenant-1', 'finance');
    expect(domainDocs.has('finance')).toBe(false);

    // Purview mirror was exercised for all three operations…
    expect(purviewCalls.map((c) => c[0])).toEqual(['create', 'update', 'delete']);
    // …and the Cosmos default path NEVER hit the network (no Fabric dependency).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cosmosDomainStore skips the Purview mirror when LOOM_PURVIEW_ACCOUNT is unset', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    const mod = await import('../domains-client');
    const created = await mod.cosmosDomainStore.createDomain(
      'tenant-1',
      { id: 'ops', name: 'Operations' },
      'alice@contoso.com',
    );
    expect(created.purviewCollectionId).toBeUndefined();
    expect(domainDocs.get('ops')).toBeTruthy();
    expect(purviewCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cosmosDomainStore.assignWorkspaces patches workspace docs to set domain', async () => {
    workspaceDocs.set('ws-1', { id: 'ws-1', tenantId: 'tenant-1', name: 'WS One' });
    workspaceDocs.set('ws-2', { id: 'ws-2', tenantId: 'tenant-1', name: 'WS Two' });
    const mod = await import('../domains-client');
    const res = await mod.cosmosDomainStore.assignWorkspaces('tenant-1', 'finance', ['ws-1', 'ws-2', 'missing']);
    expect(res.ok).toBe(true);
    expect(res.assigned).toEqual(['ws-1', 'ws-2']);
    expect(workspaceDocs.get('ws-1').domain).toBe('finance');
    expect(workspaceDocs.get('ws-2').domain).toBe('finance');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cosmosDomainStore.updateDomain throws 404 for an unknown domain', async () => {
    const mod = await import('../domains-client');
    await expect(
      mod.cosmosDomainStore.updateDomain('tenant-1', 'nope', { name: 'X' }, 'alice@contoso.com'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
