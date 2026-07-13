/**
 * attach-integration (brownfield Phase 2) — unit coverage for the auto-integration
 * orchestrator: that each of the four steps (RBAC / Purview / Telemetry /
 * Chargeback) is recorded independently on the returned
 * AttachedServiceIntegration with an honest status, and that honest gates
 * (not-configured / pending-grants / skipped) never throw.
 *
 * role-grant-client, the Purview machinery, arm-credential, and the subscription
 * scope are mocked so no ARM/Cosmos/@azure/identity call is made. The live path
 * is integration-tested against real Azure per no-vaporware.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const grantMock = vi.fn();
vi.mock('../role-grant-client', () => ({ grantNavigatorRole: (...a: any[]) => grantMock(...a) }));

vi.mock('../arm-credential', () => ({
  uamiArmCredential: () => ({
    getToken: async () => ({ token: 'fake-arm-token', expiresOnTimestamp: Date.now() + 3_600_000 }),
  }),
}));
vi.mock('../cloud-endpoints', () => ({
  armBase: () => 'https://management.azure.com',
  armScope: () => 'https://management.azure.com/.default',
}));

const scopeMock = vi.fn(() => [] as string[]);
vi.mock('../loom-subscriptions', () => ({ loomSubscriptionScope: () => scopeMock() }));

// Purview lazy imports — default to a working register; overridden per test.
const registerDataSourceMock = vi.fn(async () => ({ name: 'src' }));
vi.mock('../purview-client', () => ({ registerDataSource: (...a: any[]) => registerDataSourceMock(...a) }));
vi.mock('../purview-source-map', () => ({
  isUnsupportedPurviewSource: (x: any) => x?.unsupported === true,
  purviewSourceForConnectable: () => ({ kind: 'AdlsGen2', endpoint: 'https://x', properties: {}, scanRulesetName: 'AdlsGen2' }),
}));

const SAVED = { ...process.env };

async function load() {
  vi.resetModules();
  return import('../attach-integration');
}

const BASE = {
  armResourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct',
  displayName: 'acct',
  subscriptionId: 'sub-1',
  resourceGroup: 'rg',
  location: 'eastus',
};

beforeEach(() => {
  grantMock.mockResolvedValue({ outcome: 'granted', detail: 'ok', assignmentGuid: 'g', roleName: 'r', roleGuid: 'rg', scope: 's', principalId: 'p' });
  registerDataSourceMock.mockResolvedValue({ name: 'src' });
  scopeMock.mockReturnValue([]);
  delete process.env.LOOM_PURVIEW_ACCOUNT;
  delete process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID;
});
afterEach(() => { process.env = { ...SAVED }; vi.clearAllMocks(); });

function okFetch() { return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) } as any)); }

describe('runAttachIntegration — RBAC step', () => {
  it('maps a granted role-grant to rbac.status=granted', async () => {
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', fetchImpl: okFetch() as any });
    expect(r.rbac?.status).toBe('granted');
  });

  it('maps a pending-grants role-grant to rbac.status=pending-grants + grantScript', async () => {
    grantMock.mockResolvedValue({ outcome: 'pending-grants', grantScript: 'az role assignment create ...', detail: 'gate' });
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', fetchImpl: okFetch() as any });
    expect(r.rbac?.status).toBe('pending-grants');
    expect(r.rbac?.grantScript).toContain('az role assignment create');
  });
});

describe('runAttachIntegration — Purview step', () => {
  it('not-configured when LOOM_PURVIEW_ACCOUNT is unset', async () => {
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', fetchImpl: okFetch() as any });
    expect(r.purview?.status).toBe('not-configured');
    expect(registerDataSourceMock).not.toHaveBeenCalled();
  });

  it('registered for a scannable kind when Purview is configured', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-acct';
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', fetchImpl: okFetch() as any });
    expect(r.purview?.status).toBe('registered');
    expect(r.purview?.detail).toMatch(/source '.*'/);
    expect(registerDataSourceMock).toHaveBeenCalledTimes(1);
  });

  it('skipped (honest) for a non-scannable kind even when Purview is configured', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-acct';
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'eventhubs', fetchImpl: okFetch() as any });
    expect(r.purview?.status).toBe('skipped');
    expect(registerDataSourceMock).not.toHaveBeenCalled();
  });
});

describe('runAttachIntegration — Telemetry step', () => {
  it('not-configured when no hub LAW is wired', async () => {
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', fetchImpl: okFetch() as any });
    expect(r.telemetry?.status).toBe('not-configured');
  });

  it('wired when the diagnostic-settings PUT succeeds', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law';
    const fetchImpl = okFetch();
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', fetchImpl: fetchImpl as any });
    expect(r.telemetry?.status).toBe('wired');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('pending-grants + grantScript on a 403 AuthorizationFailed', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = '/subscriptions/sub-1/rg/law';
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'AuthorizationFailed', message: 'no' } }) } as any));
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', principalId: 'pid', fetchImpl: fetchImpl as any });
    expect(r.telemetry?.status).toBe('pending-grants');
    expect(r.telemetry?.grantScript).toContain('Monitoring Contributor');
  });
});

describe('runAttachIntegration — Chargeback step', () => {
  it('included, noting the env sweep when the sub is already in scope', async () => {
    scopeMock.mockReturnValue(['sub-1']);
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', fetchImpl: okFetch() as any });
    expect(r.chargeback?.status).toBe('included');
    expect(r.chargeback?.detail).toMatch(/already in the Loom cost sweep/);
  });

  it('included via the registry union when the sub is NOT in the env scope', async () => {
    scopeMock.mockReturnValue(['other-sub']);
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, kind: 'storage-adls', fetchImpl: okFetch() as any });
    expect(r.chargeback?.status).toBe('included');
    expect(r.chargeback?.detail).toMatch(/service registry/);
  });

  it('skipped when no subscription id is present', async () => {
    const { runAttachIntegration } = await load();
    const r = await runAttachIntegration({ ...BASE, subscriptionId: '', kind: 'storage-adls', fetchImpl: okFetch() as any });
    expect(r.chargeback?.status).toBe('skipped');
  });
});
