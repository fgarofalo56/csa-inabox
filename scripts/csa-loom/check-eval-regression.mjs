#!/usr/bin/env node
/**
 * check-eval-regression — the Copilot eval-floor gate (E3, loom-next-level).
 *
 * Compares the latest eval run per surface (from a run-artifact JSON — the E2
 * HTTP-trigger response — or directly from Cosmos `loom-copilot-evals`) against
 * `content/evals/eval-floors.json` AND against the previous run:
 *
 *   - any metric BELOW its floor            → exit 1 (hard fail, ::error)
 *   - EXCEPT (#3831) a `passRate` breach smaller than ONE JUDGED QUESTION of the
 *     run's own denominator, where the previous comparable run was at or above
 *     the floor → ::warning, exit 0. The floor is NOT lowered and the file is
 *     not touched: the gate declines to call a difference it cannot resolve a
 *     regression, the same refusal it already makes for a mixed pass predicate
 *     (#2992) and a partial measurement (#3083). A second consecutive breach
 *     FAILS, and `retrievalHitRate` / `groundingAvg` keep hard single-run floors
 *     — measured stable to three decimals across the four runs in #3831 while
 *     only the judged rate moved, in one-question steps.
 *   - a one-run drop > EVAL_REGRESSION_DELTA points but still above floor
 *                                           → ::warning annotation, exit 0
 *     (flaky-judge tolerance)
 *   - groundingAvg null (judge 'deferred' — E2 daily cap / no judge deployment)
 *                                           → the GROUNDING FLOOR is no-change
 *     (neither floor nor delta evaluated for grounding — the E2 cap contract;
 *     deterministic retrieval scoring remains authoritative) AND the surface's
 *     pass rate is a `deterministicPassRate`, not a `passRate`: it is neither
 *     floor-checked nor compared, and the run FAILS (#2992). A judge that
 *     scored nothing means there is no pass rate — there is an error.
 *   - a pass-rate whose predicate differs from the baseline's
 *                                           → the delta is REFUSED, loudly, and
 *     no number is emitted (#2992: dropping a conjunct can only raise the rate,
 *     so subtracting across predicates renders degradation as improvement).
 *
 * Usage (artifact mode — the E4 workflow path; dependency-free):
 *   node scripts/csa-loom/check-eval-regression.mjs \
 *     --artifact eval-run.json [--previous prev-run.json] \
 *     [--delta-status evaluated|absent|unstated] \
 *     [--floors content/evals/eval-floors.json] [--summary summary.md] \
 *     [--strict-missing]
 *
 * `--delta-status` (#4277): what the CALLER established about the delta
 * baseline. Without `--previous` the delta half of this gate does not run, and
 * before #4277 nothing in the summary said so — so a baseline that could not be
 * FETCHED (a broken pipeline) looked exactly like a baseline that does not YET
 * EXIST (fine). The markdown now carries a `Delta:` line either way, and
 * `unstated` is never rendered as `absent`.
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

// ── #4277 — what the CALLER knows about the delta baseline ──────────────────
// The gate has two halves: FLOORS (absolute) and DELTA (vs the previous run).
// Before #4277 the delta half switched itself off on the mere absence of
// `--previous`, and nothing the reader could see said which of the two reasons
// applied — a baseline that genuinely does not exist yet, or a baseline that
// could not be fetched. The second is a broken pipeline; the first is not. So
// the caller now STATES it, and the markdown carries it.
//
//   evaluated  NOT accepted from the caller — see below. Derived ONLY from a
//              baseline this process actually loaded.
//   absent     the caller established there is no prior run to compare against
//   unstated   nobody said — the honest default, never rendered as "absent"
//
// `evaluated` is deliberately NOT a value the caller may assert. Whether the
// delta half RAN is a fact about THIS process, and the only evidence for it is
// a baseline that was loaded — i.e. `--previous`. Accepting the word from the
// caller reintroduces the exact R7 shape this flag exists to remove: an earlier
// revision computed `previous ? 'evaluated' : (arg ?? 'unstated')`, which made
// `--previous` sufficient but not NECESSARY, so `--delta-status evaluated`
// with no `--previous` printed "Delta: evaluated against the previous run"
// while the delta half had not run at all. That is reachable from the
// workflow, whose baseline step writes `evaluated` on a successful
// `gh run download` — a download can succeed and still yield no
// `eval-run.json`, after which `[ -f prev/eval-run.json ]` is false and
// `--previous` is never passed. So the combination is a REFUSAL, not a render.
const DELTA_STATUS = new Set(['evaluated', 'absent', 'unstated']);
const deltaStatusArg = opt('--delta-status');
if (deltaStatusArg !== undefined && !DELTA_STATUS.has(deltaStatusArg)) {
  console.error(`check-eval-regression: --delta-status must be one of ${[...DELTA_STATUS].join('|')} (got "${deltaStatusArg}")`);
  process.exit(2);
}
function describeDeltaStatus(status) {
  if (status === 'absent') return 'NOT evaluated — no prior successful main run';
  return 'NOT evaluated — the caller did not state whether a baseline exists';
}

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
    // Search-only mode: a --search-artifact with no copilot artifact is valid —
    // evaluate the search floors alone (SRCH1).
    if (opt('--search-artifact')) {
      return { current: new Map(), previous: null, source: 'search-only (no copilot artifact)' };
    }
    console.error('check-eval-regression: pass --artifact <run.json> (the E2 HTTP-trigger response), --search-artifact <search.json>, or --cosmos');
    process.exit(2);
  }
  const current = normalizeRuns(readJson(artifactPath));
  const prevPath = opt('--previous');
  if (prevPath && !fs.existsSync(prevPath)) {
    // #4277 — a --previous that is not there means the caller BELIEVES it has a
    // baseline and does not. Falling through to a floor-only gate here would
    // disable half the gate on a caller mistake, silently.
    console.error(`check-eval-regression: --previous ${prevPath} does not exist. Refusing to run a FLOOR-ONLY gate while reporting a delta comparison was requested.`);
    process.exit(2);
  }
  const previous = prevPath ? normalizeRuns(readJson(prevPath)) : null;
  return {
    current,
    previous,
    // #4277 — this string used to assert "no previous run" whenever --previous
    // was absent. It could not know that: the workflow also omitted --previous
    // when the baseline fetch FAILED. Two different states, one sentence, and
    // the failing one was the one the reader most needed to see. What the
    // caller knows about the baseline now arrives as --delta-status; without
    // it, say that it is unstated rather than asserting an absence.
    source: prevPath
      ? `artifact ${artifactPath} vs ${prevPath}`
      : `artifact ${artifactPath} (delta ${describeDeltaStatus(deltaStatusArg)})`,
  };
}

// ── SRCH1 — federated-search relevance floor gate (additive) ────────────────
// Latest search-run per domain vs floorsDoc.searchFloors. Kept self-contained so
// the copilot path (evaluateGate) is untouched. Cosmos mode queries the
// `search-run` docs; artifact mode reads the search HTTP response
// ({ok, mode:'search', domains:[{domain, hitRate, ndcgAvg, queries}]}).
async function loadSearchRuns() {
  const searchArtifact = opt('--search-artifact');
  if (searchArtifact && fs.existsSync(searchArtifact)) {
    const j = readJson(searchArtifact);
    const domains = Array.isArray(j?.domains) ? j.domains : [];
    const latest = new Map();
    for (const d of domains) {
      if (!d?.domain) continue;
      latest.set(d.domain, { hitRate: Number(d.hitRate ?? d.searchHitRate ?? 0), ndcg: Number(d.ndcgAvg ?? d.ndcg ?? 0) });
    }
    return { latest, source: `search-artifact ${searchArtifact} (${latest.size} domain(s))` };
  }
  if (has('--cosmos')) {
    const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
    const db = process.env.LOOM_COSMOS_DATABASE || 'loom';
    const { CosmosClient } = await import('@azure/cosmos');
    const { DefaultAzureCredential } = await import('@azure/identity');
    const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    const container = client.database(db).container('loom-copilot-evals');
    const { resources } = await container.items
      .query({ query: "SELECT c.domain, c.finishedAt, c.totals FROM c WHERE c.docType = 'search-run' ORDER BY c.finishedAt DESC OFFSET 0 LIMIT 400" })
      .fetchAll();
    const latest = new Map();
    for (const r of resources) {
      if (!r?.domain || latest.has(r.domain)) continue; // first = newest (ordered DESC)
      latest.set(r.domain, { hitRate: Number(r.totals?.hitRate ?? 0), ndcg: Number(r.totals?.ndcgAvg ?? 0) });
    }
    return { latest, source: `cosmos search-run (${resources.length} doc(s))` };
  }
  return { latest: new Map(), source: null };
}

function evaluateSearchGate(latest, searchFloors) {
  const failures = [];
  const rows = [];
  for (const [domain, m] of latest) {
    const floor = searchFloors?.[domain];
    const checks = [];
    if (floor?.searchHitRate != null && m.hitRate + 1e-9 < floor.searchHitRate) {
      failures.push(`search:${domain} hit-rate ${m.hitRate} < floor ${floor.searchHitRate}`);
      checks.push('hit-rate<floor');
    }
    if (floor?.ndcg != null && m.ndcg + 1e-9 < floor.ndcg) {
      failures.push(`search:${domain} NDCG ${m.ndcg} < floor ${floor.ndcg}`);
      checks.push('ndcg<floor');
    }
    rows.push(`  ${checks.length ? 'FAIL    ' : 'ok      '}search:${domain}: hit-rate ${m.hitRate}, ndcg ${m.ndcg}`);
  }
  return { failures, rows };
}

const { current, previous, source } = await loadRuns();

// SRCH1 — evaluate the search-relevance floor gate up front (additive).
const searchRuns = await loadSearchRuns();
const searchGate = evaluateSearchGate(searchRuns.latest, floorsDoc.searchFloors ?? {});
if (searchRuns.source) {
  console.log(`check-eval-regression: search source = ${searchRuns.source}`);
  for (const r of searchGate.rows) console.log(r);
  for (const f of searchGate.failures) {
    console.error(`  FAIL: ${f}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${f}`);
  }
}

if (current.size === 0) {
  // An empty artifact means the eval run never happened (Function unreachable /
  // honest-gated) — that is a pipeline problem, not a quality regression.
  // Warn loudly but do not fake a floor verdict either way. A search-only run
  // (search runs present, no copilot artifact) still enforces its floors.
  const msg = 'check-eval-regression: artifact contains ZERO surface runs — the copilot eval run did not execute (Function gate/timeout?). Copilot floors NOT evaluated.';
  console.warn(msg);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${msg}`);
  if (searchGate.failures.length > 0) process.exit(1);
  process.exit(has('--strict-missing') ? 1 : 0);
}

const report = attachQuestions(
  evaluateGate(current, floorsDoc, { previous, deltaPoints, strictMissing: has('--strict-missing') }),
  current,
);

const provisional = Object.values(floorsDoc.floors ?? {}).some((f) => f?.provisional);
// #4277 — the delta half of the gate reports whether it RAN, in the artifact
// the reader actually opens. A loaded `previous` is the ONLY evidence that it
// ran, so it is the only thing that can produce "evaluated".
//
// A caller that ASSERTS `evaluated` while this process holds no baseline is
// stating a fact it did not establish, in the summary an operator reads. That
// is refused rather than rendered, and it is refused loudly enough to name the
// discrepancy — the same treatment `--previous <missing file>` already gets,
// and for the same reason: a caller mistake must not silently disable half the
// gate while the markdown claims both halves ran.
if (deltaStatusArg === 'evaluated' && !previous) {
  console.error(
    'check-eval-regression: --delta-status evaluated was passed, but no baseline was loaded '
    + `(${opt('--previous') ? `--previous ${opt('--previous')} yielded nothing` : 'no --previous argument was given'}). `
    + 'The delta half of this gate did NOT run, so it will not be reported as evaluated. '
    + 'Refusing rather than printing a comparison that did not happen. '
    + 'If the baseline genuinely does not exist, pass --delta-status absent; if it should exist, fix the fetch.',
  );
  process.exit(2);
}
const deltaStatus = previous ? 'evaluated' : (deltaStatusArg ?? 'unstated');
const md = renderMarkdown(report, {
  title: 'Copilot quality evals — floor gate',
  deltaPoints,
  floorsProvisional: provisional,
  deltaStatus,
  deltaStatusDetail: previous ? null : describeDeltaStatus(deltaStatusArg),
});

const summaryPath = opt('--summary');
if (summaryPath) fs.writeFileSync(summaryPath, md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

console.log(`check-eval-regression: source = ${source}`);
for (const row of report.rows) {
  const m = row.metrics;
  // #3083 — a partially measured surface has rates, but they are over the
  // survivors. Print the counts, never the numbers: a rate whose denominator
  // moved is not the metric its label names.
  if (row.partialMeasurement) {
    const p = row.partialMeasurement;
    console.log(
      `  ${row.status.padEnd(8)} ${row.surface}: PARTIAL — ${p.measured}/${p.attempted} row(s) measured ` +
        `(${p.lost} lost${p.probeErrors ? `, probe errors ${JSON.stringify(p.probeErrors)}` : ''}); ` +
        'rates NOT reported (they would be computed over the survivors)',
    );
    continue;
  }
  const fmt = (k) => {
    if (!m[k]) return '—';
    // #2992 — never print a degraded rate under the pass-rate label.
    if (m[k].verdict === 'degraded-predicate') {
      return `NOT COMPUTED (deterministicPassRate ${m[k].degradedValue ?? '—'})`;
    }
    return m[k].value === null ? 'deferred' : m[k].value;
  };
  const pred = row.passPredicate?.measured ? ` [predicate ${row.passPredicate.id}]` : '';
  console.log(
    `  ${row.status.padEnd(8)} ${row.surface}: hit-rate ${fmt('retrievalHitRate')}, grounding ${fmt('groundingAvg')}, pass-rate ${fmt('passRate')}${pred}`,
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

const totalFailures = report.failures.length + searchGate.failures.length;
if (totalFailures > 0) {
  // #2992 — a degraded-predicate failure is NOT a quality regression and must
  // not be triaged as one: the run measured less, it did not score worse.
  const degraded = report.rows.filter((r) => r.metrics?.passRate?.verdict === 'degraded-predicate');
  if (degraded.length > 0) {
    console.error(
      `check-eval-regression: ${degraded.length} surface(s) produced NO pass-rate — the grounding judge scored zero ` +
      `rows (${degraded.map((r) => r.surface).join(', ')}). This is a JUDGE failure, not a quality regression: ` +
      'their deterministic-only rates are reported as `deterministicPassRate` and were neither floor-checked nor ' +
      'compared against the judged baseline.',
    );
  }
  // #3083 — same class, different cause: a partial run measured less, it did
  // not score worse. Say so explicitly so nobody triages a throttle as a
  // quality regression (which is exactly what happened to `rbac 0.38` = 3/8).
  const partial = report.rows.filter((r) => r.partialMeasurement);
  if (partial.length > 0) {
    const totMeasured = partial.reduce((a, r) => a + r.partialMeasurement.measured, 0);
    const totAttempted = partial.reduce((a, r) => a + r.partialMeasurement.attempted, 0);
    console.error(
      `check-eval-regression: ${partial.length} surface(s) were only PARTIALLY measured ` +
      `(${totMeasured}/${totAttempted} rows across them: ${partial.map((r) => `${r.surface} ${r.partialMeasurement.measured}/${r.partialMeasurement.attempted}`).join(', ')}). ` +
      'This is a MEASUREMENT failure, not a quality regression — their rates were computed over the surviving rows ' +
      'and were therefore NOT floor-checked and NOT compared against the baseline. Do NOT lower a floor in response.',
    );
  }
  console.error(
    `check-eval-regression: ${totalFailures} failure(s) ` +
    `(${report.failures.length} copilot, ${searchGate.failures.length} search). ` +
    'Fix the corpus/prompt/index regression, or (explicit override only) edit content/evals/eval-floors.json with a justification.',
  );
  process.exit(1);
}
console.log(
  `check-eval-regression: OK — ${current.size} surface(s), ${searchRuns.latest.size} search domain(s), ${report.warnings.length} warning(s).`,
);
