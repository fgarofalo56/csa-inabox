/**
 * PSR-1 — standalone benchmark harness.
 *
 * Drives the deployed CSA Loom console's real backends and writes a run
 * document with p50/p95/p99 + cold-vs-warm per metric. Two measurement paths,
 * both real end-to-end:
 *
 *   1. PAGE TTI — this script measures HTML GET latency for the top-10 surfaces
 *      DIRECTLY over HTTP (authenticated with a minted session cookie, the same
 *      probe pattern as apps/fiab-console/e2e/_lib/uat.ts mintSession).
 *   2. ENGINE METRICS — this script triggers the server-side suite via
 *      POST /api/admin/performance/run (which drives Synapse serverless/
 *      dedicated, ADX, dashboard-tile ADX, and Azure OpenAI inside the console
 *      where the backend credentials live), polls until it completes, then
 *      pulls the persisted metric docs back.
 *
 * Everything is Azure-native — no Fabric endpoint is ever called
 * (.claude/rules/no-fabric-dependency.md). Unconfigured backends record an
 * honest gate row, never a fabricated number (.claude/rules/no-vaporware.md).
 *
 * Usage:
 *   SESSION_SECRET=<container-app session-secret / KV loom-session-secret> \
 *   node scripts/csa-loom/perf/run-benchmark.mjs [--samples N] [--include-spark] [--out <file>]
 *
 * Env:
 *   LOOM_URL          console base URL (default the live Commercial Front Door)
 *   UAT_OID           tenant-admin OID whose session is minted (must be a
 *                     tenant admin so /api/admin/performance/* is authorized)
 *   UAT_UPN / UAT_NAME  optional session claims
 *   PERF_POLL_TIMEOUT_MS  max wait for the server-side run (default 300000)
 *
 * Exit codes: 0 = run persisted, 2 = usage/config error, 1 = run failed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TOP_SURFACES, pageTtiMetricId, FABRIC_BARS, summarize } from './perf-metrics.mjs';

const BASE = (process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net').replace(/\/+$/, '');
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error('SESSION_SECRET required (container-app session-secret or KV loom-session-secret)');
  process.exit(2);
}

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const SAMPLES = Math.min(20, Math.max(3, Number(argVal('--samples', '6')) || 6));
const INCLUDE_SPARK = process.argv.includes('--include-spark');
const OUT = argVal('--out', path.join('test-results', 'perf', `run-${Date.now()}.json`));
const POLL_TIMEOUT_MS = Number(process.env.PERF_POLL_TIMEOUT_MS) || 300_000;

// ── Mint the session cookie (identical to the UAT harness) ───────────────────
const KEY = Buffer.from(
  crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-session-v1'), 32),
);
function mintCookie() {
  const payload = {
    claims: {
      oid: process.env.UAT_OID || '00000000-0000-0000-0000-000000000000',
      name: process.env.UAT_NAME || 'Loom Perf',
      email: process.env.UAT_EMAIL || 'perf@example.invalid',
      upn: process.env.UAT_UPN || 'perf@example.invalid',
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload))), c.final()]);
  return `loom_session=${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url')}`;
}
const COOKIE = mintCookie();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Page TTI (direct HTTP timing) ─────────────────────────────────────────
async function measurePageTti() {
  const rows = [];
  for (const s of TOP_SURFACES) {
    const url = `${BASE}${s.path}`;
    const samples = [];
    let error;
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { cookie: COOKIE, accept: 'text/html' },
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });
        await res.text().catch(() => '');
        samples.push(Date.now() - t0);
      } catch (e) {
        error = String((e && e.message) || e);
        break;
      }
    }
    const sum = error ? { n: 0, p50: null, p95: null, p99: null, coldMs: null, warmMs: null } : summarize(samples);
    const bar = FABRIC_BARS['page-tti'];
    rows.push({
      metric: pageTtiMetricId(s.slug),
      backend: 'http',
      surface: s.path,
      ...sum,
      fabricBarMs: bar.ms,
      fabricBarLabel: bar.label,
      error,
    });
    process.stdout.write(
      `  page-tti:${s.slug.padEnd(12)} p50=${String(sum.p50 ?? '—').padStart(5)}ms p95=${String(sum.p95 ?? '—').padStart(5)}ms${error ? ` ERROR ${error}` : ''}\n`,
    );
  }
  return rows;
}

// ── 2. Engine metrics (server-side run) ──────────────────────────────────────
async function runServerSide() {
  const started = await fetch(`${BASE}/api/admin/performance/run`, {
    method: 'POST',
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    body: JSON.stringify({ samples: SAMPLES, includeSpark: INCLUDE_SPARK }),
    signal: AbortSignal.timeout(30_000),
  });
  const startJson = await started.json().catch(() => ({}));
  if (!started.ok || !startJson.runId) {
    throw new Error(
      `run start failed (${started.status}): ${startJson.error || startJson.reason || JSON.stringify(startJson).slice(0, 300)}`,
    );
  }
  const runId = startJson.runId;
  console.log(`  server-side run ${runId} started — ${startJson.totalMetrics} metrics; polling…`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await fetch(`${BASE}/api/admin/performance/run?runId=${encodeURIComponent(runId)}&docs=1`, {
      headers: { cookie: COOKIE },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok && j.status) {
      status = j.status;
      process.stdout.write(`  run ${status.status} — ${status.completedMetrics}/${status.totalMetrics}\r`);
      if (status.status !== 'running') {
        process.stdout.write('\n');
        return { runId, status, docs: j.docs || [] };
      }
    }
  }
  throw new Error(`server-side run ${runId} did not complete within ${POLL_TIMEOUT_MS}ms`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`CSA Loom perf harness → ${BASE}  (samples=${SAMPLES}, includeSpark=${INCLUDE_SPARK})`);
  console.log('Measuring page TTI (direct HTTP)…');
  const pageRows = await measurePageTti();

  console.log('Triggering server-side engine benchmark…');
  let engine = { runId: null, status: null, docs: [] };
  try {
    engine = await runServerSide();
  } catch (e) {
    console.error(`  engine run error: ${String((e && e.message) || e)}`);
  }

  const doc = {
    harnessVersion: 'psr1',
    base: BASE,
    ts: new Date().toISOString(),
    samples: SAMPLES,
    includeSpark: INCLUDE_SPARK,
    runId: engine.runId,
    runStatus: engine.status,
    pageTti: pageRows,
    engineMetrics: engine.docs,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  console.log(`\nRun document written → ${OUT}`);

  // Compact table for the CI/roll receipt.
  const all = [
    ...pageRows,
    ...(engine.docs || []).map((d) => ({
      metric: d.metric,
      p50: d.p50,
      p95: d.p95,
      gated: d.gated,
      fabricBarMs: FABRIC_BARS[d.metric]?.ms ?? FABRIC_BARS['page-tti'].ms,
    })),
  ];
  console.log('\nmetric                         p50      p95   fabric-bar');
  for (const m of all) {
    if (m.gated) {
      console.log(`${String(m.metric).padEnd(30)} GATED (backend not configured)`);
      continue;
    }
    const bar = m.fabricBarMs ?? '—';
    console.log(
      `${String(m.metric).padEnd(30)} ${String(m.p50 ?? '—').padStart(6)}ms ${String(m.p95 ?? '—').padStart(6)}ms  ${String(bar).padStart(6)}ms`,
    );
  }

  const runFailed = engine.status && engine.status.status === 'failed';
  process.exit(runFailed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
