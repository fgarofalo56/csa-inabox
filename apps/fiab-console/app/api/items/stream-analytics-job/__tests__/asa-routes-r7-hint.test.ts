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
 *   population   = every Next.js route module under this item type's directory;
 *   in scope     = those that can REACH the ASA remediation vocabulary
 *                  (`ASA_MARKER`) through a bounded import closure — i.e. those
 *                  that could emit it;
 *   requirement  = every in-scope module has at least one driver in `ROUTES`;
 *   exemption    = only proven from source, never from a name list. Today the
 *                  single exempt module is `[name]/assist/route.ts`, the shared
 *                  Copilot-builder factory, which reaches no ASA vocabulary at
 *                  any depth — and the moment it does, it joins the population
 *                  and this file goes red until it has a driver.
 *
 * ── THE THREE ESCAPES THE ROUND-4 REVIEW FOUND, AND WHAT CLOSES EACH ─────────
 *
 * The reviewer ran five mutations against the previous version of this file.
 * Two survived. Both are closed here, at the mechanism rather than by adding a
 * row (a narrower enumeration is not a fix):
 *
 * MUT-A — "the derivation trusts the row's `module` LABEL, not the module the
 *   row actually drives". `ROUTES[i].module` used to be a hand-written string
 *   sitting next to a `run` that closed over a STATICALLY IMPORTED handler.
 *   Nothing coupled the two, so repointing `[name]/test`'s `run` at `queryPUT`
 *   and re-injecting the hint into `[name]/test/route.ts` was byte-identically
 *   green — the row still swore it covered a module it no longer touched.
 *   CLOSED BY DELETING THE HANDLE: there are no static handler imports left.
 *   A row names a `module` path and an HTTP `method`, and `loadHandler()`
 *   resolves the function by DYNAMICALLY IMPORTING THAT PATH. The driven module
 *   is derived from the label rather than merely compared to it, so the two
 *   cannot disagree. Relabelling a row now moves the coverage with it, and the
 *   module it left behind is reported by the undriven-module assertion.
 *
 * MUT-B — "a route can leave the population by INDIRECTING". The in-scope
 *   predicate read only the file's OWN bytes, so a new route that reached the
 *   client through a local helper and emitted its remediation from an imported
 *   `ASA_HINT` const was discovered by the walk, excluded from scope, and then
 *   "proven exempt" by the same marker that had just excluded it. This is not
 *   hypothetical: this PR created SEVEN identical copies of the same HINT
 *   literal, which is exactly the pressure that produces a shared `_hint.ts`.
 *   CLOSED BY FOLLOWING THE INDIRECTION: `reachesAsaVocabulary()` walks the
 *   first-party import closure to `MAX_IMPORT_DEPTH`, and FAILS CLOSED — a
 *   first-party specifier that does not resolve to a file on disk, or a file
 *   that cannot be read, puts the entry module IN SCOPE rather than out of it.
 *   The predicate itself is exercised against a virtual source tree below
 *   (`the in-scope predicate FOLLOWS INDIRECTION`), so a later edit that
 *   reverts it to own-bytes-only goes red on its own controls, not silently.
 *
 * MUT-D — a filter INSIDE the walk predicate (`entry === 'test'` -> `continue`)
 *   combined with a relabelled row. This one was CAUGHT by the previous version,
 *   because the driver layer still called the real `[name]/test` handler — but
 *   MUT-A's fix removes that accident (a relabelled row now drives the module it
 *   names), so the walk needed a real second instrument rather than a lucky one.
 *   CLOSED BY MEASURING THE POPULATION TWICE, WITH DIFFERENT TOOLS: the walk is
 *   cross-checked against `docs/fiab/route-inventory.md`, a GENERATED artifact
 *   produced by `scripts/ci/generate-route-inventory.mjs` and held to the tree by
 *   its own `--check` drift gate in CI. Every route the inventory lists for this
 *   item type must be found by the walk. A filter inside the walk therefore has
 *   to be paired with an edit to a generated file that a different gate
 *   regenerates — which is a much louder edit than a `continue`. Measured
 *   2026-09-10: the `mut-d-filter-inside-the-walk-predicate` arm fires BOTH the
 *   inventory cross-check (`expected [ '[name]/test/route.ts' ] to deeply equal []`)
 *   and the in-scope floor (`expected 7 to be greater than or equal to 8`).
 *
 * FAIL-CLOSED: an empty population, an empty in-scope set, an in-scope set that
 * has SHRUNK below its recorded floor, a `ROUTES` row naming a module that is
 * not on disk, and a `ROUTES` row naming a method its module does not export
 * each FAIL. Zero discovered files means the walk drifted, not that the item
 * type is clean — the guard must report NOT-RUN by failing, never by passing
 * quietly. The floor exists because fail-closed-at-zero is silent about a
 * population that shrinks by ONE, which is the realistic shape.
 *
 * CRLF: every source file under `apps/fiab-console` is CRLF with zero bare LF,
 * and a line-oriented matcher no-ops against `\r`. `readSource()` strips CR
 * before anything looks at the text.
 *
 * MUTATION HARNESS: `__tests__/mutation/` in this directory, IN THE DIFF — the
 * round-4 reviewer could not verify the previous harness because it lived only
 * on the author's machine. `node app/api/items/stream-analytics-job/__tests__/mutation/run-arms.mjs`
 * from `apps/fiab-console` replays every arm above, including the two that
 * survived, and reports NEEDLE-MISSED as its own outcome so a CRLF-blind needle
 * cannot read as a catch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// mockable for the module to import at all. These specifiers are resolved
// relative to THIS file and are therefore unaffected by the dynamic import below
// — `../../_lib/item-crud` is the same absolute module either way.
const loadOwnedItem = vi.hoisted(() => vi.fn(async () => null as any));
vi.mock('../../_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => (loadOwnedItem as any)(...a) }));
vi.mock('@/lib/install/provisioners/stream-analytics-job', () => ({
  streamAnalyticsJobProvisioner: vi.fn(async () => ({ status: 'created' as const, steps: [] })),
  asaJobNameFor: (d: string) => ({ name: d.replace(/[^A-Za-z0-9_-]+/g, '-'), sanitized: true }),
}));
vi.mock('@/lib/install/provisioning-engine', () => ({ resolveTarget: () => ({ mode: 'shared' }) }));

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

// ─────────────────────────────────────────────────────────────────────────────
// Paths.
// ─────────────────────────────────────────────────────────────────────────────

/** …/apps/fiab-console/app/api/items/stream-analytics-job */
const ITEM_TYPE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** …/apps/fiab-console — the root the `@/` alias resolves against. */
const CONSOLE_ROOT = path.resolve(ITEM_TYPE_DIR, '..', '..', '..', '..');
/** Repo root, for the generated route inventory. */
const REPO_ROOT = path.resolve(CONSOLE_ROOT, '..', '..');
const ROUTE_INVENTORY = path.join(REPO_ROOT, 'docs', 'fiab', 'route-inventory.md');
/** How the inventory spells this item type's routes (relative to `app/api`). */
const INVENTORY_PREFIX = 'items/stream-analytics-job/';

/** Console sources are CRLF; strip CR before anything reads the text. */
function readSource(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

const rel = (f: string) => path.relative(ITEM_TYPE_DIR, f).split(path.sep).join('/');

// ─────────────────────────────────────────────────────────────────────────────
// Driving a route — the module is DERIVED from the row's label, not compared
// to it. See MUT-A in the header.
// ─────────────────────────────────────────────────────────────────────────────

type RouteHandler = (req: any, ctx: any) => Promise<Response>;
type HttpMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

const moduleCache = new Map<string, Record<string, unknown>>();

/**
 * Import the route module AT THE PATH THE ROW NAMES.
 *
 * This is the whole coupling. A static `import { POST } from '../[name]/test/route'`
 * next to a hand-written `module: '[name]/test/route.ts'` is two independent
 * facts that a one-token edit can put out of agreement (MUT-A). Here there is
 * one fact: the path. `/* @vite-ignore *\/` is required because the specifier is
 * computed — vitest resolves it at runtime and `vi.mock` still applies, since
 * the mocks above are registered against absolute module ids.
 */
async function loadRouteModule(moduleRel: string): Promise<Record<string, unknown>> {
  const cached = moduleCache.get(moduleRel);
  if (cached) return cached;
  const abs = path.join(ITEM_TYPE_DIR, moduleRel);
  if (!existsSync(abs)) {
    throw new Error(`ROUTES names '${moduleRel}', which is not on disk under ${ITEM_TYPE_DIR}`);
  }
  const mod = (await import(/* @vite-ignore */ pathToFileURL(abs).href)) as Record<string, unknown>;
  moduleCache.set(moduleRel, mod);
  return mod;
}

async function loadHandler(moduleRel: string, method: HttpMethod): Promise<RouteHandler> {
  const mod = await loadRouteModule(moduleRel);
  const handler = mod[method];
  if (typeof handler !== 'function') {
    throw new Error(
      `ROUTES claims ${method} on '${moduleRel}', but that module exports ` +
        `[${Object.keys(mod).join(', ')}] — a row cannot drive a method its module does not have`,
    );
  }
  return handler as RouteHandler;
}

/**
 * A driver row.
 *
 * `module` + `method` SELECT the handler (see `loadHandler`); `arrange` makes
 * the underlying client call reject with `err`; `invoke` supplies the request
 * shape. `invoke` receives the handler — it never names one — so the row cannot
 * drive a module other than the one it declares.
 */
interface RouteDriver {
  name: string;
  module: string;
  method: HttpMethod;
  arrange: (err: Error) => void;
  invoke: (handler: RouteHandler) => Promise<Response>;
}

const ROUTES: RouteDriver[] = [
  {
    name: 'GET /stream-analytics-job (list)',
    module: 'route.ts',
    method: 'GET',
    arrange: (err) => { client.listJobs.mockRejectedValue(err); },
    invoke: (h) => h(jsonReq(null), noParams),
  },
  {
    name: 'GET /[name] (detail)',
    module: '[name]/route.ts',
    method: 'GET',
    arrange: (err) => { client.getJob.mockRejectedValue(err); },
    invoke: (h) => h(jsonReq(null), params),
  },
  {
    name: 'PUT /[name]/inputs',
    module: '[name]/inputs/route.ts',
    method: 'PUT',
    arrange: (err) => { client.createOrUpdateInput.mockRejectedValue(err); },
    invoke: (h) => h(
      jsonReq({ name: 'in1', inputType: 'Stream', datasourceType: 'Microsoft.EventHub/EventHub', serialization: 'Json' }),
      params,
    ),
  },
  {
    name: 'DELETE /[name]/inputs',
    module: '[name]/inputs/route.ts',
    method: 'DELETE',
    arrange: (err) => { client.deleteInput.mockRejectedValue(err); },
    invoke: (h) => h(jsonReq(null, 'https://loom.test/x?inputName=in1'), params),
  },
  {
    name: 'PUT /[name]/outputs',
    module: '[name]/outputs/route.ts',
    method: 'PUT',
    arrange: (err) => { client.createOrUpdateOutput.mockRejectedValue(err); },
    invoke: (h) => h(jsonReq({ name: 'out1', datasourceType: 'Microsoft.Storage/Blob' }), params),
  },
  {
    name: 'DELETE /[name]/outputs',
    module: '[name]/outputs/route.ts',
    method: 'DELETE',
    arrange: (err) => { client.deleteOutput.mockRejectedValue(err); },
    invoke: (h) => h(jsonReq(null, 'https://loom.test/x?outputName=out1'), params),
  },
  {
    name: 'GET /[name]/metrics',
    module: '[name]/metrics/route.ts',
    method: 'GET',
    arrange: (err) => { client.getJob.mockRejectedValue(err); },
    invoke: (h) => h({} as any, params),
  },
  {
    name: 'PUT /[name]/query',
    module: '[name]/query/route.ts',
    method: 'PUT',
    arrange: (err) => { client.saveTransformation.mockRejectedValue(err); },
    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),
  },
  {
    name: 'POST /[name]/state',
    module: '[name]/state/route.ts',
    method: 'POST',
    arrange: (err) => { client.startJob.mockRejectedValue(err); },
    invoke: (h) => h(jsonReq({ action: 'start' }), params),
  },
  {
    name: 'POST /[name]/test',
    module: '[name]/test/route.ts',
    method: 'POST',
    // Default `mode` is 'compile', so `compileQuery` is the call that rejects.
    arrange: (err) => { client.compileQuery.mockRejectedValue(err); },
    invoke: (h) => h(jsonReq({ query: 'SELECT 1' }), params),
  },
];

/**
 * Drive one row end to end: resolve the handler from the row's OWN label, hand
 * it in through a probe, and refuse the result unless the row really used it.
 *
 * The probe is the second half of MUT-A's closure. Resolving the handler from
 * `module` is not enough on its own — an `invoke` that ignores its argument and
 * calls some other module's handler directly would still see a plausible 502.
 * So two facts are asserted about every drive:
 *
 *   1. the resolved handler was called EXACTLY ONCE, and
 *   2. the Response the test then asserts on is the IDENTICAL object that
 *      handler produced — which also rules out "call it, discard it, return
 *      someone else's response".
 *
 * Together those make "the row drove the module it names" a measured fact
 * rather than a hand-written label.
 */
async function driveWith(row: RouteDriver, arrange: () => void): Promise<Response> {
  const handler = await loadHandler(row.module, row.method);
  let calls = 0;
  const produced: Response[] = [];
  const probe: RouteHandler = async (req, ctx) => {
    calls += 1;
    const res = await handler(req, ctx);
    produced.push(res);
    return res;
  };
  arrange();
  const res = await row.invoke(probe);
  if (calls !== 1) {
    throw new Error(
      `${row.name}: invoke() called the handler resolved from '${row.module}' ${calls} time(s), ` +
        'not once — the row drove something other than the module it names',
    );
  }
  if (!produced.includes(res)) {
    throw new Error(
      `${row.name}: the Response under assertion was NOT produced by the ${row.method} handler of ` +
        `'${row.module}' — the row is asserting against a different module's response`,
    );
  }
  return res;
}

/** Drive one row with its client call rejecting. */
function drive(row: RouteDriver, err: Error): Promise<Response> {
  return driveWith(row, () => row.arrange(err));
}

// ─────────────────────────────────────────────────────────────────────────────
// The population, walked off disk.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A module is IN SCOPE when it can REACH the ASA remediation vocabulary —
 * either by importing the client that throws `AsaNotConfiguredError` or by
 * naming the env var / bicep flag the deleted hint asserted. Keyed to what makes
 * the defect POSSIBLE, not to the deleted string: the fix removes `hint: HINT`,
 * so a rule keyed to that would go quiet on the files it just certified.
 */
const ASA_MARKER = /stream-analytics-client|LOOM_ASA_RG|enableStreamAnalytics/;

/**
 * Next.js accepts any of these as a route handler module. The previous version
 * collected `route.ts` only, so a `route.tsx` carrying the identical defect was
 * invisible (round-4 NIT 6). `git ls-files 'apps/fiab-console/app/**\/route.tsx'`
 * returns 0 today — this is not fixing a live escape, it is refusing to have one
 * available.
 */
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Extensions a first-party specifier may resolve through. */
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * How far the import closure is followed.
 *
 * MEASURED 2026-09-10 at this head, over all 9 route modules of this item type:
 * the in-scope/exempt split is 8/1 at depth 0, 1, 2, 3 AND 4 — `[name]/assist`
 * reaches no ASA vocabulary even at depth 4 (21 modules visited), and every
 * other route reaches `lib/azure/stream-analytics-client.ts` by depth 1 (depth 2
 * for `[name]/route.ts`, which goes through the provisioner). So the exemption
 * is not an artifact of a tight bound, and the bound is not an artifact of a
 * lucky tree. 2 is chosen because it covers route -> local helper -> client,
 * which is the MUT-B shape, while keeping the closure small enough to read.
 */
const MAX_IMPORT_DEPTH = 2;

/**
 * Every module specifier a source file imports, however it spells it: static
 * `import`/`export … from`, bare side-effect `import 'x'`, and dynamic
 * `import('x')` with a literal.
 *
 * The `from` pattern spans lines on purpose — this repo's route files use
 * multi-line named-import blocks. Over-matching can only make the closure WIDER,
 * i.e. put more modules in scope, which is the fail-closed direction.
 */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

/**
 * What the closure walks over. Injectable so the predicate can be exercised
 * against a VIRTUAL source tree below — the round-4 review's point that an
 * exemption "proven" by the same marker that produced it proves nothing.
 */
interface SourceWorld {
  /** Source text, or `null` when the file cannot be read. */
  read(file: string): string | null;
  /**
   * `firstParty` false -> a package (`next/server`, `zod`), not followed.
   * `firstParty` true with `file: null` -> a first-party specifier that does NOT
   * resolve, which is the fail-closed case.
   */
  resolve(spec: string, fromFile: string): { firstParty: boolean; file: string | null };
}

const DISK: SourceWorld = {
  read(file) {
    try { return readSource(file); } catch { return null; }
  },
  resolve(spec, fromFile) {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(CONSOLE_ROOT, spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else return { firstParty: false, file: null };
    const candidates = [
      base,
      ...RESOLVE_EXTS.map((e) => base + e),
      ...RESOLVE_EXTS.map((e) => path.join(base, 'index' + e)),
    ];
    for (const c of candidates) {
      try { if (statSync(c).isFile()) return { firstParty: true, file: c }; } catch { /* next candidate */ }
    }
    return { firstParty: true, file: null };
  },
};

/**
 * Can `entry` reach the ASA remediation vocabulary?
 *
 * FAILS CLOSED in both directions that matter: an unreadable file and an
 * unresolvable first-party specifier both answer `true`. "I could not establish
 * that this module is clean" is not the same fact as "this module is clean", and
 * R7 is the rule that says so.
 */
function reachesAsaVocabulary(entry: string, world: SourceWorld = DISK, maxDepth = MAX_IMPORT_DEPTH): boolean {
  const seen = new Set<string>();
  const stack: Array<{ file: string; depth: number }> = [{ file: entry, depth: 0 }];
  while (stack.length > 0) {
    const { file, depth } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = world.read(file);
    if (src === null) return true; // unreadable -> cannot be proven clean
    if (ASA_MARKER.test(src)) return true;
    if (depth >= maxDepth) continue;
    for (const spec of importSpecifiers(src)) {
      const r = world.resolve(spec, file);
      if (!r.firstParty) continue;
      if (r.file === null) return true; // unresolvable first-party -> cannot be proven clean
      stack.push({ file: r.file, depth: depth + 1 });
    }
  }
  return false;
}

function walkRouteModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkRouteModules(full));
    else if (ROUTE_FILE.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The SECOND, independent measurement of the population (MUT-D).
 *
 * `docs/fiab/route-inventory.md` is generated by
 * `scripts/ci/generate-route-inventory.mjs` and held to the tree by that
 * script's own `--check` drift gate. Reading it here means the walk is compared
 * against a number produced by different code, on a different pass, enforced by
 * a different gate — rather than against a constant this file could be edited to
 * agree with.
 */
function inventoryRoutesForItemType(): string[] {
  const src = readSource(ROUTE_INVENTORY);
  // A row of the generated table: | `items/stream-analytics-job/[name]/query/route.ts` | PUT | …
  // The trailing slash in the prefix is what stops a sibling item type whose
  // name merely starts the same way from being counted here.
  const re = /^\|\s*`([^`]+)`/gm;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1].startsWith(INVENTORY_PREFIX)) out.add(m[1].slice(INVENTORY_PREFIX.length));
  }
  return [...out].sort();
}

/**
 * The in-scope FLOOR.
 *
 * Fail-closed-at-zero is silent about the realistic failure: a population that
 * shrinks by ONE. Nine route modules are on disk; eight reach the ASA
 * vocabulary; `[name]/assist/route.ts` does not (measured 2026-09-10, and at
 * every closure depth 0..4).
 *
 * RAISE this when a route joins. LOWERING it is a deliberate act that must be
 * justified in the PR that does it — which is the point: narrowing `ASA_MARKER`,
 * or deleting a route's ASA usage, now costs an edit to a number with a reason
 * attached instead of passing in silence.
 */
const IN_SCOPE_FLOOR = 8;

describe('the guarded set is DERIVED from the filesystem, not hand-listed', () => {
  const discovered = walkRouteModules(ITEM_TYPE_DIR).map(rel).sort();
  const inScope = discovered.filter((m) => reachesAsaVocabulary(path.join(ITEM_TYPE_DIR, m)));
  const driven = new Set(ROUTES.map((r) => r.module));

  it('the walk found route modules at all — an empty population is NOT-RUN, not clean', () => {
    expect(discovered.length).toBeGreaterThan(0);
  });

  it('the ASA marker matched something — a matcher that matches zero is NOT-RUN', () => {
    expect(inScope.length).toBeGreaterThan(0);
  });

  it('the in-scope set has not SHRUNK below its recorded floor', () => {
    // The message carries the surviving modules, so a failure names what is left
    // rather than only reporting a smaller number.
    expect(
      inScope.length,
      `in-scope modules still found: [${inScope.join(', ')}] — if a route legitimately ` +
        'stopped reaching the ASA vocabulary, lower IN_SCOPE_FLOOR deliberately and say why',
    ).toBeGreaterThanOrEqual(IN_SCOPE_FLOOR);
  });

  it('every route the GENERATED inventory lists for this item type was found by the walk', () => {
    const fromInventory = inventoryRoutesForItemType();
    // The inventory is the independent instrument, so it must not be empty
    // either — a parse that matches nothing would make this assertion vacuous.
    expect(fromInventory.length).toBeGreaterThan(0);
    expect(fromInventory.filter((m) => !discovered.includes(m))).toEqual([]);
  });

  it('every ASA-reaching route module has at least one driver in ROUTES', () => {
    // `toEqual([])` prints the offenders by path, which is the whole point:
    // the failure names the route nobody is watching.
    expect(inScope.filter((m) => !driven.has(m))).toEqual([]);
  });

  it('every ROUTES row names a module that is actually on disk AND was walked', () => {
    const ghosts = [...driven].filter((m) => !existsSync(path.join(ITEM_TYPE_DIR, m)) || !discovered.includes(m));
    expect(ghosts).toEqual([]);
  });

  it('every ROUTES row resolves its handler from the module it names', async () => {
    // This is MUT-A's grave. The row declares `module` + `method`; the handler
    // comes back from importing THAT path. A row that names a method its module
    // does not export throws here rather than silently driving something else.
    const resolved: string[] = [];
    for (const row of ROUTES) {
      const handler = await loadHandler(row.module, row.method);
      expect(typeof handler).toBe('function');
      resolved.push(`${row.method} ${row.module}`);
    }
    expect(resolved.length).toBe(ROUTES.length);
  });

  it('every UNDRIVEN module is proven exempt by SOURCE, never by a name list', () => {
    const undriven = discovered.filter((m) => !driven.has(m));
    for (const m of undriven) {
      // If this ever fails, the module started reaching the ASA vocabulary —
      // directly or through an import — and must gain a driver above. The
      // exemption is not a name, it is a fact about the source.
      expect({ module: m, reachesAsaVocabulary: reachesAsaVocabulary(path.join(ITEM_TYPE_DIR, m)) })
        .toEqual({ module: m, reachesAsaVocabulary: false });
    }
  });
});

describe('the in-scope predicate FOLLOWS INDIRECTION and fails closed', () => {
  // A virtual source tree. These controls exist because the round-4 reviewer's
  // MUT-B was green precisely BECAUSE the exemption was proven with the same
  // matcher that produced it — so the matcher itself needs a test that does not
  // depend on the real tree happening to be arranged conveniently.
  function virtualWorld(files: Record<string, string>): SourceWorld {
    return {
      read: (f) => (f in files ? files[f] : null),
      resolve: (spec, fromFile) => {
        if (!spec.startsWith('.') && !spec.startsWith('@/')) return { firstParty: false, file: null };
        const base = spec.startsWith('@/')
          ? `/root/${spec.slice(2)}`
          : path.posix.resolve(path.posix.dirname(fromFile), spec);
        for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (c in files) return { firstParty: true, file: c };
        return { firstParty: true, file: null };
      },
    };
  }

  it('MUT-B: a route reaching the client through a HELPER is in scope', () => {
    const world = virtualWorld({
      '/root/app/scale/route.ts':
        "import { NextResponse } from 'next/server';\n" +
        "import { ASA_HINT } from '../_hint';\n" +
        "import { getJob } from '../_asa';\n" +
        'export const POST = async () => NextResponse.json({ ok: false, hint: ASA_HINT }, { status: 502 });\n',
      '/root/app/_hint.ts': "export const ASA_HINT = 'Provision an ASA job … and set LOOM_ASA_RG.';\n",
      '/root/app/_asa.ts': "export { getJob } from '@/lib/azure/stream-analytics-client';\n",
    });
    // The route's OWN bytes carry none of the marker vocabulary — that is the
    // premise of the escape, asserted rather than assumed.
    expect(ASA_MARKER.test(world.read('/root/app/scale/route.ts') as string)).toBe(false);
    expect(reachesAsaVocabulary('/root/app/scale/route.ts', world)).toBe(true);
  });

  it('a route that reaches nothing ASA-flavoured is NOT dragged in', () => {
    const world = virtualWorld({
      '/root/app/assist/route.ts':
        "import { makeCopilotBuilderRoute } from '../../_lib/copilot';\nexport const POST = makeCopilotBuilderRoute({});\n",
      '/root/_lib/copilot.ts': "export const makeCopilotBuilderRoute = (c: unknown) => async () => new Response('x');\n",
    });
    expect(reachesAsaVocabulary('/root/app/assist/route.ts', world)).toBe(false);
  });

  it('an UNRESOLVABLE first-party import fails CLOSED — in scope, not out', () => {
    const world = virtualWorld({
      '/root/app/scale/route.ts': "import { thing } from '../_gone';\nexport const POST = async () => new Response('x');\n",
    });
    expect(reachesAsaVocabulary('/root/app/scale/route.ts', world)).toBe(true);
  });

  it('an UNREADABLE module fails CLOSED — in scope, not out', () => {
    expect(reachesAsaVocabulary('/root/nope/route.ts', virtualWorld({}))).toBe(true);
  });

  it('a third-party package is not followed and does not make a route in scope', () => {
    const world = virtualWorld({
      '/root/app/x/route.ts': "import { NextResponse } from 'next/server';\nexport const GET = async () => NextResponse.json({});\n",
    });
    expect(reachesAsaVocabulary('/root/app/x/route.ts', world)).toBe(false);
  });
});

describe('every ASA route: a generic 502 asserts NO cause (R7)', () => {
  for (const row of ROUTES) {
    it(`${row.name} — 502 carries no LOOM_ASA_RG remediation`, async () => {
      const r = await drive(row, ARM_403());
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
  for (const row of ROUTES) {
    it(`${row.name} — 501 still names the env vars`, async () => {
      const r = await drive(row, new AsaNotConfiguredError(['LOOM_ASA_RG (or LOOM_DLZ_RG)']));
      const j = await r.json();
      expect(r.status).toBe(501);
      expect(j.hint).toContain('LOOM_ASA_RG');
    });
  }
});

describe('metrics tells a missing job apart from an unclassified failure', () => {
  const metricsRow = ROUTES.find((r) => r.module === '[name]/metrics/route.ts')!;

  it('404 + asa-job-not-provisioned, with no env-var remediation', async () => {
    const r = await drive(metricsRow, new AsaJobNotFoundError('orders-stream', 'rgAsa', 'sub1'));
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.code).toBe('asa-job-not-provisioned');
    expect(j.hint).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
  });

  it('a job with no ARM resource id is a 502 that asserts nothing', async () => {
    const r = await driveWith(metricsRow, () => {
      client.getJob.mockResolvedValue({ name: 'orders-stream', id: '', location: 'eastus2' });
    });
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.hint).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('LOOM_ASA_RG');
  });
});
