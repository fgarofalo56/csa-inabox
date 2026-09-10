/**
 * #3573 / `deploy-integrity.md` R7 — the ASA hint must ride the NOT-CONFIGURED
 * branch and NOTHING else, across EVERY route of the item type.
 *
 * WHY THIS FILE EXISTS (review of #4354): the fix originally landed in exactly
 * one of the ASA routes — `[name]/route.ts` — while the PR body claimed the
 * whole item type. Measured on the reviewed head, seven other routes still
 * attached
 *
 *   'Provision an ASA job (…stream-analytics.bicep) and set LOOM_ASA_RG…'
 *
 * to their GENERIC 502 catch. On a deployment where LOOM_ASA_RG is set
 * correctly, a 403 / throttle / DNS failure therefore told the operator to go
 * set an env var that was already set — a cause the code established nothing
 * about, which is the exact R7 failure this PR was opened to remove.
 *
 * Every case below drives the route with a generic ARM error and asserts the
 * response carries no remediation at all. The 501 counterpart is asserted too,
 * so "delete the hint everywhere" cannot pass this file either — the honest
 * gate must survive.
 *
 * ── WHY THE TARGET SET IS DERIVED, NOT LISTED ────────────────────────────────
 *
 * The first version of this file drove a HAND-MAINTAINED table of 8 entries over
 * 6 route modules, and the PR body claimed it covered the item type. It did not:
 * `[name]/test/route.ts` and `[name]/route.ts` were in neither the table nor the
 * import block, so re-injecting the deleted hint into `[name]/test/route.ts`
 * produced a byte-identical PASS. A guard that cannot go red on one of its own
 * declared targets is worse than no guard, because it is cited as proof.
 *
 * Adding the two missing rows would have been a NARROWER ENUMERATION — the next
 * ASA route added to this directory would be silently unguarded in exactly the
 * same way. So the population is instead WALKED OFF THE FILESYSTEM
 * (`the guarded set is DERIVED from the filesystem` below):
 *
 *   population   = every `route.ts` under this item type's directory;
 *   in scope     = those whose OWN SOURCE can reach the ASA remediation
 *                  vocabulary (`ASA_MARKER`) — i.e. those that could emit it;
 *   requirement  = every in-scope module has at least one driver in `ROUTES`;
 *   exemption    = only proven from the file's own bytes (an exempt module must
 *                  NOT match `ASA_MARKER`), never from a name list. Today the
 *                  single exempt module is `[name]/assist/route.ts`, the shared
 *                  Copilot-builder factory, which imports no ASA client at all —
 *                  and the moment it does, it joins the population and this file
 *                  goes red until it has a driver.
 *
 * FAIL-CLOSED: an empty population, an empty in-scope set, or a `ROUTES` entry
 * naming a module that is not on disk each FAIL. Zero discovered files means the
 * walk drifted, not that the item type is clean — the guard must report NOT-RUN
 * by failing, never by passing quietly.
 *
 * CRLF: every source file under `apps/fiab-console` is CRLF with zero bare LF,
 * and a line-oriented matcher no-ops against `\r`. `readSource()` strips CR
 * before anything looks at the text.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const H = vi.hoisted(() => {
  class AsaNotConfiguredError extends Error {
    missing: string[];
    constructor(m: string[]) {
      super(`Stream Analytics is not configured. Missing env: ${m.join(', ')}`);
      this.missing = m;
    }
  }
  class AsaJobNotFoundError extends Error {
    jobName: string; resourceGroup: string; subscriptionId: string;
    constructor(jobName: string, resourceGroup: string, subscriptionId: string) {
      super(`Stream Analytics job '${jobName}' does not exist in resource group '${resourceGroup}' (subscription ${subscriptionId}).`);
      this.jobName = jobName; this.resourceGroup = resourceGroup; this.subscriptionId = subscriptionId;
    }
  }
  class AsaTestNotAvailableError extends Error {
    hint: string;
    constructor(hint: string) {
      super('ASA sample-output Test Query is not available in this deployment.');
      this.hint = hint;
    }
  }
  return { AsaNotConfiguredError, AsaJobNotFoundError, AsaTestNotAvailableError };
});
const { AsaNotConfiguredError, AsaJobNotFoundError } = H;

const client = vi.hoisted(() => ({
  listJobs: vi.fn(),
  getJob: vi.fn(),
  saveTransformation: vi.fn(),
  createOrUpdateInput: vi.fn(),
  deleteInput: vi.fn(),
  createOrUpdateOutput: vi.fn(),
  deleteOutput: vi.fn(),
  startJob: vi.fn(),
  stopJob: vi.fn(),
  compileQuery: vi.fn(),
  testTransformation: vi.fn(),
}));

vi.mock('@/lib/azure/stream-analytics-client', () => ({
  ...client,
  AsaNotConfiguredError: H.AsaNotConfiguredError,
  AsaJobNotFoundError: H.AsaJobNotFoundError,
  AsaTestNotAvailableError: H.AsaTestNotAvailableError,
}));
vi.mock('@/lib/azure/monitor-client', () => ({ fetchMetrics: vi.fn(async () => []) }));
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

// `[name]/route.ts` reaches Cosmos and the Phase-2 provisioner on its 404 branch.
// Neither is reached on the 501/502 branches this file drives, but both must be
// mockable for the module to import at all.
const loadOwnedItem = vi.hoisted(() => vi.fn(async () => null as any));
vi.mock('../../_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => (loadOwnedItem as any)(...a) }));
vi.mock('@/lib/install/provisioners/stream-analytics-job', () => ({
  streamAnalyticsJobProvisioner: vi.fn(async () => ({ status: 'created' as const, steps: [] })),
  asaJobNameFor: (d: string) => ({ name: d.replace(/[^A-Za-z0-9_-]+/g, '-'), sanitized: true }),
}));
vi.mock('@/lib/install/provisioning-engine', () => ({ resolveTarget: () => ({ mode: 'shared' }) }));

import { GET as listGET } from '../route';
import { GET as detailGET } from '../[name]/route';
import { PUT as inputsPUT, DELETE as inputsDELETE } from '../[name]/inputs/route';
import { PUT as outputsPUT, DELETE as outputsDELETE } from '../[name]/outputs/route';
import { GET as metricsGET } from '../[name]/metrics/route';
import { PUT as queryPUT } from '../[name]/query/route';
import { POST as statePOST } from '../[name]/state/route';
import { POST as testPOST } from '../[name]/test/route';
import { getSession } from '@/lib/auth/session';

const SESSION = { claims: { oid: 'oid-1' } } as any;
const params = { params: Promise.resolve({ name: 'orders-stream' }) };
/** The list route takes no `[name]` segment — route-toolkit still hands it a ctx. */
const noParams = { params: Promise.resolve({}) } as any;

/** A 403 on a deployment whose ASA env vars are set correctly. */
const ARM_403 = () => new Error('ASA get failed 403: AuthorizationFailed');

function jsonReq(body: unknown, url = 'https://loom.test/x') {
  return { url, json: async () => body, nextUrl: new URL(url) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  loadOwnedItem.mockResolvedValue(null);
});

/**
 * `module` -> the route file this row drives, relative to the item-type
 * directory, in POSIX form. It is what the filesystem-derivation block below
 * matches its walk against, so a row cannot claim coverage of a file that is
 * not there and a file cannot escape by not being listed.
 *
 * `run` -> drive the route so its client call rejects with `err`, returning the
 * Response, so one table drives both the 502 and the 501 assertions.
 */
const ROUTES: Array<{ name: string; module: string; run: (err: Error) => Promise<Response> }> = [
  {
    name: 'GET /stream-analytics-job (list)',
    module: 'route.ts',
    run: async (err) => { client.listJobs.mockRejectedValue(err); return (await listGET(jsonReq(null), noParams)) as any; },
  },
  {
    name: 'GET /[name] (detail)',
    module: '[name]/route.ts',
    run: async (err) => { client.getJob.mockRejectedValue(err); return (await detailGET(jsonReq(null), params)) as any; },
  },
  {
    name: 'PUT /[name]/inputs',
    module: '[name]/inputs/route.ts',
    run: async (err) => {
      client.createOrUpdateInput.mockRejectedValue(err);
      return (await inputsPUT(
        jsonReq({ name: 'in1', inputType: 'Stream', datasourceType: 'Microsoft.EventHub/EventHub', serialization: 'Json' }),
        params,
      )) as any;
    },
  },
  {
    name: 'DELETE /[name]/inputs',
    module: '[name]/inputs/route.ts',
    run: async (err) => {
      client.deleteInput.mockRejectedValue(err);
      return (await inputsDELETE(jsonReq(null, 'https://loom.test/x?inputName=in1'), params)) as any;
    },
  },
  {
    name: 'PUT /[name]/outputs',
    module: '[name]/outputs/route.ts',
    run: async (err) => {
      client.createOrUpdateOutput.mockRejectedValue(err);
      return (await outputsPUT(
        jsonReq({ name: 'out1', datasourceType: 'Microsoft.Storage/Blob' }),
        params,
      )) as any;
    },
  },
  {
    name: 'DELETE /[name]/outputs',
    module: '[name]/outputs/route.ts',
    run: async (err) => {
      client.deleteOutput.mockRejectedValue(err);
      return (await outputsDELETE(jsonReq(null, 'https://loom.test/x?outputName=out1'), params)) as any;
    },
  },
  {
    name: 'GET /[name]/metrics',
    module: '[name]/metrics/route.ts',
    run: async (err) => { client.getJob.mockRejectedValue(err); return (await metricsGET({} as any, params)) as any; },
  },
  {
    name: 'PUT /[name]/query',
    module: '[name]/query/route.ts',
    run: async (err) => {
      client.saveTransformation.mockRejectedValue(err);
      return (await queryPUT(jsonReq({ query: 'SELECT 1' }), params)) as any;
    },
  },
  {
    name: 'POST /[name]/state',
    module: '[name]/state/route.ts',
    run: async (err) => {
      client.startJob.mockRejectedValue(err);
      return (await statePOST(jsonReq({ action: 'start' }), params)) as any;
    },
  },
  {
    name: 'POST /[name]/test',
    module: '[name]/test/route.ts',
    // Default `mode` is 'compile', so `compileQuery` is the call that rejects.
    run: async (err) => {
      client.compileQuery.mockRejectedValue(err);
      return (await testPOST(jsonReq({ query: 'SELECT 1' }), params)) as any;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The population, walked off disk.
// ─────────────────────────────────────────────────────────────────────────────

const ITEM_TYPE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A route module is IN SCOPE when its own source can reach the ASA remediation
 * vocabulary — either by importing the client that throws `AsaNotConfiguredError`
 * or by naming the env var / bicep flag the deleted hint asserted. Keyed to what
 * makes the defect POSSIBLE, not to the deleted string: the fix removes
 * `hint: HINT`, so a rule keyed to that would go quiet on the files it just
 * certified.
 */
const ASA_MARKER = /stream-analytics-client|LOOM_ASA_RG|enableStreamAnalytics/;

/** Console sources are CRLF; strip CR before anything reads the text. */
function readSource(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

function walkRouteModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkRouteModules(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ITEM_TYPE_DIR, f).split(path.sep).join('/');

describe('the guarded set is DERIVED from the filesystem, not hand-listed', () => {
  const discovered = walkRouteModules(ITEM_TYPE_DIR).map(rel).sort();
  const inScope = discovered.filter((m) => ASA_MARKER.test(readSource(path.join(ITEM_TYPE_DIR, m))));
  const driven = new Set(ROUTES.map((r) => r.module));

  it('the walk found route modules at all — an empty population is NOT-RUN, not clean', () => {
    expect(discovered.length).toBeGreaterThan(0);
  });

  it('the ASA marker matched something — a matcher that matches zero is NOT-RUN', () => {
    expect(inScope.length).toBeGreaterThan(0);
  });

  it('every ASA-reaching route module has at least one driver in ROUTES', () => {
    // `toEqual([])` prints the offenders by path, which is the whole point:
    // the failure names the route nobody is watching.
    expect(inScope.filter((m) => !driven.has(m))).toEqual([]);
  });

  it('every ROUTES row names a module that is actually on disk', () => {
    const ghosts = [...driven].filter((m) => !existsSync(path.join(ITEM_TYPE_DIR, m)));
    expect(ghosts).toEqual([]);
  });

  it('every UNDRIVEN module is proven exempt by its own bytes, never by a name list', () => {
    const undriven = discovered.filter((m) => !driven.has(m));
    for (const m of undriven) {
      // If this ever fails, the module started reaching the ASA vocabulary and
      // must gain a driver above — the exemption is not a name, it is a fact
      // about the file.
      expect({ module: m, reachesAsaVocabulary: ASA_MARKER.test(readSource(path.join(ITEM_TYPE_DIR, m))) })
        .toEqual({ module: m, reachesAsaVocabulary: false });
    }
  });
});

describe('every ASA route: a generic 502 asserts NO cause (R7)', () => {
  for (const { name, run } of ROUTES) {
    it(`${name} — 502 carries no LOOM_ASA_RG remediation`, async () => {
      const r = await run(ARM_403());
      const j = await r.json();
      expect(r.status).toBe(502);
      expect(j.ok).toBe(false);
      // The ARM error itself must survive — an honest 502 still says what failed.
      expect(String(j.error)).toContain('403');
      // …but it must not assert a cause the code never established.
      expect(j.hint).toBeUndefined();
      expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
      expect(JSON.stringify(j)).not.toContain('enableStreamAnalytics');
    });
  }
});

describe('every ASA route: the 501 honest gate SURVIVES', () => {
  for (const { name, run } of ROUTES) {
    it(`${name} — 501 still names the env vars`, async () => {
      const r = await run(new AsaNotConfiguredError(['LOOM_ASA_RG (or LOOM_DLZ_RG)']));
      const j = await r.json();
      expect(r.status).toBe(501);
      expect(j.hint).toContain('LOOM_ASA_RG');
    });
  }
});

describe('metrics tells a missing job apart from an unclassified failure', () => {
  it('404 + asa-job-not-provisioned, with no env-var remediation', async () => {
    client.getJob.mockRejectedValue(new AsaJobNotFoundError('orders-stream', 'rgAsa', 'sub1'));
    const r = (await metricsGET({} as any, params)) as any;
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.code).toBe('asa-job-not-provisioned');
    expect(j.hint).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
  });

  it('a job with no ARM resource id is a 502 that asserts nothing', async () => {
    client.getJob.mockResolvedValue({ name: 'orders-stream', id: '', location: 'eastus2' });
    const r = (await metricsGET({} as any, params)) as any;
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.hint).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
  });
});
