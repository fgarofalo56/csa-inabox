/**
 * #3342 — probe-databricks-account-admin, the live half of the
 * svc-databricks-account-admin gate.
 *
 * The probe is what makes the guided fix "clear itself": the Re-check re-runs
 * it, and only a successful account-plane read turns it green. These tests pin
 * that each probe outcome maps to a distinct status and that the guided steps
 * carry THIS deployment's values. The account client is mocked at its
 * classified boundary (`probeConsoleAccountAdmin`), whose own classification is
 * covered in lib/azure/__tests__/unity-catalog-account-admin.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  probe: vi.fn(),
  values: {
    consoleClientId: 'c1d2e3f4-0000-1111-2222-333344445555',
    consolePrincipalId: 'a9b8c7d6-0000-1111-2222-333344445555',
    accountId: 'acct-0f0f',
    accountConsoleUrl: 'https://accounts.azuredatabricks.net',
    suggestedDisplayName: 'loom-console-uami',
  },
}));

vi.mock('@/lib/azure/unity-catalog-account-client', () => ({
  probeConsoleAccountAdmin: h.probe,
  consoleAccountAdminValues: () => h.values,
}));

import { databricksAccountAdminFix, probeDatabricksAccountAdmin, type ProbeHelpers } from '../health-probes';

const helpers: ProbeHelpers = {
  ctx: { app: 'a', adminRg: 'rg', dlzRg: 'rg', sub: 's', uamiClientId: 'u', tenant: 't', cosmosAccount: 'c' },
  envVarFix: (vars) => ({ portalSteps: [`set ${vars.join(',')}`], fixScript: `# set ${vars.join(',')}` }),
};

beforeEach(() => h.probe.mockReset());

describe('probeDatabricksAccountAdmin', () => {
  it('passes only when the account API answered as an admin', async () => {
    h.probe.mockResolvedValueOnce({ state: 'admin', metastoreCount: 3 });
    const r = await probeDatabricksAccountAdmin(helpers);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('3 metastore(s)');
  });

  // Breaks if a refusal is reported as warn (or pass): the fix steps must ride on a fail.
  it('a refusal is a fail carrying the guided grant with this deployment\'s values', async () => {
    h.probe.mockResolvedValueOnce({ state: 'not-admin', status: 403, message: 'not an account admin' });
    const r = await probeDatabricksAccountAdmin(helpers);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('HTTP 403');
    expect(r.portalSteps?.join('\n')).toContain(h.values.consoleClientId);
    expect(r.fixScript).toContain(`APP_ID="${h.values.consoleClientId}"`);
    expect(r.fixScript).toContain(`ACCOUNT_ID="${h.values.accountId}"`);
  });

  // Breaks if "established nothing" is reported as a refusal (the R7 case):
  // no grant steps may be offered for a role nobody showed to be missing.
  it('an inconclusive read is a warn with NO grant steps', async () => {
    h.probe.mockResolvedValueOnce({ state: 'inconclusive', status: 0, message: 'timed out' });
    const r = await probeDatabricksAccountAdmin(helpers);
    expect(r.status).toBe('warn');
    expect(r.portalSteps).toBeUndefined();
    expect(r.remediation).toContain('does not say the role is missing');
  });

  it('an unset account id is a warn with the env Fix-it for LOOM_DATABRICKS_ACCOUNT_ID', async () => {
    h.probe.mockResolvedValueOnce({ state: 'not-configured' });
    const r = await probeDatabricksAccountAdmin(helpers);
    expect(r.status).toBe('warn');
    expect(r.fixScript).toBe('# set LOOM_DATABRICKS_ACCOUNT_ID');
  });

  it('a probe that throws or hangs is inconclusive, never a pass', async () => {
    h.probe.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await probeDatabricksAccountAdmin(helpers);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('socket hang up');
  });
});

describe('databricksAccountAdminFix', () => {
  it('names an unset value as unset instead of printing a stand-in', () => {
    const f = databricksAccountAdminFix({ ...h.values, consoleClientId: null, consolePrincipalId: null });
    expect(f.fixScript).toContain('APP_ID="<LOOM_UAMI_CLIENT_ID is unset in this deployment>"');
    expect(f.portalSteps.join('\n')).toContain('<LOOM_UAMI_PRINCIPAL_ID is unset in this deployment>');
  });

  it('targets the sovereign account host it was given', () => {
    const f = databricksAccountAdminFix({ ...h.values, accountConsoleUrl: 'https://accounts.azuredatabricks.us' });
    expect(f.fixScript).toContain('API="https://accounts.azuredatabricks.us/api/2.0/accounts/${ACCOUNT_ID}"');
    expect(f.portalSteps[0]).toContain('https://accounts.azuredatabricks.us');
  });
});
