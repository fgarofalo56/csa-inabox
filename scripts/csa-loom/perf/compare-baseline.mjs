/**
 * PSR-2 — perf-gate baseline comparison (CI entrypoint).
 *
 * Reads the LATEST PSR-1 benchmark run + the trailing-N baseline from the
 * `perf-benchmarks` Cosmos container, compares each metric against
 * `perf-budgets.json`, prints a markdown verdict table, and EXITS NONZERO when a
 * budgeted metric breaches (unless a documented OVERRIDE_LABEL is set).
 *
 * This is the self-contained Node ESM twin of the typed, unit-tested engine in
 * `apps/fiab-console/lib/perf/compare-budgets.ts` — the algorithm MUST match it
 * (the TS module has vitest coverage; this script runs in CI with no TS build so
 * it re-implements the same ~40 lines inline). Keep them in sync.
 *
 * PSR-1 doc shape (`perf-benchmarks` container, one row per metric+backend):
 *   { runId, gitSha, rev, metric, backend, p50, p95, p99, coldMs, warmMs, ts }
 *
 * Data sources (in priority order):
 *   • RUN_BUNDLE_FILE   — a local JSON `{ latest:[...rows], baseline:[...rows] }` as
 *                         served by the console's in-VNet GET /api/admin/performance.
 *                         THE PRIMARY CI PATH: the console (which is inside the VNet)
 *                         reads the private-endpoint Cosmos and hands the gate both the
 *                         run and its baseline, so the public runner never touches Cosmos.
 *   • LATEST_RUN_FILE   — a local JSON file of just the run under test ({rows:[...]} or
 *                         a bare array). Baseline then comes from BASELINE_FILE if set,
 *                         else from Cosmos. Lets a "deliberately regress one metric"
 *                         test drive the gate.
 *   • Cosmos            — LOOM_COSMOS_ENDPOINT|COSMOS_ENDPOINT + LOOM_COSMOS_DATABASE
 *                         (default 'loom'), container 'perf-benchmarks'. AAD via
 *                         DefaultAzureCredential (same pattern as backfill-workspace-tid.mjs).
 *                         Only usable where the runner can REACH Cosmos (e.g. an
 *                         in-VNet lane); public runners use the bundle/run files above.
 *                         When no file is given, the latest run is the most recent runId
 *                         in the container and the baseline is the trailing runs.
 *
 * Env:
 *   LOOM_COSMOS_ENDPOINT | COSMOS_ENDPOINT   Cosmos account endpoint (for baseline).
 *   LOOM_COSMOS_DATABASE                     database (default 'loom').
 *   LOOM_PERF_CONTAINER                      container (default 'perf-benchmarks').
 *   PERF_BUDGETS_FILE                        budgets path (default ./perf-budgets.json).
 *   LATEST_RUN_FILE                          optional local run JSON (see above).
 *   RUN_ID                                   optional — pin the latest run to this id.
 *   OVERRIDE_LABEL                           documented justification for an accepted regression.
 *
 * Exit codes: 0 = green (or overridden, or honestly skipped); 1 = red (breach); 2 = config error.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── inline engine (mirror of apps/fiab-console/lib/perf/compare-budgets.ts) ──

const rowKey = (metric, backend) => `${metric}|${backend}`;

function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

const round1 = (n) => Math.round(n * 10) / 10;

function baselineMedians(baseline) {
  const buckets = new Map();
  for (const r of baseline) {
    const k = rowKey(r.metric, r.backend);
    const arr = buckets.get(k);
    if (arr) arr.push(r.p95);
    else buckets.set(k, [r.p95]);
  }
  const out = new Map();
  for (const [k, arr] of buckets) {
    const m = median(arr);
    if (m !== null) out.set(k, m);
  }
  return out;
}

function evaluateBudgets({ latest, baseline, budgets, overrideLabel }) {
  const label = overrideLabel && String(overrideLabel).trim() ? String(overrideLabel).trim() : null;
  const base = baselineMedians(baseline);
  const evaluations = [];
  for (const row of latest) {
    const budget = budgets.metrics[row.metric];
    if (!budget) continue;
    const maxReg = typeof budget.maxRegressionPct === 'number' ? budget.maxRegressionPct : budgets.defaults.maxRegressionPct;
    const k = rowKey(row.metric, row.backend);
    const baselineP95 = base.has(k) ? base.get(k) : null;
    const deltaPct = baselineP95 !== null && baselineP95 > 0 ? round1(((row.p95 - baselineP95) / baselineP95) * 100) : null;
    const ceilingBreach = row.p95 > budget.p95CeilingMs;
    const regressionBreach = deltaPct !== null && deltaPct > maxReg;
    const breach = ceilingBreach || regressionBreach;
    const notes = [];
    if (ceilingBreach) notes.push(`p95 ${row.p95}ms over ceiling ${budget.p95CeilingMs}ms`);
    if (regressionBreach) notes.push(`+${deltaPct}% vs baseline ${baselineP95}ms (max +${maxReg}%)`);
    if (!breach) notes.push(baselineP95 === null ? 'no baseline yet — ceiling-only' : `ok (${deltaPct}% vs baseline)`);
    evaluations.push({
      key: k, metric: row.metric, backend: row.backend, latestP95: row.p95,
      baselineP95, deltaPct, ceilingMs: budget.p95CeilingMs, maxRegressionPct: maxReg,
      fabricBarMs: typeof budget.fabricBarMs === 'number' ? budget.fabricBarMs : null,
      ceilingBreach, regressionBreach, breach, note: notes.join('; '),
    });
  }
  evaluations.sort((a, b) => (a.breach !== b.breach ? (a.breach ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const breachCount = evaluations.filter((e) => e.breach).length;
  return {
    evaluations, breachCount, overrideLabel: label,
    overridden: breachCount > 0 && label !== null,
    breached: breachCount > 0 && label === null,
  };
}

function renderMarkdownTable(result) {
  const header =
    '| Metric | Backend | p95 | Baseline | Δ% | Ceiling | Fabric bar | Verdict |\n' +
    '|--------|---------|----:|---------:|---:|--------:|-----------:|:--------|';
  const rows = result.evaluations.map((e) => {
    const verdict = e.breach ? (result.overridden ? '⚠️ override' : '❌ BREACH') : '✅';
    const baseline = e.baselineP95 === null ? '—' : `${e.baselineP95}ms`;
    const delta = e.deltaPct === null ? '—' : `${e.deltaPct > 0 ? '+' : ''}${e.deltaPct}%`;
    const fabric = e.fabricBarMs === null ? '—' : `${e.fabricBarMs}ms`;
    return `| ${e.metric} | ${e.backend} | ${e.latestP95}ms | ${baseline} | ${delta} | ${e.ceilingMs}ms | ${fabric} | ${verdict} |`;
  });
  const summary = result.breached
    ? `\n\n**Perf gate: ❌ RED** — ${result.breachCount} metric(s) breached budget.`
    : result.overridden
      ? `\n\n**Perf gate: ⚠️ OVERRIDDEN** — ${result.breachCount} breach(es) accepted via \`OVERRIDE_LABEL=${result.overrideLabel}\`.`
      : '\n\n**Perf gate: ✅ GREEN** — all budgeted metrics within budget.';
  return `${header}\n${rows.join('\n')}${summary}`;
}

// ── I/O helpers ──

function loadBudgets() {
  const file = process.env.PERF_BUDGETS_FILE || path.resolve(process.cwd(), 'perf-budgets.json');
  if (!existsSync(file)) {
    console.error(`perf-budgets not found at ${file} (set PERF_BUDGETS_FILE)`);
    process.exit(2);
  }
  const budgets = JSON.parse(readFileSync(file, 'utf-8'));
  if (!budgets || typeof budgets.metrics !== 'object') {
    console.error(`perf-budgets at ${file} is malformed (missing "metrics")`);
    process.exit(2);
  }
  if (!budgets.defaults || typeof budgets.defaults.maxRegressionPct !== 'number') {
    budgets.defaults = { maxRegressionPct: 25 };
  }
  return budgets;
}

/** Normalize a run-file payload ({rows:[...]} or a bare array) into a row array. */
function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  return [];
}

/**
 * Pull the latest run + trailing-N baseline from Cosmos. Returns null (honest skip)
 * when no Cosmos endpoint is configured. Uses parameterized queries only.
 */
async function loadFromCosmos(budgets, pinnedRunId) {
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT || process.env.COSMOS_ENDPOINT;
  if (!endpoint) return null;
  const dbName = process.env.LOOM_COSMOS_DATABASE || 'loom';
  const containerName = process.env.LOOM_PERF_CONTAINER || 'perf-benchmarks';
  const { CosmosClient } = await import('@azure/cosmos');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  const container = client.database(dbName).container(containerName);

  // Distinct runs by most-recent timestamp (Cosmos GROUP BY + MAX).
  const { resources: runs } = await container.items
    .query('SELECT c.runId AS runId, MAX(c.ts) AS ts FROM c GROUP BY c.runId')
    .fetchAll();
  runs.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (runs.length === 0) return { latest: [], baseline: [], latestRunId: null };

  const latestRunId = pinnedRunId || runs[0].runId;
  const n = Number(budgets.trailingBaselineRuns) || 5;
  const baselineIds = runs.filter((r) => r.runId !== latestRunId).slice(0, n).map((r) => r.runId);

  const fetchRows = async (runId) => {
    const { resources } = await container.items
      .query({ query: 'SELECT * FROM c WHERE c.runId = @runId', parameters: [{ name: '@runId', value: runId }] })
      .fetchAll();
    return resources;
  };

  const latest = await fetchRows(latestRunId);
  const baselineArrays = await Promise.all(baselineIds.map(fetchRows));
  const baseline = baselineArrays.flat();
  return { latest, baseline, latestRunId };
}

/**
 * Pull only the trailing baseline from Cosmos (excluding the given run id) when the
 * latest run is supplied via LATEST_RUN_FILE. Returns [] when no Cosmos configured.
 */
async function loadBaselineFromCosmos(budgets, excludeRunId) {
  const res = await loadFromCosmos(budgets, null);
  if (!res) return [];
  // Rebuild baseline as the trailing runs, excluding the file's run id if present.
  return res.baseline.filter((r) => r.runId !== excludeRunId).concat(
    // the file-run is under test; the Cosmos "latest" is a legitimate baseline point
    excludeRunId && res.latestRunId && res.latestRunId !== excludeRunId ? res.latest : [],
  );
}

// ── main ──

async function main() {
  const budgets = loadBudgets();
  const overrideLabel = process.env.OVERRIDE_LABEL || null;
  const pinnedRunId = process.env.RUN_ID || null;

  let latest = [];
  let baseline = [];
  let latestRunId = pinnedRunId;
  let source = '';

  const bundleFile = process.env.RUN_BUNDLE_FILE;
  const runFile = process.env.LATEST_RUN_FILE;
  const baselineFile = process.env.BASELINE_FILE;

  if (bundleFile) {
    if (!existsSync(bundleFile)) {
      console.error(`RUN_BUNDLE_FILE not found: ${bundleFile}`);
      process.exit(2);
    }
    const bundle = JSON.parse(readFileSync(bundleFile, 'utf-8'));
    latest = normalizeRows(bundle && bundle.latest);
    baseline = normalizeRows(bundle && bundle.baseline);
    latestRunId = latestRunId || (latest[0] && latest[0].runId) || null;
    source = `bundle:${bundleFile}`;
  } else if (runFile) {
    if (!existsSync(runFile)) {
      console.error(`LATEST_RUN_FILE not found: ${runFile}`);
      process.exit(2);
    }
    latest = normalizeRows(JSON.parse(readFileSync(runFile, 'utf-8')));
    latestRunId = latestRunId || (latest[0] && latest[0].runId) || null;
    if (baselineFile) {
      if (!existsSync(baselineFile)) {
        console.error(`BASELINE_FILE not found: ${baselineFile}`);
        process.exit(2);
      }
      baseline = normalizeRows(JSON.parse(readFileSync(baselineFile, 'utf-8')));
      source = `file:${runFile}+${baselineFile}`;
    } else {
      baseline = await loadBaselineFromCosmos(budgets, latestRunId);
      source = `file:${runFile}`;
    }
  } else {
    const res = await loadFromCosmos(budgets, pinnedRunId);
    if (!res) {
      console.log('::warning::No Cosmos endpoint (LOOM_COSMOS_ENDPOINT/COSMOS_ENDPOINT) and no LATEST_RUN_FILE — perf gate has nothing to compare. SKIPPING (honest no-op, exit 0). Provision the perf-benchmarks container or pass a run file to enable.');
      process.exit(0);
    }
    latest = res.latest;
    baseline = res.baseline;
    latestRunId = res.latestRunId;
    source = `cosmos:${process.env.LOOM_PERF_CONTAINER || 'perf-benchmarks'}`;
  }

  if (!latest || latest.length === 0) {
    console.log(`::warning::No latest benchmark rows found (source=${source}, runId=${latestRunId ?? '<none>'}). SKIPPING perf gate (exit 0) — run the PSR-1 suite first.`);
    process.exit(0);
  }

  const result = evaluateBudgets({ latest, baseline, budgets, overrideLabel });
  const table = renderMarkdownTable(result);

  console.log(`\nPerf gate — run ${latestRunId ?? '<file>'} (source=${source})`);
  console.log(`Latest rows: ${latest.length} · baseline rows: ${baseline.length} · budgeted metrics evaluated: ${result.evaluations.length}\n`);
  console.log(table);

  // Post the table into the GitHub step summary / roll receipt when available.
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      appendFileSync(summaryFile, `## Perf gate — run ${latestRunId ?? '<file>'}\n\n${table}\n`);
    } catch (e) {
      console.log(`::warning::Could not write GITHUB_STEP_SUMMARY: ${e && e.message}`);
    }
  }

  if (result.breached) {
    const worst = result.evaluations.filter((e) => e.breach).map((e) => `${e.metric}/${e.backend}: ${e.note}`);
    for (const w of worst) console.log(`::error::perf budget breach — ${w}`);
    console.log(`\nPerf gate RED — ${result.breachCount} metric(s) over budget. Set OVERRIDE_LABEL="<reason>" to accept a justified regression.`);
    process.exit(1);
  }
  if (result.overridden) {
    console.log(`::warning::Perf gate has ${result.breachCount} breach(es) accepted via OVERRIDE_LABEL="${result.overrideLabel}". Documented + green.`);
  }
  process.exit(0);
}

// Only run main() when invoked as a script (not when imported by a test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`::error::perf gate crashed: ${e && e.stack ? e.stack : e}`);
    process.exit(2);
  });
}

export { evaluateBudgets, baselineMedians, median, rowKey, renderMarkdownTable, normalizeRows };
