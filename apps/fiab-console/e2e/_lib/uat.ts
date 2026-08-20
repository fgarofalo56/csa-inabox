/**
 * Shared UAT helpers — auth cookie minting, structured verdict capture,
 * tutorial markdown generation. Used by every *.uat.ts spec.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserContext, Page, expect, request as playwrightRequest } from '@playwright/test';
import { requireAutomationOid } from '../auth/mint-session';

const SECRET = process.env.SESSION_SECRET!;
if (!SECRET) throw new Error('SESSION_SECRET env required — pull from kv-loom-m56yejezt7bjo/loom-session-secret');

/**
 * Automation identity — FAIL CLOSED, never a placeholder (#3804).
 *
 * This used to fall back to `00000000-0000-0000-0000-000000000000` when neither
 * var was set. That is a syntactically valid GUID, so every guard expecting a
 * well-formed oid passed, and the harness went on to mint a real session and
 * drive real writes as a principal that can never sign in.
 *
 * On 2026-07-12 that produced 24 `tut-app-*` workspaces owned by the zero GUID.
 * `workspaces` is partitioned by /tenantId == the creator's oid, so they landed
 * in a partition no operator can enumerate — and every item inside them became
 * unreadable through any surface that verifies parent-workspace ownership. It
 * surfaced five weeks later as 24 of 32 semantic models rendering empty editors
 * (#3801). Nothing failed at the time: the installs returned success and the
 * provisioners reported `created` with content counts.
 *
 * A KNOWN synthetic automation oid is a documented, tolerated cost with an
 * operator-side cleanup path (scripts/csa-loom/purge-test-workspaces.sh). The
 * zero-GUID fallback is different in kind: the debris it creates is attributable
 * to nothing, so recovery by owner is impossible in principle.
 *
 * An unset identity is an operator error. Refusing to start is strictly better
 * than producing plausible-looking data under a principal that does not exist.
 *
 * The check itself lives in mint-session.ts so that empty AND placeholder are
 * decided in one place: an oid of `00000000-0000-0000-0000-000000000001` passes
 * a non-empty test and every GUID-shape test, so a local `if (!oid)` here would
 * still be fail-open. Taking the guard's return value also types this export as
 * `string` rather than `string | undefined` for every consumer.
 */
export const AUTOMATION_OID: string = requireAutomationOid({
  oid: process.env.UAT_OID || process.env.LOOM_AUTOMATION_OID,
});

/**
 * UAT target base URL (rel-T30). Resolution order:
 *   1. LOOM_UAT_BASE_URL — explicit UAT target. Point this at a CANDIDATE
 *      revision's direct ingress URL to run the journeys PRE-traffic-shift
 *      (before the roll flips Front Door to the new revision).
 *   2. LOOM_URL — the existing convention (the live Front Door URL the
 *      unattended runner + verify project already set).
 *   3. The live Front Door default.
 */
export const BASE =
  process.env.LOOM_UAT_BASE_URL || process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
export const HOST = new URL(BASE).hostname;

/** Mint a Loom session cookie identical to the one /auth/callback writes. */
export function mintSession(): string {
  const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'),
    Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
  const payload = {
    claims: {
      oid:   AUTOMATION_OID,
      name:  process.env.UAT_NAME  || process.env.LOOM_AUTOMATION_NAME || 'Loom UAT',
      email: process.env.UAT_EMAIL || 'uat@example.invalid',
      upn:   process.env.UAT_UPN   || 'uat@example.invalid',
    },
    exp: Math.floor(Date.now() / 1000) + 8 * 3600,
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

/**
 * Install the minted session cookie before any navigation.
 *
 * `secure` MATCHES THE SCHEME OF `BASE` — it is not hard-coded true. A `Secure`
 * cookie is never sent over `http://` (Chromium special-cases only localhost),
 * so hard-coding it silently leaves the browser context UNAUTHENTICATED against
 * an http BASE: every client API call 401s, and the only symptom is a pile of
 * "Failed to load resource … 401" console errors that read like an app bug.
 *
 * That is not hypothetical. The in-VNet `loom-synthetic-monitor` job runs with
 * `LOOM_URL=http://loom-console` — admin-plane/main.bicep hands the job
 * `fdOn ? frontDoorPublicUrl : 'http://loom-console'`, and the job existing at
 * all proves the other two conjuncts of `fdOn` are true, so it was deployed
 * with frontDoorEnabled false. Measured on the live job 2026-08-09.
 * J3 (open editor + primary action) failed on exactly those console 401s,
 * including one on /api/telemetry/rum.
 *
 * API-context auth is unaffected: it passes the cookie as a header, which is
 * why J2/J4 kept passing while only the browser-driven journey failed.
 */
export async function signIn(context: BrowserContext) {
  await context.addCookies([{
    name: 'loom_session', value: mintSession(),
    domain: HOST, path: '/', secure: BASE.startsWith('https:'), httpOnly: false, sameSite: 'Lax',
  }]);
}

export type Verdict = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface FeatureResult {
  surface: string;            // e.g. "editor:notebook" or "page:/workspaces"
  feature: string;            // e.g. "create-item" or "tab:run-history"
  verdict: Verdict;
  status: 'pass' | 'fail' | 'vaporware' | 'skip';
  notes?: string;
  consoleErrors?: string[];
  networkErrors?: NetworkFailure[];
  screenshot?: string;
  durationMs?: number;
}

/**
 * Append a verdict to the run-wide JSON log AND echo it to stdout.
 *
 * The echo is not decoration — it is the only channel that reliably survives.
 * This suite's real home is the in-VNet `loom-uat` Container App Job, where:
 *   - `test-results/` dies with the container;
 *   - `actions/upload-artifact` does not exist (it is not a GitHub runner);
 *   - the blob upload in `run-uat-unattended.mjs` is explicitly best-effort and
 *     is skipped entirely unless LOOM_UAT_RESULTS_ACCOUNT/_CONTAINER are set.
 * Container stdout reaches Log Analytics, so echoing the exact ndjson line means
 * a log scrape can rebuild `verdicts.ndjson` line-for-line when the blob path is
 * unset or failed. Producing a result nobody can retrieve is the same defect as
 * producing no result (#3167).
 *
 * The `UAT_VERDICT` prefix deliberately does NOT contain the substring
 * `UAT_RESULT`: the roll gate and the synthetic monitor both select their
 * summary with `Log_s contains 'UAT_RESULT' | take 1`, and a prefix that
 * matched would let a per-verdict line win that `take 1` and change what the
 * gate reads.
 */
export function recordVerdict(r: FeatureResult) {
  const dir = path.join(process.cwd(), 'test-results', 'uat');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'verdicts.ndjson');
  const line = JSON.stringify({ ts: new Date().toISOString(), ...r });
  fs.appendFileSync(f, line + '\n');
  console.log(`UAT_VERDICT ${line}`);
}

/**
 * One captured network failure.
 *
 * `status` is the HTTP status, or 0 when the request never got a response
 * (DNS / TLS / connection reset — `failure` then carries Chromium's errorText).
 */
export interface NetworkFailure {
  url: string;
  status: number;
  body?: string;
  method?: string;
  /** False for third-party hosts (App Insights, CDNs) — those must not fail a smoke. */
  sameOrigin: boolean;
  /** Chromium errorText for a request that never completed. */
  failure?: string;
}

export interface CaptureOptions {
  /**
   * Echo every captured failure to stdout the moment it happens. This is what
   * makes a TIMED-OUT test diagnosable: when Playwright aborts the test body,
   * nothing the spec would have asserted is ever reported, but stdout is
   * already in the Actions log. Default: on.
   */
  echo?: boolean;
  /** Prefix for echoed lines, e.g. the route under test. */
  label?: string;
  /**
   * Grace period for in-flight response-body reads to land before returning.
   * `response.text()` is a CDP round-trip, so a failure that arrives in the
   * last milliseconds of `fn()` would otherwise be dropped. Default 2000ms.
   */
  settleMs?: number;
}

/** Format one failure as a single actionable line. */
export function formatNetworkFailure(n: NetworkFailure): string {
  const where = n.sameOrigin ? '' : ' [third-party]';
  const what = n.status ? `${n.status}` : `FAILED(${n.failure || 'unknown'})`;
  const body = n.body ? ` :: ${n.body.replace(/\s+/g, ' ').slice(0, 300)}` : '';
  return `${what}${where} ${n.method || 'GET'} ${n.url}${body}`;
}

/**
 * Subscribe to console + network failures while running `fn`; return them.
 *
 * Hardened 2026-07-28 after the in-VNet route-smoke sweep (run 30330893902)
 * proved a 500 existed on /admin/rum while the spec's `5xx calls:` diagnostic
 * printed NOTHING — the failure was real but unattributable without the trace
 * (which the workflow had also dropped). Four independent gaps are closed:
 *
 *  1. RECORD-THEN-ENRICH. The old handler `await`ed `response.text()` BEFORE
 *     pushing, so any body read that resolved after `fn()` returned — or hung,
 *     or threw on page teardown — lost the whole record. The record is now
 *     pushed SYNCHRONOUSLY from the event; the body is filled in afterwards.
 *  2. NO HOST FILTER ON 5xx. `if (!u.includes(HOST)) return` silently dropped
 *     any 5xx whose URL did not literally contain the base hostname (a vanity
 *     domain, an apex redirect, a same-site API host). 5xx is now recorded from
 *     ANY origin and tagged `sameOrigin` so callers can still scope what fails.
 *  3. requestfailed. A request that dies before a response (reset, TLS, DNS)
 *     emitted no `response` event at all and was invisible. Now captured, with
 *     `net::ERR_ABORTED` filtered out (React StrictMode / AbortController noise).
 *  4. CONSOLE LOCATION. A bare "Failed to load resource: …500" now carries
 *     `msg.location()`, so the resource is named even if every other path fails.
 */
export async function captureFailures<T>(page: Page, fn: () => Promise<T>, opts: CaptureOptions = {}): Promise<{
  result: T;
  consoleErrors: string[];
  networkErrors: NetworkFailure[];
}> {
  const { echo = true, label = '', settleMs = 2_000 } = opts;
  const tag = label ? `[capture ${label}]` : '[capture]';
  const consoleErrors: string[] = [];
  const networkErrors: NetworkFailure[] = [];
  /** In-flight body reads — awaited (bounded) before returning. */
  const pending: Promise<unknown>[] = [];

  const say = (line: string) => { if (echo) console.log(`${tag} ${line}`); };

  const onConsole = (msg: any) => {
    if (msg.type() !== 'error') return;
    let where = '';
    try {
      const loc = msg.location?.();
      if (loc?.url) where = ` @ ${loc.url}${loc.lineNumber ? `:${loc.lineNumber}` : ''}`;
    } catch { /* location is best-effort */ }
    const text = `${msg.text()}${where}`;
    consoleErrors.push(text);
    say(`console.error ${text}`);
  };

  const onResponse = (r: any) => {
    let u = '';
    let status = 0;
    try { u = r.url(); status = r.status(); } catch { return; }
    const sameOrigin = u.includes(HOST);
    // 401 is the auth-not-loaded-yet noise we ignore. 4xx is only interesting
    // on our own origin (a third-party 404 is not our mount's problem); a 5xx
    // is ALWAYS recorded, wherever it came from.
    if (status < 400 || status === 401) return;
    if (status < 500 && !sameOrigin) return;

    const rec: NetworkFailure = { url: u, status, sameOrigin };
    try { rec.method = r.request?.().method?.(); } catch { /* best-effort */ }
    networkErrors.push(rec);            // <-- synchronous: never lost to a race
    say(formatNetworkFailure(rec));

    // Enrich with the body afterwards. Bounded so a never-finishing body cannot
    // stall the settle window.
    pending.push(
      Promise.race([
        r.text().then((t: string) => { rec.body = t.slice(0, 1_000); }),
        new Promise((res) => setTimeout(res, 1_500)),
      ]).catch(() => { /* body unavailable — the url + status still stand */ }),
    );
  };

  const onRequestFailed = (req: any) => {
    let u = '';
    let errorText = '';
    try {
      u = req.url();
      errorText = req.failure?.()?.errorText || '';
    } catch { return; }
    // Aborts are expected: unmount cancellations, AbortController timeouts.
    if (/ERR_ABORTED/i.test(errorText)) return;
    const sameOrigin = u.includes(HOST);
    if (!sameOrigin) return;
    const rec: NetworkFailure = { url: u, status: 0, sameOrigin, failure: errorText };
    try { rec.method = req.method?.(); } catch { /* best-effort */ }
    networkErrors.push(rec);
    say(formatNetworkFailure(rec));
  };

  page.on('console', onConsole);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  try {
    const result = await fn();
    // Let in-flight body reads land before the caller inspects the array.
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((res) => setTimeout(res, settleMs)),
    ]);
    return { result, consoleErrors, networkErrors };
  } finally {
    page.off('console', onConsole);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}

/**
 * #2830 — the `loom:`-id 4xx assertion. Four defects in this family reached
 * production, and every one was VISIBLE in a Playwright run beforehand: the
 * capture log printed the 404 and no assertion looked at it.
 *
 *   404 GET /api/items/report/loom%3A8872fd18-…/pages?workspaceId=loom-native
 *
 * `captureFailures` already records these; the gap was that nothing FAILED on
 * them. The predicate lives in a dependency-free sibling so it can be unit-
 * tested (vitest excludes `e2e/`) — an unproven assertion is how this class
 * survived — and is re-exported here so specs keep one import.
 */
export { loomIdFailures, assertNoLoomIdFailures } from './loom-id-failures';

/** Write a tutorial markdown for a passed editor with screenshots + steps. */
export interface TutorialStep {
  description: string;
  screenshotPath?: string;
}
export function writeTutorial(slug: string, title: string, summary: string, steps: TutorialStep[]) {
  const root = path.resolve(process.cwd(), '..', '..', 'docs', 'fiab', 'tutorials');
  fs.mkdirSync(root, { recursive: true });
  const lines = [
    `# ${title}`,
    '',
    `> Auto-generated from the Loom UAT harness on ${new Date().toISOString().slice(0, 10)}. Edits welcome.`,
    '',
    summary,
    '',
    '## Walkthrough',
    '',
  ];
  steps.forEach((s, i) => {
    lines.push(`### Step ${i + 1} — ${s.description}`);
    lines.push('');
    if (s.screenshotPath) {
      // Copy screenshot into docs/fiab/tutorials/img/<slug>-<n>.png
      const imgDir = path.join(root, 'img');
      fs.mkdirSync(imgDir, { recursive: true });
      const dst = path.join(imgDir, `${slug}-${i + 1}.png`);
      try {
        fs.copyFileSync(s.screenshotPath, dst);
        lines.push(`![Step ${i + 1}](./img/${slug}-${i + 1}.png)`);
        lines.push('');
      } catch { /* missing screenshot — keep going */ }
    }
  });
  fs.writeFileSync(path.join(root, `${slug}.md`), lines.join('\n'));
}

/** Resolve the editor types list from registry.ts. */
export function loadEditorTypes(): string[] {
  const reg = path.join(__dirname, '..', '..', 'lib', 'editors', 'registry.ts');
  return fs.readFileSync(reg, 'utf-8')
    .split('\n')
    .map(l => l.match(/^\s*['"]([a-z][a-z0-9-]+)['"]\s*:\s*reg\(/))
    .filter(Boolean)
    .map(m => m![1]);
}

/**
 * Top-level navigation surfaces ("features"), mirroring the LeftNav. Single
 * source of truth — consumed by both nav-pages.uat.ts (render/console/network
 * check) and tutorial-capture.uat.ts (per-feature screenshot walkthrough) so
 * the two never drift.
 */
export const NAV_PAGES = [
  '/',
  '/workspaces',
  '/browse',
  '/onelake',
  '/api-marketplace',
  '/governance',
  '/monitor',
  '/realtime-hub',
  '/data-agent',
  '/copilot',
  '/workload-hub',
  '/deployment-pipelines',
  '/admin',
  '/setup',
  '/apps',
  '/workloads',
  '/learn',
] as const;

/** Filesystem-safe slug for a nav page path (`/` -> "home", `/a/b` -> "a-b"). */
export function pageSlug(p: string): string {
  const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? 'home' : trimmed.replace(/\//g, '-');
}

/** Common create-workspace helper.
 *
 * The POST /api/workspaces route requires a governance `domain` binding
 * (t158 — a workspace MUST be bound to a domain). `default` is the built-in
 * fallback domain (DEFAULT_DOMAIN_ID, always present in the registry), so it is
 * the parity-correct value when the caller doesn't specify one. Omitting it
 * makes the route return 400 `domain_required` and every workspace-creating
 * test dies at setup. */
export async function createWorkspace(page: Page, name?: string, domain = 'default'): Promise<string> {
  const r = await page.request.post(`${BASE}/api/workspaces`, {
    data: { name: name || `uat-${Date.now()}`, domain },
    // Explicit 60s: the config actionTimeout (30s) also governs API calls, and
    // workspace creation behind Front Door can queue behind an in-flight app
    // provisioning burst. A timed-out create fails the whole test at setup.
    timeout: 60_000,
  });
  if (!r.ok()) {
    throw new Error(
      `createWorkspace failed: POST /api/workspaces -> ${r.status()} ${await r.text().catch(() => '')}`,
    );
  }
  return (await r.json()).id as string;
}

export async function deleteWorkspace(page: Page, wsId: string) {
  try { await page.request.delete(`${BASE}/api/workspaces/${wsId}`); } catch { /* best-effort */ }
}

/**
 * Suite-end teardown for specs that mint throwaway workspaces (uat-* / tut-*).
 *
 * Some suites create a fresh workspace per app/item and cannot use a per-test
 * `finally { deleteWorkspace }` because their assertions throw before cleanup
 * runs — leaving hundreds of `uat-app-*` / `tut-*` workspaces behind that
 * pollute the tenant (see scripts/csa-loom/purge-test-workspaces.sh, rel-T09c).
 * Collect created ids into a module-level array and call this from a
 * `test.afterAll` so the namespace is disposable: whatever the suite created,
 * it removes. Best-effort — a failed delete is logged, never thrown, so
 * cleanup can't fail an otherwise-green run.
 *
 * Uses a standalone APIRequestContext with the same minted session cookie the
 * suite ran under, so the owner-scoped bulk-delete (`/api/workspaces/bulk-delete`)
 * resolves the caller's own partition. Ids are chunked to the route's 500 max.
 */
export async function cleanupWorkspaces(ids: string[]): Promise<void> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return;
  let ctx: Awaited<ReturnType<typeof playwrightRequest.newContext>> | undefined;
  try {
    ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: { cookie: `loom_session=${mintSession()}` },
    });
    let deleted = 0;
    let failed = 0;
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      try {
        const r = await ctx.post(`${BASE}/api/workspaces/bulk-delete`, { data: { ids: chunk } });
        const body = await r.json().catch(() => ({}));
        deleted += Array.isArray(body?.deleted) ? body.deleted.length : 0;
        failed += Array.isArray(body?.failed) ? body.failed.length : chunk.length;
      } catch {
        failed += chunk.length;
      }
    }
    console.log(`[uat-cleanup] removed ${deleted}/${unique.length} throwaway workspace(s)` +
      (failed ? ` (${failed} not deleted — safe to sweep with scripts/csa-loom/purge-test-workspaces.sh)` : ''));
  } catch (e: any) {
    console.warn(`[uat-cleanup] teardown skipped: ${e?.message || e}`);
  } finally {
    await ctx?.dispose().catch(() => {});
  }
}

export async function createItem(page: Page, wsId: string, type: string, displayName?: string): Promise<string> {
  const r = await page.request.post(`${BASE}/api/workspaces/${wsId}/items`, {
    data: { itemType: type, displayName: displayName || `uat-${type}-${Date.now()}` },
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).id as string;
}

/**
 * Poll an app-install job to terminal state and return the completed job doc.
 *
 * The app install POST is ASYNC (202 `{ ok, jobId, totalItems }`): item creation
 * + Phase-2 provisioning run in a background worker so a long provision can't
 * 504. The dialog polls GET /api/apps/install-jobs/{jobId}. Tests must do the
 * same — the 202 body has NO `installed`/`provision`; those land on the job doc
 * when it reaches a terminal phase (`done` / status done|partial|failed).
 *
 * Returns the last-known job doc (terminal if it finished within the timeout).
 */
export async function pollInstallJob(page: Page, jobId: string, timeoutMs = 240_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let job: any = null;
  while (Date.now() < deadline) {
    const r = await page.request.get(`${BASE}/api/apps/install-jobs/${jobId}`);
    if (r.ok()) {
      const b = await r.json().catch(() => ({}));
      job = b?.job ?? b;
      const terminal =
        job && (job.phase === 'done' || ['done', 'partial', 'failed', 'completed'].includes(job.status));
      if (terminal) return job;
    }
    await page.waitForTimeout(3000);
  }
  return job;
}
