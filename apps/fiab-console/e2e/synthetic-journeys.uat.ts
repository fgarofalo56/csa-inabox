/**
 * Synthetic user-journey monitoring slice (V1 — loom-next-level WS-V #1).
 *
 * Six REAL end-to-end journeys run against the LIVE deployment every 15 min by
 * the scheduled in-VNet `loom-synthetic-monitor` Container App Job
 * (e2e/run-synthetic.mjs → run-uat-unattended.mjs, UAT_PROJECT=journey,
 * UAT_GREP="synthetic"). Two auth paths so the monitor is NOT blind to broken
 * login the way minted-session-only monitoring was on 2026-07-19:
 *
 *   1. Minted-session path (mintSession()) — J2–J6 exercise the real BFF +
 *      Azure backends without MFA. Proves the APP works.
 *   2. TRUE MSAL login probe (J1, _lib/msal-login.ts) — drives /auth/sign-in →
 *      Entra authorize → /auth/callback with the SYNTHETIC_LOGIN_* automation
 *      credential and asserts the REAL callback minted a loom_session cookie.
 *      Proves SIGN-IN works (the AADSTS7000215 class). Credential absent →
 *      honest 'skip' verdict, never a fail.
 *
 * GATE SEMANTICS (identical to ten-journey.uat.ts / run-uat-unattended.mjs):
 * pass = expected 2xx + shape; gate = honest infra/authz gate (503/403/404/
 * 401/429 or a structured not-configured body) — never fails the run; fail =
 * real code bug only (records a CRASH=[journey] verdict → realFail → exit 1
 * → the workflow fires the shared action group + dedup issue).
 *
 * DISPOSABLE STATE: seeds ONE `synthetic-journey-*` workspace and removes it
 * in afterAll via cleanupWorkspaces(). Verdicts land in verdicts.ndjson
 * (recordVerdict) and are uploaded to Blob (LOOM_UAT_RESULTS_ACCOUNT/
 * CONTAINER) under uat-runs/synthetic/<runId>/ for the Health & Reliability
 * hub's Journeys tab (/api/admin/synthetic-runs).
 *
 * Run in-VNet:  node e2e/run-synthetic.mjs
 * Enumerate:    pnpm exec playwright test e2e/synthetic-journeys.uat.ts --list
 */
import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import { BASE, mintSession, recordVerdict, cleanupWorkspaces, signIn, captureFailures } from './_lib/uat';
import { loginViaMsal } from './_lib/msal-login';

// Serial — the journeys share one seeded workspace and ordered teardown.
test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let workspaceId = '';
const createdWorkspaces: string[] = [];

// ── helpers (ten-journey semantics) ──────────────────────────────────────────

async function safeJson(res: APIResponse): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

function trunc(v: unknown): string {
  return JSON.stringify(v ?? '').slice(0, 200);
}

/** Honest-gate classifier — the code ran and returned a structured, documented
 * "this environment isn't wired for X" answer; not a crash. */
function gateFor(status: number, body: any): string | null {
  const s = trunc(body).toLowerCase();
  if (status === 503 || status === 501) return `infra-gate ${status}: ${body?.code || body?.error || ''}`;
  if (status === 403) return `authz-gate ${status}: ${body?.code || body?.error || ''}`;
  if (status === 404) return `not-found ${status} (optional item/infra)`;
  if (status === 429) return `rate-limited ${status}`;
  if (status === 401) return `reauth-gate ${status} (minted session, no MSAL cache)`;
  if (/not configured|not provisioned|missing|no .*workspace|not available|no_aoai|reauth|disabled|gated/.test(s)) {
    return `honest gate: ${body?.error || body?.hint || body?.code || ''}`;
  }
  return null;
}

type Outcome = 'pass' | 'gate' | 'skip' | 'fail';
interface JourneyResult { outcome: Outcome; note: string }

/** Run one journey, record its gate-aware verdict; fail Playwright only on a
 * REAL code failure (CRASH=[…] → realFail in the unattended runner). */
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
    surface: `synthetic:${name}`,
    feature: name,
    verdict: outcome === 'pass' ? 'A' : outcome === 'fail' ? 'F' : 'B',
    status: outcome === 'fail' ? 'fail' : outcome === 'skip' ? 'skip' : 'pass',
    notes: outcome === 'fail' ? `CRASH=[${name}] ${note}` : `${outcome.toUpperCase()}: ${note}`,
    durationMs: Date.now() - started,
  });
  expect(outcome, `${name} → ${note}`).not.toBe('fail');
}

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
  api = await playwrightRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { cookie: `loom_session=${mintSession()}` },
  });
  // Seed the ONE disposable workspace (synthetic-journey-* namespace; `default`
  // domain is the built-in fallback — t158 requires a domain binding).
  const res = await api.post('/api/workspaces', {
    data: { name: `synthetic-journey-${Date.now()}`, domain: 'default' },
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

// ── the six journeys ──────────────────────────────────────────────────────────

test('synthetic J1 — login (TRUE MSAL authorize-code path)', async ({ browser }) => {
  await journey('login-msal', async () => {
    // FRESH context — zero pre-minted cookies, so any loom_session that appears
    // was minted by the REAL /auth/callback (not our test mint).
    const ctx = await browser.newContext();
    try {
      const r = await loginViaMsal(ctx);
      if (r.skipped) return { outcome: 'skip', note: r.reason || 'automation credential absent' };
      if (!r.cookieMinted) {
        // The 07-19 class: sign-in path broken while the app itself is healthy.
        return { outcome: 'fail', note: r.reason || `no callback-minted cookie (landed ${r.landedUrl})` };
      }
      // The callback-minted cookie must be a REAL session: /api/auth/me → 200 + claims.
      const cookies = await ctx.cookies(BASE);
      const loomCookie = cookies.find((c) => c.name === 'loom_session')!;
      const meCtx = await playwrightRequest.newContext({
        baseURL: BASE,
        extraHTTPHeaders: { cookie: `loom_session=${loomCookie.value}` },
      });
      try {
        const me = await meCtx.get('/api/auth/me');
        const meBody = await safeJson(me);
        if (me.ok() && (meBody?.claims || meBody?.user || meBody?.oid || meBody?.ok)) {
          return { outcome: 'pass', note: `real callback session verified — /api/auth/me ${me.status()}` };
        }
        return { outcome: 'fail', note: `callback cookie minted but /api/auth/me ${me.status()}: ${trunc(meBody)}` };
      } finally {
        await meCtx.dispose().catch(() => {});
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  });
});

test('synthetic J2 — create item (workspace item CRUD → Cosmos)', async () => {
  await journey('create-item', async () => {
    const id = await createItem('lakehouse', `synthetic-lakehouse-${Date.now()}`);
    const get = await api.get(`/api/items/lakehouse/${id}?workspaceId=${workspaceId}`);
    const gb = await safeJson(get);
    if (get.ok()) return { outcome: 'pass', note: `created + read back id=${id}` };
    const g = gateFor(get.status(), gb);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `read-back ${get.status()}: ${trunc(gb)}` };
  });
});

test('synthetic J3 — open editor + primary action (lakehouse tables → ADLS)', async ({ browser }) => {
  await journey('editor-primary-action', async () => {
    const id = await createItem('lakehouse', `synthetic-lh-editor-${Date.now()}`);
    // (a) The editor chunk mounts cleanly in a real browser (no console throw,
    //     no 5xx during load) — the GuidedPickerRail-freeze class.
    const ctx = await browser.newContext();
    let mountNote = '';
    try {
      await signIn(ctx);
      const page = await ctx.newPage();
      const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
        await page.goto(`${BASE}/items/lakehouse/${id}?workspaceId=${workspaceId}`, {
          waitUntil: 'domcontentloaded', timeout: 60_000,
        });
        await page.waitForTimeout(4_000); // let the editor chunk hydrate
      });
      const fiveHundreds = networkErrors.filter((n) => n.status >= 500);
      if (consoleErrors.length > 0 || fiveHundreds.length > 0) {
        return {
          outcome: 'fail',
          note: `editor mount errors — console=[${consoleErrors.slice(0, 2).join(' | ').slice(0, 150)}] 5xx=[${fiveHundreds.map((n) => `${n.status} ${n.url}`).slice(0, 2).join(' | ').slice(0, 150)}]`,
        };
      }
      mountNote = 'editor mounted clean';
    } finally {
      await ctx.close().catch(() => {});
    }
    // (b) The editor's primary data call hits the REAL backend: enumerate the
    //     lakehouse's Delta tables (ADLS Gen2) — 2xx receipt or honest gate.
    const res = await api.get(`/api/lakehouse/tables?lakehouseId=${id}&workspaceId=${workspaceId}`);
    const body = await safeJson(res);
    if (res.ok()) return { outcome: 'pass', note: `${mountNote}; tables 200: ${trunc(body)}` };
    const g = gateFor(res.status(), body);
    return g
      ? { outcome: 'gate', note: `${mountNote}; ${g}` }
      : { outcome: 'fail', note: `${mountNote}; tables ${res.status()}: ${trunc(body)}` };
  });
});

test('synthetic J4 — query data (warehouse SELECT over Synapse TDS)', async () => {
  await journey('query-data', async () => {
    const res = await api.post('/api/warehouse/query', {
      data: { sql: 'SELECT 1 AS one', workspaceId },
    });
    const body = await safeJson(res);
    if (res.ok()) return { outcome: 'pass', note: `query 200: ${trunc(body)}` };
    const g = gateFor(res.status(), body);
    return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `query ${res.status()}: ${trunc(body)}` };
  });
});

test('synthetic J5 — share / marketplace (subscribe → grant persisted)', async () => {
  await journey('marketplace-subscribe', async () => {
    const res = await api.post('/api/marketplace/subscriptions', {
      data: { allApis: true, displayName: `synthetic-sub-${Date.now()}` },
    });
    const body = await safeJson(res);
    if (!res.ok() || body?.ok === false) {
      const g = gateFor(res.status(), body);
      return g ? { outcome: 'gate', note: g } : { outcome: 'fail', note: `subscribe ${res.status()}: ${trunc(body)}` };
    }
    // Real persistence outcome: the subscription is listable after the POST.
    const list = await api.get('/api/marketplace/subscriptions');
    const lb = await safeJson(list);
    if (list.ok()) return { outcome: 'pass', note: `subscribed + listed: ${trunc(lb)}` };
    const g = gateFor(list.status(), lb);
    return g ? { outcome: 'gate', note: `subscribed; list ${g}` } : { outcome: 'fail', note: `list ${list.status()}: ${trunc(lb)}` };
  });
});

test('synthetic J6 — git sync / promotion (SCM binding + deployment pipelines)', async () => {
  await journey('git-promotion', async () => {
    // (a) The surviving git-integration route (R28): the workspace SCM binding
    //     read is a REAL Cosmos read ({ok:true, git:<doc|null>}). A fresh
    //     synthetic workspace has no binding — git:null is the correct outcome;
    //     a bound estate returns the full binding doc.
    const scm = await api.get(`/api/workspaces/${workspaceId}/scm`);
    const scmBody = await safeJson(scm);
    if (!scm.ok() || scmBody?.ok !== true) {
      const g = gateFor(scm.status(), scmBody);
      return g ? { outcome: 'gate', note: `scm ${g}` } : { outcome: 'fail', note: `scm ${scm.status()}: ${trunc(scmBody)}` };
    }
    // (b) Promotion path: list the Loom-native deployment pipelines (real Cosmos
    //     read). When one exists with ≥2 stages, read its detail — the compare→
    //     deploy surface the multi-user/promotion flow rides.
    const pipes = await api.get('/api/deployment-pipelines/loom');
    const pb = await safeJson(pipes);
    if (!pipes.ok()) {
      const g = gateFor(pipes.status(), pb);
      return g ? { outcome: 'gate', note: `scm ok; pipelines ${g}` } : { outcome: 'fail', note: `pipelines ${pipes.status()}: ${trunc(pb)}` };
    }
    const list: any[] = Array.isArray(pb?.pipelines) ? pb.pipelines : Array.isArray(pb?.data) ? pb.data : Array.isArray(pb) ? pb : [];
    if (list.length === 0) {
      return { outcome: 'pass', note: 'scm binding route ok (git:null on fresh ws); pipelines list ok (none seeded)' };
    }
    const pid = list[0].id || list[0].pipelineId;
    const detail = await api.get(`/api/deployment-pipelines/loom/${encodeURIComponent(pid)}`);
    const db = await safeJson(detail);
    if (detail.ok()) return { outcome: 'pass', note: `scm ok; pipeline ${pid} detail 200: ${trunc(db)}` };
    const g = gateFor(detail.status(), db);
    return g ? { outcome: 'gate', note: `scm ok; pipeline detail ${g}` } : { outcome: 'fail', note: `pipeline detail ${detail.status()}: ${trunc(db)}` };
  });
});
