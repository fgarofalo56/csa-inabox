/**
 * Vitest specs for scc-labels-client. Stubs global fetch to exercise the
 * honest-gate (SccNotConfiguredError) and the sidecar request composition
 * for label / policy CRUD — without a real SCC PowerShell sidecar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('scc-labels-client', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
    delete process.env.LOOM_MIP_ADMIN_ENABLED;
    delete process.env.LOOM_SCC_LABELS_ENDPOINT;
    delete process.env.LOOM_SCC_LABELS_KEY;
  });
  afterEach(() => { process.env = { ...ORIG_ENV }; vi.restoreAllMocks(); });

  it('throws SccNotConfiguredError when admin sidecar is not enabled', async () => {
    const mod = await import('../scc-labels-client');
    await expect(mod.createLabel({ displayName: 'Confidential' })).rejects.toBeInstanceOf(mod.SccNotConfiguredError);
    try {
      await mod.listLabelPolicies();
    } catch (e: any) {
      expect(e.hint.missingEnvVar).toBe('LOOM_MIP_ADMIN_ENABLED');
      expect(e.hint.rolesRequired).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Exchange.ManageAsApp' }),
        expect.objectContaining({ name: 'Compliance Administrator' }),
      ]));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gates on missing endpoint / key even when enabled', async () => {
    process.env.LOOM_MIP_ADMIN_ENABLED = 'true';
    let mod = await import('../scc-labels-client');
    await expect(mod.listLabelPolicies()).rejects.toBeInstanceOf(mod.SccNotConfiguredError);
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://scc.example.net';
    vi.resetModules();
    mod = await import('../scc-labels-client');
    await expect(mod.listLabelPolicies()).rejects.toBeInstanceOf(mod.SccNotConfiguredError);
  });

  it('posts a create-label command with the function key header', async () => {
    process.env.LOOM_MIP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://scc.example.net/';
    process.env.LOOM_SCC_LABELS_KEY = 'k-123';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { id: 'guid-1', raw: {} } }), { status: 200 }));
    const mod = await import('../scc-labels-client');
    const r = await mod.createLabel({ displayName: 'Confidential', encryptionEnabled: true });
    expect(r.id).toBe('guid-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://scc.example.net/api/labels');
    expect((init as any).headers['x-functions-key']).toBe('k-123');
    const body = JSON.parse((init as any).body);
    expect(body.action).toBe('create-label');
    expect(body.label.displayName).toBe('Confidential');
    expect(body.label.encryptionEnabled).toBe(true);
  });

  it('maps Get-LabelPolicy rows (PascalCase) into the policy shape', async () => {
    process.env.LOOM_MIP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://scc.example.net';
    process.env.LOOM_SCC_LABELS_KEY = 'k-123';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: [{ Guid: 'p-1', Name: 'All staff', Mandatory: true, Labels: ['lbl-a'], Enabled: true }],
    }), { status: 200 }));
    const mod = await import('../scc-labels-client');
    const policies = await mod.listLabelPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ id: 'p-1', name: 'All staff', isMandatory: true, enabled: true });
    expect(policies[0].labels).toEqual(['lbl-a']);
  });

  it('throws SccError when the sidecar returns ok:false', async () => {
    process.env.LOOM_MIP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://scc.example.net';
    process.env.LOOM_SCC_LABELS_KEY = 'k-123';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'Set-Label: label not found' }), { status: 200 }));
    const mod = await import('../scc-labels-client');
    await expect(mod.deleteLabel('missing')).rejects.toBeInstanceOf(mod.SccError);
  });

  it('surfaces per-workload scope locations from Get-LabelPolicy', async () => {
    process.env.LOOM_MIP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://scc.example.net';
    process.env.LOOM_SCC_LABELS_KEY = 'k-123';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: [{
        Guid: 'p-2', Name: 'Finance', Labels: ['lbl-a'],
        ExchangeLocation: ['All'], SharePointLocation: ['https://x.sharepoint.com/sites/Fin'],
        OneDriveLocation: [], ModernGroupLocation: ['finance@contoso.com'],
      }],
    }), { status: 200 }));
    const mod = await import('../scc-labels-client');
    const [p] = await mod.listLabelPolicies();
    expect(p.exchangeLocation).toEqual(['All']);
    expect(p.sharePointLocation).toEqual(['https://x.sharepoint.com/sites/Fin']);
    expect(p.oneDriveLocation).toEqual([]);
    expect(p.modernGroupLocation).toEqual(['finance@contoso.com']);
    expect(p.scopes).toEqual(expect.arrayContaining(['Exchange', 'SharePoint', 'Microsoft 365 Groups']));
  });

  it('sends scope locations in a create-policy command', async () => {
    process.env.LOOM_MIP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://scc.example.net';
    process.env.LOOM_SCC_LABELS_KEY = 'k-123';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { id: 'p-9', raw: {} } }), { status: 200 }));
    const mod = await import('../scc-labels-client');
    await mod.createLabelPolicy({
      name: 'All staff', labels: ['lbl-a'],
      exchangeLocation: ['All'], modernGroupLocation: ['g@contoso.com'],
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.action).toBe('create-policy');
    expect(body.policy.exchangeLocation).toEqual(['All']);
    expect(body.policy.modernGroupLocation).toEqual(['g@contoso.com']);
  });
});
