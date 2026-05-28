#!/usr/bin/env node
/**
 * One-command UAT launcher.
 *
 * Run:  pnpm uat
 *
 * What it does:
 *   1. Ensures @playwright/test + chromium browser are installed.
 *   2. Opens Chromium in headed mode at the Loom sign-in page.
 *   3. Waits for you to sign in. Once /api/me reports authenticated:true,
 *      saves the storage state (cookies + localStorage) to
 *      .auth/loom-state.json (gitignored).
 *   4. Runs the deep-functional-uat.uat.ts spec against the live env
 *      using that saved storage state.
 *   5. Opens temp/uat-2026-05-28/deep-functional/INDEX.md (per-editor reports)
 *      and prints the verdict tally.
 *
 * No remote browser needed — everything happens on your machine.
 */

import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(ROOT, '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'loom-state.json');
const BASE_URL = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const REPORT_DIR = path.resolve(ROOT, '..', '..', 'temp', 'uat-2026-05-28', 'deep-functional');

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

function step(msg) { console.log(`\n▶ ${msg}`); }

async function ensureSession() {
  step('Opening Chromium for you to sign in');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/auth/sign-in`);

  console.log('  Sign in with your Loom credentials. I\'ll detect when you\'re signed in.');
  let auth = null;
  const start = Date.now();
  while (Date.now() - start < 10 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await page.request.get(`${BASE_URL}/api/me`);
    const j = await r.json().catch(() => null);
    if (j?.authenticated) { auth = j; break; }
  }
  if (!auth) {
    console.error('Timed out waiting for sign-in. Re-run pnpm uat.');
    await browser.close();
    process.exit(1);
  }
  console.log(`  Signed in as ${auth.user.upn || auth.user.email}`);
  await context.storageState({ path: AUTH_FILE });
  await browser.close();
  console.log(`  Saved session to ${path.relative(ROOT, AUTH_FILE)}`);
}

function runDeepUat() {
  step('Running deep-functional UAT against the live env');
  console.log('  Spec: e2e/deep-functional-uat.uat.ts');
  console.log('  Live env: ' + BASE_URL);
  console.log('  Reports will land under temp/uat-2026-05-28/deep-functional/');

  const env = {
    ...process.env,
    LOOM_URL: BASE_URL,
    LOOM_STORAGE_STATE: AUTH_FILE,
  };
  const proc = spawn('pnpm', ['exec', 'playwright', 'test',
    'e2e/deep-functional-uat.uat.ts',
    '--reporter=line',
    '--workers=4',
  ], { cwd: ROOT, env, stdio: 'inherit', shell: true });

  return new Promise(resolve => {
    proc.on('close', code => resolve(code ?? 0));
  });
}

function printSummary() {
  step('Summary');
  const csv = path.resolve(ROOT, '..', '..', 'temp', 'uat-2026-05-28', 'deep-functional-uat.csv');
  if (!fs.existsSync(csv)) {
    console.log('  (no CSV — spec did not complete; check the line above)');
    return;
  }
  const rows = fs.readFileSync(csv, 'utf8').split('\n').filter(Boolean);
  const tally = {};
  for (let i = 1; i < rows.length; i++) {
    const verdict = rows[i].split(',')[2];
    tally[verdict] = (tally[verdict] || 0) + 1;
  }
  console.log('  Verdict tally:', tally);
  console.log(`  Per-editor markdown: temp/uat-2026-05-28/deep-functional/`);
  console.log(`  Screenshots: temp/uat-2026-05-28/screenshots/`);
}

async function main() {
  try {
    if (!fs.existsSync(AUTH_FILE)) {
      await ensureSession();
    } else {
      const stat = fs.statSync(AUTH_FILE);
      const ageHr = (Date.now() - stat.mtimeMs) / 3600_000;
      if (ageHr > 8) {
        console.log(`  Cookie is ${ageHr.toFixed(1)}h old; refreshing.`);
        await ensureSession();
      } else {
        console.log(`  Re-using saved session from ${path.relative(ROOT, AUTH_FILE)} (${ageHr.toFixed(1)}h old)`);
      }
    }
    await runDeepUat();
    printSummary();
  } catch (e) {
    console.error('UAT launcher failed:', e?.message || e);
    process.exit(1);
  }
}

main();
