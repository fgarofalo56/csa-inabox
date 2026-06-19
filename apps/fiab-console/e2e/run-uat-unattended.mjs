#!/usr/bin/env node
/**
 * Unattended headless entrypoint for the Loom UAT Container App Job.
 *
 * What it does:
 *   1. Reads SESSION_SECRET + LOOM_URL + automation-identity env vars.
 *   2. Calls mintStorageState() (same mechanism as global-setup.ts) to
 *      produce a Playwright storageState object with a pre-minted
 *      loom_session cookie — no MSAL, no MFA, no user credentials.
 *   3. Writes the storageState to .auth/loom-state.json and sets
 *      LOOM_STORAGE_STATE so playwright.config.ts picks it up.
 *   4. Runs `pnpm exec playwright test --project=<UAT_PROJECT>` (default: uat).
 *      UAT_GREP narrows to a spec pattern (slice run).
 *   5. Reads test-results/uat/report.json and prints a one-line summary:
 *        UAT_RESULT pass=<n> fail=<n> skip=<n>
 *      Exits non-zero if any test failed.
 *   6. (Best-effort) Uploads playwright-report/ + report.json to blob
 *      when LOOM_UAT_RESULTS_CONTAINER is set.
 *
 * Required env vars:
 *   SESSION_SECRET          — console session-signing secret (from ARM literal)
 *   LOOM_URL                — console base URL (e.g. https://loom-console.b02.azurefd.net)
 *
 * Optional env vars:
 *   LOOM_AUTOMATION_OID     — object ID baked into the minted session (default: sentinel)
 *   LOOM_AUTOMATION_UPN     — UPN for the minted session
 *   LOOM_AUTOMATION_NAME    — display name for the minted session
 *   UAT_PROJECT             — playwright --project value (default: uat)
 *   UAT_GREP                — playwright --grep pattern for a slice run
 *   LOOM_UAT_RESULTS_CONTAINER — ADLS/blob URL; when set, uploads HTML report + JSON
 *
 * Usage (in Container App Job):
 *   node e2e/run-uat-unattended.mjs
 *   # Or run a slice first:
 *   UAT_GREP="catalog" node e2e/run-uat-unattended.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root of the fiab-console package (one level up from e2e/).
const ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(ROOT, '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'loom-state.json');
const REPORT_JSON = path.join(ROOT, 'test-results', 'uat', 'report.json');
const HTML_REPORT_DIR = path.join(ROOT, 'playwright-report');

// ---------------------------------------------------------------------------
// Inline session mint — mirrors mint-session.ts using only Node built-ins so
// this .mjs entrypoint has zero imports from the TypeScript source tree.
// The algorithm is IDENTICAL to lib/auth/session.ts (HKDF-SHA-256 + AES-256-GCM).
// ---------------------------------------------------------------------------
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const HKDF_INFO = 'loom-session-v1';
const COOKIE_NAME = 'loom_session';

function deriveKey(sessionSecret) {
  const ab = crypto.hkdfSync(
    'sha256',
    Buffer.from(sessionSecret, 'utf-8'),
    Buffer.alloc(32),
    Buffer.from(HKDF_INFO),
    32,
  );
  return Buffer.from(ab);
}

function mintCookieValue(sessionSecret, claims, ttlSecs = 28_800) {
  const key = deriveKey(sessionSecret);
  const payload = { claims, exp: Math.floor(Date.now() / 1000) + ttlSecs };
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plain = Buffer.from(JSON.stringify(payload), 'utf-8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function buildStorageState(baseUrl, claims, ttlSecs = 28_800) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error(
      '[run-uat-unattended] SESSION_SECRET is required.\n' +
      '  Pull it from the console container-app literal via ARM:\n' +
      '  az containerapp secret show -n loom-console -g $ADMIN_RG --secret-name session-secret --query value -o tsv',
    );
  }
  const host = new URL(baseUrl).hostname;
  const value = mintCookieValue(sessionSecret, claims, ttlSecs);
  const expires = Math.floor(Date.now() / 1000) + ttlSecs;
  return {
    cookies: [
      {
        name: COOKIE_NAME,
        value,
        domain: host,
        path: '/',
        expires,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
}

// ---------------------------------------------------------------------------
// Summary reader
// ---------------------------------------------------------------------------
function readSummary() {
  try {
    const raw = fs.readFileSync(REPORT_JSON, 'utf-8');
    const report = JSON.parse(raw);
    // Playwright JSON reporter top-level structure: { stats: { expected, unexpected, skipped, ... } }
    const stats = report.stats || {};
    const pass = stats.expected ?? 0;
    const fail = stats.unexpected ?? 0;
    const skip = stats.skipped ?? 0;
    return { pass, fail, skip };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Optional results upload
// ---------------------------------------------------------------------------
function uploadResults() {
  const container = process.env.LOOM_UAT_RESULTS_CONTAINER;
  if (!container) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    // Upload HTML report directory
    if (fs.existsSync(HTML_REPORT_DIR)) {
      execSync(
        `az storage blob upload-batch --source "${HTML_REPORT_DIR}" --destination "${container}/uat-runs/${stamp}/playwright-report/" --auth-mode login --overwrite`,
        { stdio: 'inherit' },
      );
    }
    // Upload JSON report
    if (fs.existsSync(REPORT_JSON)) {
      execSync(
        `az storage blob upload --file "${REPORT_JSON}" --container-name "" --name "uat-runs/${stamp}/report.json" --blob-url "${container}/uat-runs/${stamp}/report.json" --auth-mode login --overwrite`,
        { stdio: 'inherit' },
      );
    }
    console.log(`[run-uat-unattended] Results uploaded to ${container}/uat-runs/${stamp}/`);
  } catch (err) {
    // Non-fatal — results are still in the container job logs.
    console.warn(`[run-uat-unattended] Results upload failed (non-fatal): ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // --- 1. Validate required env vars ----------------------------------------
  const loomUrl = process.env.LOOM_URL;
  if (!loomUrl) {
    console.error('[run-uat-unattended] LOOM_URL is required.');
    process.exit(1);
  }

  const oid = process.env.LOOM_AUTOMATION_OID || '00000000-0000-0000-0000-000000000001';
  const upn = process.env.LOOM_AUTOMATION_UPN || 'loom-uat@automation.local';
  const name = process.env.LOOM_AUTOMATION_NAME || 'Loom UAT [automation]';
  const claims = { oid, name, upn, email: upn };

  const project = process.env.UAT_PROJECT || 'uat';
  const grep = process.env.UAT_GREP || '';

  console.log(`[run-uat-unattended] target   : ${loomUrl}`);
  console.log(`[run-uat-unattended] project  : ${project}${grep ? ` (grep: ${grep})` : ' (full suite)'}`);
  console.log(`[run-uat-unattended] identity : oid=${oid} upn=${upn}`);

  // --- 2. Mint storageState -------------------------------------------------
  let storageState;
  try {
    storageState = buildStorageState(loomUrl, claims);
  } catch (err) {
    console.error(`[run-uat-unattended] Failed to mint session: ${err.message}`);
    process.exit(1);
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(storageState, null, 2));
  console.log(`[run-uat-unattended] session minted → ${AUTH_FILE}`);

  // --- 3. Set env vars for playwright.config.ts ----------------------------
  process.env.LOOM_STORAGE_STATE = AUTH_FILE;
  process.env.LOOM_URL = loomUrl;

  // --- 4. Run Playwright ----------------------------------------------------
  let playwrightExitCode = 0;
  try {
    const grepArg = grep ? ` --grep "${grep}"` : '';
    const cmd = `pnpm exec playwright test --project=${project}${grepArg}`;
    console.log(`[run-uat-unattended] running: ${cmd}`);
    execSync(cmd, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (err) {
    // execSync throws when the child exits non-zero.
    playwrightExitCode = err.status ?? 1;
  }

  // --- 5. Emit summary ------------------------------------------------------
  const summary = readSummary();
  if (summary) {
    const { pass, fail, skip } = summary;
    console.log(`\nUAT_RESULT pass=${pass} fail=${fail} skip=${skip}`);
    if (fail > 0) {
      console.error(`[run-uat-unattended] ${fail} test(s) FAILED.`);
    } else {
      console.log(`[run-uat-unattended] All tests PASSED.`);
    }
  } else {
    console.warn('[run-uat-unattended] Could not read test-results/uat/report.json — check Playwright output above.');
    console.log(`UAT_RESULT exit_code=${playwrightExitCode}`);
  }

  // --- 6. Best-effort results upload ----------------------------------------
  uploadResults();

  // Exit with the playwright exit code so the CA job marks itself failed/passed.
  process.exit(playwrightExitCode);
}

main().catch((err) => {
  console.error('[run-uat-unattended] Unhandled error:', err?.message || err);
  process.exit(1);
});
