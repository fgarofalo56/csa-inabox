#!/usr/bin/env node
/**
 * CSA Loom — exercise every backend service data path from CI (unattended).
 *
 * Mints a loom_session cookie from SESSION_SECRET (identical encoding to
 * lib/auth/session.ts / e2e/auth/mint-session.ts — Node builtins only, no
 * dependencies), POSTs /api/admin/health/exercise to start a probe run, polls
 * GET until the run completes, prints the report, and exits non-zero when any
 * probe reports a REAL 'fail'. Honest gates ('gate' = backend not configured)
 * are printed as warnings and do NOT fail the job — a fresh minimal deployment
 * is all-gates, zero-fails.
 *
 * Required env:
 *   LOOM_URL              console base URL (e.g. https://…azurefd.net)
 *   SESSION_SECRET        from the loom Key Vault (secret 'session-secret')
 *   LOOM_AUTOMATION_OID   Entra oid baked into the session — MUST be a tenant
 *                         admin (LOOM_TENANT_ADMIN_OID or in the admin group),
 *                         because the exercise route is tenant-admin gated.
 * Optional env:
 *   LOOM_AUTOMATION_UPN / LOOM_AUTOMATION_NAME   identity cosmetics
 *   EXERCISE_SERVICES     comma-separated probe filter (e.g. "spark,adx")
 *   EXERCISE_POLL_TIMEOUT_MS   max wait for the run (default 480000 = 8 min)
 */

import crypto from 'node:crypto';

// ── config ───────────────────────────────────────────────────────────────────
const BASE_URL = (process.env.LOOM_URL || '').replace(/\/+$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const OID = process.env.LOOM_AUTOMATION_OID || '';
const UPN = process.env.LOOM_AUTOMATION_UPN || 'loom-exercise@automation.local';
const NAME = process.env.LOOM_AUTOMATION_NAME || 'Loom Exercise [automation]';
const SERVICES = (process.env.EXERCISE_SERVICES || '').split(',').map((s) => s.trim()).filter(Boolean);
const POLL_TIMEOUT_MS = Number(process.env.EXERCISE_POLL_TIMEOUT_MS) || 480_000;
const POLL_INTERVAL_MS = 10_000;

function fatal(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

if (!BASE_URL) fatal('LOOM_URL is required (the console base URL).');
if (!SESSION_SECRET) fatal('SESSION_SECRET is required (fetch it from the loom Key Vault, secret "session-secret").');
if (!OID) fatal('LOOM_AUTOMATION_OID is required and must be a tenant-admin principal (LOOM_TENANT_ADMIN_OID or a member of LOOM_TENANT_ADMIN_GROUP_ID).');

// ── mint the loom_session cookie (matches lib/auth/session.ts exactly) ───────
function mintCookie(ttlSecs = 3600) {
  const key = Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(SESSION_SECRET, 'utf-8'),
    Buffer.alloc(32),
    Buffer.from('loom-session-v1'),
    32,
  ));
  const payload = {
    claims: { oid: OID, name: NAME, upn: UPN, email: UPN },
    exp: Math.floor(Date.now() / 1000) + ttlSecs,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf-8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

const COOKIE = `loom_session=${mintCookie()}`;

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── run ──────────────────────────────────────────────────────────────────────
const start = await api('POST', '/api/admin/health/exercise', SERVICES.length ? { services: SERVICES } : undefined);
if (start.status === 401) fatal('401 unauthenticated — the minted cookie was rejected. Is SESSION_SECRET the value from THIS deployment\'s Key Vault?');
if (start.status === 403) fatal('403 forbidden — LOOM_AUTOMATION_OID is not a tenant admin. Set LOOM_TENANT_ADMIN_OID to it (or add it to LOOM_TENANT_ADMIN_GROUP_ID) on the Console app.');
if (!start.json?.ok) fatal(`Failed to start the exercise run (HTTP ${start.status}): ${start.json?.error || 'no response body'}`);

const runId = start.json.runId;
console.log(`Exercise run started: ${runId}${start.json.alreadyRunning ? ' (a run was already in progress — polling it)' : ''}${SERVICES.length ? ` [services: ${SERVICES.join(', ')}]` : ' [all services]'}`);

let state = null;
const deadline = Date.now() + POLL_TIMEOUT_MS;
for (;;) {
  if (Date.now() > deadline) fatal(`Exercise run did not complete within ${POLL_TIMEOUT_MS}ms.`);
  await sleep(POLL_INTERVAL_MS);
  const poll = await api('GET', '/api/admin/health/exercise');
  if (!poll.json?.ok) {
    console.log(`poll: transient HTTP ${poll.status} — retrying`);
    continue;
  }
  state = poll.json.state;
  if (!state) { console.log('poll: no state yet — retrying'); continue; }
  // Only accept the report for THE run we started — a replica serving a stale
  // previous 'complete' doc must never be mistaken for this run's result.
  if (state.runId !== runId) { console.log(`poll: replica served run ${state.runId} (waiting for ${runId}) — retrying`); continue; }
  if (state.status === 'complete' && state.report) break;
  if (poll.json.stale) fatal('The run went stale (the console replica likely restarted mid-run). Re-dispatch the workflow.');
  console.log(`poll: run ${state.runId} still in progress (started ${state.startedAt})`);
}

// ── report ───────────────────────────────────────────────────────────────────
const report = state.report;
const ICON = { pass: 'PASS', gate: 'GATE', fail: 'FAIL' };
console.log('');
console.log(`Service exercise report — ${report.generatedAt} (${Math.round(report.durationMs / 1000)}s total)`);
console.log('─'.repeat(100));
for (const r of report.results) {
  console.log(`[${ICON[r.status] || r.status}] ${r.service.padEnd(14)} ${(r.latencyMs / 1000).toFixed(1).padStart(6)}s  ${r.detail}`);
  if (r.status === 'fail' && r.evidence) {
    console.log(`       evidence: ${String(r.evidence).split('\n').join('\n       ')}`);
  }
}
console.log('─'.repeat(100));
console.log(`pass=${report.summary.pass} gate=${report.summary.gate} fail=${report.summary.fail} total=${report.summary.total}`);

for (const r of report.results.filter((x) => x.status === 'gate')) {
  console.log(`::warning::[gate] ${r.service}: ${r.detail}`);
}
const fails = report.results.filter((x) => x.status === 'fail');
if (fails.length) {
  for (const r of fails) console.error(`::error::[fail] ${r.service}: ${r.detail}`);
  process.exit(1);
}
console.log('All exercised backends executed real work (gates are honest not-configured states).');
