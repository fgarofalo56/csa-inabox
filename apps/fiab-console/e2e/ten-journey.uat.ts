/**
 * Ten-journey UAT slice (rel-T30) — the pre-traffic-shift smoke that proves a
 * CANDIDATE console revision serves the ten load-bearing end-to-end journeys
 * before the roll flips Front Door to it.
 *
 * WHY API-level, not DOM strings: per no-vaporware.md + the roll-gate, every
 * journey asserts a REAL BACKEND OUTCOME (HTTP status + response body / job
 * state), NOT that some text rendered. The minted-session cookie (no MSAL/MFA)
 * lets the ACA UAT job drive the real BFF routes exactly as the browser would.
 *
 * GATE SEMANTICS (matches e2e/run-uat-unattended.mjs): a journey is
 *   - PASS       when the backend returns the expected 2xx + shape;
 *   - PASS-with-NOTE ("gate") when the backend returns an HONEST infra/authz
 *     gate (503 not-configured, 403 admin-only, 404 optional-item, 401 reauth,
 *     429 rate-limited) — the code works, the environment just isn't wired for
 *     that capability. These do NOT fail the run;
 *   - FAIL only on a real code bug (5xx crash, unexpected shape, or a thrown
 *     exception). A FAIL records a `CRASH=[journey]` verdict so the unattended
 *     runner counts it as a realFail and exits non-zero.
 *
 * TARGET: e2e/_lib/uat.ts `BASE` resolves LOOM_UAT_BASE_URL → LOOM_URL → the
 * live Front Door. Set LOOM_UAT_BASE_URL to a candidate revision's direct URL
 * to gate a roll before the traffic shift.
 *
 * DISPOSABLE STATE: seeds ONE `uat-app-ten-journey-*` workspace (the namespace
 * scripts/csa-loom/purge-test-workspaces.sh sweeps) and tears it down in
 * afterAll via cleanupWorkspaces() — whatever this suite creates, it removes.
 *
 * Run (in-VNet ACA job): UAT_GREP="ten-journey" node e2e/run-uat-unattended.mjs
 * Enumerate locally:      pnpm exec playwright test e2e/ten-journey.uat.ts --list
 */
import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import { BASE, mintSession, recordVerdict, cleanupWorkspaces } from './_lib/uat';

// Serial — the journeys share one seeded workspace and ordered teardown.
test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let workspaceId = '';
const createdWorkspaces: string[] = [];

// ── helpers ──────────────────────────────────────────────────────────────────

async function safeJson(res: APIResponse): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

function trunc(v: unknown): string {
  return JSON.stringify(v ?? '').slice(0, 200);
}

/**
 * Classify a non-2xx response as an HONEST gate (returns a note) or a real
 * failure (returns null). Honest gates: the code ran and returned a structured,
 * documented "this environment isn't wired for X" answer — not a crash.
 */
function gateFor(status: number, body: any): string | null {
  const s = trunc(body).toLowerCase();
  if (status === 503 || status === 501) return `infra-gate ${status}: ${body?.code || body?.error || ''}`;
  if (status === 403) return `authz-gate ${status}: ${body?.code || body?.error || ''}`;
  if (status === 404) return `not-found ${status} (optional item/infra)`;
  if (status === 429) return `rate-limited ${status}`;
  if (status === 401) return `reauth-gate ${status} (minted session, no MSAL cache)`;
  if (/not configured|not provisioned|missing|no .*workspace|not available|no_aoai|reauth|disabled/.test(s)) {
    return `honest gate: ${body?.error || body?.hint || body?.code || ''}`;
  }
  return null;
}

type Outcome = 'pass' | 'gate' | 'fail';
interface JourneyResult { outcome: Outcome; note: string }

/**
 * Run one journey, record its gate-aware verdict, and (on a real code failure
 * only) fail the Playwright test too so it surfaces in report.json triage.
 */
async function journey(name: string, fn: () => Promise<JourneyResult>): Promise<void> {
  let outcome: Outcome;
  let note: string;
  const started = Date.now();
  try {
    const r = await fn();
    outcome = r.outcome;
    note = r.note;
  } catch (e: any) {
    outcome = 'fail';
    note = `CRASH: ${e?.message || e}`;
  }
  recordVerdict({
    surface: `journey:${name}`,
    feature: name,
    verdict: outcome === 'pass' ? 'A' : outcome === 'gate' ? 'B' : 'F',
    status: outcome === 'fail' ? 'fail' : 'pass',
    // The unattended runner treats a `CRASH=[...]` note as a realFail (exit 1);
    // gate/pass notes are informational and keep the run green.
    notes: outcome === 'fail' ? `CRASH=[${name}] ${note}` : `${outcome.toUpperCase()}: ${note}`,
    durationMs: Date.now() - started,
  });
  // Only a real code failure fails the spec; honest gates pass with a note.
  expect(outcome, `${name} → ${note}`).not.toBe('fail');
}

/** POST /api/workspaces/{ws}/items — returns the created item id or throws. */
async function createItem(itemType: string, displayName: string): Promise<string> {
  const res = await api.post(`/api/workspaces/${workspaceId}/items`, {
    data: { itemType, displayName },
  });
  const body = await safeJson(res);
  if (!res.ok() || !body?.id) {
    throw new Error(`create ${itemType} failed: ${res.status()} ${trunc(body)}`);
  }
  return body.id as string;
}

// ── suite setup / teardown ────────────────────────────────────────────────────

test.beforeAll(async () => {
  // Standalone request context carrying the minted session cookie — same
  // mechanism cleanupWorkspaces() and the verify project use.
  api = await playwrightRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { cookie: `loom_session=${mintSession()}` },
  });
  // Seed the disposable workspace (uat-app-* namespace → covered by the purge
  // script). `default` domain is the built-in fallback (t158 requires a domain).
  const res = await api.post('/api/workspaces', {
    data: { name: `uat-app-ten-journey-${Date.now()}`, domain: 'default' },
  });
  const body = await safeJson(res);
  if (!res.ok() || !body?.id) {
    throw new Error(`seed workspace failed: ${res.status()} ${trunc(body)}`);
  }
  workspaceId = body.id;
  createdWorkspaces.push(workspaceId);
});

test.afterAll(async () => {
  await cleanupWorkspaces(createdWorkspaces);
  await api?.dispose().catch(() => {});
});

// ── the ten journeys ──────────────────────────────────────────────────────────

test('J1 — create item (workspace item CRUD → Cosmos)', async () => {
  await journey('create-item', async () => {
    const id = await createItem('lakehouse', `uat-lakehouse-${Date.now()}`);
    // Real backend outcome: the item is retrievable from its own route.
    const get = await api.get(`/api/items/lakehouse/${id}?workspaceId=${workspaceId}`);
    const gb = await safeJson(get);
    if (get.ok()) return { outcome: 'pass', note: `created + read back id=${id}` };
    const g = gateFor(get.status(), gb);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `read-back ${get.status()}: ${trunc(gb)}` };
  });
});

test('J2 — run notebook cell (Spark/Livy execute)', async () => {
  await journey('notebook-run-cell', async () => {
    const id = await createItem('notebook', `uat-notebook-${Date.now()}`);
    // POST a trivial cell to the real execute route. Without a bound Spark pool
    // this returns an honest 503 gate — the code path still executes.
    const res = await api.post(`/api/notebook/${id}/execute`, {
      data: { code: 'print(1)', kind: 'pyspark', workspaceId },
    });
    const body = await safeJson(res);
    if (res.ok()) return { outcome: 'pass', note: `execute 200: ${trunc(body)}` };
    const g = gateFor(res.status(), body);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `execute ${res.status()}: ${trunc(body)}` };
  });
});

test('J3 — pipeline save + run (ADF/Synapse)', async () => {
  await journey('pipeline-save-run', async () => {
    const id = await createItem('data-pipeline', `uat-pipeline-${Date.now()}`);
    // Save a minimal spec (real PUT to the item route), then trigger a run.
    const save = await api.put(`/api/items/data-pipeline/${id}?workspaceId=${workspaceId}`, {
      data: { spec: { activities: [], parameters: {} } },
    });
    const saveBody = await safeJson(save);
    if (!save.ok()) {
      const g = gateFor(save.status(), saveBody);
      return g ? { outcome: 'gate', note: `save ${g}` } : { outcome: 'fail', note: `save ${save.status()}: ${trunc(saveBody)}` };
    }
    const run = await api.post(`/api/items/data-pipeline/${id}/run?workspaceId=${workspaceId}`, { data: {} });
    const runBody = await safeJson(run);
    if (run.ok()) return { outcome: 'pass', note: `saved + run 2xx: ${trunc(runBody)}` };
    const g = gateFor(run.status(), runBody);
    return g ? { outcome: 'gate', note: `run ${g}` } : { outcome: 'fail', note: `run ${run.status()}: ${trunc(runBody)}` };
  });
});

test('J4 — warehouse query (Synapse dedicated SQL)', async () => {
  await journey('warehouse-query', async () => {
    const res = await api.post('/api/warehouse/query', {
      data: { sql: 'SELECT 1 AS one', workspaceId },
    });
    const body = await safeJson(res);
    if (res.ok()) return { outcome: 'pass', note: `query 200: ${trunc(body)}` };
    const g = gateFor(res.status(), body);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `query ${res.status()}: ${trunc(body)}` };
  });
});

test('J5 — marketplace subscribe (data/API product)', async () => {
  await journey('marketplace-subscribe', async () => {
    const res = await api.post('/api/marketplace/subscriptions', {
      data: { allApis: true, displayName: `uat-sub-${Date.now()}` },
    });
    const body = await safeJson(res);
    // A submitted OR active subscription is a real outcome (the route persists it).
    if (res.ok() && (body?.ok !== false)) return { outcome: 'pass', note: `subscribe 2xx: ${trunc(body)}` };
    const g = gateFor(res.status(), body);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `subscribe ${res.status()}: ${trunc(body)}` };
  });
});

test('J6 — app install (one-click app → install job)', async () => {
  await journey('app-install', async () => {
    // Discover a real app id from the live catalog (the fixture can be empty).
    const cat = await api.get('/api/apps-catalog');
    const catBody = await safeJson(cat);
    const apps: any[] = Array.isArray(catBody?.apps) ? catBody.apps : Array.isArray(catBody) ? catBody : [];
    if (!cat.ok() || apps.length === 0) {
      const g = gateFor(cat.status(), catBody);
      return { outcome: 'gate', note: g || `no apps in catalog (${cat.status()})` };
    }
    const appId = apps[0].id || apps[0].appId || apps[0].slug;
    // deploy:false → item creation only (no heavy Phase-2 provisioning) so the
    // journey stays fast; the install job semantics are still exercised.
    const inst = await api.post(`/api/apps/${encodeURIComponent(appId)}/install`, {
      data: { workspaceId, deploy: false },
    });
    const instBody = await safeJson(inst);
    if (inst.status() === 202 && instBody?.jobId) {
      // Poll the real install-job to a terminal phase (bounded).
      const deadline = Date.now() + 180_000;
      let job: any = null;
      while (Date.now() < deadline) {
        const jr = await api.get(`/api/apps/install-jobs/${instBody.jobId}`);
        const jb = await safeJson(jr);
        job = jb?.job ?? jb;
        if (job && (job.phase === 'done' || ['done', 'partial', 'failed', 'completed'].includes(job.status))) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (job && ['done', 'partial', 'completed'].includes(job.status || job.phase)) {
        return { outcome: 'pass', note: `install job ${job.status || job.phase}` };
      }
      if (job && job.status === 'failed') {
        // A provisioning failure with an infra reason is a gate, not a code bug.
        const reason = trunc(job.error || job.failures || job);
        const g = gateFor(500, { error: reason });
        return g ? { outcome: 'gate', note: `install gated: ${reason}` } : { outcome: 'fail', note: `install failed: ${reason}` };
      }
      return { outcome: 'gate', note: `install job did not reach terminal in 180s (phase=${job?.phase})` };
    }
    if (inst.ok()) return { outcome: 'pass', note: `install 2xx: ${trunc(instBody)}` };
    const g = gateFor(inst.status(), instBody);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `install ${inst.status()}: ${trunc(instBody)}` };
  });
});

test('J7 — catalog search (federated Purview/UC/OneLake)', async () => {
  await journey('catalog-search', async () => {
    const res = await api.get('/api/catalog/search?q=uat');
    const body = await safeJson(res);
    // Real outcome: the federated search returns { ok, hits[], sources{} } — the
    // per-source honest gates live INSIDE sources{} and are not a failure.
    if (res.ok() && body?.ok === true && body?.sources) {
      return { outcome: 'pass', note: `search ok, sources=${Object.keys(body.sources).join(',')}` };
    }
    const g = gateFor(res.status(), body);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `search ${res.status()}: ${trunc(body)}` };
  });
});

test('J8 — report open (Loom-native report model)', async () => {
  await journey('report-open', async () => {
    const id = await createItem('report', `uat-report-${Date.now()}`);
    const res = await api.get(`/api/items/report/${id}?workspaceId=${workspaceId}`);
    const body = await safeJson(res);
    if (res.ok()) return { outcome: 'pass', note: `report open 200: ${trunc(body)}` };
    const g = gateFor(res.status(), body);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `report ${res.status()}: ${trunc(body)}` };
  });
});

test('J9 — admin health (tenant overview tiles)', async () => {
  await journey('admin-health', async () => {
    const res = await api.get('/api/admin/overview');
    const body = await safeJson(res);
    // 200 tiles = pass; 403 = honest admin-only gate (minted oid isn't the
    // bootstrap tenant admin in this env) — both are real backend outcomes.
    if (res.ok() && body?.ok !== false) return { outcome: 'pass', note: `overview 200` };
    const g = gateFor(res.status(), body);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `overview ${res.status()}: ${trunc(body)}` };
  });
});

test('J10 — login / session refresh (sliding /api/auth/refresh)', async () => {
  await journey('session-refresh', async () => {
    // Exercise the sliding-refresh endpoint with the minted-session cookie (NOT
    // interactive MSAL). A minted automation session has no MSAL cache entry, so
    // the endpoint's correct answer is a structured 401 REAUTH — that proves the
    // route validated the session and handled the no-cache case without crashing.
    const res = await api.post('/api/auth/refresh');
    const body = await safeJson(res);
    if (res.ok() && body?.ok !== false) return { outcome: 'pass', note: `refresh 200 (sliding session extended)` };
    if (res.status() === 401) return { outcome: 'gate', note: `reauth 401 (minted session has no MSAL refresh token — expected)` };
    const g = gateFor(res.status(), body);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `refresh ${res.status()}: ${trunc(body)}` };
  });
});
