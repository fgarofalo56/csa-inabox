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
  const SIX = ['g-a', 'g-b', 'g-c', 'g-d', 'g-e', 'g-f'];

  /**
   * The walk ceiling these tests configure.
   *
   * IT MUST NOT BE 30_000. The first version of this suite used exactly the
   * mocked `DEFAULT_SERVER_FETCH_TIMEOUT_MS` above, which is the value
   * `graphGroupWalkBudgetMs()` falls back to when the knob is unset — so the
   * knob arm and the no-knob arm produced identical behaviour and a
   * `graphGroupWalkBudgetMs()` that IGNORED `LOOM_GRAPH_GROUP_WALK_BUDGET_MS`
   * entirely still passed every test here. Any value that is not the fallback
   * separates them; 24_000 is chosen so that with an 8_000ms probe exactly
   * three of the four groups fit, while the 30_000 fallback fits all four.
   */
  const WALK_MS = 24_000;
  const PROBE_MS = 8_000;
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

  /**
   * Run ONE walk over `groups` where every Graph probe answers a measured
   * negative and costs `costMs` of the walk's wall clock.
   *
   * Only `Date` is faked — the module under test reads the clock through
   * `PagingBudget`, and faking timers wholesale would also intercept the test
   * runner's own. Returns what the walk OBSERVABLY did: how many probes it
   * made, the per-probe `timeoutMs` it handed down, and everything it logged.
   */
  async function walkRun(groups: string[], costMs: number) {
    setGroupAssignments(groups.map((principalId) => ({ principalId, role: 'Admin' })));
    fetchWithTimeout.mockReset();
    (console.warn as any).mockClear();
    let now = Date.UTC(2026, 7, 24);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    fetchWithTimeout.mockImplementation(async () => {
      now += costMs;
      vi.setSystemTime(now);
      return res(404, { error: {} }); // a measured negative — exactly one call per group
    });
    try {
      const role = await resolveEffectiveRole(USER, WS);
      return {
        role,
        probes: fetchWithTimeout.mock.calls.length,
        timeouts: fetchWithTimeout.mock.calls.map((c: any[]) => c[2]),
        warn: warnings(),
      };
    } finally {
      vi.useRealTimers();
    }
  }

  it('stops claiming groups once the walk-wide clock is spent', async () => {
    // Each probe burns 8s of the 24s walk, so three fit and the fourth must
    // never be attempted.
    const r = await walkRun(FOUR, PROBE_MS);
    expect(r.role).toBeNull();
    expect(r.probes).toBeLessThan(FOUR.length);
    expect(r.probes).toBe(3);
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

  /**
   * N1 — EACH PROBE GETS THE WALK'S REMAINING CLOCK, NOT A FRESH ONE.
   *
   * The point-read is dispatched as `fetchWithTimeout(url, init, walk?.remainingMs())`.
   * Deleting that third argument left every test above green while silently
   * degrading the worst case from ~30s to 30s + 30s + 15s, because a probe with
   * `timeoutMs === undefined` falls back to the 30s single-request ceiling and
   * can therefore out-live the walk that is supposed to contain it. The
   * observable property is the argument itself: a number, shrinking as the
   * walk's clock is spent, never repeating.
   */
  it('hands each probe the walk REMAINING clock, not a fresh per-probe ceiling', async () => {
    const r = await walkRun(FOUR, PROBE_MS);
    for (const t of r.timeouts) expect(typeof t).toBe('number');
    // strictly decreasing — a fresh ceiling per probe would be constant
    expect(r.timeouts).toEqual([...r.timeouts].sort((a: number, b: number) => b - a));
    expect(new Set(r.timeouts).size).toBe(r.timeouts.length);
    // and never more than what is actually left of the walk
    expect(r.timeouts).toEqual([WALK_MS, WALK_MS - PROBE_MS, WALK_MS - 2 * PROBE_MS]);
  });

  /**
   * N2 — THE ADVERTISED KNOB IS ACTUALLY READ.
   *
   * `LOOM_GRAPH_GROUP_WALK_BUDGET_MS` is documented in `workspace-guard.ts`,
   * `docs/fiab/arm-paging-budget.md` and `docs/fiab/brain/security-taxonomy.md`.
   * A `graphGroupWalkBudgetMs()` that ignored `process.env` completely and
   * always returned the fallback passed the whole suite, because the suite set
   * the knob to the fallback's own value. This is the A/B that separates them:
   * set vs unset must produce DIFFERENT behaviour.
   */
  it('honours LOOM_GRAPH_GROUP_WALK_BUDGET_MS — a lower knob stops the walk sooner', async () => {
    // 12s probes: the 24_000 knob fits two, the 30_000 fallback fits three.
    process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS = String(WALK_MS);
    const knobbed = await walkRun(FOUR, 12_000);
    delete process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS;
    const fallback = await walkRun(FOUR, 12_000);
    expect(knobbed.probes).toBe(2);
    expect(fallback.probes).toBe(3);
    expect(knobbed.probes).toBeLessThan(fallback.probes);
    // and the ceiling handed to the first probe is the knob itself
    expect(knobbed.timeouts[0]).toBe(WALK_MS);
    expect(fallback.timeouts[0]).toBe(30_000); // DEFAULT_SERVER_FETCH_TIMEOUT_MS
  });

  it('ignores a non-positive or non-numeric knob and uses the single-request ceiling', async () => {
    for (const bad of ['0', '-1', 'soon', '']) {
      process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS = bad;
      const r = await walkRun(FOUR, 12_000);
      expect(r.timeouts[0], `knob=${JSON.stringify(bad)}`).toBe(30_000);
      expect(r.probes, `knob=${JSON.stringify(bad)}`).toBe(3);
    }
  });

  /**
   * F1 — THE TRUNCATION LINE MUST NAME A KNOB THAT ACTUALLY MOVES THIS CEILING.
   *
   * This walk used to report itself through `PagingBudget.warnIfTruncated`,
   * which hardcodes `LOOM_ARM_PAGING_BUDGET_MS` — a knob this budget never
   * reads. MEASURED before the fix: `LOOM_ARM_PAGING_BUDGET_MS=600000` still
   * truncated at 30000ms after 3 of 6 groups. The one diagnostic for the one
   * new failure mode the aggregate ceiling introduces pointed at a no-op, which
   * is the deploy-integrity R7 shape exactly.
   *
   * Keyed to the PROPERTY, not to a spelling: extract every `LOOM_*` token the
   * walk logged, then RE-RUN the identical scenario with each of them raised.
   * A named knob that does not stop the truncation fails the test — whatever it
   * is called, including one nobody thought to blocklist.
   */
  it('names a knob that ACTUALLY moves this ceiling — raising it must stop the truncation (R7)', async () => {
    process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS = String(WALK_MS);
    const base = await walkRun(SIX, PROBE_MS);
    expect(base.probes).toBe(3); // it genuinely truncated: 3 of 6
    expect(base.probes).toBeLessThan(SIX.length);

    const knobs = [...new Set(base.warn.match(/LOOM_[A-Z0-9_]+/g) ?? [])];
    expect(knobs, 'a truncated walk must name the knob to raise').not.toHaveLength(0);

    for (const knob of knobs) {
      const previous = process.env[knob];
      process.env[knob] = String(WALK_MS * 20);
      try {
        const raised = await walkRun(SIX, PROBE_MS);
        expect(
          raised.probes,
          `the truncation line tells the operator to raise ${knob}, but raising it to ` +
            `${WALK_MS * 20}ms still probed only ${raised.probes} of ${SIX.length} groups`,
        ).toBe(SIX.length);
      } finally {
        if (previous === undefined) delete process.env[knob];
        else process.env[knob] = previous;
      }
    }
  });

  /**
   * F1, second half — the CONSEQUENCE has to be the one that actually happens.
   *
   * The borrowed text said "returning N row(s), the list may be incomplete",
   * which describes a picker showing a short list. What actually happens is an
   * authorization decision taken on a partial group set: a genuine member of an
   * unprobed group is refused. Nobody chasing an unexplained 403 would have
   * connected the borrowed line to it.
   */
  it('states the consequence as an AUTHORIZATION refusal, not a truncated list (R7)', async () => {
    process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS = String(WALK_MS);
    const base = await walkRun(SIX, PROBE_MS);
    // the accounting an operator needs, computed from the run rather than
    // asserted as prose: how many of the workspace's group grants were resolved
    expect(base.warn).toContain(`${base.probes} of ${SIX.length} group(s)`);
    expect(base.warn).toContain(`${SIX.length - base.probes} group grant(s) were NEVER PROBED`);
    expect(base.warn).toMatch(/REFUSED/);
    expect(base.warn).toMatch(/403/);
    // both log taxonomies stay greppable: the umbrella `[paging-budget]` tag
    // every bounded walk in the console shares, and the walk-specific one
    expect(base.warn).toContain('[paging-budget]');
    expect(base.warn).toContain('[graph-group-walk]');
    // neither half of the borrowed line may come back
    expect(base.warn).not.toContain('the list may be incomplete');
    expect(base.warn).not.toContain('LOOM_ARM_PAGING_BUDGET_MS');
  });

  // CONTROL — silence means "every group grant was resolved". A warn that fired
  // unconditionally would satisfy every assertion above.
  it('says NOTHING when the walk resolved every group', async () => {
    process.env.LOOM_GRAPH_GROUP_WALK_BUDGET_MS = String(WALK_MS);
    const r = await walkRun(SIX, 1_000); // 6 x 1s fits inside 24s
    expect(r.probes).toBe(SIX.length);
    expect(r.warn).toBe('');
  });
});

/**
 * N3 — A PROBE'S PAGED FALLBACK CANNOT OUTLIVE THE WALK THAT CONTAINS IT.
 *
 * The enumeration budget is
 * `Math.min(defaultPagingBudgetMs(), walk.remainingMs())`. Replacing that with
 * a bare `{}` — i.e. always the ARM paging ceiling, ignoring the walk — left
 * the whole suite green, so the "takes the smaller of the two ceilings" claim
 * was unguarded and one slow group's fallback could spend clock the walk had
 * already promised to the groups behind it.
 *
 * The observable is the `timeoutMs` the enumeration page fetch is handed. Both
 * directions are pinned, because a test for only one of them is satisfied by
 * "always the walk's remaining" just as easily as by the minimum.
 */
describe("a probe's paged fallback takes the SMALLER of the two ceilings (#3834 §3)", () => {
  const ARM_KNOB = 'LOOM_ARM_PAGING_BUDGET_MS';
  const WALK_KNOB = 'LOOM_GRAPH_GROUP_WALK_BUDGET_MS';
  let savedArm: string | undefined;
  let savedWalk: string | undefined;

  beforeEach(() => {
    savedArm = process.env[ARM_KNOB];
    savedWalk = process.env[WALK_KNOB];
  });

  afterEach(() => {
    if (savedArm === undefined) delete process.env[ARM_KNOB];
    else process.env[ARM_KNOB] = savedArm;
    if (savedWalk === undefined) delete process.env[WALK_KNOB];
    else process.env[WALK_KNOB] = savedWalk;
    vi.useRealTimers();
  });

  /**
   * ONE group whose point-read answers 403 — the case the paged fallback exists
   * for — after burning `pointReadCostMs` of the walk's clock, then ONE clean
   * enumeration page. Returns the `timeoutMs` the ENUMERATION fetch was handed.
   */
  async function enumerationTimeout(pointReadCostMs: number): Promise<number> {
    setGroupAssignments([{ principalId: 'g-a', role: 'Admin' }]);
    fetchWithTimeout.mockReset();
    let now = Date.UTC(2026, 7, 24);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    let call = 0;
    fetchWithTimeout.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        now += pointReadCostMs;
        vi.setSystemTime(now);
        return res(403, { error: { code: 'Authorization_RequestDenied' } });
      }
      return res(200, { value: [{ id: 'someone-else' }] }); // clean page, no match
    });
    try {
      await resolveEffectiveRole(USER, WS);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    return fetchWithTimeout.mock.calls[1][2];
  }

  it("uses the WALK's remaining clock when the walk is the tighter ceiling", async () => {
    process.env[ARM_KNOB] = '15000';
    process.env[WALK_KNOB] = '20000';
    // the point-read burnt 12s of the 20s walk, leaving 8s — tighter than 15s
    expect(await enumerationTimeout(12_000)).toBe(8_000);
  });

  it('uses LOOM_ARM_PAGING_BUDGET_MS when THAT is the tighter ceiling', async () => {
    process.env[ARM_KNOB] = '6000';
    process.env[WALK_KNOB] = '60000';
    // the walk has 60s left, so the 6s paging ceiling is what must bind
    expect(await enumerationTimeout(0)).toBe(6_000);
  });

  /**
   * ONE group whose point-read 403s after `pointReadCostMs`, then an
   * enumeration whose FIRST page costs `pageCostMs` and advertises an
   * `@odata.nextLink`. The SECOND page — reached only if the budget allows one —
   * carries the user. So a ceiling too tight truncates and answers `unknown`
   * (no role); a ceiling wide enough reaches page 2 and grants.
   */
  async function enumerationRun(pointReadCostMs: number, pageCostMs: number) {
    setGroupAssignments([{ principalId: 'g-a', role: 'Admin' }]);
    fetchWithTimeout.mockReset();
    (console.warn as any).mockClear();
    let now = Date.UTC(2026, 7, 24);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    let call = 0;
    fetchWithTimeout.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        now += pointReadCostMs;
        vi.setSystemTime(now);
        return res(403, { error: { code: 'Authorization_RequestDenied' } });
      }
      now += pageCostMs;
      vi.setSystemTime(now);
      if (call === 2) {
        return res(200, {
          value: [{ id: 'other' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
        });
      }
      return res(200, { value: [{ id: USER }] }); // page 2 carries the user
    });
    try {
      const role = await resolveEffectiveRole(USER, WS);
      return { role, pages: fetchWithTimeout.mock.calls.length - 1, warn: warnings() };
    } finally {
      vi.useRealTimers();
    }
  }

  /**
   * The SAME R7 defect lived on this budget's own truncation line, and it is
   * introduced by the very `Math.min` above: `PagingBudget.warnIfTruncated` can
   * only ever name `LOOM_ARM_PAGING_BUDGET_MS`, so whenever the WALK is the
   * tighter of the two ceilings the operator is told to raise the one knob that
   * cannot move it.
   *
   * Keyed to the property, and run in BOTH directions so the message cannot
   * pass by always blaming the walk: extract every `LOOM_*` token the probe
   * logged, raise each one, and require that the enumeration then completes and
   * grants. The second scenario is the control — there the ARM knob genuinely
   * IS the binding ceiling and naming it is correct.
   */
  it('the enumeration truncation names a knob that ACTUALLY moves ITS ceiling (R7)', async () => {
    const scenarios = [
      { name: "the walk's remaining clock binds", arm: '15000', walk: '20000', pointRead: 12_000, page: 8_000 },
      { name: 'the ARM paging ceiling binds', arm: '6000', walk: '60000', pointRead: 0, page: 6_000 },
    ];
    for (const s of scenarios) {
      process.env[ARM_KNOB] = s.arm;
      process.env[WALK_KNOB] = s.walk;
      const base = await enumerationRun(s.pointRead, s.page);
      expect(base.role, `${s.name}: the probe must have truncated`).toBeNull();
      expect(base.warn, `${s.name}`).toContain('[graph-membership] UNKNOWN (not a measured negative)');
      // the umbrella tag `paging-budget-residual.test.ts` greps for must survive
      expect(base.warn, `${s.name}`).toContain('[paging-budget]');
      expect(base.warn, `${s.name}`).toMatch(/REFUSED/);

      const knobs = [...new Set(base.warn.match(/LOOM_[A-Z0-9_]+/g) ?? [])];
      expect(knobs, `${s.name}: a truncated probe must name the knob to raise`).not.toHaveLength(0);
      for (const knob of knobs) {
        const previous = process.env[knob];
        process.env[knob] = '600000';
        try {
          const raised = await enumerationRun(s.pointRead, s.page);
          expect(
            raised.role,
            `${s.name}: the truncation line tells the operator to raise ${knob}, but raising it ` +
              `to 600000ms still answered unknown after ${raised.pages} enumeration page(s)`,
          ).toBe('Admin');
        } finally {
          if (previous === undefined) delete process.env[knob];
          else process.env[knob] = previous;
        }
      }
    }
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
