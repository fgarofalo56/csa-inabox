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
  missingProviders,
  buildContributorGrantCommand,
  buildProviderRegisterCommands,
  checkSubscriptionDeployPermission,
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
