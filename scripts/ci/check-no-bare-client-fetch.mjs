#!/usr/bin/env node
/**
 * GUARDRAIL: no-bare-client-fetch  (merge-blocker, RATCHETING)
 * ------------------------------------------------------------------------
 * RULE (rel-T61): every browser→BFF call to a first-party `/api` route from a
 *   CLIENT component MUST go through `clientFetch` (lib/client-fetch.ts), the
 *   client half of the timeout fix. clientFetch carries same-session
 *   credentials (so the loom_session cookie reaches the BFF behind Front Door
 *   instead of a spurious 401), bounds the browser→BFF hop at 6s so a stalled
 *   route can't pin a spinner forever, and transparently refreshes an expired
 *   session. A bare `fetch('/api…')` reintroduces those defects.
 *
 * Mirror of scripts/no-bare-server-fetch.mjs, for the client side.
 *
 * ALLOWED (never flagged):
 *   - STREAMING call sites — clientFetch's 6s abort is wrong for SSE/token
 *     streams, so a `fetch('/api…')` whose URL names a streaming endpoint
 *     (copilot / chat / orchestrate / dax / *-assist / stream) or whose response
 *     is drained via `getReader()` / `text/event-stream` / `EventSource` stays
 *     raw. These are NOT counted.
 *   - Non-`/api` fetches (third-party/absolute URLs), `.fetch(`, `refetch(`,
 *     `window.fetch`, and calls in non-`'use client'` files (server code, which
 *     no-bare-server-fetch.mjs governs).
 *
 * RATCHET: a backlog of non-streaming bare client `/api` fetches predates the
 * rel-T61 codemod (variable-URL calls the codemod couldn't rewrite). Their
 * per-file counts are frozen as BASELINE; CI fails only when a file's count
 * RISES (a NEW bare client fetch). Convert it to clientFetch to clear.
 *
 * HOW TO CLEAR A NEW FAILURE:
 *   import { clientFetch } from '@/lib/client-fetch'; and call clientFetch(...)
 *   instead of fetch(...). Bulk codemod for literal-URL calls:
 *     node apps/fiab-console/scripts/codemod-client-fetch.mjs --apply
 *   then refresh the baseline:
 *     node scripts/ci/check-no-bare-client-fetch.mjs --update-baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const SCOPE_DIRS = ['lib/editors', 'lib/panes', 'lib/components'];

const FETCH_RE = /(?<![\w.$])fetch\(\s*([`'"])\/api/g;
const STREAM_WINDOW = 3500;
const STREAM_URL_RE = /\/api\/[^`'"]*(copilot|\/chat\b|orchestrate|\/dax\b|-assist|\/stream\b)/i;

function isStreaming(src, from) {
  if (STREAM_URL_RE.test(src.slice(from, from + 160))) return true;
  return /getReader\(|text\/event-stream|EventSource/.test(src.slice(from, from + STREAM_WINDOW));
}

/** Count non-streaming bare client `/api` fetches in a 'use client' file. */
function countViolations(src) {
  if (!/^\s*['"]use client['"]/m.test(src.slice(0, 200))) return 0;
  let n = 0, m;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src))) {
    if (!isStreaming(src, m.index)) n++;
  }
  return n;
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

const rel = (f) => path.relative(REPO_ROOT, f).split(path.sep).join('/');

function scan() {
  const counts = {};
  for (const f of listFiles()) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const n = countViolations(src);
    if (n > 0) counts[rel(f)] = n;
  }
  return counts;
}

// __BASELINE_START__  (regenerate with --update-baseline)
// Empty: the rel-T61 codemod converted every non-streaming literal-URL client
// /api fetch, so there is NO backlog to grandfather — the guard starts fully
// clean and any NEW bare client /api fetch fails CI.
const BASELINE = {};
// __BASELINE_END__

function main() {
  const counts = scan();
  if (process.argv.includes('--update-baseline')) {
    const ordered = Object.keys(counts).sort().reduce((o, k) => { o[k] = counts[k]; return o; }, {});
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`// ${Object.keys(counts).length} files, ${total} grandfathered bare client /api fetches`);
    console.log(JSON.stringify(ordered, null, 2));
    process.exit(0);
  }

  const regressions = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = BASELINE[file] ?? 0;
    if (n > allowed) regressions.push({ file, n, allowed });
  }
  const totalNow = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalBase = Object.values(BASELINE).reduce((a, b) => a + b, 0);
  console.log(`[no-bare-client-fetch] scanned 'use client' files in lib/editors + lib/panes + lib/components + app pages`);
  console.log(`[no-bare-client-fetch] grandfathered baseline: ${totalBase} across ${Object.keys(BASELINE).length} files`);
  console.log(`[no-bare-client-fetch] current: ${totalNow} across ${Object.keys(counts).length} files`);
  if (regressions.length) {
    console.error('\n✖ no-bare-client-fetch: NEW bare client /api fetch above the ratchet baseline:');
    for (const r of regressions) console.error(`   - ${r.file}: ${r.n} (baseline ${r.allowed})`);
    console.error('\n  Route it through clientFetch (import { clientFetch } from \'@/lib/client-fetch\')');
    console.error('  so it carries credentials + a 6s timeout. Streaming (copilot/SSE) stays raw.');
    console.error('  Bulk: node apps/fiab-console/scripts/codemod-client-fetch.mjs --apply');
    process.exit(1);
  }
  console.log('✓ no-bare-client-fetch: no new bare client /api fetches above baseline.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
