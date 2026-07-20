#!/usr/bin/env node
/**
 * check-local-profile — golden-path local-dev readiness check (WS-J / J2).
 * ---------------------------------------------------------------------------
 * Prints PASS / FAIL / INFO for every prerequisite the local "golden path"
 * needs, plus a clear fix for anything missing. Exits non-zero if any REQUIRED
 * prerequisite fails, 0 otherwise.
 *
 * This is a *real* check — it inspects the actual environment, the console's
 * `.env.local`, installed dependencies, and the minted local-session artifact.
 * Nothing is faked: an absent Azure backend is reported honestly as INFO
 * ("demo mode"), never as a spurious PASS (no-vaporware.md).
 *
 * Usage:
 *   node scripts/dev/check-local-profile.mjs          # human-readable
 *   node scripts/dev/check-local-profile.mjs --json    # machine-readable
 *
 * See docs/fiab/local-golden-path.md for the end-to-end flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const ENV_LOCAL = path.join(CONSOLE_ROOT, '.env.local');
const AUTH_STATE = path.join(CONSOLE_ROOT, '.auth', 'loom-local-state.json');

const MIN_NODE_MAJOR = 20; // apps/fiab-console/package.json engines.node >= 20
const MIN_PNPM_MAJOR = 9; // engines.pnpm >= 9

const JSON_OUT = process.argv.includes('--json');

// --- tiny .env parser (KEY=VALUE, ignores # comments / blanks) --------------
function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Effective value: real process.env wins, then .env.local. */
function envValue(fileEnv, name) {
  return process.env[name] ?? fileEnv[name] ?? '';
}

const results = [];
function record(status, name, detail, fix) {
  results.push({ status, name, detail, fix: fix || '' });
}

function main() {
  const fileEnv = parseEnvFile(ENV_LOCAL);

  // 1. Node version (REQUIRED) ------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= MIN_NODE_MAJOR) {
    record('PASS', 'node-version', `node ${process.versions.node} (>= ${MIN_NODE_MAJOR})`);
  } else {
    record(
      'FAIL',
      'node-version',
      `node ${process.versions.node} is below the required ${MIN_NODE_MAJOR}.x`,
      `Install Node >= ${MIN_NODE_MAJOR} (see apps/fiab-console/package.json "engines").`,
    );
  }

  // 2. pnpm available (REQUIRED) ---------------------------------------------
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: true });
  const pnpmVer = (pnpm.stdout || '').trim();
  if (pnpm.status === 0 && pnpmVer) {
    const pnpmMajor = Number(pnpmVer.split('.')[0]);
    if (pnpmMajor >= MIN_PNPM_MAJOR) {
      record('PASS', 'pnpm', `pnpm ${pnpmVer} (>= ${MIN_PNPM_MAJOR})`);
    } else {
      record('FAIL', 'pnpm', `pnpm ${pnpmVer} is below the required ${MIN_PNPM_MAJOR}.x`, 'npm i -g pnpm@latest');
    }
  } else {
    record('FAIL', 'pnpm', 'pnpm is not on PATH', 'npm i -g pnpm@latest  (engines.pnpm >= 9)');
  }

  // 3. SESSION_SECRET present (REQUIRED for local sign-in) --------------------
  const secret = envValue(fileEnv, 'SESSION_SECRET');
  if (secret && secret.length >= 16) {
    const source = process.env.SESSION_SECRET ? 'process.env' : '.env.local';
    record('PASS', 'session-secret', `SESSION_SECRET set (${secret.length} chars, from ${source})`);
  } else if (secret) {
    record('FAIL', 'session-secret', `SESSION_SECRET is only ${secret.length} chars (need >= 16)`, 'node scripts/dev/local-golden-path.mjs --prepare-only');
  } else {
    record(
      'FAIL',
      'session-secret',
      'SESSION_SECRET is not set (required to encrypt/verify the local session cookie)',
      'node scripts/dev/local-golden-path.mjs --prepare-only   (generates one into apps/fiab-console/.env.local)',
    );
  }

  // 4. Console dependencies installed (REQUIRED to run `next dev`) ------------
  if (fs.existsSync(path.join(CONSOLE_ROOT, 'node_modules'))) {
    record('PASS', 'console-deps', 'apps/fiab-console/node_modules present');
  } else {
    record(
      'FAIL',
      'console-deps',
      'apps/fiab-console/node_modules is missing',
      'pnpm install   (run at the repo root)',
    );
  }

  // 5. Minted local-session artifact (INFO — auto-created by golden path) -----
  if (fs.existsSync(AUTH_STATE)) {
    record('INFO', 'local-session', `minted Playwright session at ${path.relative(REPO_ROOT, AUTH_STATE)}`);
  } else {
    record(
      'INFO',
      'local-session',
      'no minted local session yet',
      'node scripts/dev/local-golden-path.mjs --prepare-only   (mints .auth/loom-local-state.json)',
    );
  }

  // 6. Playwright chromium (INFO — enables auto-signed-in browser) ------------
  const hasPwDep = fs.existsSync(path.join(CONSOLE_ROOT, 'node_modules', '@playwright', 'test'));
  record(
    hasPwDep ? 'INFO' : 'INFO',
    'playwright',
    hasPwDep ? '@playwright/test available (auto-signed-in browser supported)' : 'Playwright not installed (optional — only needed for the auto-signed-in browser)',
    hasPwDep ? '' : 'pnpm --dir apps/fiab-console exec playwright install chromium',
  );

  // 7. Azure backend profile (INFO — unset => honest demo mode) --------------
  const azureMarkers = ['LOOM_SUBSCRIPTION_ID', 'LOOM_SYNAPSE_WORKSPACE', 'LOOM_COSMOS_ENDPOINT'];
  const setMarkers = azureMarkers.filter((m) => envValue(fileEnv, m));
  if (setMarkers.length === 0) {
    record(
      'INFO',
      'backend-profile',
      'no Azure backends configured — DEMO MODE: the shell, catalog, and editor surfaces render; data panels show honest "not configured" gates',
      'Optional: set LOOM_SUBSCRIPTION_ID + per-service vars in .env.local to light up live data (see docs/fiab/local-golden-path.md).',
    );
  } else {
    record('INFO', 'backend-profile', `live-backed: ${setMarkers.join(', ')} set`);
  }

  // --- report ---------------------------------------------------------------
  const failures = results.filter((r) => r.status === 'FAIL');

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failures.length === 0, results }, null, 2));
  } else {
    console.log('\nCSA Loom — local golden-path readiness\n');
    const icon = { PASS: '  [PASS]', FAIL: '  [FAIL]', INFO: '  [info]' };
    for (const r of results) {
      console.log(`${icon[r.status]} ${r.name}: ${r.detail}`);
      if (r.fix && r.status !== 'PASS') console.log(`         fix: ${r.fix}`);
    }
    console.log('');
    if (failures.length === 0) {
      console.log('READY — required prerequisites pass. Start the console with:');
      console.log('  node scripts/dev/local-golden-path.mjs --start');
      console.log('  (or)  pnpm --dir apps/fiab-console dev\n');
    } else {
      console.log(`NOT READY — ${failures.length} required prerequisite(s) failing. See the fixes above.\n`);
    }
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main();
