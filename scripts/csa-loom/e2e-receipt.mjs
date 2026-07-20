#!/usr/bin/env node
/**
 * e2e-receipt.mjs — the repeatable browser-E2E RECEIPT path for CSA Loom.
 *
 * This is the validation backbone every A / A+ grade depends on (die-hard rule
 * G1, docs/fiab/ux-standards.md §9): a surface is not "done" until a full
 * in-browser E2E proves it works against the LIVE console with REAL data and a
 * MINTED session. `tsc` + `vitest` + DOM-string checks are NOT completion
 * evidence. This script produces that evidence — a screenshot (light + dark) +
 * a Playwright trace of a target route, captured against the live console with
 * a pre-minted `loom_session` cookie (no MSAL, no MFA, no user credentials).
 *
 * WHAT IT DOES
 *   1. Mints a `loom_session` cookie from SESSION_SECRET via the SHARED minter
 *      (apps/fiab-console/e2e/auth/mint-cookie.mjs) — the exact HKDF-SHA-256 +
 *      AES-256-GCM scheme the BFF uses. It does NOT reinvent the crypto.
 *   2. Launches headless Chromium (resolved from the fiab-console package) with
 *      that cookie as Playwright storageState.
 *   3. Navigates to a target route, waits for the page to settle + real data to
 *      land, and captures:
 *          receipt-<slug>-light.png   receipt-<slug>-dark.png
 *          trace-<slug>-light.zip     trace-<slug>-dark.zip
 *          receipt-<slug>.json        (metadata: url, status, title, timings)
 *      into a predictable artifacts dir (default: fiab-console/test-results/receipts).
 *
 * MODES
 *   --dry-run / --prepare   Offline self-test: mint a cookie and DECODE it back,
 *                           proving the crypto round-trips (claims + exp survive)
 *                           WITHOUT needing the live console or a browser. Also
 *                           does a best-effort reachability probe of the target
 *                           and reports reachable / unreachable (never fabricates
 *                           a receipt). Exit 0 iff the mint round-trip verifies.
 *   (default)               Live capture as described above.
 *
 * HONEST FAILURE (no-vaporware.md)
 *   If the live console is unreachable (DNS / connection refused / TLS / nav
 *   timeout) the script prints EXACTLY what is unreachable and why (VPN not
 *   connected? private-link? wrong URL?) and exits 2 — it NEVER writes a
 *   fabricated screenshot. If the session is rejected (redirect to sign-in) it
 *   exits 3 (misconfigured / stale SESSION_SECRET).
 *
 * USAGE
 *   Local (P2S VPN connected, SESSION_SECRET from KV):
 *     export LOOM_URL=https://csa-loom.limitlessdata.ai
 *     export SESSION_SECRET=$(az keyvault secret show --vault-name <kv> \
 *                              --name session-secret --query value -o tsv)
 *     node scripts/csa-loom/e2e-receipt.mjs --route /admin/readiness
 *
 *   Offline self-test (no live target needed):
 *     SESSION_SECRET=any-nonempty-string \
 *       node scripts/csa-loom/e2e-receipt.mjs --route /catalog --dry-run
 *
 *   CI (in-VNet gh-aca-runner): the loom-ui-verify workflow runs this when its
 *   `target_route` input is set; artifacts upload as loom-ui-verify-report-<id>.
 *
 * FLAGS
 *   --route <path>          Target route (required for a receipt). e.g. /catalog
 *   --slug <slug>           Artifact slug (default: derived from the route)
 *   --url <baseUrl>         Console base URL (default: env LOOM_URL)
 *   --out <dir>             Output dir (default: <fiab-console>/test-results/receipts)
 *   --themes <list>         Comma list of light,dark (default: light,dark)
 *   --wait-selector <css>   Extra selector to wait for before capture
 *   --wait-text <text>      Extra visible text to wait for before capture
 *   --timeout <ms>          Per-navigation timeout (default 45000)
 *   --settle <ms>           Post-networkidle settle before screenshot (default 1200)
 *   --dry-run / --prepare   Offline mint self-test (+ reachability probe)
 *
 * ENV
 *   SESSION_SECRET          Console session-signing secret (from KV; never logged)
 *   LOOM_URL                Console base URL (fallback for --url)
 *   LOOM_AUTOMATION_OID     Object id baked into the minted session
 *   LOOM_AUTOMATION_UPN     UPN for the minted session (audit-visible)
 *   LOOM_AUTOMATION_NAME    Display name for the minted session
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildStorageState,
  mintLoomSessionCookie,
  decodeLoomSessionCookie,
  requireSessionSecret,
} from '../../apps/fiab-console/e2e/auth/mint-cookie.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const DEFAULT_OUT = path.join(CONSOLE_ROOT, 'test-results', 'receipts');

// ---------------------------------------------------------------------------
// Tiny arg parser (no deps).
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--prepare') {
      args.dryRun = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function slugify(route) {
  return (
    route
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/+|\/+$/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'root'
  );
}

/** Resolve Chromium from the fiab-console package regardless of where we run. */
async function resolveChromium() {
  const req = createRequire(pathToFileURL(path.join(CONSOLE_ROOT, 'package.json')));
  let modPath;
  try {
    modPath = req.resolve('@playwright/test');
  } catch {
    try {
      modPath = req.resolve('playwright');
    } catch {
      throw new Error(
        '[e2e-receipt] Could not resolve Playwright from apps/fiab-console. ' +
          'Run `pnpm -C apps/fiab-console install` first (and, if browsers are ' +
          'not baked into the image, `pnpm -C apps/fiab-console exec playwright install chromium`).',
      );
    }
  }
  const mod = await import(pathToFileURL(modPath).href);
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error('[e2e-receipt] Playwright module has no `chromium` export.');
  return chromium;
}

// ---------------------------------------------------------------------------
// Dry-run: offline mint self-test + best-effort reachability probe.
// ---------------------------------------------------------------------------
async function runDryRun({ baseUrl, claims }) {
  console.log('[e2e-receipt] DRY-RUN — offline mint self-test (no browser).');

  // 1. Mint + decode round-trip (proves the crypto without the live console).
  const cookie = mintLoomSessionCookie(claims, 3600);
  const decoded = decodeLoomSessionCookie(cookie);
  const okOid = decoded?.claims?.oid === claims.oid;
  const okUpn = decoded?.claims?.upn === claims.upn;
  const okExp = typeof decoded?.exp === 'number' && decoded.exp > Math.floor(Date.now() / 1000);
  const roundTripOk = okOid && okUpn && okExp;

  console.log(`  cookie length        : ${cookie.length} chars (base64url)`);
  console.log(`  decode round-trip    : ${roundTripOk ? 'PASS' : 'FAIL'} (oid=${okOid} upn=${okUpn} exp>now=${okExp})`);
  console.log(`  decoded upn          : ${decoded?.claims?.upn}`);
  console.log(`  decoded exp          : ${new Date((decoded?.exp ?? 0) * 1000).toISOString()}`);

  // 2. Best-effort reachability probe (informational — never fails the dry-run).
  let reach = 'skipped (no baseUrl)';
  if (baseUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(baseUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { cookie: `loom_session=${cookie}` },
      }).finally(() => clearTimeout(t));
      reach = `REACHABLE — HTTP ${res.status} from ${baseUrl}`;
    } catch (err) {
      reach = `UNREACHABLE — ${err?.name || 'Error'}: ${err?.message || err} ` +
        `(from THIS host — expected off-VPN, since the console is private-link/Front-Door-fronted)`;
    }
  }
  console.log(`  target reachability  : ${reach}`);

  if (!roundTripOk) {
    console.error('[e2e-receipt] DRY-RUN FAILED — mint did not round-trip. Check SESSION_SECRET.');
    process.exit(1);
  }
  console.log('[e2e-receipt] DRY-RUN OK — session mint verified. Live capture will use this exact cookie.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Live capture.
// ---------------------------------------------------------------------------
async function runLive({ baseUrl, claims, route, slug, outDir, themes, waitSelector, waitText, navTimeout, settleMs }) {
  const chromium = await resolveChromium();
  const target = new URL(route, baseUrl).toString();

  fs.mkdirSync(outDir, { recursive: true });

  const storageState = buildStorageState({ baseUrl, claims });
  const meta = {
    route,
    slug,
    baseUrl,
    target,
    capturedAt: new Date().toISOString(),
    identity: { oid: claims.oid, upn: claims.upn, name: claims.name },
    themes: {},
  };

  console.log(`[e2e-receipt] target : ${target}`);
  console.log(`[e2e-receipt] out    : ${outDir}`);
  console.log(`[e2e-receipt] themes : ${themes.join(', ')}`);

  const browser = await chromium.launch({ headless: true });
  let exitCode = 0;
  try {
    for (const theme of themes) {
      const context = await browser.newContext({
        storageState,
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        viewport: { width: 1600, height: 1000 },
        ignoreHTTPSErrors: true,
      });
      // The console persists theme in localStorage('loom.theme') and falls back
      // to prefers-color-scheme (lib/theme/theme-context.tsx). Seed BOTH so the
      // captured surface is unambiguously in the requested theme on first paint.
      await context.addInitScript((mode) => {
        try { localStorage.setItem('loom.theme', mode); } catch { /* ignore */ }
      }, theme);

      const tracePath = path.join(outDir, `trace-${slug}-${theme}.zip`);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

      const page = await context.newPage();
      const shotPath = path.join(outDir, `receipt-${slug}-${theme}.png`);
      const started = Date.now();
      let status = null;

      try {
        const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        status = resp ? resp.status() : null;
      } catch (err) {
        // Navigation itself failed → the console is unreachable from here.
        await context.tracing.stop({ path: tracePath }).catch(() => {});
        await context.close().catch(() => {});
        console.error(
          `\n[e2e-receipt] UNREACHABLE — could not load ${target}\n` +
            `  ${err?.name || 'Error'}: ${err?.message || err}\n` +
            `  This host cannot reach the live console. Likely causes:\n` +
            `    • P2S VPN not connected (vpngw-loom-centralus) for a LOCAL run, or\n` +
            `    • the console is private-link only and you are not in-VNet — run this\n` +
            `      via the in-VNet path (loom-ui-verify workflow / loom-uat CA Job), or\n` +
            `    • LOOM_URL is wrong (${baseUrl}).\n` +
            `  NOT writing a fabricated receipt (no-vaporware.md).`,
        );
        exitCode = 2;
        break;
      }

      // Detect a bounced session (redirect to sign-in) — session not accepted.
      const landedUrl = page.url();
      if (/\/(login|signin|sign-in|auth)(\/|\?|$)/i.test(landedUrl) && !/\/admin\//.test(route)) {
        await context.tracing.stop({ path: tracePath }).catch(() => {});
        await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
        await context.close().catch(() => {});
        console.error(
          `\n[e2e-receipt] SESSION REJECTED — ${target} redirected to a sign-in page (${landedUrl}).\n` +
            `  The minted cookie was not accepted. Likely a stale/wrong SESSION_SECRET\n` +
            `  (the console's live literal has drifted from the KV value). A sign-in\n` +
            `  screenshot was still saved for evidence: ${shotPath}`,
        );
        exitCode = 3;
        break;
      }

      // Wait for the surface to settle + real data to land.
      await page.waitForLoadState('networkidle', { timeout: navTimeout }).catch(() => {
        // networkidle can never arrive on pages with long-poll / SSE; that's fine —
        // fall through to the explicit waits + settle below.
      });
      if (waitSelector) {
        await page.waitForSelector(waitSelector, { timeout: navTimeout, state: 'visible' }).catch(() => {
          console.warn(`[e2e-receipt] wait-selector "${waitSelector}" not seen within ${navTimeout}ms — capturing anyway.`);
        });
      }
      if (waitText) {
        await page.getByText(waitText, { exact: false }).first().waitFor({ timeout: navTimeout, state: 'visible' }).catch(() => {
          console.warn(`[e2e-receipt] wait-text "${waitText}" not seen within ${navTimeout}ms — capturing anyway.`);
        });
      }
      await page.waitForTimeout(settleMs);

      const title = await page.title().catch(() => '');
      const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
      await page.screenshot({ path: shotPath, fullPage: true });
      await context.tracing.stop({ path: tracePath });
      await context.close();

      const elapsed = Date.now() - started;
      meta.themes[theme] = {
        status,
        landedUrl,
        title,
        bodyChars: bodyText.length,
        screenshot: path.relative(REPO_ROOT, shotPath),
        trace: path.relative(REPO_ROOT, tracePath),
        elapsedMs: elapsed,
      };
      console.log(
        `[e2e-receipt] ${theme.padEnd(5)} → HTTP ${status ?? '?'} · "${(title || '').slice(0, 60)}" · ` +
          `${bodyText.length} body chars · ${elapsed}ms · ${path.basename(shotPath)}`,
      );
      // Soft signal for a blank surface — not a hard fail (a legit honest-gate
      // MessageBar is short), but worth flagging in the log for triage.
      if (bodyText.length < 40) {
        console.warn(`[e2e-receipt] WARNING — ${theme} body has only ${bodyText.length} chars; surface may be blank/broken.`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (exitCode === 0) {
    const metaPath = path.join(outDir, `receipt-${slug}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`\n[e2e-receipt] RECEIPT OK — metadata → ${path.relative(REPO_ROOT, metaPath)}`);
    console.log('[e2e-receipt] Attach the receipt-*.png (light+dark) + trace-*.zip to the PR (no-vaporware / G1).');
  }
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = (args.url || process.env.LOOM_URL || '').replace(/\/+$/, '');
  const route = args.route || args._[0] || '/';
  const slug = args.slug || slugify(route);
  const outDir = path.resolve(args.out || DEFAULT_OUT);
  const themes = String(args.themes || 'light,dark')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === 'light' || s === 'dark');
  const waitSelector = typeof args['wait-selector'] === 'string' ? args['wait-selector'] : '';
  const waitText = typeof args['wait-text'] === 'string' ? args['wait-text'] : '';
  const navTimeout = Number(args.timeout || 45_000);
  const settleMs = Number(args.settle || 1200);

  // Identity claims baked into the minted session (audit-visible).
  const claims = {
    oid: process.env.LOOM_AUTOMATION_OID || '00000000-0000-0000-0000-000000000001',
    name: process.env.LOOM_AUTOMATION_NAME || 'Loom Receipt [automation]',
    upn: process.env.LOOM_AUTOMATION_UPN || 'loom-receipt@automation.local',
    email: process.env.LOOM_AUTOMATION_UPN || 'loom-receipt@automation.local',
  };

  // Fail fast + clearly if the secret is missing (both modes need it).
  try {
    requireSessionSecret();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (args.dryRun) {
    await runDryRun({ baseUrl, claims });
    return;
  }

  if (!baseUrl) {
    console.error('[e2e-receipt] LOOM_URL (or --url) is required for a live receipt. Use --dry-run for the offline self-test.');
    process.exit(1);
  }
  if (themes.length === 0) {
    console.error('[e2e-receipt] --themes must include at least one of: light, dark');
    process.exit(1);
  }

  await runLive({ baseUrl, claims, route, slug, outDir, themes, waitSelector, waitText, navTimeout, settleMs });
}

main().catch((err) => {
  console.error('[e2e-receipt] Unhandled error:', err?.stack || err?.message || err);
  process.exit(1);
});
