#!/usr/bin/env node
/**
 * parity-autopilot.mjs — WS-10.5 Parity Autopilot (BTB-12), the SCHEDULED job.
 *
 * The cron-able driver of the "keep the surface honest at scale" loop:
 *
 *   Playwright capture (Track-0) → AOAI vision diff vs the parity doc →
 *   `plan-model` proposal → `gh issue` filing — for one or more target surfaces.
 *
 * It reuses the EXISTING pieces rather than reinventing them:
 *   1. CAPTURE   — spawns scripts/csa-loom/e2e-receipt.mjs (the merged Track-0
 *                  receipt backbone) to capture a real, minted-session screenshot
 *                  of the target route against the LIVE console. No fabricated
 *                  image — if the console is unreachable, e2e-receipt exits
 *                  non-zero and this script propagates that honest failure.
 *   2. DIFF+PLAN+FILE — POSTs the captured PNG + the parity-doc markdown to the
 *                  console BFF `POST /api/admin/parity-autopilot/run` (minted
 *                  session cookie, same crypto as e2e-receipt). The route runs
 *                  the REAL AOAI vision diff, the REAL plan-model, and files the
 *                  REAL GitHub issue, then persists a run doc. This script does
 *                  NOT re-implement any of that — it wires capture → route.
 *
 * TARGETS
 *   --slug <slug>        A parity-doc slug under docs/fiab/parity/ (repeatable via
 *                        comma list, e.g. --slug report,lakehouse). REQUIRED
 *                        unless --all is passed.
 *   --route <path>       Route override for the single-slug case. When omitted the
 *                        route is read from the doc's `Route:` line; a slug with no
 *                        declared route AND no --route is skipped (honest — logged).
 *   --all                Run every parity doc that declares a `Route:` line.
 *   --max <n>            Cap the number of surfaces processed (default 10).
 *
 * CONNECTION
 *   --url <baseUrl>      Console base URL (default env LOOM_URL).
 *   --theme <light|dark> Capture theme (default light).
 *   --dry-run            Offline: resolve routes + parse Route: lines + mint
 *                        round-trip, WITHOUT capturing or POSTing. Never fabricates
 *                        a run. Exit 0 iff the mint verifies.
 *
 * ENV (same as e2e-receipt.mjs)
 *   SESSION_SECRET       Console session-signing secret (mints the cookie).
 *   LOOM_URL             Console base URL.
 *   LOOM_AUTOMATION_*    Identity baked into the minted session (audit-visible).
 *
 * HONEST FAILURE (no-vaporware.md): the console being unreachable, the session
 * being rejected, or AOAI/GitHub being unconfigured are all reported as exactly
 * what they are — never masked, never mocked. A gated run still persists a run
 * doc (server-side) explaining the gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { mintLoomSessionCookie, requireSessionSecret } from '../../apps/fiab-console/e2e/auth/mint-cookie.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PARITY_DIR = path.join(REPO_ROOT, 'docs', 'fiab', 'parity');
const RECEIPT_SCRIPT = path.join(__dirname, 'e2e-receipt.mjs');
const RECEIPTS_OUT = path.join(REPO_ROOT, 'apps', 'fiab-console', 'test-results', 'receipts');

// ── Tiny arg parser (matches e2e-receipt.mjs style) ─────────────────────────
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--prepare') args.dryRun = true;
    else if (a === '--all') args.all = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

/** Read the `Route:` line from a parity doc's raw markdown (the one thing the
 *  script needs client-side; the server re-parses the whole doc). */
export function routeFromDoc(md) {
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:Live\s+)?Route:\s*`?([^`\s]+)`?/i);
    if (m) {
      const cand = m[1].trim();
      if (cand.startsWith('/')) return cand;
    }
  }
  return null;
}

/** Resolve the list of {slug, route} targets from args. */
function resolveTargets(args) {
  const maxN = Number(args.max || 10);
  const targets = [];
  if (args.all) {
    if (!fs.existsSync(PARITY_DIR)) return [];
    for (const name of fs.readdirSync(PARITY_DIR).sort()) {
      if (!name.endsWith('.md') || name.startsWith('MASTER')) continue;
      const slug = name.replace(/\.md$/, '');
      const md = fs.readFileSync(path.join(PARITY_DIR, name), 'utf8');
      const route = routeFromDoc(md);
      if (route) targets.push({ slug, route });
      if (targets.length >= maxN) break;
    }
    return targets;
  }
  const slugArg = String(args.slug || args._[0] || '').trim();
  if (!slugArg) return [];
  for (const slug of slugArg.split(',').map((s) => s.trim()).filter(Boolean)) {
    const docPath = path.join(PARITY_DIR, `${slug}.md`);
    if (!fs.existsSync(docPath)) {
      console.error(`[parity-autopilot] no parity doc for slug "${slug}" (${path.relative(REPO_ROOT, docPath)}) — skipping.`);
      continue;
    }
    const md = fs.readFileSync(docPath, 'utf8');
    const route = (typeof args.route === 'string' && args.route.startsWith('/')) ? args.route : routeFromDoc(md);
    targets.push({ slug, route, md });
    if (targets.length >= maxN) break;
  }
  return targets;
}

/** Capture a screenshot of `route` via e2e-receipt.mjs (Track-0). Returns the
 *  PNG path, or throws with the honest reason (unreachable / session rejected). */
function captureSurface({ slug, route, baseUrl, theme }) {
  const receiptSlug = `parity-${slug}`;
  const res = spawnSync(
    process.execPath,
    [RECEIPT_SCRIPT, '--route', route, '--slug', receiptSlug, '--url', baseUrl, '--themes', theme, '--out', RECEIPTS_OUT],
    { stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
  );
  if (res.status !== 0) {
    // e2e-receipt already printed the precise honest reason (exit 2 unreachable,
    // 3 session rejected). Propagate it.
    throw new Error(`capture failed for /${slug} (e2e-receipt exit ${res.status}) — see the message above.`);
  }
  const png = path.join(RECEIPTS_OUT, `receipt-${receiptSlug}-${theme}.png`);
  if (!fs.existsSync(png)) throw new Error(`capture reported success but ${path.relative(REPO_ROOT, png)} is missing.`);
  return png;
}

/** POST the captured PNG + doc markdown to the console run route. */
async function postRun({ baseUrl, cookie, slug, route, md, pngPath, theme }) {
  const imageBase64 = fs.readFileSync(pngPath).toString('base64');
  const target = new URL('/api/admin/parity-autopilot/run', baseUrl).toString();
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `loom_session=${cookie}` },
    body: JSON.stringify({
      slug, route, docMarkdown: md, imageBase64, contentType: 'image/png',
      theme, capturedAt: new Date().toISOString(), url: new URL(route, baseUrl).toString(),
    }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json?.ok) {
    throw new Error(`run route ${res.status}: ${text.slice(0, 300)}`);
  }
  return json.run;
}

// ── Dry-run: offline route resolution + mint round-trip ─────────────────────
function runDryRun(targets, claims) {
  console.log('[parity-autopilot] DRY-RUN — offline route resolution + mint self-test (no capture, no POST).');
  const cookie = mintLoomSessionCookie(claims, 3600);
  const ok = typeof cookie === 'string' && cookie.length > 20;
  console.log(`  session mint         : ${ok ? 'PASS' : 'FAIL'} (${cookie.length} chars)`);
  console.log(`  resolvable targets   : ${targets.length}`);
  for (const t of targets) console.log(`    - ${t.slug.padEnd(28)} ${t.route ? `→ ${t.route}` : '(no Route: declared — would be skipped)'}`);
  if (!ok) { console.error('[parity-autopilot] DRY-RUN FAILED — mint did not produce a cookie. Check SESSION_SECRET.'); process.exit(1); }
  console.log('[parity-autopilot] DRY-RUN OK.');
  process.exit(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args.url || process.env.LOOM_URL || '').replace(/\/+$/, '');
  const theme = (String(args.theme || 'light').toLowerCase() === 'dark') ? 'dark' : 'light';

  const claims = {
    oid: process.env.LOOM_AUTOMATION_OID || '00000000-0000-0000-0000-000000000001',
    name: process.env.LOOM_AUTOMATION_NAME || 'Loom Parity Autopilot [automation]',
    upn: process.env.LOOM_AUTOMATION_UPN || 'parity-autopilot@automation.local',
    email: process.env.LOOM_AUTOMATION_UPN || 'parity-autopilot@automation.local',
  };

  try { requireSessionSecret(); }
  catch (err) { console.error(err.message); process.exit(1); }

  const targets = resolveTargets(args);
  if (targets.length === 0) {
    console.error('[parity-autopilot] no targets. Pass --slug <slug[,slug]> (or --all for every doc with a Route:).');
    process.exit(1);
  }

  if (args.dryRun) return runDryRun(targets, claims);

  if (!baseUrl) {
    console.error('[parity-autopilot] LOOM_URL (or --url) is required for a live run. Use --dry-run for the offline self-test.');
    process.exit(1);
  }

  const cookie = mintLoomSessionCookie(claims, 3600);
  let filedTotal = 0, gapTotal = 0, ranTotal = 0, failed = 0;

  for (const t of targets) {
    const md = t.md || fs.readFileSync(path.join(PARITY_DIR, `${t.slug}.md`), 'utf8');
    if (!t.route) {
      console.warn(`[parity-autopilot] ${t.slug}: no Route: declared and no --route — skipping (honest).`);
      continue;
    }
    console.log(`\n[parity-autopilot] ▶ ${t.slug} → ${t.route}`);
    try {
      const png = captureSurface({ slug: t.slug, route: t.route, baseUrl, theme });
      const run = await postRun({ baseUrl, cookie, slug: t.slug, route: t.route, md, pngPath: png, theme });
      ranTotal++;
      gapTotal += run.gapCount || 0;
      const filed = (run.gaps || []).filter((g) => g.issue?.filed).length;
      const deduped = (run.gaps || []).filter((g) => g.issue?.deduped).length;
      filedTotal += filed;
      if (run.gated) {
        console.log(`  ⚠ gated: ${run.gateReason}`);
      } else {
        console.log(`  ✓ checked ${run.checked} built rows · ${run.gapCount} gap(s) · ${filed} issue(s) filed · ${deduped} already-open`);
        for (const g of run.gaps || []) {
          const st = g.issue?.filed ? `filed #${g.issue.issueNumber}`
            : g.issue?.deduped ? `open #${g.issue.issueNumber}`
            : g.issue?.gated ? 'issue gated' : (g.issue?.error || 'not filed');
          console.log(`      • #${g.gap.num} ${g.gap.capability} — ${st}`);
        }
      }
    } catch (e) {
      failed++;
      console.error(`  ✗ ${e.message}`);
    }
  }

  console.log(`\n[parity-autopilot] done — ${ranTotal} run(s), ${gapTotal} gap(s), ${filedTotal} issue(s) filed, ${failed} failure(s).`);
  // A capture/route failure is a real failure (exit 1) so the schedule surfaces
  // it; a clean run with zero gaps is success (exit 0).
  process.exit(failed > 0 ? 1 : 0);
}

// Only run when invoked directly (so unit tests can import routeFromDoc).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[parity-autopilot] Unhandled error:', err?.stack || err?.message || err);
    process.exit(1);
  });
}
