#!/usr/bin/env node
/**
 * codemod-client-fetch (rel-T61, one-shot)
 * ---------------------------------------------------------------------------
 * Rewrites raw browser `fetch('/api…')` calls in CLIENT components to
 * `clientFetch` (lib/client-fetch.ts), which adds same-session credentials
 * (fixes the Front Door 401), a 6s fast-fail timeout, and transparent
 * session-expiry refresh+retry. See lib/client-fetch.ts for the rationale.
 *
 * SCOPE: `'use client'` files under lib/editors, lib/panes, lib/components,
 * and app/**\/page.tsx — browser code only. Server fetches (lib/azure,
 * lib/install, route handlers) are the domain of fetchWithTimeout and are
 * NOT touched (guarded by no-bare-server-fetch.mjs).
 *
 * ONLY first-party `/api` URLs are converted (string or template literal
 * starting with `/api`), and STREAMING call sites are skipped — clientFetch's
 * 6s abort is wrong for a long-lived stream. A call is treated as streaming if
 * its URL names a known streaming endpoint (copilot / chat / orchestrate / dax
 * / *-assist / stream) OR `getReader(` / `text/event-stream` / `EventSource`
 * appears within ~3.5k chars after it (the response is drained as a stream).
 * `refetch(`, `.fetch(`, `window.fetch(` and already-`clientFetch(` are not
 * matched.
 *
 * Run:  node scripts/codemod-client-fetch.mjs [--apply]   (dry-run by default)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const SCOPE_DIRS = ['lib/editors', 'lib/panes', 'lib/components'];

const IMPORT_LINE = "import { clientFetch } from '@/lib/client-fetch';";
// bare `fetch(` (not .fetch / clientFetch / refetch / prefetch), then optional
// ws, then a quote/backtick opening a `/api` URL.
const FETCH_RE = /(?<![\w.$])fetch\(\s*([`'"])\/api/g;
// getReader/SSE can sit well after the fetch options block — use a generous
// backstop window; over-skipping only leaves a call as raw fetch (grandfathered).
const STREAM_WINDOW = 3500;
// Known streaming endpoint markers in the URL just after `fetch(` — every SSE/
// token-stream copilot route matches one of these; the primary, robust signal.
const STREAM_URL_RE = /\/api\/[^`'"]*(copilot|\/chat\b|orchestrate|\/dax\b|-assist|\/stream\b)/i;

function isStreaming(src, from) {
  const head = src.slice(from, from + 160);
  if (STREAM_URL_RE.test(head)) return true;
  const w = src.slice(from, from + STREAM_WINDOW);
  return /getReader\(|text\/event-stream|EventSource/.test(w);
}

function transform(src) {
  if (!/^\s*['"]use client['"]/m.test(src.slice(0, 200))) return { out: src, count: 0 };
  let count = 0;
  // Right-to-left so indices stay valid while we splice `client` before `fetch`.
  const hits = [];
  let m;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src))) {
    if (isStreaming(src, m.index)) continue;
    // m.index points at 'fetch'; record the position of that token.
    hits.push(m.index);
  }
  if (!hits.length) return { out: src, count: 0 };
  let out = src;
  for (let i = hits.length - 1; i >= 0; i--) {
    const idx = hits[i];
    out = out.slice(0, idx) + 'clientFetch' + out.slice(idx + 'fetch'.length);
    count++;
  }
  // Ensure the import exists.
  if (!/from\s+['"]@\/lib\/client-fetch['"]/.test(out)) {
    const uc = out.match(/^(\s*['"]use client['"];?\s*\n)/m);
    if (uc) {
      const at = uc.index + uc[0].length;
      out = out.slice(0, at) + IMPORT_LINE + '\n' + out.slice(at);
    } else {
      out = IMPORT_LINE + '\n' + out;
    }
  }
  return { out, count };
}

function listFiles() {
  const files = [];
  try {
    const out = execSync(`git ls-files ${SCOPE_DIRS.join(' ')}`, { cwd: APP_ROOT, encoding: 'utf8' });
    for (const f of out.split('\n').map((s) => s.trim())) {
      if (f.endsWith('.tsx') && !f.includes('__tests__')) files.push(path.join(APP_ROOT, f));
    }
  } catch { /* ignore */ }
  const appDir = path.join(APP_ROOT, 'app');
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules' && ent.name !== '.next') walk(full); }
      else if (ent.name === 'page.tsx') files.push(full);
    }
  };
  if (fs.existsSync(appDir)) walk(appDir);
  return files;
}

let totalFiles = 0, totalRepl = 0;
for (const file of listFiles()) {
  const src = fs.readFileSync(file, 'utf8');
  const { out, count } = transform(src);
  if (count > 0) {
    totalFiles++; totalRepl += count;
    if (APPLY) fs.writeFileSync(file, out);
    console.log(`${count.toString().padStart(3)}  ${path.relative(APP_ROOT, file).split(path.sep).join('/')}`);
  }
}
console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${totalRepl} client /api fetch → clientFetch across ${totalFiles} files.`);
