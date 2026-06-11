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

  it('honest-gates when Graph has no DLP policies segment for the tenant (404)', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const mod = await import('../dlp-graph-client');
    // The dataLossPrevention segment isn't readable via Graph for most tenants
    // (404 or 400 "Resource not found for the segment"). We surface an honest
    // configured-but-unavailable gate naming the Purview-portal action, rather
    // than masquerade it as an empty policy list.
    await expect(mod.listDlpPolicies()).rejects.toBeInstanceOf(mod.DlpNotConfiguredError);
    try {
      await mod.listDlpPolicies();
    } catch (e: any) {
      expect(e.hint.followUp).toMatch(/Purview portal/i);
    }
  });

  it('honest-gates when Graph 400s with "Resource not found for the segment"', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'BadRequest', message: "Resource not found for the segment 'dataLossPreventionPolicies'." } }), { status: 400 }),
    );
    const mod = await import('../dlp-graph-client');
    await expect(mod.listDlpPolicies()).rejects.toBeInstanceOf(mod.DlpNotConfiguredError);
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
    // Policy reads must target the informationProtection navigation property
    // (Get-MgBetaInformationProtectionDataLossPreventionPolicy), NOT security/.
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/beta/informationProtection/dataLossPreventionPolicies');
    expect(url).not.toContain('/beta/security/dataLossPreventionPolicies');
    expect(policies).toHaveLength(2);
    expect(policies[0]).toMatchObject({ id: 'p1', mode: 'enforce', ruleCount: 2 });
    expect(policies[1]).toMatchObject({ id: 'p2', status: 'Disabled', locations: ['Exchange'] });
  });

  it('lists DLP rules via the informationProtection policyRules navigation property', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [{ id: 'r1', name: 'SSN rule', priority: 0, isEnabled: true }],
    }), { status: 200 }));
    const mod = await import('../dlp-graph-client');
    const rules = await mod.listDlpRules('p1');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/beta/informationProtection/dataLossPreventionPolicies/p1/policyRules');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'r1', isEnabled: true });
  });

  it('passes assertEnabled (no throw) once LOOM_DLP_ENABLED=true — DLP wired by default', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    const mod = await import('../dlp-graph-client');
    expect(() => mod.__testing.assertEnabled()).not.toThrow();
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

  // ── F22 additions ──────────────────────────────────────────────────────────

  it('listDlpViolations shapes per-item violations from alerts_v2 evidence', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        {
          id: 'v1', severity: 'high', status: 'newAlert', createdDateTime: '2026-05-22T09:00:00Z',
          title: "DLP policy 'Finance PII' matched", actorDisplayName: 'Jane Doe',
          additionalData: { policyId: 'p1', policyName: 'Finance PII', ruleName: 'SSN rule', dlpAction: 'Block', workload: 'SharePoint' },
          evidences: [
            { '@odata.type': '#microsoft.graph.security.fileEvidence', filePath: '/sites/finance/q1.xlsx', userAccount: { userPrincipalName: 'jane@contoso.com' } },
          ],
        },
      ],
    }), { status: 200 }));
    const mod = await import('../dlp-graph-client');
    const violations = await mod.listDlpViolations();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1.0/security/alerts_v2');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      alertId: 'v1', policyId: 'p1', policyName: 'Finance PII', ruleName: 'SSN rule',
      severity: 'high', action: 'Block', user: 'jane@contoso.com', itemPath: '/sites/finance/q1.xlsx',
    });
  });

  it('listDlpViolations filters by policyId when supplied', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { id: 'v1', additionalData: { policyId: 'p1', policyName: 'A' } },
        { id: 'v2', additionalData: { policyId: 'p2', policyName: 'B' } },
      ],
    }), { status: 200 }));
    const mod = await import('../dlp-graph-client');
    const violations = await mod.listDlpViolations({ policyId: 'p2' });
    expect(violations).toHaveLength(1);
    expect(violations[0].alertId).toBe('v2');
  });

  it('getScanStatus returns an honest, non-faked gate', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    const mod = await import('../dlp-graph-client');
    const status = await mod.getScanStatus();
    expect(status.available).toBe(false);
    expect(status.powershellCmd).toBe('Get-ScanStatus');
    expect(status.portalLink).toMatch(/purview/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('triggerScan throws a typed 501 with portal remediation (no faked success)', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    const mod = await import('../dlp-graph-client');
    await expect(mod.triggerScan()).rejects.toBeInstanceOf(mod.DlpError);
    try {
      await mod.triggerScan();
    } catch (e: any) {
      expect(e.status).toBe(501);
      expect(e.body?.powershellCmd).toBe('Start-Scan');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honest-gates DLP policy reads in US Government clouds before calling Graph', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    process.env.LOOM_CLOUD_BOUNDARY = 'GCC-High';
    delete process.env.LOOM_DLP_GRAPH_BASE;
    const mod = await import('../dlp-graph-client');
    await expect(mod.listDlpPolicies()).rejects.toBeInstanceOf(mod.DlpNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled(); // gated before any Graph call
  });

  it('uses the graph.microsoft.us root for violations in US Government clouds', async () => {
    process.env.LOOM_DLP_ENABLED = 'true';
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    process.env.LOOM_CLOUD_BOUNDARY = 'GCC-High';
    delete process.env.LOOM_DLP_GRAPH_BASE;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ value: [] }), { status: 200 }));
    const mod = await import('../dlp-graph-client');
    await mod.listDlpViolations();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('https://graph.microsoft.us/v1.0/security/alerts_v2');
  });
});
