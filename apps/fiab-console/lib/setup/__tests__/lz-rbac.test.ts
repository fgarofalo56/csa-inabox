/**
 * Unit tests for the landing-zone RBAC auto-grant (Wave 1).
 *
 * Covers the pure helpers (role set, RG scope, copy-paste commands) and the
 * LIVE grantRgScopedRoles ARM PUT path with a stubbed fetch:
 *   - all-granted (201) → ok/allGranted
 *   - already-exists (409) → 'already', still ok
 *   - 403 → forbidden flag set (route surfaces the honest gate)
 *   - input validation (bad sub / RG / principal)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  RG_SCOPED_LZ_ROLES,
  resourceGroupScope,
  buildRgScopedGrantCommands,
  grantRgScopedRoles,
  isGovBoundary,
} from '@/lib/setup/lz-rbac';

const SUB = '11111111-2222-3333-4444-555555555555';
const RG = 'rg-csa-loom-dlz-finance-centralus';
const PRINCIPAL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  delete process.env.LOOM_ARM_ENDPOINT;
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_CLOUD;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown = {}, text?: string) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const payload = text !== undefined ? text : JSON.stringify(body);
      return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

describe('pure helpers', () => {
  it('role set is Contributor + the minimal data-plane roles, all built-in GUIDs', () => {
    const names = RG_SCOPED_LZ_ROLES.map((r) => r.name);
    expect(names).toContain('Contributor');
    expect(names).toContain('Storage Blob Data Contributor');
    expect(names).toContain('Azure Event Hubs Data Owner');
    for (const r of RG_SCOPED_LZ_ROLES) {
      expect(r.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  // #3608. The shape assertion above is NOT enough and never was: a wrong GUID
  // is still a well-shaped GUID, so `b24988ac-6180-42a0-bb6f-b91a8f3d3d0e` sat
  // under `name: 'Contributor'` for the module's entire life with this suite
  // green, while every automatic ARM Contributor grant on a DLZ attach was
  // rejected. grantRgScopedRoles() interpolates `guid` straight into
  // roleDefinitionId and ARM resolves by ID, never by name.
  //
  // Ids from learn.microsoft.com/azure/role-based-access-control/built-in-roles
  // and identical in Commercial, GCC, GCC-High and DoD — built-in role
  // definition ids are global, so a wrong one is wrong in every cloud at once.
  // Repo-wide, this same property is enforced by
  // scripts/ci/check-role-guid-consistency.mjs.
  it('each role carries the DOCUMENTED built-in id, not merely a GUID-shaped string', () => {
    const documented: Record<string, string> = {
      Contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
      'Storage Blob Data Contributor': 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
      'Azure Event Hubs Data Owner': 'f526a384-b230-433a-b45c-95f59c4a2dec',
    };
    // Every role in the set is pinned — a role added later without an id here
    // fails rather than slipping through unchecked.
    for (const r of RG_SCOPED_LZ_ROLES) {
      expect(Object.keys(documented), `no documented id pinned for role "${r.name}"`).toContain(r.name);
      expect(r.guid.toLowerCase(), `${r.name} is bound to the wrong role definition id`).toBe(documented[r.name]);
    }
    expect(RG_SCOPED_LZ_ROLES.length).toBe(Object.keys(documented).length);
  });

  it('resourceGroupScope builds an RG-scoped (never sub-wide) id', () => {
    expect(resourceGroupScope(SUB, RG)).toBe(`/subscriptions/${SUB}/resourceGroups/${RG}`);
  });

  it('buildRgScopedGrantCommands scopes every grant to the RG and sets the sub', () => {
    const cmds = buildRgScopedGrantCommands({ subscriptionId: SUB, resourceGroup: RG, principalObjectId: PRINCIPAL });
    const joined = cmds.join('\n');
    expect(joined).toContain(`az account set --subscription ${SUB}`);
    // Every --scope is the RG scope — never bare /subscriptions/<sub> at the end.
    const scopeLines = cmds.filter((l) => l.includes('--scope'));
    expect(scopeLines.length).toBe(RG_SCOPED_LZ_ROLES.length);
    for (const l of scopeLines) expect(l).toContain(`/resourceGroups/${RG}`);
    expect(joined).toContain('--role "Contributor"');
    expect(joined).not.toContain('az cloud set'); // Commercial by default
  });

  it('buildRgScopedGrantCommands prefixes az cloud set for Gov', () => {
    const cmds = buildRgScopedGrantCommands({ subscriptionId: SUB, resourceGroup: RG, isGov: true });
    expect(cmds[0]).toBe('az cloud set --name AzureUSGovernment');
  });

  it('isGovBoundary honours an explicit boundary', () => {
    expect(isGovBoundary('GCC-High')).toBe(true);
    expect(isGovBoundary('IL5')).toBe(true);
    expect(isGovBoundary('Commercial')).toBe(false);
  });
});

describe('grantRgScopedRoles (LIVE ARM PUT)', () => {
  // #3608. Asserting the CONSTANT is right is worth nothing if the value that
  // reaches ARM is something else, so this asserts on the wire: the ARM body
  // must carry the documented Contributor roleDefinitionId.
  it('PUTs the documented Contributor roleDefinitionId', async () => {
    const calls = stubFetch(201, { id: '/ra/1' });
    await grantRgScopedRoles({ subscriptionId: SUB, resourceGroup: RG, principalObjectId: PRINCIPAL, getToken: async () => 'tk' });
    const bodies = calls.map((c) => String(c.init?.body));
    expect(bodies.some((b) => b.includes('/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c'))).toBe(true);
    expect(bodies.some((b) => b.includes('b24988ac-6180-42a0-bb6f-b91a8f3d3d0e'))).toBe(false);
  });

  it('grants the full set on 201 and reports allGranted', async () => {
    const calls = stubFetch(201, { id: '/ra/1' });
    const r = await grantRgScopedRoles({ subscriptionId: SUB, resourceGroup: RG, principalObjectId: PRINCIPAL, getToken: async () => 'tk' });
    expect(r.ok).toBe(true);
    expect(r.allGranted).toBe(true);
    expect(r.forbidden).toBe(false);
    expect(r.outcomes.every((o) => o.status === 'granted')).toBe(true);
    // One PUT per role, all at the RG scope with principalType=ServicePrincipal.
    expect(calls.length).toBe(RG_SCOPED_LZ_ROLES.length);
    for (const c of calls) {
      expect(c.url).toContain(`/resourceGroups/${RG}/providers/Microsoft.Authorization/roleAssignments/`);
      expect(c.init?.method).toBe('PUT');
      expect(String(c.init?.body)).toContain('"principalType":"ServicePrincipal"');
    }
  });

  it('treats 409 (already exists) as success', async () => {
    stubFetch(409, {}, 'RoleAssignmentExists');
    const r = await grantRgScopedRoles({ subscriptionId: SUB, resourceGroup: RG, principalObjectId: PRINCIPAL, getToken: async () => 'tk' });
    expect(r.allGranted).toBe(true);
    expect(r.outcomes.every((o) => o.status === 'already')).toBe(true);
  });

  it('sets forbidden on 403 (caller cannot write role assignments)', async () => {
    stubFetch(403, {}, 'AuthorizationFailed');
    const r = await grantRgScopedRoles({ subscriptionId: SUB, resourceGroup: RG, principalObjectId: PRINCIPAL, getToken: async () => 'tk' });
    expect(r.forbidden).toBe(true);
    expect(r.allGranted).toBe(false);
  });

  it('rejects a bad subscription id without calling ARM', async () => {
    const calls = stubFetch(201);
    const r = await grantRgScopedRoles({ subscriptionId: 'not-a-guid', resourceGroup: RG, principalObjectId: PRINCIPAL, getToken: async () => 'tk' });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('rejects a bad principal id without calling ARM', async () => {
    const calls = stubFetch(201);
    const r = await grantRgScopedRoles({ subscriptionId: SUB, resourceGroup: RG, principalObjectId: 'nope', getToken: async () => 'tk' });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
