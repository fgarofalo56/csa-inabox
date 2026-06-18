/**
 * Tests for the cross-subscription DLZ deploy pre-flight (item-4).
 *
 * Covers the PURE evaluators (permission math, RP-registration diff, gate
 * command building) and the LIVE check with a stubbed fetch + token — proving
 * the exact live-diagnosed scenario (UAMI has Reader-only on the target sub →
 * canDeploy=false → honest Contributor gate) without a real subscription.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  canDeployAtScope,
  canManageResourceGroup,
  missingProviders,
  buildContributorGrantCommand,
  buildProviderRegisterCommands,
  checkSubscriptionDeployPermission,
  checkResourceGroupManagePermission,
  DLZ_REQUIRED_PROVIDERS,
  type ArmPermission,
} from '../deploy-preflight';

// Reader role: only */read actions.
const READER: ArmPermission[] = [{ actions: ['*/read'], notActions: [] }];
// Contributor: everything except authorization writes.
const CONTRIBUTOR: ArmPermission[] = [
  { actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] },
];
// Owner: everything.
const OWNER: ArmPermission[] = [{ actions: ['*'], notActions: [] }];

describe('canDeployAtScope', () => {
  it('returns false for Reader (only */read) — the live-diagnosed failure', () => {
    expect(canDeployAtScope(READER)).toBe(false);
  });

  it('returns false for empty permissions', () => {
    expect(canDeployAtScope([])).toBe(false);
  });

  it('returns true for Contributor (deployment writes allowed, only auth excluded)', () => {
    expect(canDeployAtScope(CONTRIBUTOR)).toBe(true);
  });

  it('returns true for Owner', () => {
    expect(canDeployAtScope(OWNER)).toBe(true);
  });

  it('returns false when a notAction subtracts a needed deployment write', () => {
    const restricted: ArmPermission[] = [
      { actions: ['*'], notActions: ['Microsoft.Resources/deployments/write'] },
    ];
    expect(canDeployAtScope(restricted)).toBe(false);
  });

  it('returns true with an explicit Microsoft.Resources/* grant', () => {
    const scoped: ArmPermission[] = [
      { actions: ['Microsoft.Resources/*', 'Microsoft.Resources/subscriptions/resourceGroups/write'], notActions: [] },
    ];
    expect(canDeployAtScope(scoped)).toBe(true);
  });
});

describe('canManageResourceGroup (RG-scoped Contributor — the multi-sub least-privilege case)', () => {
  it('returns true for Contributor at RG scope (can run RG deployments)', () => {
    expect(canManageResourceGroup(CONTRIBUTOR)).toBe(true);
  });

  it('returns true for Owner', () => {
    expect(canManageResourceGroup(OWNER)).toBe(true);
  });

  it('returns false for Reader-only', () => {
    expect(canManageResourceGroup(READER)).toBe(false);
  });

  it('returns false for empty permissions', () => {
    expect(canManageResourceGroup([])).toBe(false);
  });

  it('does NOT require the sub-scope-only resourceGroups/write action', () => {
    // RG-scoped Contributor cannot create new RGs, but can manage the existing
    // one — the RG-manage bar must not include the sub-scope create action.
    const rgScoped: ArmPermission[] = [
      { actions: ['Microsoft.Resources/deployments/*'], notActions: [] },
    ];
    expect(canManageResourceGroup(rgScoped)).toBe(true);
    // The sub-scope deploy check still requires the RG-create action → false.
    expect(canDeployAtScope(rgScoped)).toBe(false);
  });
});

describe('missingProviders', () => {
  it('lists RPs that are not Registered', () => {
    const state = {
      'Microsoft.Storage': 'Registered',
      'Microsoft.Kusto': 'NotRegistered',
      'Microsoft.DocumentDB': 'Registered',
      'Microsoft.KeyVault': 'Registering',
      'Microsoft.ManagedIdentity': 'Registered',
      'Microsoft.Network': 'Registered',
    };
    expect(missingProviders(state)).toEqual(['Microsoft.Kusto', 'Microsoft.KeyVault']);
  });

  it('returns empty when all required RPs are Registered (the live target-sub case)', () => {
    const state: Record<string, string> = {};
    for (const ns of DLZ_REQUIRED_PROVIDERS) state[ns] = 'Registered';
    expect(missingProviders(state)).toEqual([]);
  });

  it('treats a totally absent RP as missing', () => {
    expect(missingProviders({}, ['Microsoft.Kusto'])).toEqual(['Microsoft.Kusto']);
  });
});

describe('buildContributorGrantCommand', () => {
  it('embeds the real subscription id + principal object id', () => {
    const cmd = buildContributorGrantCommand({
      subscriptionId: '363ef5d1-0e77-4594-a530-f51af23dbf8c',
      principalObjectId: '41d32562-f864-4450-8b84-cd3d59f58bf4',
    });
    expect(cmd).toContain('--role Contributor');
    expect(cmd).toContain('--scope /subscriptions/363ef5d1-0e77-4594-a530-f51af23dbf8c');
    expect(cmd).toContain('--assignee-object-id 41d32562-f864-4450-8b84-cd3d59f58bf4');
    expect(cmd).not.toContain('az cloud set'); // commercial default
  });

  it('prepends the gov cloud switch when isGov', () => {
    const cmd = buildContributorGrantCommand({ subscriptionId: 'x', isGov: true });
    expect(cmd).toContain('az cloud set --name AzureUSGovernment');
  });

  it('falls back to a placeholder when no principal id is known', () => {
    const cmd = buildContributorGrantCommand({ subscriptionId: 'x' });
    expect(cmd).toContain('<deploying-identity-object-id>');
  });
});

describe('buildProviderRegisterCommands', () => {
  it('emits one az provider register line per missing RP', () => {
    const lines = buildProviderRegisterCommands(['Microsoft.Kusto', 'Microsoft.KeyVault'], 'sub-1');
    expect(lines).toEqual([
      'az provider register --namespace Microsoft.Kusto --subscription sub-1',
      'az provider register --namespace Microsoft.KeyVault --subscription sub-1',
    ]);
  });
});

describe('checkSubscriptionDeployPermission (live shape, stubbed I/O)', () => {
  const TARGET = '363ef5d1-0e77-4594-a530-f51af23dbf8c';
  afterEach(() => vi.restoreAllMocks());

  it('rejects an invalid subscription id without calling ARM', async () => {
    const getToken = vi.fn(async () => 'tok');
    const r = await checkSubscriptionDeployPermission('not-a-guid', getToken);
    expect(r.canDeploy).toBe(false);
    expect(r.error).toMatch(/invalid subscriptionId/);
    expect(getToken).not.toHaveBeenCalled();
  });

  it('returns canDeploy=false for the Reader-only target sub (live scenario)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: READER }), { status: 200 })));
    const r = await checkSubscriptionDeployPermission(TARGET, async () => 'tok');
    expect(r.canDeploy).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('returns canDeploy=true when the identity is Owner', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: OWNER }), { status: 200 })));
    const r = await checkSubscriptionDeployPermission(TARGET, async () => 'tok');
    expect(r.canDeploy).toBe(true);
  });

  it('surfaces an ARM error (not a silent deny) so the route can fall through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const r = await checkSubscriptionDeployPermission(TARGET, async () => 'tok');
    expect(r.canDeploy).toBe(false);
    expect(r.error).toMatch(/ARM permissions 500/);
  });

  it('treats a token failure as an error, not a deny', async () => {
    const r = await checkSubscriptionDeployPermission(TARGET, async () => { throw new Error('no token'); });
    expect(r.canDeploy).toBe(false);
    expect(r.error).toMatch(/token: no token/);
  });
});

describe('checkResourceGroupManagePermission (live shape, stubbed I/O)', () => {
  const TARGET = '363ef5d1-0e77-4594-a530-f51af23dbf8c';
  const RG = 'rg-csa-loom-dlz-default-centralus';
  afterEach(() => vi.restoreAllMocks());

  it('rejects an invalid subscription id without calling ARM', async () => {
    const getToken = vi.fn(async () => 'tok');
    const r = await checkResourceGroupManagePermission('not-a-guid', RG, getToken);
    expect(r.canManage).toBe(false);
    expect(r.error).toMatch(/invalid subscriptionId/);
    expect(getToken).not.toHaveBeenCalled();
  });

  it('returns canManage=true for RG-scoped Contributor (the multi-sub healthy case)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: CONTRIBUTOR }), { status: 200 })));
    const r = await checkResourceGroupManagePermission(TARGET, RG, async () => 'tok');
    expect(r.canManage).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('returns canManage=false for Reader-only on the RG', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: READER }), { status: 200 })));
    const r = await checkResourceGroupManagePermission(TARGET, RG, async () => 'tok');
    expect(r.canManage).toBe(false);
  });

  it('hits the RG-scoped permissions endpoint', async () => {
    const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify({ value: OWNER }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await checkResourceGroupManagePermission(TARGET, RG, async () => 'tok');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/subscriptions/${TARGET}/resourceGroups/${RG}/providers/Microsoft.Authorization/permissions`);
  });

  it('uses GET (Permissions - List For Resource Group is GET; POST 405s and would false-flag Reader-only)', async () => {
    // Regression for the live multi-sub false "only Reader": the permissions list
    // API is GET, not POST. The old POST returned a non-2xx that the route treated
    // as a deny, so a verified RG-scoped Contributor was reported as needing repair.
    const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify({ value: CONTRIBUTOR }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await checkResourceGroupManagePermission(TARGET, RG, async () => 'tok');
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('evaluates the RG in the DLZ OWN subscription, not a hard-coded admin sub', async () => {
    // Multi-sub: the DLZ lives in 363ef5d1…; the admin/hub sub is e093f4fd…. The
    // scope must be built from the DLZ's own subscription id passed in.
    const ADMIN_SUB = 'e093f4fd-5047-4ee4-968d-a56942c665f3';
    const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify({ value: CONTRIBUTOR }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await checkResourceGroupManagePermission(TARGET, RG, async () => 'tok');
    expect(r.canManage).toBe(true);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/subscriptions/${TARGET}/`);
    expect(url).not.toContain(ADMIN_SUB);
  });

  it('surfaces an ARM error (not a silent deny) so the route can report unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const r = await checkResourceGroupManagePermission(TARGET, RG, async () => 'tok');
    expect(r.canManage).toBe(false);
    expect(r.error).toMatch(/ARM permissions 403/);
  });
});

describe('checkSubscriptionDeployPermission uses GET (regression)', () => {
  const TARGET = '363ef5d1-0e77-4594-a530-f51af23dbf8c';
  afterEach(() => vi.restoreAllMocks());

  it('uses GET — Permissions - List is GET, POST 405s', async () => {
    const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(new Response(JSON.stringify({ value: OWNER }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await checkSubscriptionDeployPermission(TARGET, async () => 'tok');
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
  });
});
