/**
 * Shared UAT helpers — auth cookie minting, structured verdict capture,
 * tutorial markdown generation. Used by every *.uat.ts spec.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserContext, Page, expect } from '@playwright/test';

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
      oid:   process.env.UAT_OID   || '866a2e12-0fee-4c99-923c-7cdfd61e08cd',
      name:  process.env.UAT_NAME  || 'Frank Garofalo (UAT)',
      email: process.env.UAT_EMAIL || 'fgarofalo@limitlessdata.ai',
      upn:   process.env.UAT_UPN   || 'fgarofalo@limitlessdata.ai',
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

export async function createItem(page: Page, wsId: string, type: string, displayName?: string): Promise<string> {
  const r = await page.request.post(`${BASE}/api/workspaces/${wsId}/items`, {
    data: { itemType: type, displayName: displayName || `uat-${type}-${Date.now()}` },
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).id as string;
}
