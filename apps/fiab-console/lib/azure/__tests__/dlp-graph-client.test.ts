/**
 * Vitest specs for dlp-graph-client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-token-dlp', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ManagedIdentityCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ChainedTokenCredential: class { constructor(..._creds: any[]) {} async getToken() { return { token: 'fake-token-dlp', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

describe('dlp-graph-client', () => {
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

  it('throws DlpNotConfiguredError when LOOM_DLP_ENABLED is unset', async () => {
    delete process.env.LOOM_DLP_ENABLED;
    const mod = await import('../dlp-graph-client');
    await expect(mod.listDlpPolicies()).rejects.toBeInstanceOf(mod.DlpNotConfiguredError);
    try {
      await mod.listDlpPolicies();
    } catch (e: any) {
      expect(e.hint.missingEnvVar).toBe('LOOM_DLP_ENABLED');
      expect(e.hint.rolesRequired).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Policy.Read.All' }),
      ]));
    }
  });

  it('returns [] when Graph 404s on the DLP policies list (preview not enabled)', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const mod = await import('../dlp-graph-client');
    const policies = await mod.listDlpPolicies();
    expect(policies).toEqual([]);
  });

  it('shapes DLP policy responses', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { id: 'p1', name: 'Finance PII', mode: 'enforce', status: 'Enabled', locations: ['SharePoint', 'OneDrive'], rules: [{ id: 'r1' }, { id: 'r2' }] },
        { id: 'p2', name: 'HR Records', mode: 'audit', status: 'Disabled', locations: ['Exchange'] },
      ],
    }), { status: 200 }));
    const mod = await import('../dlp-graph-client');
    const policies = await mod.listDlpPolicies();
    expect(policies).toHaveLength(2);
    expect(policies[0]).toMatchObject({ id: 'p1', mode: 'enforce', ruleCount: 2 });
    expect(policies[1]).toMatchObject({ id: 'p2', status: 'Disabled', locations: ['Exchange'] });
  });

  it('lists DLP alerts with a default 30-day filter', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { id: 'a1', title: 'PII detected', severity: 'high', status: 'newAlert', createdDateTime: '2026-05-20T10:00:00Z', detectionSource: 'microsoftDataLossPrevention' },
      ],
    }), { status: 200 }));
    const mod = await import('../dlp-graph-client');
    const alerts = await mod.listDlpAlerts();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1.0/security/alerts_v2');
    expect(url).toContain('microsoftDataLossPrevention');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'a1', severity: 'high' });
  });

  it('returns null from evaluatePolicy when Graph 404s (route translates to 501)', async () => {
    // evaluatePolicy uses the shared readJson which returns null on 404
    // (no throw). The BFF /api/admin/security/dlp/simulate route
    // catches the resulting null + DlpError chain and translates it
    // into HTTP 501 with the preview-not-enabled hint.
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const mod = await import('../dlp-graph-client');
    const result = await mod.evaluatePolicy({ content: 'test' });
    expect(result).toBeNull();
  });

  it('surfaces a DlpError when Graph returns 500 on simulate', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    const make500 = () => new Response(JSON.stringify({
      error: { message: 'Internal error' },
    }), { status: 500, headers: { 'content-type': 'application/json' } });
    fetchMock.mockResolvedValueOnce(make500());
    fetchMock.mockResolvedValueOnce(make500());

    const mod = await import('../dlp-graph-client');
    await expect(mod.evaluatePolicy({ content: 'test' })).rejects.toBeInstanceOf(mod.DlpError);
    try {
      await mod.evaluatePolicy({ content: 'test' });
    } catch (e: any) {
      expect(e.status).toBe(500);
    }
  });

  it('rejects empty content on simulate before calling Graph', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    const mod = await import('../dlp-graph-client');
    await expect(mod.evaluatePolicy({ content: '' })).rejects.toBeInstanceOf(mod.DlpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
