/**
 * `resolvePrincipalRef` / `getPrincipalsByIds` — the directory lookup behind
 * <IdentityPicker>'s stored-value mode (Wave 1C).
 *
 * The property under test is the one deploy-integrity R7 exists for: this
 * function must distinguish "the directory answered and matched nothing"
 * (returns null) from "the directory could not be asked" (throws). The picker
 * renders those as two different sentences, and printing the first for the
 * second is exactly the class of false claim that sent two investigations down
 * the wrong path on 2026-08-05.
 *
 * Sovereign correctness is asserted too (cloud-parity.md): a Gov boundary must
 * resolve principals against ITS OWN Graph host, not the commercial one.
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

const OID = 'deadbeef-1111-2222-3333-444444444444';

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('graph-identity-client — stored-principal resolution', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    process.env.LOOM_UAMI_CLIENT_ID = 'test-uami';
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    delete process.env.LOOM_GRAPH_BASE;
    delete process.env.LOOM_CLOUD_BOUNDARY;
    delete process.env.AZURE_CLOUD;
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
  });
  afterEach(() => { process.env = { ...ORIG_ENV }; vi.restoreAllMocks(); });

  it('resolves an object id via directoryObjects/getByIds across ALL principal types', async () => {
    fetchMock.mockImplementation(async () => ok({
      value: [{ '@odata.type': '#microsoft.graph.group', id: OID, displayName: 'Finance Analysts' }],
    }));
    const mod = await import('../graph-identity-client');
    const hit = await mod.resolvePrincipalRef(OID);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1.0/directoryObjects/getByIds');
    // A user/group/spn filter — not the group-only one getGroupsByIds uses, or
    // a stored user oid would resolve to nothing and read as "deleted".
    expect(JSON.parse((init as any).body).types).toEqual(['user', 'group', 'servicePrincipal']);
    expect(hit).toMatchObject({ id: OID, type: 'group', displayName: 'Finance Analysts' });
  });

  it('returns NULL — not an error — when the directory answered and matched nothing', async () => {
    // getByIds returns [], then the appId fallback also returns [].
    fetchMock.mockImplementation(async () => ok({ value: [] }));
    const mod = await import('../graph-identity-client');
    await expect(mod.resolvePrincipalRef(OID)).resolves.toBeNull();
  });

  it('falls back to an appId lookup — an MSAL app-registration field stores a CLIENT id, not an object id', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ value: [] })) // getByIds: not a directory object id
      .mockResolvedValueOnce(ok({ value: [{ id: 'sp-object-id', displayName: 'CSA Loom Console', appId: OID, servicePrincipalType: 'Application' }] }));
    const mod = await import('../graph-identity-client');
    const hit = await mod.resolvePrincipalRef(OID);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/servicePrincipals?$filter=');
    expect(hit).toMatchObject({ type: 'spn', displayName: 'CSA Loom Console', appId: OID });
  });

  it('THROWS when the directory could not be asked, so the caller cannot print "not found" (R7)', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Insufficient privileges' } }), { status: 403 }));
    const mod = await import('../graph-identity-client');
    await expect(mod.resolvePrincipalRef(OID)).rejects.toBeInstanceOf(mod.GraphIdentityError);
  });

  it('resolves a UPN reference (AAS role members and policy statements store names, not ids)', async () => {
    fetchMock.mockResolvedValueOnce(ok({
      value: [{ id: 'u1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com', mail: 'ada@contoso.com' }],
    }));
    const mod = await import('../graph-identity-client');
    const hit = await mod.resolvePrincipalRef('ada@contoso.com');
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain("userPrincipalName eq 'ada@contoso.com'");
    expect(hit).toMatchObject({ type: 'user', upn: 'ada@contoso.com' });
  });

  it('falls through to a GROUP display-name lookup when no user matches', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ value: [] }))
      .mockResolvedValueOnce(ok({ value: [{ id: 'g1', displayName: 'Legacy-SSMS-Group' }] }));
    const mod = await import('../graph-identity-client');
    const hit = await mod.resolvePrincipalRef('Legacy-SSMS-Group');
    expect(hit).toMatchObject({ type: 'group', displayName: 'Legacy-SSMS-Group' });
  });

  it('escapes an OData literal so a quote in a stored name cannot break out of the filter', async () => {
    fetchMock.mockImplementation(async () => ok({ value: [] }));
    const mod = await import('../graph-identity-client');
    await mod.resolvePrincipalRef("O'Brien Analysts");
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain("O''Brien Analysts");
  });

  it('resolves against each SOVEREIGN Graph host — the real three-way split (cloud-parity)', async () => {
    // The earlier version set LOOM_GRAPH_BASE, which is the ONE branch that
    // short-circuits graphBoundary() — so the split it claimed to cover was
    // never exercised. Drive the boundary itself.
    const cases: Array<[string, string]> = [
      ['GCC-High', 'https://graph.microsoft.us'],
      ['IL5', 'https://dod-graph.microsoft.us'],
    ];
    for (const [boundary, host] of cases) {
      delete process.env.LOOM_GRAPH_BASE;
      process.env.LOOM_CLOUD_BOUNDARY = boundary;
      fetchMock.mockClear();
      fetchMock.mockImplementation(async () => ok({ value: [] }));
      vi.resetModules();
      const mod = await import('../graph-identity-client');
      await mod.resolvePrincipalRef(OID);
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url, `${boundary} must resolve against ${host}`).toContain(`${host}/v1.0/directoryObjects/getByIds`);
      expect(url).not.toContain('graph.microsoft.com');
    }
  });

  it('honours an explicit LOOM_GRAPH_BASE override ahead of the boundary map', async () => {
    process.env.LOOM_GRAPH_BASE = 'https://graph.microsoft.us';
    process.env.LOOM_CLOUD_BOUNDARY = 'Commercial';
    fetchMock.mockImplementation(async () => ok({ value: [] }));
    vi.resetModules();
    const mod = await import('../graph-identity-client');
    await mod.resolvePrincipalRef(OID);
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://graph.microsoft.us/v1.0/directoryObjects/getByIds');
  });

  it('is gated on LOOM_IDENTITY_PICKER_ENABLED like every other read on this client', async () => {
    delete process.env.LOOM_IDENTITY_PICKER_ENABLED;
    const mod = await import('../graph-identity-client');
    await expect(mod.resolvePrincipalRef(OID)).rejects.toBeInstanceOf(mod.GraphIdentityNotConfiguredError);
  });

  it('getPrincipalsByIds de-dupes, drops blanks, and CAPS the batch at 100', async () => {
    fetchMock.mockImplementation(async () => ok({ value: [] }));
    const mod = await import('../graph-identity-client');
    await mod.getPrincipalsByIds(['a', 'a', '', '  ', 'b']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).ids).toEqual(['a', 'b']);

    // The cap was in the name of this spec and asserted by nothing.
    // getByIds rejects more than 1000 per call; this client caps at 100.
    fetchMock.mockClear();
    await mod.getPrincipalsByIds(Array.from({ length: 250 }, (_, i) => `id-${i}`));
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).ids;
    expect(sent).toHaveLength(100);
    expect(sent[0]).toBe('id-0');
    expect(sent[99]).toBe('id-99');
  });
});
