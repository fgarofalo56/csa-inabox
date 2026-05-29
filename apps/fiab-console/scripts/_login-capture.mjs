import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const AUTH = path.resolve('.auth'); fs.mkdirSync(AUTH, { recursive: true });
const FILE = path.join(AUTH, 'loom-state.json');
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/auth/sign-in`);
console.log('▶ Chromium open — please sign in. Polling /api/me…');
let ok = false; const start = Date.now();
while (Date.now() - start < 15*60*1000) {
  await new Promise(r => setTimeout(r, 2000));
  const r = await page.request.get(`${BASE}/api/me`);
  const j = await r.json().catch(() => null);
  if (j && j.authenticated) { ok = true; console.log('✔ Signed in as', j.user?.upn || j.user?.email); break; }
}
if (ok) { await ctx.storageState({ path: FILE }); console.log('✔ Session saved to .auth/loom-state.json'); }
else console.log('✖ Timed out waiting for sign-in.');
await browser.close();
