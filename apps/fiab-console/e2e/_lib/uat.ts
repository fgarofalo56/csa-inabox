/**
 * Shared UAT helpers — auth cookie minting, structured verdict capture,
 * tutorial markdown generation. Used by every *.uat.ts spec.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserContext, Page, expect, request as playwrightRequest } from '@playwright/test';

const SECRET = process.env.SESSION_SECRET!;
if (!SECRET) throw new Error('SESSION_SECRET env required — pull from kv-loom-m56yejezt7bjo/loom-session-secret');

export const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
export const HOST = new URL(BASE).hostname;

/** Mint a Loom session cookie identical to the one /auth/callback writes. */
export function mintSession(): string {
  const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'),
    Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
  const payload = {
    claims: {
      oid:   process.env.UAT_OID   || process.env.LOOM_AUTOMATION_OID || '00000000-0000-0000-0000-000000000000',
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

/** Install the minted session cookie before any navigation. */
export async function signIn(context: BrowserContext) {
  await context.addCookies([{
    name: 'loom_session', value: mintSession(),
    domain: HOST, path: '/', secure: true, httpOnly: false, sameSite: 'Lax',
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
  networkErrors?: { url: string; status: number; body?: string }[];
  screenshot?: string;
  durationMs?: number;
}

/** Append a verdict to the run-wide JSON log. */
export function recordVerdict(r: FeatureResult) {
  const dir = path.join(process.cwd(), 'test-results', 'uat');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'verdicts.ndjson');
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...r }) + '\n');
}

/** Subscribe to console + network failures while running `fn`; return them. */
export async function captureFailures<T>(page: Page, fn: () => Promise<T>): Promise<{
  result: T;
  consoleErrors: string[];
  networkErrors: { url: string; status: number; body?: string }[];
}> {
  const consoleErrors: string[] = [];
  const networkErrors: { url: string; status: number; body?: string }[] = [];
  const onConsole = (msg: any) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  };
  const onResponse = async (r: any) => {
    const u = r.url();
    if (!u.includes(HOST)) return;
    if (r.status() >= 400 && r.status() !== 401) {
      // 401 is the auth-not-loaded-yet noise we ignore
      let body: string | undefined;
      try { body = (await r.text()).slice(0, 300); } catch { /* ignore */ }
      networkErrors.push({ url: u, status: r.status(), body });
    }
  };
  page.on('console', onConsole);
  page.on('response', onResponse);
  try {
    const result = await fn();
    return { result, consoleErrors, networkErrors };
  } finally {
    page.off('console', onConsole);
    page.off('response', onResponse);
  }
}

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
 * Suite-end teardown for specs that mint throwaway workspaces (uat-*/tut-*).
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
