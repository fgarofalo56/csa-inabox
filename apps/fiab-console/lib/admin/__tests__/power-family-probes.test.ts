/**
 * Live-probe coverage for the Power Platform / Power BI / Dataverse family.
 *
 * WHY: before this wave the entire family had ZERO live probes. `/admin/readiness`
 * reported `svc-powerplatform` **Ready** purely because `LOOM_UAMI_CLIENT_ID` was
 * set — a var every deployed Container App always carries. That gate measured
 * "is the console deployed", not "can we reach Power Platform", so it could not
 * go red no matter how broken the family was (the repo's "gates that measure
 * nothing" class).
 *
 * These tests pin BOTH halves of the fix:
 *   1. the probes are REGISTERED (so readiness has a real signal at all), and
 *   2. each probe classifies a real backend outcome correctly — in particular
 *      that a 401/403 becomes an actionable `gate` naming the documented
 *      tenant-admin action, not an opaque `fail`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SERVICE_PROBES, isKnownService } from '../service-probes';

const ctx = { tenantId: 't1', who: 'tester', deadline: Date.now() + 60_000 };

function probe(service: string) {
  const p = SERVICE_PROBES.find((x) => x.service === service);
  if (!p) throw new Error(`probe '${service}' is not registered`);
  return p;
}

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.unstubAllEnvs(); });

describe('registration', () => {
  // MUTATION-PROOF: dropping any probe from SERVICE_PROBES fails here, which is
  // the exact regression that left this family unmeasured for its whole life.
  it.each(['powerplatform', 'powerbi', 'dataverse'])('registers the %s probe', (service) => {
    expect(isKnownService(service)).toBe(true);
    expect(SERVICE_PROBES.some((p) => p.service === service)).toBe(true);
  });

  it('gives every family probe a real timeout budget', () => {
    for (const s of ['powerplatform', 'powerbi', 'dataverse']) {
      expect(probe(s).timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('powerplatform probe', () => {
  it('gates (not fails) on a 401 and names the management-app registration', async () => {
    vi.doMock('@/lib/azure/powerplatform-client', () => ({
      powerPlatformConfigGate: () => null,
      dataverseConfigGate: () => null,
      listEnvironments: async () => { const e: any = new Error('The caller is not authorized'); e.status = 401; throw e; },
      listTables: async () => [],
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'powerplatform')!.run(ctx);

    expect(out.status).toBe('gate');
    // MUTATION-PROOF: the whole value of this probe is the ACTIONABLE text. A
    // rethrow (status 'fail') or a generic message fails these.
    expect(out.detail).toContain('New-PowerAppManagementApp');
    expect(out.detail).toContain('cannot register itself');
  });

  it('gates when BAP answers but returns ZERO environments (authenticated but blind)', async () => {
    vi.doMock('@/lib/azure/powerplatform-client', () => ({
      powerPlatformConfigGate: () => null,
      dataverseConfigGate: () => null,
      listEnvironments: async () => [],
      listTables: async () => [],
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'powerplatform')!.run(ctx);

    // A zero-length list is the "green but dead" shape the old env-var gate
    // could never distinguish from working.
    expect(out.status).toBe('gate');
    expect(out.detail).toContain('ZERO environments');
  });

  it('passes and reports the environment count on a real listing', async () => {
    vi.doMock('@/lib/azure/powerplatform-client', () => ({
      powerPlatformConfigGate: () => null,
      dataverseConfigGate: () => null,
      listEnvironments: async () => [{ name: 'g1', displayName: 'HQ' }, { name: 'g2', displayName: 'Dev' }],
      listTables: async () => [],
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'powerplatform')!.run(ctx);

    expect(out.status).toBe('pass');
    expect(out.detail).toContain('2 environment(s)');
    expect(out.evidence).toContain('HQ');
  });
});

describe('powerbi probe', () => {
  it('gates on 401 and surfaces the service-principal tenant-setting hint', async () => {
    vi.doMock('@/lib/azure/powerbi-client', () => ({
      powerbiConfigGate: () => null,
      POWERBI_SP_HINT: 'SP-HINT-SENTINEL',
      listWorkspaces: async () => { const e: any = new Error('Unauthorized'); e.status = 401; throw e; },
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'powerbi')!.run(ctx);

    expect(out.status).toBe('gate');
    expect(out.detail).toContain('SP-HINT-SENTINEL');
  });

  it('gates when the identity can see ZERO workspaces — the exact cause of workspace-scoped 401s', async () => {
    vi.doMock('@/lib/azure/powerbi-client', () => ({
      powerbiConfigGate: () => null,
      POWERBI_SP_HINT: 'hint',
      listWorkspaces: async () => [],
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'powerbi')!.run(ctx);

    expect(out.status).toBe('gate');
    expect(out.detail).toContain('ZERO workspaces');
  });

  it('passes and lists visible workspaces', async () => {
    vi.doMock('@/lib/azure/powerbi-client', () => ({
      powerbiConfigGate: () => null,
      POWERBI_SP_HINT: 'hint',
      listWorkspaces: async () => [{ id: 'w1', name: 'Finance' }],
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'powerbi')!.run(ctx);

    expect(out.status).toBe('pass');
    expect(out.evidence).toContain('Finance');
  });
});

describe('dataverse probe', () => {
  it('gates when no environment carries a Dataverse instance', async () => {
    vi.doMock('@/lib/azure/powerplatform-client', () => ({
      powerPlatformConfigGate: () => null,
      dataverseConfigGate: () => null,
      listEnvironments: async () => [{ name: 'g1', displayName: 'HQ' }], // no instanceUrl
      listTables: async () => [],
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'dataverse')!.run(ctx);

    expect(out.status).toBe('gate');
    expect(out.detail).toContain('No environment with a Dataverse instance');
  });

  it('gates on a Dataverse 403 and names the Application User remediation', async () => {
    vi.doMock('@/lib/azure/powerplatform-client', () => ({
      powerPlatformConfigGate: () => null,
      dataverseConfigGate: () => null,
      listEnvironments: async () => [{ name: 'g1', displayName: 'HQ', instanceUrl: 'https://org1.crm.dynamics.com/' }],
      listTables: async () => { const e: any = new Error('user is not a member of the organization'); e.status = 403; throw e; },
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'dataverse')!.run(ctx);

    expect(out.status).toBe('gate');
    expect(out.detail).toContain('Application User');
  });

  it('passes and reports the table count — the backing store for every Copilot Studio agent', async () => {
    vi.doMock('@/lib/azure/powerplatform-client', () => ({
      powerPlatformConfigGate: () => null,
      dataverseConfigGate: () => null,
      listEnvironments: async () => [{ name: 'g1', displayName: 'HQ', instanceUrl: 'https://org1.crm.dynamics.com/' }],
      listTables: async () => [{ MetadataId: 'm1', LogicalName: 'msdyn_copilot' }],
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'dataverse')!.run(ctx);

    expect(out.status).toBe('pass');
    expect(out.evidence).toContain('msdyn_copilot');
  });

  it('gates when Dataverse has no usable credential', async () => {
    vi.doMock('@/lib/azure/powerplatform-client', () => ({
      powerPlatformConfigGate: () => null,
      dataverseConfigGate: () => ({ missing: 'LOOM_DATAVERSE_CLIENT_SECRET' }),
      listEnvironments: async () => [],
      listTables: async () => [],
    }));
    vi.resetModules();
    const { SERVICE_PROBES: fresh } = await import('../service-probes');
    const out = await fresh.find((p) => p.service === 'dataverse')!.run(ctx);

    expect(out.status).toBe('gate');
    expect(out.detail).toContain('LOOM_DATAVERSE_CLIENT_SECRET');
    expect(out.detail).toContain('cannot be a');
  });
});
