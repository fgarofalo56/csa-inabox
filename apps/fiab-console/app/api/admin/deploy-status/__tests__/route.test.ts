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

vi.mock('@/lib/updates/current-version', () => ({
  readBuildMarker: () => MARKER,
}));

vi.mock('@/lib/azure/cloud-endpoints', () => ({
  detectLoomCloud: () => 'commercial',
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

const HOST = 'https://api.github.com';

beforeEach(() => {
  MARKER = {};
  FETCHED = [];
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
      ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data }) as unknown as Response;

    if (/^\/repos\/[^/]+\/[^/]+\/compare\/[^/]+$/.test(p)) {
      return body({ status: 'identical', ahead_by: 0, behind_by: 0, commits: [] });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/runs$/.test(p)) {
      return body({ workflow_runs: [] });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+$/.test(p)) {
      return body({ state: 'active' });
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

/** Every fetched URL that is NOT one of the workflow-lane reads. */
function compareCalls(): string[] {
  return FETCHED.filter((u) => !u.includes('/actions/workflows/'));
}

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
      ]);
    });
  });

  it('an 8-char short sha still reaches the compare endpoint', async () => {
    // gov-console-roll / console-bluegreen-roll pass `git rev-parse --short=8`.
    MARKER = { sha: '0f50dad7' };
    await run();
    expect(compareCalls()).toEqual([
      `${HOST}/repos/fgarofalo56/csa-inabox/compare/0f50dad7...main`,
    ]);
  });

  it('a traversal payload in the marker issues NO request at all', async () => {
    MARKER = { sha: '../../../../user/repos' };
    await run();
    expect(compareCalls()).toEqual([]);
  });

  it('the disclosure payload issues NO request at all', async () => {
    // The query-terminated traversal: pre-fix this fetched /user/repos with the
    // console's own GitHub token attached.
    MARKER = { sha: '../../../../user/repos?x=' };
    await run();
    expect(compareCalls()).toEqual([]);
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

  it('still reports the no-sha case distinctly from the malformed case', async () => {
    // The two must not collapse into one message: "no fingerprint at all" and
    // "a fingerprint that is not a commit id" have different remediations.
    MARKER = {};
    const body = await run();
    expect(body.estate.headline).toBe('Running build is unidentified');
    expect(JSON.stringify(body)).toContain('no build fingerprint');
    expect(JSON.stringify(body)).not.toContain('does not carry a git object id');
    expect(compareCalls()).toEqual([]);
  });
});
