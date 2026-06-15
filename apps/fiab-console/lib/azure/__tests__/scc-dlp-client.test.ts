/**
 * Vitest specs for scc-dlp-client (DLP compliance-policy CRUD sidecar).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('scc-dlp-client', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('throws DlpAdminNotConfiguredError when LOOM_DLP_ADMIN_ENABLED is unset', async () => {
    delete process.env.LOOM_DLP_ADMIN_ENABLED;
    const mod = await import('../scc-dlp-client');
    await expect(mod.listDlpCompliancePolicies()).rejects.toBeInstanceOf(mod.DlpAdminNotConfiguredError);
    try {
      await mod.listDlpCompliancePolicies();
    } catch (e: any) {
      expect(e.hint.missingEnvVar).toBe('LOOM_DLP_ADMIN_ENABLED');
      expect(e.hint.rolesRequired).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Exchange.ManageAsApp' }),
        expect.objectContaining({ name: 'Compliance Administrator' }),
      ]));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honest-gates when the SCC endpoint env var is missing', async () => {
    process.env.LOOM_DLP_ADMIN_ENABLED = 'true';
    delete process.env.LOOM_SCC_LABELS_ENDPOINT;
    const mod = await import('../scc-dlp-client');
    await expect(mod.createDlpCompliancePolicy({ name: 'x', exchange: true })).rejects.toBeInstanceOf(mod.DlpAdminNotConfiguredError);
  });

  it('isDlpAdminConfigured reflects env wiring', async () => {
    const mod = await import('../scc-dlp-client');
    delete process.env.LOOM_DLP_ADMIN_ENABLED;
    expect(mod.isDlpAdminConfigured()).toBe(false);
    process.env.LOOM_DLP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://func-scclbl-test.azurewebsites.net';
    process.env.LOOM_SCC_LABELS_KEY = 'k';
    expect(mod.isDlpAdminConfigured()).toBe(true);
  });

  it('validates create input before calling the sidecar', async () => {
    process.env.LOOM_DLP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://func-scclbl-test.azurewebsites.net';
    process.env.LOOM_SCC_LABELS_KEY = 'k';
    const mod = await import('../scc-dlp-client');
    // No workload selected.
    await expect(mod.createDlpCompliancePolicy({ name: 'p' })).rejects.toBeInstanceOf(mod.DlpAdminError);
    // Rule without a sensitive type.
    await expect(mod.createDlpCompliancePolicy({ name: 'p', exchange: true, rule: { name: 'r', sensitiveTypes: [] } }))
      .rejects.toBeInstanceOf(mod.DlpAdminError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a create command to /api/dlp with the host key and returns data', async () => {
    process.env.LOOM_DLP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://func-scclbl-test.azurewebsites.net';
    process.env.LOOM_SCC_LABELS_KEY = 'secret-key';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { id: 'guid-1', name: 'p' } }), { status: 200 }));
    const mod = await import('../scc-dlp-client');
    const res = await mod.createDlpCompliancePolicy({
      name: 'p', exchange: true, rule: { name: 'r', sensitiveTypes: ['Credit Card Number'], blockAccess: true },
    });
    expect(res).toEqual({ id: 'guid-1', name: 'p' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://func-scclbl-test.azurewebsites.net/api/dlp');
    expect(init.headers['x-functions-key']).toBe('secret-key');
    const body = JSON.parse(init.body);
    expect(body.action).toBe('create');
    expect(body.policy.rule.sensitiveTypes).toEqual(['Credit Card Number']);
  });

  it('maps a sidecar {ok:false} into DlpAdminError', async () => {
    process.env.LOOM_DLP_ADMIN_ENABLED = 'true';
    process.env.LOOM_SCC_LABELS_ENDPOINT = 'https://func-scclbl-test.azurewebsites.net';
    process.env.LOOM_SCC_LABELS_KEY = 'k';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'cmdlet boom' }), { status: 502 }));
    const mod = await import('../scc-dlp-client');
    await expect(mod.listDlpCompliancePolicies()).rejects.toBeInstanceOf(mod.DlpAdminError);
  });
});
