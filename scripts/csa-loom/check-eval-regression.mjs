#!/usr/bin/env node
/**
 * check-eval-regression — the Copilot eval-floor gate (E3, loom-next-level).
 *
 * Compares the latest eval run per surface (from a run-artifact JSON — the E2
 * HTTP-trigger response — or directly from Cosmos `loom-copilot-evals`) against
 * `content/evals/eval-floors.json` AND against the previous run:
 *
 *   - any metric BELOW its floor            → exit 1 (hard fail, ::error)
 *   - a one-run drop > EVAL_REGRESSION_DELTA points but still above floor
 *                                           → ::warning annotation, exit 0
 *     (flaky-judge tolerance)
 *   - groundingAvg null (judge 'deferred' — E2 daily cap / no judge deployment)
 *                                           → NO-CHANGE: neither floor nor delta
 *     is evaluated for grounding (the E2 cap contract; deterministic retrieval
 *     scoring remains authoritative)
 *
 * Usage (artifact mode — the E4 workflow path; dependency-free):
 *   node scripts/csa-loom/check-eval-regression.mjs \
 *     --artifact eval-run.json [--previous prev-run.json] \
 *     [--floors content/evals/eval-floors.json] [--summary summary.md] \
 *     [--strict-missing]
 *
 * Usage (Cosmos mode — reads the latest 2 eval-runs per surface via AAD;
 * requires @azure/cosmos + @azure/identity resolvable and a data-plane role):
 *   LOOM_COSMOS_ENDPOINT=https://<acct>.documents.azure.com:443/ \
 *   [LOOM_COSMOS_DATABASE=loom] \
 *   node scripts/csa-loom/check-eval-regression.mjs --cosmos [--surfaces help,cost]
 *
 * Env: EVAL_REGRESSION_DELTA — warn threshold in POINTS (default 5; rates
 * compare in percentage points, groundingAvg maps its 1..5 scale ×25).
 *
 * Exit codes: 0 pass (warnings allowed) · 1 below-floor regression · 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRuns,
  latestAndPrevious,
  evaluateGate,
  attachQuestions,
  renderMarkdown,
} from './eval-regression-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

const floorsPath = opt('--floors') ?? path.join(repo, 'content', 'evals', 'eval-floors.json');
const deltaPoints = Number(process.env.EVAL_REGRESSION_DELTA ?? '5');
if (!Number.isFinite(deltaPoints) || deltaPoints <= 0) {
  console.error(`check-eval-regression: EVAL_REGRESSION_DELTA must be a positive number (got "${process.env.EVAL_REGRESSION_DELTA}")`);
  process.exit(2);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`check-eval-regression: cannot read ${p}: ${e.message}`);
    process.exit(2);
  }
}

const floorsDoc = readJson(floorsPath);

async function loadRuns() {
  if (has('--cosmos')) {
    const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
    if (!endpoint) {
      console.error('check-eval-regression: --cosmos requires LOOM_COSMOS_ENDPOINT');
      process.exit(2);
    }
    const db = process.env.LOOM_COSMOS_DATABASE || 'loom';
    // Lazy imports — artifact mode stays dependency-free (repo root has no
    // package.json; these resolve via the console workspace when present).
    const { CosmosClient } = await import('@azure/cosmos');
    const { DefaultAzureCredential } = await import('@azure/identity');
    const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    const container = client.database(db).container('loom-copilot-evals');
    const surfaces = (opt('--surfaces') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const filter = surfaces.length
      ? ` AND ARRAY_CONTAINS(@surfaces, c.surface)`
      : '';
    const { resources } = await container.items
      .query({
        query: `SELECT c.surface, c.startedAt, c.totals FROM c WHERE c.docType = 'eval-run'${filter} ORDER BY c.startedAt DESC OFFSET 0 LIMIT 400`,
        parameters: surfaces.length ? [{ name: '@surfaces', value: surfaces }] : [],
      })
      .fetchAll();
    const { latest, previous } = latestAndPrevious(resources);
    return { current: latest, previous, source: `cosmos ${endpoint} (${resources.length} run docs)` };
  }

  const artifactPath = opt('--artifact');
  if (!artifactPath) {
    console.error('check-eval-regression: pass --artifact <run.json> (the E2 HTTP-trigger response) or --cosmos');
    process.exit(2);
  }
  const current = normalizeRuns(readJson(artifactPath));
  const prevPath = opt('--previous');
  const previous = prevPath && fs.existsSync(prevPath) ? normalizeRuns(readJson(prevPath)) : null;
  return {
    current,
    previous,
    source: `artifact ${artifactPath}${prevPath ? ` vs ${prevPath}` : ' (no previous run — delta check skipped)'}`,
  };
}

const { current, previous, source } = await loadRuns();

if (current.size === 0) {
  // An empty artifact means the eval run never happened (Function unreachable /
  // honest-gated) — that is a pipeline problem, not a quality regression.
  // Warn loudly but do not fake a floor verdict either way.
  const msg = 'check-eval-regression: artifact contains ZERO surface runs — the eval run did not execute (Function gate/timeout?). Floors NOT evaluated.';
  console.warn(msg);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${msg}`);
  process.exit(has('--strict-missing') ? 1 : 0);
}

const report = attachQuestions(
  evaluateGate(current, floorsDoc, { previous, deltaPoints, strictMissing: has('--strict-missing') }),
  current,
);

const provisional = Object.values(floorsDoc.floors ?? {}).some((f) => f?.provisional);
const md = renderMarkdown(report, {
  title: 'Copilot quality evals — floor gate',
  deltaPoints,
  floorsProvisional: provisional,
});

const summaryPath = opt('--summary');
if (summaryPath) fs.writeFileSync(summaryPath, md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

console.log(`check-eval-regression: source = ${source}`);
for (const row of report.rows) {
  const m = row.metrics;
  const fmt = (k) => (m[k] ? (m[k].value === null ? 'deferred' : m[k].value) : '—');
  console.log(
    `  ${row.status.padEnd(8)} ${row.surface}: hit-rate ${fmt('retrievalHitRate')}, grounding ${fmt('groundingAvg')}, pass-rate ${fmt('passRate')}`,
  );
}
for (const n of report.notes) console.log(`  note: ${n}`);
for (const w of report.warnings) {
  console.warn(`  WARN: ${w}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${w}`);
}
for (const f of report.failures) {
  console.error(`  FAIL: ${f}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${f}`);
}

if (report.failures.length > 0) {
  console.error(
    `check-eval-regression: ${report.failures.length} below-floor failure(s). ` +
    'Fix the corpus/prompt regression, or (explicit override only) edit content/evals/eval-floors.json with a justification.',
  );
  process.exit(1);
}
console.log(`check-eval-regression: OK — ${current.size} surface(s), ${report.warnings.length} warning(s).`);
