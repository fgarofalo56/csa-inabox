/**
 * Shared helpers for the Data Engineering family Playwright walkthroughs
 * under tests/e2e/<slug>.spec.ts.
 *
 * Each spec:
 *   1. Loads (or mints) a session cookie from temp/.playwright-storage.json
 *      if present, otherwise mints one via SESSION_SECRET (same trick as
 *      tests/walkthrough.mjs and e2e/_lib/uat.ts).
 *   2. Navigates to /items/<slug>/new and checks:
 *      - HTTP 200 with no client-side crash
 *      - An <h1> is present (page rendered)
 *      - No "<undefined />" text leaked (a Next.js dynamic-import failure
 *        symptom we hit on the 2026-05-26 sweep)
 *      - No console errors
 *      - At least one primary action button is clickable
 *
 * Run:  LOOM_URL=https://loom-… SESSION_SECRET=… pnpm exec playwright test --config=tests/e2e/playwright.config.ts
 *       (or against a local dev server: LOOM_URL=http://localhost:3000 pnpm exec playwright test ...)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

export const BASE = process.env.LOOM_URL || 'http://localhost:3000';
export const HOST = new URL(BASE).hostname;

const STORAGE_PATH = process.env.LOOM_PLAYWRIGHT_STORAGE
  || path.resolve(process.cwd(), '..', '..', 'temp', '.playwright-storage.json');

function mintSessionCookie(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const KEY = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-session-v1'), 32),
  );
  const payload = {
    claims: {
      oid: process.env.UAT_OID || process.env.LOOM_AUTOMATION_OID || '00000000-0000-0000-0000-000000000000',
      name: process.env.UAT_NAME || process.env.LOOM_AUTOMATION_NAME || 'Loom UAT',
      email: process.env.UAT_EMAIL || 'uat@example.invalid',
      upn: process.env.UAT_UPN || 'uat@example.invalid',
    },
    exp: Math.floor(Date.now() / 1000) + 8 * 3600,
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

export async function signIn(context: BrowserContext): Promise<void> {
  // Prefer existing storage-state if present (matches the request from the
  // task spec: reuse temp/.playwright-storage.json when available).
  if (fs.existsSync(STORAGE_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf-8'));
      if (raw?.cookies?.length) {
        await context.addCookies(raw.cookies);
        return;
      }
    } catch {
      /* fall through to mint */
    }
  }
  const cookie = mintSessionCookie();
  if (!cookie) {
    // No session secret and no stored cookie. The test will still run, but
    // the editor will likely 401. We treat that as a soft skip — the spec
    // catches a real client-side crash either way.
    return;
  }
  await context.addCookies([
    {
      name: 'loom_session',
      value: cookie,
      domain: HOST,
      path: '/',
      secure: BASE.startsWith('https'),
      httpOnly: false,
      sameSite: 'Lax',
    },
  ]);
}

/** Subscribe to console errors while running fn; return them. */
export async function trackConsoleErrors<T>(page: Page, fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const onConsole = (msg: any) => {
    if (msg.type() === 'error') errors.push(msg.text());
  };
  page.on('console', onConsole);
  try {
    const result = await fn();
    return { result, errors };
  } finally {
    page.off('console', onConsole);
  }
}
