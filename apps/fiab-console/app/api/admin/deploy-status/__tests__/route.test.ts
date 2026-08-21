/**
 * /api/admin/deploy-status — the build marker decides which URL we fetch
 * (CodeQL js/file-access-to-http #776).
 *
 * WHAT THIS PROVES. `readBuildMarker()` parses public/build-marker.txt with
 * `/sha=([^\s]+)/` — every non-whitespace byte is accepted — and the result was
 * interpolated straight into `/repos/<repo>/compare/<sha>...<branch>`. A URL
 * parser collapses `..` BEFORE the request leaves, so file content chose which
 * api.github.com endpoint this route called, with LOOM_FEEDBACK_GITHUB_TOKEN
 * attached when one is configured.
 *
 * The sharp edge is the query-terminated form, `../../../../user/repos?x=`:
 * the trailing `...main` parks in the query string, so the request lands on
 * `GET /user/repos` EXACTLY. That is asserted as its own control below rather
 * than described.
 *
 * WHAT IT IS NOT, stated so the severity is not overread: no byte of the
 * diverted response reaches the client. `DeployStatusReport` carries only
 * `estate` + `paths`; `EstateDrift` has no field holding the compare payload;
 * `classifyEstateDrift` reads only `status`/`ahead_by`/`behind_by`/
 * `commits[].commit.*.date`, all undefined for a diverted endpoint. So this is
 * a BLIND credential-attached GET confined to one host, not disclosure — and
 * the marker is writable only at image build (Dockerfile:152 + six CI
 * build-args), behind an Admin capability gate.
 *
 * The honest-reason test is therefore the load-bearing one (deploy-integrity
 * R7), and the degraded verdict it replaces is measured, not assumed: fed the
 * real `/user/repos` array, classifyEstateDrift returns state:'behind',
 * severity:'error', "This estate is **undefined** commits behind main" — loud
 * and incoherent, naming no real cause. (It is NOT a false green; an earlier
 * revision of this file claimed that, because its stub returned the comparison
 * object for every URL.)
 *
 * These tests assert the URL ACTUALLY REQUESTED, not the shape of a string:
 * `fetch` is captured and every call inspected with the WHATWG parser, so a
 * payload that only becomes dangerous after normalization is still caught. The
 * normalization itself is asserted first, as a control — otherwise a traversal
 * test could be passing because the payload was inert, not because the guard
 * held.
 *
 * The pure classifiers in lib/admin/deploy-status.ts are NOT mocked; only the
 * I/O the route exists to perform is.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** The marker each test wants readBuildMarker() to return. */
let MARKER: { sha?: string; stamp?: string } = {};
/** Every URL passed to fetch, in order. */
let FETCHED: string[] = [];
/**
 * Run history per workflow filename. Default (`{}`) means every lane answers
 * with an empty history, which is what the SSRF tests above want — they care
 * about which URL was requested, not what came back.
 */
let ROLL_RUNS: Record<string, unknown[]> = {};
/**
 * Job lists per run id, for the step-2b lookback.
 *
 * Three deliberate shapes, because the route must survive all three:
 *   { jobs: [...] }  a normal answer;
 *   'HTTP_500'       a non-ok response — an unreadable job list;
 *   'MALFORMED'      a 200 carrying a JSON ARRAY, the shape GitHub returns for
 *                    other endpoints and the one that used to reach
 *                    `undefined.find(...)`.
 * A run id absent from this map is a test that expected no jobs call at all;
 * it answers MALFORMED so that an unexpected call is loud rather than benign.
 */
let JOBS: Record<string, unknown> = {};

vi.mock('@/lib/updates/current-version', () => ({
  readBuildMarker: () => MARKER,
  // #3730 — the self row reports this console's running version alongside its
  // sha. Modelled on the real resolver's LAST fallback (`build-<sha12>`) rather
  // than a fixed string, so the value still tracks the marker under test.
  resolveCurrentVersion: (b: { sha?: string }) => (b?.sha ? `build-${b.sha.slice(0, 12)}` : 'dev'),
}));

vi.mock('@/lib/azure/cloud-endpoints', () => ({
  // 'Commercial' with the capital, which is what detectLoomCloud() actually
  // returns (lib/azure/cloud-boundary.ts LoomCloud). The lowercase string this
  // mock used to return matched no cloud at all, so after #3730 the route would
  // have treated BOTH estates as remote peers and probed its own console over
  // the network — a divergence between the fixture and the dependency, which is
  // exactly the modelling error this file's own beforeEach warns about.
  detectLoomCloud: () => 'Commercial',
}));

// The cache is not under test: run the compute function every time.
vi.mock('@/lib/azure/query-result-cache', () => ({
  getOrComputeCached: async (_k: string, _m: string, compute: () => Promise<unknown>) => ({
    value: await compute(),
    meta: { stale: false },
  }),
}));

// Session + capability are covered by the toolkit's own suite; here the handler
// must actually run, so the wrapper is a pass-through.
vi.mock('@/lib/api/route-toolkit', () => ({
  withCapability:
    (_cap: string, _role: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown, ctx: unknown) =>
      handler(req, ctx),
}));

import { GET } from '../route';
 import { LOOM_ESTATES } from '@/lib/admin/estate-fleet';

const HOST = 'https://api.github.com';

/**
 * Is this URL actually addressed to api.github.com?
 *
 * PARSED HOST, NEVER A PREFIX MATCH. `u.startsWith('https://api.github.com')` —
 * which is what this file's helpers first used — is true of
 * `https://api.github.com.evil.example/…`, and CodeQL flagged all three sites
 * (js/incomplete-url-substring-sanitization, 3 high). In a test that is not a
 * runtime hole, but it is worse than cosmetic: these helpers CLASSIFY the calls
 * the SSRF assertions are made over, so a diverted URL that merely started with
 * the right prefix would be filed as a legitimate compare call and the guard
 * would pass over it. Fixing it makes the control sharper, not just quieter.
 */
function isGitHubApi(u: string): boolean {
  try {
    return new URL(u).host === 'api.github.com';
  } catch {
    return false;
  }
}

beforeEach(() => {
  MARKER = {};
  FETCHED = [];
  ROLL_RUNS = {};
  JOBS = {};
  // The stub answers BY PARSED PATHNAME, the way the network stack does — not
  // by substring on the raw URL, and not with one payload for every request.
  // Both shortcuts are the same modelling error and both were made here:
  //
  //   - one payload for everything manufactured a "false green" finding this
  //     PR then asserted as measured fact in three places;
  //   - matching `/compare/` on the RAW string re-manufactured it, because
  //     `.../compare/../../../../user/repos...main` still CONTAINS `/compare/`
  //     while normalizing to `/user/repos...main`. That is the whole bug: a
  //     fixture that reads the string the code built rather than the request
  //     the code actually makes cannot see a traversal at all.
  //
  // Model the dependency, not the code under test.
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url);
    FETCHED.push(u);
    const p = new URL(u).pathname;
    const body = (data: unknown) =>
      ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => data,
        // `text` is modelled too: the #3730 fleet probe reads the peer estate's
        // marker with res.text(). A stub carrying only `json` would make every
        // peer read throw and land in the honest-degrade branch — the suite
        // would still pass, while silently testing the failure path instead of
        // the success one.
        text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
      }) as unknown as Response;

    if (/^\/repos\/[^/]+\/[^/]+\/compare\/[^/]+$/.test(p)) {
      return body({ status: 'identical', ahead_by: 0, behind_by: 0, commits: [] });
    }
    const runs = /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/runs$/.exec(p);
    if (runs) {
      return body({ workflow_runs: ROLL_RUNS[runs[1]] ?? [] });
    }
    // Step 2b's job lookback. Keyed by run id so a test can give the newest run
    // a SKIPPED roll job and an older one a successful roll job — the shape of
    // the 2026-08-17 run that concluded success having rolled nothing.
    //
    // THE STUB PAGINATES, because the route's `per_page` is a real bound and a
    // stub that ignores it cannot see the route run off the end of a page. It
    // answers the way the endpoint does: `total_count` is the run's WHOLE job
    // count, `jobs` is at most `per_page` of them. A fixture may set an explicit
    // `total_count` larger than the rows it supplies, which is the truncation
    // case without needing a hundred filler rows.
    const jobs = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/([^/]+)\/jobs$/.exec(p);
    if (jobs) {
      const fixture = JOBS[jobs[1]];
      if (fixture === 'HTTP_500') {
        return {
          ok: false, status: 500, headers: { get: () => null },
          json: async () => ({}), text: async () => '',
        } as unknown as Response;
      }
      // A 200 whose body is an ARRAY, not { jobs: [...] }. `jobs.data` is
      // truthy and `jobs.data.jobs` is undefined, so a truthiness guard lets
      // `.find` run on undefined and throw — uncaught, that is a 500 for the
      // whole readiness panel rather than one unknown verdict.
      if (fixture === undefined || fixture === 'MALFORMED') return body([{ id: 1 }]);
      // A 200 whose `jobs` is present but is an OBJECT, not an array. This is
      // the ONLY shape that can tell `Array.isArray(jobs.data?.jobs)` apart from
      // a plain truthiness check — under MALFORMED above, `data.jobs` is
      // `undefined` and both guards degrade identically, so the suite could not
      // see the difference and the mutation `!Array.isArray(x)` -> `!x` survived
      // it. Here truthiness passes and `.find` is not a function, which throws
      // uncaught and 500s the whole readiness panel.
      if (fixture === 'JOBS_NOT_AN_ARRAY') return body({ total_count: 1, jobs: { 0: { name: 'x' } } });
      // A 200 with a well-formed `jobs` array and NO `total_count` at all.
      // Separated from every other fixture because it is the only one that can
      // tell `total !== null && len < total` apart from `total === null ||
      // len < total`: with a total present both read alike, and the truncation
      // guard's absent-total branch fell straight through to an older candidate
      // and returned a GREEN verdict off a page whose completeness was never
      // established. Note this body carries a NON-roll job, so the fall-through
      // is reachable — a body with the roll job in it would settle before the
      // guard is consulted at all.
      if (fixture === 'NO_TOTAL_COUNT') {
        return body({ jobs: [{ name: 'Should this roll proceed?', conclusion: 'success' }] });
      }
      const f = fixture as { jobs: unknown[]; total_count?: number };
      const perPage = Number(new URL(u).searchParams.get('per_page') || 30);
      return body({
        total_count: f.total_count ?? f.jobs.length,
        jobs: f.jobs.slice(0, perPage),
      });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+$/.test(p)) {
      return body({ state: 'active' });
    }
    // #3730 — the peer estate's own unauthenticated endpoints. Answered with a
    // realistic sovereign marker (8-hex sha, extended-ISO stamp) so the fleet
    // path is exercised as it behaves in production.
    if (p === '/build-marker.txt') {
      return body('loom-build-marker sha=28de89fb stamp=2026-08-11T09:23:46Z token=LOOM_LIVE_BUILD\n');
    }
    if (p === '/api/version') {
      return body({ current: '0.90.2' });
    }
    // Anything else is an endpoint the marker DIVERTED us to. GET /user/repos
    // returns a JSON ARRAY — which is what makes the degraded verdict real.
    return body([{ id: 1, name: 'a-private-repo', private: true }]);
  });
});

async function run(): Promise<any> {
  const res = await (GET as any)({} as never, {} as never);
  return res.json();
}

/**
 * Every api.github.com call that is NOT one of the workflow-lane reads — i.e.
 * the compare calls, the only place a marker-derived value has ever reached a
 * URL.
 *
 * SCOPED TO THE GITHUB HOST BY #3730, and the scoping is a widening of what is
 * observed rather than a narrowing of what is enforced. The route now also
 * fetches each PEER ESTATE's `/build-marker.txt` and `/api/version`; those URLs
 * come from the static LOOM_ESTATES registry and contain no marker bytes, so
 * folding them into this list would have said "the marker chose a URL" about
 * calls the marker cannot influence. The property being protected — no
 * marker-derived value selects an endpoint — is unchanged, and the test below
 * (`the peer-estate probes are STATIC`) asserts it directly for the new calls
 * rather than leaving them merely excluded.
 */
function compareCalls(): string[] {
  return FETCHED.filter((u) => isGitHubApi(u) && !new URL(u).pathname.includes('/actions/workflows/'));
}

/** Every fetch that is NOT to api.github.com — i.e. the peer-estate probes. */
function estateCalls(): string[] {
  return FETCHED.filter((u) => !isGitHubApi(u));
}

/**
 * The compare the PEER estate legitimately produces (#3730).
 *
 * The fleet reads the Gov console's own marker — the stub above serves the real
 * sovereign shape, `sha=28de89fb` — and compares THAT sha against the branch
 * too. So from #3730 onward a healthy run makes TWO compare calls, not one, and
 * the tests below name this one explicitly rather than loosening their
 * assertions to `toContain`. An exact list is what makes "the local marker
 * contributed NO request" checkable at all: with a substring match, a traversal
 * that produced an extra call would still pass.
 *
 * Note this sha is itself marker-derived — from a REMOTE marker, which is
 * strictly less trusted than the local one — so it passes through the same
 * GIT_OBJECT_ID validation, and the `no fetched URL ever leaves the compare
 * endpoint` test covers it alongside the local one.
 */
const PEER_COMPARE = `${HOST}/repos/fgarofalo56/csa-inabox/compare/28de89fb...main`;

describe('deploy-status — the build marker cannot choose the endpoint (#776)', () => {
  it('CONTROL — `..` in a path IS collapsed by the URL parser before the request', () => {
    // If this ever stops holding, the traversal cases below would pass for the
    // wrong reason. Asserting it makes the threat model visible rather than
    // assumed: the marker's bytes did not stay in the compare path, they moved
    // the request to a different api.github.com endpoint entirely.
    const u = new URL(`${HOST}/repos/o/n/compare/../../../../user/repos...main`);
    expect(u.pathname).toBe('/user/repos...main');
    expect(u.pathname).not.toContain('/repos/o/n/compare/');
  });

  it('CONTROL — a query-terminated traversal lands on /user/repos EXACTLY', () => {
    // This is the payload that makes #776 sharp. The trailing `...main` the
    // route appends is parked in the query string, so the path is a real
    // authenticated endpoint (401 unauthenticated, verified) rather than a
    // nonsense one. Blind — the body never reaches the client — but a
    // credential-attached GET the marker chose.
    const u = new URL(`${HOST}/repos/o/n/compare/../../../../user/repos?x=...main`);
    expect(u.pathname).toBe('/user/repos');
    expect(u.search).toBe('?x=...main');
  });

  it('a well-formed sha still reaches the compare endpoint', () => {
    // The guard must not have closed the feature it protects.
    MARKER = { sha: '0f50dad764fa748f33acc6112671c26c284faa89' };
    return run().then(() => {
      expect(compareCalls()).toEqual([
        `${HOST}/repos/fgarofalo56/csa-inabox/compare/0f50dad764fa748f33acc6112671c26c284faa89...main`,
        PEER_COMPARE,
      ]);
    });
  });

  it('an 8-char short sha still reaches the compare endpoint', async () => {
    // gov-console-roll / console-bluegreen-roll pass `git rev-parse --short=8`.
    MARKER = { sha: '0f50dad7' };
    await run();
    expect(compareCalls()).toEqual([
      `${HOST}/repos/fgarofalo56/csa-inabox/compare/0f50dad7...main`,
      PEER_COMPARE,
    ]);
  });

  it('a traversal payload in the marker issues NO request at all', async () => {
    MARKER = { sha: '../../../../user/repos' };
    await run();
    // ONLY the peer's compare remains — the local marker contributed nothing.
    expect(compareCalls()).toEqual([PEER_COMPARE]);
  });

  it('the disclosure payload issues NO request at all', async () => {
    // The query-terminated traversal: pre-fix this fetched /user/repos with the
    // console's own GitHub token attached.
    MARKER = { sha: '../../../../user/repos?x=' };
    await run();
    expect(compareCalls()).toEqual([PEER_COMPARE]);
  });

  it('no fetched URL ever leaves the compare endpoint, whatever the marker says', async () => {
    const payloads = [
      '../../../../user/repos',
      '../../../../user/repos?x=',
      '../../../../gists?x=',
      '..%2f..%2fuser%2frepos',
      'main?per_page=100',
      'abc#fragment',
      'x'.repeat(300),
      'not-hex-at-all',
      'HEAD',
      '../../../../../../',
    ];
    for (const sha of payloads) {
      FETCHED = [];
      MARKER = { sha };
      await run();
      for (const u of compareCalls()) {
        expect(new URL(u).pathname, `marker sha=${sha}`).toMatch(
          /^\/repos\/fgarofalo56\/csa-inabox\/compare\/[0-9a-f]{7,40}\.\.\.main$/i,
        );
      }
    }
  });

  it('reports an honest, marker-specific reason instead of a verdict built from a non-comparison', async () => {
    // deploy-integrity R7. Both pre-fix outcomes asserted something untrue:
    //   - the endpoint 404s  -> "GitHub API returned HTTP 404", a GitHub-side
    //     cause for a purely local defect (both the traversal path and a
    //     non-hex sha 404 unauthenticated — measured);
    //   - the endpoint 200s  -> a verdict computed from a body that is not a
    //     comparison. Measured against the real /user/repos array shape:
    //     state:'behind', severity:'error', "This estate is undefined commits
    //     behind main". Loud and incoherent, naming no real cause.
    MARKER = { sha: '../../../../user/repos' };
    const body = await run();
    const text = JSON.stringify(body);
    expect(text).toContain('does not carry a git object id');
    expect(text).toContain('check /build-marker.txt');
    expect(text).not.toContain('HTTP 404');
    expect(text).not.toContain('undefined commits behind');
    expect(body.estate.state).toBe('unknown');
    //
    // NOT asserted, on purpose: that the response is free of the marker's bytes.
    // It is not. `classifyEstateDrift` (lib/admin/deploy-status.ts) echoes
    // `buildSha` into `detail` and builds `compareUrl` — a link rendered on
    // /admin/readiness — by interpolating it into a github.com URL. That is a
    // SECOND sink from the same unvalidated source, in a file this change does
    // not own, and it is reported rather than quietly papered over here. Echoing
    // the value into `detail` is also the RIGHT behaviour: "the marker is
    // malformed, here is what it says" is the honest report, and suppressing it
    // would trade one true statement for a vaguer one.
  });

  it('the peer-estate probes are STATIC — the marker cannot influence them either (#3730)', async () => {
    // The #3730 fleet added the first fetches this route makes to a host other
    // than api.github.com. Excluding them from compareCalls() would be a
    // narrowing of the guard unless the property is asserted directly, so it is:
    // whatever the marker says, the peer URLs are byte-identical to the static
    // registry, and none of them carries any part of the marker.
    const expected = LOOM_ESTATES
      .filter((e) => e.id !== 'commercial') // 'Commercial' is self — read from the image
      .flatMap((e) => [e.markerUrl, e.versionUrl]);
    expect(expected.length).toBeGreaterThan(0); // population guard

    for (const sha of ['0f50dad7', '../../../../user/repos?x=', 'not-hex-at-all', 'x'.repeat(300)]) {
      FETCHED = [];
      MARKER = { sha };
      await run();
      expect(estateCalls().sort(), `marker sha=${sha}`).toEqual(expected.slice().sort());
      for (const u of estateCalls()) {
        expect(u, `marker sha=${sha}`).not.toContain(sha);
      }
    }
  });

  it('a peer estate that cannot be read is UNKNOWN, never current and never behind', async () => {
    // deploy-integrity R7. A sovereign boundary with no egress to the other
    // cloud lands here on every single load, so this is the COMMON path, not an
    // edge case — and it must never render as a healthy peer.
    MARKER = { sha: '0f50dad764fa748f33acc6112671c26c284faa89' };
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      FETCHED.push(u);
      if (!isGitHubApi(u)) throw new Error('getaddrinfo ENOTFOUND');
      return ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ status: 'identical', ahead_by: 0, behind_by: 0, commits: [] }),
        text: async () => '',
      }) as unknown as Response;
    });
    const body = await run();
    const gov = (body.estates as any[]).find((e) => e.id === 'gov');
    expect(gov.reachable).toBe(false);
    expect(gov.unreachableReason).toMatch(/could not reach/);
    expect(gov.drift.state).toBe('unknown');
    expect(gov.drift.state).not.toBe('current');
    expect(gov.drift.state).not.toBe('behind');
    expect(gov.drift.commitsBehind).toBeNull();
    // …and the self row is still reported normally: one cloud being unreadable
    // must not take the whole surface down.
    const self = (body.estates as any[]).find((e) => e.id === 'commercial');
    expect(self.isSelf).toBe(true);
    expect(self.source).toBe('this-image');
    expect(self.drift.state).toBe('current');
  });

  it('still reports the no-sha case distinctly from the malformed case', async () => {
    // The two must not collapse into one message: "no fingerprint at all" and
    // "a fingerprint that is not a commit id" have different remediations.
    MARKER = {};
    const body = await run();
    expect(body.estate.headline).toBe('Running build is unidentified');
    expect(JSON.stringify(body)).toContain('no build fingerprint');
    expect(JSON.stringify(body)).not.toContain('does not carry a git object id');
    expect(compareCalls()).toEqual([PEER_COMPARE]);
  });
});

/**
 * Step 2b — which roll actually shipped, and did something put the estate back?
 * (#3676)
 *
 * The unit tests in lib/admin cover the classifiers. What only the ROUTE can be
 * asked is the part that costs money and can be wrong in the expensive
 * direction: WHEN it spends an upstream call, WHICH run it settles on when the
 * newest one lied, and whether a bad answer from GitHub degrades or detonates.
 *
 * The call budget is not decoration. This route already issues ~12 requests
 * against an unauthenticated ceiling of 60/hour per egress IP; a lookback that
 * fired on every healthy load would spend three more on every refresh and turn
 * the whole page UNKNOWN — a strictly worse outcome than the question it was
 * added to answer. So "zero calls when healthy" is asserted as a hard number,
 * not left to the unit test's opinion of `rollNeedsJobCheck`.
 */
describe('the roll-regression lookback (step 2b)', () => {
  /** What roll 32225337320 shipped at 07:04:56Z on 2026-08-19. */
  const SHA_NEW = '150d2937aa1b4c5d6e7f8091a2b3c4d5e6f70819';
  /** What the scheduled reconcile put BACK at 07:10:19Z. */
  const SHA_OLD = '83e7cab6bb2c5d6e7f8091a2b3c4d5e6f7081920';
  const ROLL_LANE = 'loom-roll-and-validate.yml';
  const ROLL_JOB = 'Roll image + validate live URL';
  /** The step INSIDE that job that runs `az containerapp update`. */
  const ROLL_STEP = 'Roll Container App to new image';

  /** A run of the Commercial roll lane, titled the way the workflow titles it. */
  const rollRun = (id: number, sha: string, finishedAt: string) => ({
    id,
    name: `roll ${sha} (build-triggered)`,
    conclusion: 'success',
    updated_at: finishedAt,
    created_at: finishedAt,
    html_url: `https://github.com/x/y/actions/runs/${id}`,
  });

  /** The jobs calls actually issued, which is the quantity under test. */
  const jobsCalls = (): string[] =>
    FETCHED.filter((u) => isGitHubApi(u) && /\/actions\/runs\/[^/]+\/jobs/.test(new URL(u).pathname));

  it('spends ZERO upstream calls when the newest roll names what the estate runs', async () => {
    MARKER = { sha: SHA_NEW, stamp: '2026-08-19T07:04:56Z' };
    ROLL_RUNS[ROLL_LANE] = [
      rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z'),
      // An older roll naming a different sha, finished BEFORE this image was
      // built — it cannot have overtaken us, so it must not provoke a call.
      rollRun(32220000000, SHA_OLD, '2026-08-19T05:59:00Z'),
    ];
    const body = await run();
    expect(jobsCalls()).toEqual([]);
    expect(body.rollRegression.state).toBe('current');
    expect(body.rollRegression.rolledSha).toBe(SHA_NEW);
  });

  it('settles on the OLDER roll when the newest one succeeded without rolling', async () => {
    // The 2026-08-17 shape: the gate job succeeded, `Roll image + validate live
    // URL` was SKIPPED because no image had built, and the RUN still reported
    // success. Reading the run conclusion would name SHA_NEW as what shipped,
    // see the estate running SHA_OLD, and convict a healthy estate of running a
    // reverted image. Asking the JOB finds the roll that actually shipped.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [
      rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z'),
      rollRun(32220000000, SHA_OLD, '2026-08-19T05:59:00Z'),
    ];
    JOBS['32225337320'] = { jobs: [
      { name: 'Should this roll proceed?', conclusion: 'success' },
      { name: ROLL_JOB, conclusion: 'skipped' },
    ] };
    JOBS['32220000000'] = { jobs: [{ name: ROLL_JOB, conclusion: 'success' }] };

    const body = await run();
    expect(jobsCalls().length).toBe(2);
    // The run it names is the one that shipped, not the one that merely ran.
    expect(body.rollRegression.rolledSha).toBe(SHA_OLD);
    expect(body.rollRegression.rollRunUrl).toContain('32220000000');
    expect(body.rollRegression.state).toBe('current');
    expect(body.rollRegression.severity).not.toBe('error');
  });

  it('an unreadable job list is UNKNOWN — never a green verdict, never a regression', async () => {
    // deploy-integrity R7: "we could not establish whether the roll was
    // overwritten" is a different sentence from "nothing overwrote it", and it
    // is equally not "something did". Both wrong answers are excluded here.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z')];
    JOBS['32225337320'] = 'HTTP_500';

    const body = await run();
    expect(body.rollRegression.state).toBe('unknown');
    expect(body.rollRegression.state).not.toBe('current');
    expect(body.rollRegression.state).not.toBe('regressed');
    expect(body.rollRegression.severity).toBe('warning');
    expect(body.rollRegression.detail).toContain('could not read the jobs');
    // The reason names the cause it actually established (HTTP 500), not one it
    // inferred — the R7 failure that sent two investigations the wrong way.
    expect(body.rollRegression.detail).toContain('500');
  });

  it('a MALFORMED 200 degrades the verdict instead of 500-ing the whole panel', async () => {
    // `jobs.data` truthy + `jobs.data.jobs` undefined ⇒ `.find` throws, and
    // nothing between here and the handler catches it, so the entire deploy
    // panel would vanish from /admin/readiness over one odd body from GitHub.
    // The route must return 200 with an honest unknown.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z')];
    JOBS['32225337320'] = 'MALFORMED';

    const res = await (GET as any)({} as never, {} as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The rest of the report still rendered — this is one degraded verdict, not
    // an outage.
    expect(body.estate).toBeTruthy();
    expect(body.paths.length).toBeGreaterThan(0);
    expect(body.rollRegression.state).toBe('unknown');
    expect(body.rollRegression.detail).toContain('no job list returned');
  });

  it('a 200 whose `jobs` is an OBJECT, not an array, also degrades instead of 500-ing', async () => {
    // The `Array.isArray` guard's own mutation proof, and it was MISSING: the
    // MALFORMED case above sends a bare JSON array, so `data.jobs` is undefined
    // and `!Array.isArray(x)` and `!x` behave identically — mutating the guard
    // to truthiness passed the whole suite. Only a body where `jobs` EXISTS but
    // is not an array separates them: truthiness lets `.find` run on an object,
    // which is a TypeError, uncaught, and therefore a 500 that takes the entire
    // deploy panel off /admin/readiness over one odd body from GitHub.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z')];
    JOBS['32225337320'] = 'JOBS_NOT_AN_ARRAY';

    const res = await (GET as any)({} as never, {} as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paths.length).toBeGreaterThan(0);
    expect(body.rollRegression.state).toBe('unknown');
    expect(body.rollRegression.detail).toContain('no job list returned');
  });

  it('stops after ROLL_JOB_LOOKBACK runs and says so, rather than guessing from a fourth', async () => {
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [
      rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z'),
      rollRun(32225337321, SHA_NEW, '2026-08-19T06:50:00Z'),
      rollRun(32225337322, SHA_NEW, '2026-08-19T06:40:00Z'),
      // The fourth WOULD settle it — and must not be reached. Naming a roll
      // from outside the window as "the last effective roll" is a guess wearing
      // a verdict's clothes.
      rollRun(32225337323, SHA_OLD, '2026-08-19T06:30:00Z'),
    ];
    for (const id of ['32225337320', '32225337321', '32225337322']) {
      JOBS[id] = { jobs: [{ name: ROLL_JOB, conclusion: 'skipped' }] };
    }
    JOBS['32225337323'] = { jobs: [{ name: ROLL_JOB, conclusion: 'success' }] };

    const body = await run();
    expect(jobsCalls().length).toBe(3);
    expect(jobsCalls().some((u) => u.includes('32225337323'))).toBe(false);
    expect(body.rollRegression.state).toBe('unknown');
    expect(body.rollRegression.detail).toContain('none of the last 3');
    expect(body.rollRegression.rolledSha).toBeNull();
  });

  it('the run ids it asks about come from the run LIST, not from the build marker', async () => {
    // Same property the SSRF suite above protects for the compare call: no
    // marker-derived byte selects an endpoint. Step 2b added a new URL shape
    // with an interpolated id, so it is asserted here rather than assumed.
    MARKER = { sha: '../../../../user/repos?x=', stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z')];
    JOBS['32225337320'] = { jobs: [{ name: ROLL_JOB, conclusion: 'success' }] };

    await run();
    expect(jobsCalls().length).toBe(1);
    for (const u of jobsCalls()) {
      expect(u).not.toContain('user/repos');
      expect(new URL(u).pathname).toMatch(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/32225337320\/jobs$/);
    }
  });

  it('a candidate with NO run id is reported as UNCHECKED, never as one that did not roll', async () => {
    // deploy-integrity R7, committed by the loop whose own comment forbids it.
    // `if (!c.run.id) continue` skipped a candidate WITHOUT querying it, and the
    // exit message then stated as fact that "none of the last N successful
    // run(s) ACTUALLY RAN its 'Roll image + validate live URL' job". For a run
    // that was never asked, that sentence asserts something this code did not
    // establish — the same shape as the roll that reported "the tag does not
    // exist" when the truth was "I could not reach the registry".
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    const noId = rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z') as Record<string, unknown>;
    delete noId.id;
    ROLL_RUNS[ROLL_LANE] = [noId];

    const body = await run();
    // Nothing was asked, so nothing may be claimed…
    expect(jobsCalls()).toEqual([]);
    expect(body.rollRegression.state).toBe('unknown');
    expect(body.rollRegression.detail).toMatch(/could be CHECKED|could not be checked/);
    expect(body.rollRegression.detail).not.toContain('actually ran');
    // …and it is emphatically not settled on either. A mutation that replaces
    // the skip with `return settle(c)` names SHA_NEW as what shipped and
    // convicts the estate of a regression it was never shown to be in.
    expect(body.rollRegression.state).not.toBe('regressed');
    expect(body.rollRegression.rolledSha).toBeNull();
  });

  it('an id-less candidate is counted apart from the ones that WERE checked', async () => {
    // The mixed case: one run answered "no, I did not roll", one was never
    // asked. The message has to keep those two apart or it launders an unknown
    // into a measurement.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    const noId = rollRun(32225337321, SHA_NEW, '2026-08-19T06:50:00Z') as Record<string, unknown>;
    delete noId.id;
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z'), noId];
    JOBS['32225337320'] = { jobs: [{ name: ROLL_JOB, conclusion: 'skipped' }] };

    const body = await run();
    expect(jobsCalls().length).toBe(1);
    expect(body.rollRegression.state).toBe('unknown');
    expect(body.rollRegression.detail).toContain('none of the last 1');
    expect(body.rollRegression.detail).toContain('a further 1 carried no run id');
  });

  it('reads the WHOLE job list, not the first page of it', async () => {
    // per_page was 50 with no total_count check, so a green verdict could come
    // off a page that was never read: 50 non-roll jobs returned out of 60, the
    // route concludes "this run did not roll", settles on an older run, and
    // reports current/ok. Nothing pinned the bound — mutating it to per_page=1
    // survived 100/100 green — so it is pinned here BEHAVIOURALLY: the roll job
    // is the 60th of 60, and only a request that actually asks for the whole
    // list finds it. The stub paginates, so a narrower bound returns a
    // truncated page and this verdict changes.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [
      rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z'),
      rollRun(32220000000, SHA_OLD, '2026-08-19T05:59:00Z'),
    ];
    const filler = Array.from({ length: 59 }, (_, i) => ({ name: `matrix job ${i}`, conclusion: 'success' }));
    JOBS['32225337320'] = {
      jobs: [...filler, { name: ROLL_JOB, conclusion: 'success', completed_at: '2026-08-19T07:00:11Z' }],
    };

    const body = await run();
    expect(jobsCalls().length).toBe(1);
    expect(jobsCalls()[0]).toContain('per_page=100');
    // It found the roll job on the page it asked for, so the newest run IS the
    // effective roll and the estate is behind it.
    expect(body.rollRegression.state).toBe('regressed');
    expect(body.rollRegression.rolledSha).toBe(SHA_NEW);
  });

  it('a TRUNCATED job page is UNKNOWN — never a fall-through to an older roll', async () => {
    // The demonstrated failure, exactly: page 1 carries 50 non-roll jobs out of
    // a total_count of 60. Pre-fix the route read that as "this run did not
    // roll", settled on the older run naming what the estate happens to be
    // running, and returned state:'current', severity:'ok' — a green verdict
    // drawn from a page it never read. "I did not see it" is not "it is not
    // there" (deploy-integrity R7).
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [
      rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z'),
      rollRun(32220000000, SHA_OLD, '2026-08-19T05:59:00Z'),
    ];
    JOBS['32225337320'] = {
      total_count: 60,
      jobs: Array.from({ length: 50 }, (_, i) => ({ name: `matrix job ${i}`, conclusion: 'success' })),
    };
    JOBS['32220000000'] = { jobs: [{ name: ROLL_JOB, conclusion: 'success' }] };

    const body = await run();
    expect(body.rollRegression.state).toBe('unknown');
    expect(body.rollRegression.severity).toBe('warning');
    expect(body.rollRegression.state).not.toBe('current');
    expect(body.rollRegression.detail).toContain('NOT established');
    expect(body.rollRegression.detail).toContain('60');
    // And it stopped there — consulting the older run at all is the mistake.
    expect(jobsCalls().length).toBe(1);
    expect(jobsCalls().some((x) => x.includes('32220000000'))).toBe(false);
  });

  it('a job page with NO total_count is UNKNOWN too — an absent total is not proof of completeness', async () => {
    // THE SAME DEFECT, ONE BRANCH OVER. The truncation guard read
    // `total !== null && jobs.length < total`, so a 200 that carried `jobs` but
    // no `total_count` made `total` null, made the guard INERT, and fell through
    // to an older candidate — state:'current', severity:'ok', off a page whose
    // completeness was never established. Measured against this exact fixture
    // before the fix: `expected 'current' to be 'unknown'`.
    //
    // "GitHub always sends total_count" is not the standard this file holds
    // itself to six lines earlier, where `Array.isArray` is justified against
    // "a 200 carrying an unexpected shape (the rate-limit body, an error object,
    // the array GET /user/repos returns)". A body with `jobs` and no
    // `total_count` is a MORE likely malformation than `jobs` being an object,
    // and it is the only one of the family that failed to a false green rather
    // than to an honest unknown.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [
      rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z'),
      rollRun(32220000000, SHA_OLD, '2026-08-19T05:59:00Z'),
    ];
    JOBS['32225337320'] = 'NO_TOTAL_COUNT';
    // The older run WOULD settle it as `current` — that fall-through is the bug.
    JOBS['32220000000'] = { jobs: [{ name: ROLL_JOB, conclusion: 'success' }] };

    const body = await run();
    expect(body.rollRegression.state).toBe('unknown');
    expect(body.rollRegression.state).not.toBe('current');
    expect(body.rollRegression.severity).toBe('warning');
    expect(body.rollRegression.detail).toContain('NOT established');
    expect(body.rollRegression.detail).toContain('no total_count');
    // Stopped at the run it could not vouch for; never reached the older one.
    expect(jobsCalls().length).toBe(1);
    expect(jobsCalls().some((x) => x.includes('32220000000'))).toBe(false);
  });

  it('dates the roll from the roll STEP, not the job or the run — the 5m47s that makes a false red', async () => {
    // EVERY NUMBER BELOW IS READ FROM THE ACTIONS API for the incident run this
    // whole verdict was written for, loom-roll-and-validate 32225337320:
    //
    //   step "Roll Container App to new image"  07:04:42Z -> 07:05:14Z
    //   step "Wait for revision health"                   -> 07:06:09Z
    //   step "Purge Front Door"                           -> 07:06:47Z
    //   step "Validate live URL"                          -> 07:06:51Z
    //   step "Gate — in-VNet UAT"                         -> 07:10:58Z
    //   job  "Roll image + validate live URL"   completed_at 07:11:01Z
    //   run  updated_at                                      07:11:02Z
    //   estate revision 0000782 written         07:04:56Z  (inside the step)
    //
    // THE NAME AND BODY OF THIS TEST USED TO ASSERT 4m45s, "update 07:10:44, run
    // completed 07:15:30". Neither stamp exists in any run, job or step record of
    // that run, and the change it justified — run -> JOB — buys one second
    // (07:11:02 -> 07:11:01) on Commercial and zero on Gov, where run 32260846293
    // has a single job whose completion IS the run's (both 14:14:43Z). So the
    // fixture below is built from the real shape: an image stamped 07:08:00 is
    // genuinely NEWER than the 07:04:56 estate write, and only the STEP's stamp
    // gets that right. Dated from the job it reads `regressed` — the false red.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T07:08:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:11:02Z')];
    JOBS['32225337320'] = {
      jobs: [{
        name: ROLL_JOB,
        conclusion: 'success',
        completed_at: '2026-08-19T07:11:01Z',
        steps: [
          { name: 'Gate — the image must EXIST in ACR (unskippable)', conclusion: 'success', completed_at: '2026-08-19T06:55:43Z' },
          { name: ROLL_STEP, conclusion: 'success', completed_at: '2026-08-19T07:05:14Z' },
          { name: 'Wait for revision health', conclusion: 'success', completed_at: '2026-08-19T07:06:09Z' },
          { name: 'Gate — in-VNet UAT (loom-uat Container App Job)', conclusion: 'success', completed_at: '2026-08-19T07:10:58Z' },
        ],
      }],
    };

    const body = await run();
    expect(body.rollRegression.rolledAt).toBe('2026-08-19T07:05:14Z');
    expect(body.rollRegression.rolledAt).not.toBe('2026-08-19T07:11:01Z'); // the job
    expect(body.rollRegression.rolledAt).not.toBe('2026-08-19T07:11:02Z'); // the run
    // The verdict, not just the field: this is the deploy path working.
    expect(body.rollRegression.state).toBe('ahead');
    expect(body.rollRegression.severity).toBe('ok');
    expect(body.rollRegression.state).not.toBe('regressed');
  });

  it('CONTROL — the same fixture dated from the JOB is the false red', async () => {
    // Without this the test above could be passing because the fixture is
    // harmless rather than because the step is being read. Identical inputs, one
    // difference: no `steps[]`, so the route falls back to the job's completion —
    // the behaviour that shipped before — and the SAME estate image now reads
    // `regressed`. That is the 5m47s window measured on 32225337320 (roll step
    // 07:05:14Z -> job 07:11:01Z), and it is what makes the step selection
    // load-bearing rather than cosmetic.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T07:08:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:11:02Z')];
    JOBS['32225337320'] = {
      jobs: [{ name: ROLL_JOB, conclusion: 'success', completed_at: '2026-08-19T07:11:01Z' }],
    };

    const body = await run();
    expect(body.rollRegression.rolledAt).toBe('2026-08-19T07:11:01Z');
    expect(body.rollRegression.state).toBe('regressed');
  });

  it('a SKIPPED roll step does not date the roll — a step that declined to run wrote nothing', async () => {
    // `steps[].completed_at` is populated for skipped steps too, and it is the
    // instant the step declined rather than a write. Taking it would move
    // `rolledAt` arbitrarily early and manufacture `ahead` verdicts. The job's
    // completion is the honest fallback here.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T07:08:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:11:02Z')];
    JOBS['32225337320'] = {
      jobs: [{
        name: ROLL_JOB,
        conclusion: 'success',
        completed_at: '2026-08-19T07:11:01Z',
        steps: [{ name: ROLL_STEP, conclusion: 'skipped', completed_at: '2026-08-19T06:59:27Z' }],
      }],
    };

    const body = await run();
    expect(body.rollRegression.rolledAt).toBe('2026-08-19T07:11:01Z');
    expect(body.rollRegression.rolledAt).not.toBe('2026-08-19T06:59:27Z');
  });

  it('a RENAMED roll step degrades to the job stamp, never to UNKNOWN', async () => {
    // The contract test in lib/admin/__tests__ is what CATCHES a rename; this is
    // what happens meanwhile. Losing the verdict entirely over a step name would
    // be a worse failure than the coarser stamp that shipped before it.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:11:02Z')];
    JOBS['32225337320'] = {
      jobs: [{
        name: ROLL_JOB,
        conclusion: 'success',
        completed_at: '2026-08-19T07:11:01Z',
        steps: [{ name: 'Roll the Container App (renamed)', conclusion: 'success', completed_at: '2026-08-19T07:05:14Z' }],
      }],
    };

    const body = await run();
    expect(body.rollRegression.rolledAt).toBe('2026-08-19T07:11:01Z');
    expect(body.rollRegression.state).toBe('regressed');
    expect(body.rollRegression.state).not.toBe('unknown');
  });

  it('falls back to the run stamp when neither the step nor the job carries a completion time', async () => {
    // The job time is preferred, not required — a jobs payload without
    // completed_at must still produce a dated verdict rather than an UNKNOWN.
    MARKER = { sha: SHA_OLD, stamp: '2026-08-19T06:00:00Z' };
    ROLL_RUNS[ROLL_LANE] = [rollRun(32225337320, SHA_NEW, '2026-08-19T07:04:56Z')];
    JOBS['32225337320'] = { jobs: [{ name: ROLL_JOB, conclusion: 'success' }] };

    const body = await run();
    expect(body.rollRegression.rolledAt).toBe('2026-08-19T07:04:56Z');
    expect(body.rollRegression.state).toBe('regressed');
  });
});
