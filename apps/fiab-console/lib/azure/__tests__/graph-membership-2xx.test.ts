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
 *
 * ── §2 RESIDUAL AND §3, ADDED WITH THE SECOND HALF OF #3834 ──────────────────
 *
 * The body check above landed in #3859. Three things it did not settle, all of
 * them about the WALK rather than about one answer, and each covered below with
 * a control so the guard cannot pass by simply refusing everything:
 *
 *   • A TRANSPORT FAILURE DURING THE ENUMERATION still escaped. The paged loop
 *     sat OUTSIDE `graphUserInGroup`'s try/catch and `PagingBudget.runPage`
 *     rethrows anything that is not its own deadline, so an `ECONNRESET` on the
 *     fallback propagated out of the authorization boundary as a rejection
 *     rather than resolving the membership question.
 *   • A 429 AMPLIFIED. A non-404 4xx fell through into the enumeration, which
 *     throttles too — measured `graphCalls=2` on a throttled probe, with no
 *     `Retry-After` honoured anywhere. Under throttling these routes made the
 *     throttling worse.
 *   • THE GROUP LOOP HAD NO AGGREGATE CEILING. Each probe was bounded (30s
 *     point-read + a 15s paging budget); the loop over N group assignments was
 *     not, so the worst case was `N x ~45s` on routes that declare no
 *     `maxDuration`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const USER = '33333333-3333-3333-3333-333333333333';
const GROUP = '44444444-4444-4444-4444-444444444444';
const WS = 'ws-1';

const fetchWithTimeout = vi.fn();

/**
 * The transport is the ONLY thing faked about the walk — `PagingBudget` and
 * `graphUserInGroup` run for real. The mock therefore has to re-export the two
 * non-function members the real module publishes to that path: `PagingBudget`
 * imports `FetchTimeoutError` for its `instanceof` deadline test, and the group
 * walk's default ceiling is the single-request ceiling. Omitting either makes
 * vitest throw a "No X export is defined on the mock" error from INSIDE the
 * code under test, which reads exactly like the escaping-throw defect this file
 * exists to catch — a false positive that would have proved nothing.
 */
vi.mock('@/lib/azure/fetch-with-timeout', () => {
  class FetchTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(url: string, timeoutMs: number) {
      super(`Request to ${url} timed out after ${timeoutMs}ms`);
      this.name = 'FetchTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  }
  return {
    fetchWithTimeout: (...a: any[]) => fetchWithTimeout(...a),
    FetchTimeoutError,
    DEFAULT_SERVER_FETCH_TIMEOUT_MS: 30_000,
  };
});
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

/**
 * The workspace's role rows. MUTATED IN PLACE rather than reassigned, because
 * the cosmos mock's factory closes over this binding and reads it per call —
 * `beforeEach` restores the single-group default, so a test that widens the
 * fixture cannot leak into its neighbours.
 */
const ASSIGNMENTS: any[] = [];

/** ONE group assignment on the workspace — so the Graph probe is what decides. */
function setGroupAssignments(rows: Array<{ principalId: string; role: string }>): void {
  ASSIGNMENTS.length = 0;
  for (const r of rows) {
    ASSIGNMENTS.push({
      id: `${WS}:${r.principalId}`,
      workspaceId: WS,
      principalId: r.principalId,
      principalType: 'Group',
      role: r.role,
    });
  }
}

vi.mock('../cosmos-client', () => ({
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: ASSIGNMENTS }) }) },
  }),
}));

import { resolveEffectiveRole } from '../workspace-roles-client';

/** A Response-alike whose `json()` and `headers.get()` behave as the fixture says. */
function res(status: number, body: unknown | 'NOT-JSON', headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => {
      if (body === 'NOT-JSON') throw new SyntaxError('Unexpected token < in JSON at position 0');
      return body;
    },
  } as any;
}

beforeEach(() => {
  // reset, not clear: a `mockResolvedValueOnce` queue left by the previous test
  // would otherwise decide this one's first Graph call.
  fetchWithTimeout.mockReset();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setGroupAssignments([{ principalId: GROUP, role: 'Admin' }]);
});

/** Every warn line this call emitted, joined — the log is part of the contract (R7). */
function warnings(): string {
  return (console.warn as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
}

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
    expect(warnings()).toContain('[graph-membership] UNKNOWN (not a measured negative)');
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
    expect(warnings()).not.toContain('[graph-membership] UNKNOWN');
  });
});

describe('the paged enumeration fallback answers instead of throwing (#3834)', () => {
  /**
   * First call = the point-read, second = the page.
   *
   * The point-read status here USED TO BE 429, which is precisely why it had to
   * change: a 429 no longer falls through (it aborts — see the throttling block
   * below), so keeping it would have made every test in this describe assert
   * against a call that is no longer made. 403 is the honest stand-in for the
   * reason the fallback exists at all — a tenant where the point-read by id is
   * not permitted on the resource type.
   */
  const pointReadThen = (page: any) => {
    fetchWithTimeout
      .mockResolvedValueOnce(res(403, { error: { code: 'Authorization_RequestDenied' } }))
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

  // THE §2 RESIDUAL. `PagingBudget.runPage` rethrows anything that is not its
  // own deadline and the loop sat outside the try/catch, so this REJECTED —
  // an uncaught throw out of an authorization boundary, into 99 route entry
  // points, denying by crashing rather than by answering.
  it('does not REJECT when the enumeration fetch throws — it answers unknown', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(res(403, { error: {} }))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(resolveEffectiveRole(USER, WS)).resolves.toBeNull();
  });

  it('names that transport failure as UNKNOWN, not as a measured negative (R7)', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(res(403, { error: {} }))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    await resolveEffectiveRole(USER, WS);
    expect(warnings()).toContain('[graph-membership] UNKNOWN (not a measured negative)');
  });
});

describe('a throttled point-read ABORTS instead of amplifying (#3834 §3)', () => {
  it('makes exactly ONE Graph call on a 429 — it does not fall through', async () => {
    fetchWithTimeout.mockResolvedValue(res(429, { error: {} }, { 'retry-after': '120' }));
    await expect(resolveEffectiveRole(USER, WS)).resolves.toBeNull();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('carries Retry-After into the honest UNKNOWN line rather than discarding it', async () => {
    fetchWithTimeout.mockResolvedValue(res(429, { error: {} }, { 'retry-after': '120' }));
    await resolveEffectiveRole(USER, WS);
    expect(warnings()).toContain('[graph-membership] UNKNOWN (not a measured negative)');
    expect(warnings()).toContain('Retry-After: 120');
  });

  it('still aborts when the 429 carries no Retry-After at all', async () => {
    fetchWithTimeout.mockResolvedValue(res(429, { error: {} }));
    await expect(resolveEffectiveRole(USER, WS)).resolves.toBeNull();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  // CONTROL — the abort is 429-ONLY. A 403 is the case the paged fallback was
  // built for (the point-read by id not permitted on the resource type), so
  // widening the abort to "any non-404" would deny a genuine member.
  it('a 403 still falls through to enumeration and can still grant', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(res(403, { error: {} }))
      .mockResolvedValueOnce(res(200, { value: [{ id: USER }] }));
    expect(await resolveEffectiveRole(USER, WS)).toBe('Admin');
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });
});

describe('the group walk is bounded IN AGGREGATE, not only per probe (#3834 §3)', () => {
  const FOUR = ['g-a', 'g-b', 'g-c', 'g-d'];
  const WALK_MS = 30_000;
  let previousKnob: string | undefined;

  beforeEach(() => {
    previousKnob = process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS;
    process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS = String(WALK_MS);
    setGroupAssignments(FOUR.map((principalId) => ({ principalId, role: 'Admin' })));
  });

  afterEach(() => {
    if (previousKnob === undefined) delete process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS;
    else process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS = previousKnob;
    vi.useRealTimers();
  });

  it('stops claiming groups once the walk-wide clock is spent', async () => {
    // Only `Date` is faked — the module under test reads the clock through
    // `PagingBudget`, and faking timers wholesale would also intercept the test
    // runner's own. Each probe burns 12s of the 30s walk, so three fit and the
    // fourth must never be attempted.
    let now = Date.UTC(2026, 7, 24);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    fetchWithTimeout.mockImplementation(async () => {
      now += 12_000;
      vi.setSystemTime(now);
      return res(404, { error: {} }); // a measured negative — exactly one call per group
    });

    await expect(resolveEffectiveRole(USER, WS)).resolves.toBeNull();
    expect(fetchWithTimeout.mock.calls.length).toBeLessThan(FOUR.length);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
  });

  // CONTROL — the ceiling must not be "deny everything". Only the LAST group
  // carries the user, so a walk that stops short of the end would refuse a
  // genuine member and this test would go red.
  it('probes every group and still grants when the clock is not spent', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(res(404, { error: {} }))
      .mockResolvedValueOnce(res(404, { error: {} }))
      .mockResolvedValueOnce(res(404, { error: {} }))
      .mockResolvedValueOnce(res(200, { id: USER }));
    expect(await resolveEffectiveRole(USER, WS)).toBe('Admin');
    expect(fetchWithTimeout).toHaveBeenCalledTimes(FOUR.length);
  });
});

describe('one probe per DISTINCT group within a walk (#3834 §3)', () => {
  it('a group id repeated across rows costs ONE Graph probe, not one per row', async () => {
    setGroupAssignments([
      { principalId: GROUP, role: 'Viewer' },
      { principalId: GROUP, role: 'Admin' },
    ]);
    fetchWithTimeout.mockResolvedValue(res(200, { id: USER }));
    // Both rows still contribute — the memo saves the CALL, not the role.
    expect(await resolveEffectiveRole(USER, WS)).toBe('Admin');
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  // CONTROL — a memo keyed on the user alone (or on nothing) would collapse
  // these two DIFFERENT groups into one probe and answer from the wrong group.
  it('two DIFFERENT groups still cost two probes', async () => {
    setGroupAssignments([
      { principalId: 'g-a', role: 'Viewer' },
      { principalId: 'g-b', role: 'Admin' },
    ]);
    fetchWithTimeout.mockResolvedValue(res(200, { id: USER }));
    expect(await resolveEffectiveRole(USER, WS)).toBe('Admin');
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });
});
