/**
 * Vitest specs for graph-identity-client. Stubs global fetch + @azure/identity
 * to exercise URL composition ($search + ConsistencyLevel header), response
 * shaping, transitive-member mapping, sovereign scope derivation, and the
 * NotConfigured / 403 error code paths — without hitting real Microsoft Graph.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-token-id', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ManagedIdentityCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ChainedTokenCredential: class {
      constructor(..._creds: any[]) {}
      async getToken() { return { token: 'fake-token-id', expiresOnTimestamp: Date.now() + 60_000 }; }
    },
  };
});

describe('graph-identity-client', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    process.env.LOOM_UAMI_CLIENT_ID = 'test-uami';
    delete process.env.LOOM_GRAPH_BASE;
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('throws GraphIdentityNotConfiguredError naming all three AppRoles when env unset', async () => {
    delete process.env.LOOM_IDENTITY_PICKER_ENABLED;
    const mod = await import('../graph-identity-client');
    await expect(mod.searchUsers('alice')).rejects.toBeInstanceOf(mod.GraphIdentityNotConfiguredError);
    try {
      await mod.searchUsers('alice');
    } catch (e: any) {
      expect(e.hint.missingEnvVar).toBe('LOOM_IDENTITY_PICKER_ENABLED');
      const names = e.hint.rolesRequired.map((r: any) => r.name);
      expect(names).toEqual(expect.arrayContaining(['User.Read.All', 'Group.Read.All', 'Application.Read.All']));
    }
  });

  it('searchUsers uses $search with ConsistencyLevel:eventual and shapes hits', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { id: 'u1', displayName: 'Alice Smith', userPrincipalName: 'alice@contoso.com', mail: 'alice@contoso.com' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const mod = await import('../graph-identity-client');
    const hits = await mod.searchUsers('alice');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://graph.microsoft.com/v1.0/users?$search=');
    expect(decodeURIComponent(url)).toContain('"userPrincipalName:alice"');
    expect((init as any).headers.ConsistencyLevel).toBe('eventual');
    expect((init as any).headers.authorization).toBe('Bearer fake-token-id');
    expect(hits).toEqual([{ id: 'u1', type: 'user', displayName: 'Alice Smith', upn: 'alice@contoso.com', mail: 'alice@contoso.com' }]);
  });

  it('getGroupTransitiveMembers maps @odata.type to kind and dedupes', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { '@odata.type': '#microsoft.graph.user', id: 'u1', displayName: 'Alice', userPrincipalName: 'alice@contoso.com' },
        { '@odata.type': '#microsoft.graph.group', id: 'g2', displayName: 'Nested Group' },
        { '@odata.type': '#microsoft.graph.servicePrincipal', id: 's3', displayName: 'App SP', appId: 'app-3' },
        { '@odata.type': '#microsoft.graph.user', id: 'u1', displayName: 'Alice dup' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const mod = await import('../graph-identity-client');
    const members = await mod.getGroupTransitiveMembers('group-1');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/groups/group-1/transitiveMembers');
    expect(members).toHaveLength(3);
    expect(members.find((m) => m.id === 'u1')!.type).toBe('user');
    expect(members.find((m) => m.id === 'g2')!.type).toBe('group');
    expect(members.find((m) => m.id === 's3')).toMatchObject({ type: 'spn', appId: 'app-3' });
  });

  it('derives sovereign Graph base + scope from LOOM_GRAPH_BASE (GCC-High)', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    process.env.LOOM_GRAPH_BASE = 'https://graph.microsoft.us';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ value: [] }), { status: 200 }));

    const mod = await import('../graph-identity-client');
    expect(mod.__testing.GRAPH_BASE).toBe('https://graph.microsoft.us');
    expect(mod.__testing.GRAPH_SCOPE).toBe('https://graph.microsoft.us/.default');
    await mod.searchGroups('eng');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('https://graph.microsoft.us/v1.0/groups?$search=');
  });

  it('throws GraphIdentityError with status 403 when AppRole not consented', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    const make403 = () => new Response(JSON.stringify({
      error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' },
    }), { status: 403, headers: { 'content-type': 'application/json' } });
    fetchMock.mockResolvedValueOnce(make403());
    fetchMock.mockResolvedValueOnce(make403());

    const mod = await import('../graph-identity-client');
    await expect(mod.searchServicePrincipals('sp')).rejects.toBeInstanceOf(mod.GraphIdentityError);
    try {
      await mod.searchServicePrincipals('sp');
    } catch (e: any) {
      expect(e.status).toBe(403);
      expect(e.message).toContain('Insufficient privileges');
    }
  });

  it('searchAll merges kinds in parallel and dedupes by id', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/users?')) return Promise.resolve(new Response(JSON.stringify({ value: [{ id: 'u1', displayName: 'Alice', userPrincipalName: 'alice@x' }] }), { status: 200 }));
      if (url.includes('/groups?')) return Promise.resolve(new Response(JSON.stringify({ value: [{ id: 'g1', displayName: 'Alpha' }] }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ value: [{ id: 's1', displayName: 'SP-A', appId: 'a1' }] }), { status: 200 }));
    });

    const mod = await import('../graph-identity-client');
    const hits = await mod.searchAll('a');
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toEqual(['g1', 's1', 'u1']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('getGroupsByIds POSTs to /directoryObjects/getByIds with types=["group"] and maps results', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { id: 'g1', displayName: 'Alpha Team', mail: 'alpha@contoso.com', '@odata.type': '#microsoft.graph.group' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const mod = await import('../graph-identity-client');
    const results = await mod.getGroupsByIds(['g1', 'g2']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.microsoft.com/v1.0/directoryObjects/getByIds');
    expect((init as any).method).toBe('POST');
    const sentBody = JSON.parse((init as any).body);
    expect(sentBody.types).toEqual(['group']);
    expect(sentBody.ids).toEqual(['g1', 'g2']);
    expect(results).toEqual([{ id: 'g1', type: 'group', displayName: 'Alpha Team', mail: 'alpha@contoso.com', description: undefined }]);
  });

  it('getGroupsByIds returns [] without calling Graph for empty input', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    const mod = await import('../graph-identity-client');
    const results = await mod.getGroupsByIds([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('getGroupsByIds throws GraphIdentityNotConfiguredError when env unset', async () => {
    delete process.env.LOOM_IDENTITY_PICKER_ENABLED;
    const mod = await import('../graph-identity-client');
    await expect(mod.getGroupsByIds(['g1'])).rejects.toBeInstanceOf(mod.GraphIdentityNotConfiguredError);
  });
});
