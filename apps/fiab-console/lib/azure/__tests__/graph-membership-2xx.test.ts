/**
 * #3834 — a bare 2xx from Microsoft Graph is NOT a membership.
 *
 * THE DEFECT. `graphUserInGroup` opened with
 *
 *     if (res.ok) return 'member';
 *
 * and never looked at the body. The endpoint is
 * `groups/{id}/transitiveMembers/{userId}` — a directoryObject point-read — so a
 * genuine positive answers with THAT object. Anything else in front of Graph
 * that answers 200 (a proxy, a WAF, a captive portal, or the wrong national-cloud
 * host: the #3381 condition) therefore GRANTED the group's workspace role.
 *
 * WHY THAT IS A TENANT-BOUNDARY BUG AND NOT MERELY A GRAPH BUG. In
 * `resolveWorkspaceAccessByOid` the ACL step (5) runs BEFORE the admin-open step
 * (6). A forged membership hands back a real role at step 5, so the caller is
 * granted `via: 'acl'` and the `tenant_unconfirmed` refusal at step 6 — the whole
 * of #3823 — is never reached. This is the last unhardened path of the three the
 * `workspace-guard.ts` docblock listed as residuals.
 *
 * The vocabulary is the one already in the module (`GraphMembership`,
 * `[graph-membership] UNKNOWN (not a measured negative)`), not a second one: a
 * non-answer is `unknown`, `unknown` contributes no role, and it stays
 * distinguishable in the logs from a measured `not-member`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER = '33333333-3333-3333-3333-333333333333';
const GROUP = '44444444-4444-4444-4444-444444444444';
const WS = 'ws-1';

const fetchWithTimeout = vi.fn();

vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: any[]) => fetchWithTimeout(...a),
}));
vi.mock('@azure/identity', () => {
  class Cred {
    getToken() {
      return Promise.resolve({ token: 'graph-token' });
    }
  }
  return {
    ChainedTokenCredential: Cred,
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
  };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class AcaManagedIdentityCredential {
    getToken() {
      return Promise.resolve({ token: 'graph-token' });
    }
  }
  return { AcaManagedIdentityCredential };
});
vi.mock('../cloud-endpoints', () => ({
  armBase: () => 'https://management.azure.com',
  armScope: () => 'https://management.azure.com/.default',
  graphBase: () => 'https://graph.microsoft.com/v1.0',
  graphScope: () => 'https://graph.microsoft.com/.default',
}));

/** ONE group assignment on the workspace — so the Graph probe is what decides. */
const ASSIGNMENTS = [
  { id: `${WS}:${GROUP}`, workspaceId: WS, principalId: GROUP, principalType: 'Group', role: 'Admin' },
];

vi.mock('../cosmos-client', () => ({
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: ASSIGNMENTS }) }) },
  }),
}));

import { resolveEffectiveRole } from '../workspace-roles-client';

/** A Response-alike whose `json()` behaves as the fixture says. */
function res(status: number, body: unknown | 'NOT-JSON') {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === 'NOT-JSON') throw new SyntaxError('Unexpected token < in JSON at position 0');
      return body;
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('graphUserInGroup — a 2xx must IDENTIFY the principal (#3834)', () => {
  it('grants when the point-read returns the requested principal', async () => {
    fetchWithTimeout.mockResolvedValue(res(200, { id: USER }));
    expect(await resolveEffectiveRole(USER, WS)).toBe('Admin');
  });

  it('grants when the returned id differs only in CASE (GUIDs are case-insensitive)', async () => {
    fetchWithTimeout.mockResolvedValue(res(200, { id: USER.toUpperCase() }));
    expect(await resolveEffectiveRole(USER, WS)).toBe('Admin');
  });

  // THE FIX. Each of these used to be read as membership by `if (res.ok)`.
  it('does NOT grant on a 200 whose body is not JSON (a captive portal / WAF page)', async () => {
    fetchWithTimeout.mockResolvedValue(res(200, 'NOT-JSON'));
    expect(await resolveEffectiveRole(USER, WS)).toBeNull();
  });

  it('does NOT grant on a 200 with no `id` field at all', async () => {
    fetchWithTimeout.mockResolvedValue(res(200, { value: [], '@odata.context': 'x' }));
    expect(await resolveEffectiveRole(USER, WS)).toBeNull();
  });

  it('does NOT grant on a 200 identifying a DIFFERENT principal', async () => {
    fetchWithTimeout.mockResolvedValue(res(200, { id: 'someone-else' }));
    expect(await resolveEffectiveRole(USER, WS)).toBeNull();
  });

  it('does NOT grant on a 200 whose body is null or a bare string', async () => {
    fetchWithTimeout.mockResolvedValue(res(200, null));
    expect(await resolveEffectiveRole(USER, WS)).toBeNull();
    fetchWithTimeout.mockResolvedValue(res(200, 'html-as-parsed-json'));
    expect(await resolveEffectiveRole(USER, WS)).toBeNull();
  });

  it('says UNKNOWN — not "not a member" — so the log distinguishes the two (R7)', async () => {
    fetchWithTimeout.mockResolvedValue(res(200, { id: 'someone-else' }));
    await resolveEffectiveRole(USER, WS);
    const said = (console.warn as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(said).toContain('[graph-membership] UNKNOWN (not a measured negative)');
  });

  // An ambiguous 2xx FALLS THROUGH to the paged walk rather than answering. A
  // 204, or a `$select` quirk that omits `id`, is a GENUINE member, and denying
  // them would be a fail-closed bug of its own. The walk settles it.
  it('an ambiguous 2xx falls through to enumeration, which can still find the member', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(res(204, 'NOT-JSON')) // no body to identify anyone
      .mockResolvedValueOnce(res(200, { value: [{ id: USER }] }));
    expect(await resolveEffectiveRole(USER, WS)).toBe('Admin');
  });

  it('a WAF answering the SAME non-JSON body to both calls still resolves UNKNOWN', async () => {
    fetchWithTimeout.mockResolvedValue(res(200, 'NOT-JSON'));
    expect(await resolveEffectiveRole(USER, WS)).toBeNull();
  });

  it('a 404 is still a MEASURED negative — the honest case is unchanged', async () => {
    fetchWithTimeout.mockResolvedValue(res(404, { error: {} }));
    expect(await resolveEffectiveRole(USER, WS)).toBeNull();
    const said = (console.warn as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(said).not.toContain('[graph-membership] UNKNOWN');
  });
});

describe('the paged enumeration fallback answers instead of throwing (#3834)', () => {
  /** First call = the point-read (non-404 4xx → falls through); second = the page. */
  const pointReadThen = (page: any) => {
    fetchWithTimeout
      .mockResolvedValueOnce(res(429, { error: {} }))
      .mockResolvedValueOnce(page);
  };

  it('grants when the enumeration page contains the user', async () => {
    pointReadThen(res(200, { value: [{ id: 'other' }, { id: USER }] }));
    expect(await resolveEffectiveRole(USER, WS)).toBe('Admin');
  });

  it('a clean page with no match is a measured NOT-MEMBER', async () => {
    pointReadThen(res(200, { value: [{ id: 'other' }] }));
    expect(await resolveEffectiveRole(USER, WS)).toBeNull();
  });

  // These two used to throw a SyntaxError / TypeError out of the whole
  // authorization stack and surface as a 500 rather than a membership answer.
  it('does not THROW on a page whose body is not JSON — it answers unknown', async () => {
    pointReadThen(res(200, 'NOT-JSON'));
    await expect(resolveEffectiveRole(USER, WS)).resolves.toBeNull();
  });

  it('does not THROW when `value` is not an array — it answers unknown', async () => {
    pointReadThen(res(200, { value: { nope: true } }));
    await expect(resolveEffectiveRole(USER, WS)).resolves.toBeNull();
  });

  it('a non-ok enumeration page stays UNKNOWN (pre-existing behaviour, unchanged)', async () => {
    pointReadThen(res(503, {}));
    await expect(resolveEffectiveRole(USER, WS)).resolves.toBeNull();
  });
});
