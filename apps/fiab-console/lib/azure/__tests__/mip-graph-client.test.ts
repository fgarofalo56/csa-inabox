/**
 * Vitest specs for mip-graph-client. These tests stub global fetch +
 * @azure/identity to exercise the URL composition, response shaping,
 * and the NotConfigured / Mip error code paths — without hitting real
 * Microsoft Graph.
 *
 * To run:  pnpm test  (vitest is already in package.json devDependencies)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock @azure/identity BEFORE importing the client so the module-level
// `credential` is constructed with a deterministic stub.
vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-token-mip', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ManagedIdentityCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ChainedTokenCredential: class { constructor(..._creds: any[]) {} async getToken() { return { token: 'fake-token-mip', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

describe('mip-graph-client', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    process.env.LOOM_UAMI_CLIENT_ID = 'test-uami';
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('throws MipNotConfiguredError when LOOM_MIP_ENABLED is unset', async () => {
    delete process.env.LOOM_MIP_ENABLED;
    const mod = await import('../mip-graph-client');
    await expect(mod.listSensitivityLabels()).rejects.toBeInstanceOf(mod.MipNotConfiguredError);
    try {
      await mod.listSensitivityLabels();
    } catch (e: any) {
      expect(e.hint.missingEnvVar).toBe('LOOM_MIP_ENABLED');
      expect(e.hint.rolesRequired).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'InformationProtectionPolicy.Read.All' }),
      ]));
    }
  });

  it('lists labels from Graph beta and shapes the response', async () => {
    process.env.LOOM_MIP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { id: 'lbl-1', name: 'Public', displayName: 'Public', sensitivity: 0, isActive: true, applicableTo: 'file' },
        { id: 'lbl-2', name: 'Confidential', displayName: 'Confidential', sensitivity: 3, color: '#cc0000', parent: { id: 'lbl-1' } },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const mod = await import('../mip-graph-client');
    const labels = await mod.listSensitivityLabels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://graph.microsoft.com/beta/security/informationProtection/sensitivityLabels');
    expect((init as any).headers.authorization).toBe('Bearer fake-token-mip');

    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatchObject({ id: 'lbl-1', displayName: 'Public', sensitivity: 0, isActive: true });
    expect(labels[1]).toMatchObject({ id: 'lbl-2', parentId: 'lbl-1', color: '#cc0000' });
  });

  it('returns null when Graph 404s for a specific label', async () => {
    process.env.LOOM_MIP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const mod = await import('../mip-graph-client');
    const label = await mod.getSensitivityLabel('does-not-exist');
    expect(label).toBeNull();
  });

  it('surfaces a MipError with the Graph error message on 403', async () => {
    process.env.LOOM_MIP_ENABLED = 'true';
    // mockResolvedValueOnce-twice so both the rejects.toBeInstanceOf and
    // the subsequent .catch invocation each get a fresh 403 response.
    const make403 = () => new Response(JSON.stringify({
      error: { code: 'Forbidden', message: 'AppRole not consented' },
    }), { status: 403, headers: { 'content-type': 'application/json' } });
    fetchMock.mockResolvedValueOnce(make403());
    fetchMock.mockResolvedValueOnce(make403());

    const mod = await import('../mip-graph-client');
    await expect(mod.listLabelPolicies()).rejects.toBeInstanceOf(mod.MipError);
    try {
      await mod.listLabelPolicies();
    } catch (e: any) {
      expect(e.status).toBe(403);
      expect(e.message).toContain('AppRole not consented');
      expect(e.endpoint).toBe('/beta/security/informationProtection/policy/labels');
    }
  });

  it('posts evaluateApplication with the supplied content + metadata', async () => {
    process.env.LOOM_MIP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ result: { actions: [] } }), { status: 200 }));
    const mod = await import('../mip-graph-client');
    await mod.evaluateLabel({
      contentInfo: { format: 'default', identifier: 'item-1', metadata: [{ key: 'k', value: 'v' }] },
      contentToProcess: { contentEntries: [{ id: 'c1', content: 'secret data' }] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/beta/me/informationProtection/policy/labels/evaluateApplication');
    expect((init as any).method).toBe('POST');
    const body = JSON.parse((init as any).body);
    expect(body.contentInfo.identifier).toBe('item-1');
    expect(body.contentToProcess.contentEntries[0].content).toBe('secret data');
  });
});
