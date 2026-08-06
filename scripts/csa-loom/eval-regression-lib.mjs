/**
 * eval-regression-lib — PURE comparison + ratchet logic for the Copilot eval
 * floors (E3, PRPs/active/loom-next-level/ws-copilot-cost.md).
 *
 * Consumed by:
 *   - scripts/csa-loom/check-eval-regression.mjs  (the CI gate — E4 workflow +
 *     the full-app-deploy post-roll run)
 *   - scripts/csa-loom/ratchet-eval-floors.mjs    (raise-only floor ratchet)
 *   - apps/fiab-console/__tests__/eval-regression-gate.test.ts (fixtures)
 *
 * Dependency-free on purpose (runs from the repo root). No I/O in this module —
 * the CLIs own fs/Cosmos; everything here is a pure function over plain data.
 *
 * Metric semantics (must stay in lockstep with the E2 evaluator contract,
 * azure-functions/copilot-evaluator/src/evaluator-core.ts::RunTotals):
 *   retrievalHitRate  0..1  deterministic, always present
 *   groundingAvg      1..5  judged questions only; null = judge 'deferred'
 *                            (E2 daily cap / no judge deployment). The GROUNDING
 *                            FLOOR is treated as NO-CHANGE when null (the E2 cap
 *                            contract — never a fabricated grounding regression).
 *                            That tolerance is scoped to the grounding metric
 *                            ALONE: a null grounding also means the pass
 *                            predicate lost a conjunct, which is a hard failure
 *                            (see passPredicateOf / issue #2992).
 *   passRate          0..1  deterministic verdict (+ grounding>=4 when judged,
 *                            + productFidelity>=4 when the judge returned it).
 *                            NOT a single quantity: WHICH conjuncts were applied
 *                            varies run to run, so every comparison of this
 *                            metric must first agree the two sides were produced
 *                            under the same predicate (#2992).
 *   questions         int   rows that produced a score. ZERO means the surface
 *                            was NOT MEASURED (every eval-probe call failed) —
 *                            the evaluator rolls an empty result set up as a
 *                            hard 0.00, so the gate must NOT read that as a
 *                            retrieval result. Issue #2798. null = a legacy
 *                            artifact that never carried the count.
 *   rowsAttempted     int   golden rows the surface tried (#2798, optional)
 *   probeErrors       map   probe failures by HTTP status (#2798, optional)
 *
 * Delta convention: EVAL_REGRESSION_DELTA is in POINTS. Rate metrics compare in
 * percentage points (0.05 = 5 points). groundingAvg maps its 4-wide 1..5 scale
 * onto 0..100, so a 0.2 grounding drop = 5 points (documented in
 * content/evals/eval-floors.json _meta.deltaConvention).
 */

/** Metrics the floors file may constrain, with their delta-point scaling. */
export const METRICS = /** @type {const} */ ([
  { key: 'retrievalHitRate', label: 'hit-rate', pointsPerUnit: 100, display: (v) => v == null ? '—' : v.toFixed(2) },
  { key: 'groundingAvg', label: 'grounding', pointsPerUnit: 25, display: (v) => v == null ? 'deferred' : v.toFixed(2) },
  { key: 'passRate', label: 'pass-rate', pointsPerUnit: 100, display: (v) => v == null ? '—' : v.toFixed(2) },
]);

const EPS = 1e-9;

/**
 * Normalize any accepted run shape into a per-surface map (latest run wins).
 * Accepted inputs:
 *   1. the E2 HTTP-trigger response body:
 *      { ok, surfaces: [{ surface, questions, retrievalHitRate, groundingAvg, passRate }] }
 *   2. one Cosmos `eval-run` doc: { surface, startedAt, totals: {...} }
 *   3. an array of Cosmos `eval-run` docs (mixed surfaces / runs).
 * Returns Map<surface, {surface, questions, retrievalHitRate, groundingAvg, passRate, startedAt?}>.
 */
export function normalizeRuns(json) {
  const out = new Map();
  const put = (r) => {
    if (!r || typeof r.surface !== 'string' || !r.surface) return;
    const prev = out.get(r.surface);
    // latest-wins when startedAt is known on both; otherwise last-listed wins
    if (prev && prev.startedAt && r.startedAt && String(r.startedAt) < String(prev.startedAt)) return;
    out.set(r.surface, r);
  };
  const fromDoc = (d) => ({
    surface: d.surface,
    startedAt: d.startedAt,
    // null (not 0) when the field is ABSENT — a legacy doc that never carried a
    // count must not be mistaken for a run that measured nothing (#2798).
    questions: numOrNull(d.totals?.questions ?? d.questions),
    rowsAttempted: numOrNull(d.totals?.rowsAttempted ?? d.rowsAttempted),
    probeErrors: d.totals?.probeErrors ?? d.probeErrors ?? null,
    retrievalHitRate: numOrNull(d.totals?.retrievalHitRate ?? d.retrievalHitRate),
    groundingAvg: numOrNull(d.totals?.groundingAvg ?? d.groundingAvg),
    passRate: numOrNull(d.totals?.passRate ?? d.passRate),
    // #2979 — the parity-inversion channel. `productFidelityJudged` is the
    // COVERAGE counter: judged > 0 with productFidelityJudged === 0 means the
    // judge deployment never returned the rubric field, i.e. the channel
    // measured NOTHING that run. It is reported, never inferred from a healthy
    // groundingAvg.
    judged: numOrNull(d.totals?.judged ?? d.judged),
    autoFailed: numOrNull(d.totals?.autoFailed ?? d.autoFailed),
    productFidelityAvg: numOrNull(d.totals?.productFidelityAvg ?? d.productFidelityAvg),
    productFidelityJudged: numOrNull(d.totals?.productFidelityJudged ?? d.productFidelityJudged),
    parityInversions: numOrNull(d.totals?.parityInversions ?? d.parityInversions),
    // #2992 — the pass predicate's own provenance. DECLARED by evaluators new
    // enough to emit it; INFERRED from the observable judge fields otherwise
    // (see passPredicateOf). `deterministicPassRate` is the degraded-mode
    // metric under its own name — deliberately NOT `passRate`.
    passPredicate: d.totals?.passPredicate ?? d.passPredicate ?? null,
    deterministicPassRate: numOrNull(d.totals?.deterministicPassRate ?? d.deterministicPassRate),
  });
  if (Array.isArray(json)) {
    for (const d of json) put(fromDoc(d));
  } else if (json && Array.isArray(json.surfaces)) {
    for (const s of json.surfaces) put(fromDoc(s));
  } else if (json && typeof json.surface === 'string') {
    put(fromDoc(json));
  }
  return out;
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Pass-predicate provenance (#2992) ────────────────────────────────────────
//
// `passRate` is NOT one quantity. It is "the fraction of questions satisfying
// the conjunct set that this run was able to apply", and that set VARIES:
//
//   deterministic      retrievalHit && mentionPass && !forbiddenHit
//                      && !parityInversionHit          — always applied
//   grounding          judge.grounding >= 4            — only on JUDGED rows
//   productFidelity    judge.productFidelity >= 4      — only when the judge
//                                                        deployment returns the
//                                                        rubric field (#2979)
//
// (evaluator-core.ts::computePass — a deferred/errored judge keeps the
// deterministic verdict, so a dropped conjunct can only move `passRate` UP.)
//
// That asymmetry is what made this dangerous enough to file: a TOTAL judge
// failure drops the grounding conjunct on every row and therefore renders as a
// large IMPROVEMENT. The worse the degradation, the better the number looks.
// An eval run did exactly this — `groundingAvg: null` on every surface, the
// deterministic-only rate compared against a judged baseline, and the
// difference reported as `data-agent +20` / `report +20`.
//
// So: every run carries the predicate that produced its rate, and two rates are
// only ever subtracted after their predicates are agreed to match.

/** Conjuncts the pass predicate may carry, with the rubric each comes from. */
export const PASS_CONJUNCTS = /** @type {const} */ ([
  { key: 'deterministic', label: 'retrievalHit && mentionPass && !forbiddenHit && !parityInversionHit' },
  { key: 'grounding', label: 'judge.grounding >= 4' },
  { key: 'productFidelity', label: 'judge.productFidelity >= 4' },
]);

/**
 * The predicate that produced a run's pass rate.
 *
 * DECLARED when the evaluator emitted `passPredicate` (a run receipt from an
 * evaluator built after #2992). INFERRED otherwise, from fields every receipt
 * has carried since the evaluator's first commit — the inference is exact, not
 * a heuristic:
 *
 *   groundingAvg === null  ⟺  rollupRun found ZERO judged results
 *                             (evaluator-core.ts: `judgedResults.length
 *                             ? avg(...) : null`)  ⟺  the grounding conjunct
 *                             was applied to no row at all.
 *   productFidelityJudged  is the count of judged rows that RETURNED the
 *                          dimension (#2979); 0/absent ⟺ the conjunct was
 *                          applied to no row.
 *
 * Inference matters because the deployed evaluator image is stale (#2991) — a
 * fix that only read a DECLARED field would be inert until that image ships.
 *
 * @param {object|null} run  a normalized run (normalizeRuns)
 * @returns {{id: string, conjuncts: string[], degraded: boolean,
 *            judgeCoverage: number|null, source: 'declared'|'inferred',
 *            metricName: 'passRate'|'deterministicPassRate', measured: boolean}}
 */
export function passPredicateOf(run) {
  const notMeasured = {
    id: 'not-measured',
    conjuncts: [],
    degraded: false,
    judgeCoverage: null,
    source: 'inferred',
    metricName: 'passRate',
    measured: false,
  };
  if (!run) return notMeasured;
  // Zero scored questions = nothing was evaluated under ANY predicate (#2798).
  if (run.questions === 0) return notMeasured;

  const declared = run.passPredicate;
  if (declared && Array.isArray(declared.conjuncts)) {
    const conjuncts = declared.conjuncts.filter((c) => PASS_CONJUNCTS.some((x) => x.key === c));
    return {
      id: conjuncts.join('+') || 'none',
      conjuncts,
      degraded: !conjuncts.includes('grounding'),
      judgeCoverage: numOrNull(declared.judgeCoverage),
      source: 'declared',
      metricName: conjuncts.includes('grounding') ? 'passRate' : 'deterministicPassRate',
      measured: true,
    };
  }

  const conjuncts = ['deterministic'];
  if (run.groundingAvg !== null && run.groundingAvg !== undefined) conjuncts.push('grounding');
  if (Number.isFinite(run.productFidelityJudged) && run.productFidelityJudged > 0) {
    conjuncts.push('productFidelity');
  }
  // Coverage refines a MATCHING predicate: how much of the judgeable set the
  // judge actually reached. `judged`/`autoFailed` ride the Cosmos `totals`; the
  // console-log receipt does not carry them, hence null-tolerant.
  let judgeCoverage = null;
  if (Number.isFinite(run.judged) && Number.isFinite(run.questions)) {
    // auto-failed rows never spend a judge call by design and fail the
    // deterministic conjunct anyway — they are not "missing" judge coverage.
    const judgeable = run.questions - (Number.isFinite(run.autoFailed) ? run.autoFailed : 0);
    judgeCoverage = judgeable > 0 ? Math.min(1, run.judged / judgeable) : 1;
  }
  const degraded = !conjuncts.includes('grounding');
  return {
    id: conjuncts.join('+'),
    conjuncts,
    degraded,
    judgeCoverage,
    source: 'inferred',
    metricName: degraded ? 'deterministicPassRate' : 'passRate',
    measured: true,
  };
}

/**
 * May these two pass rates be subtracted?
 *
 * The refusal is the point. Emitting no delta is strictly better than emitting
 * one computed across different predicates, because the second is indexed under
 * a column header ("Pass-rate Δ") that asserts it means something it does not.
 *
 * @returns {{ok: boolean, reason: string|null, detail: string|null}}
 */
export function predicatesComparable(cur, prev, opts = {}) {
  const deltaPoints = Number.isFinite(opts.deltaPoints) ? opts.deltaPoints : 5;
  if (!cur?.measured || !prev?.measured) {
    return { ok: false, reason: 'not-measured', detail: 'one side scored zero questions — nothing to compare' };
  }
  if (cur.id !== prev.id) {
    const gained = cur.conjuncts.filter((c) => !prev.conjuncts.includes(c));
    const lost = prev.conjuncts.filter((c) => !cur.conjuncts.includes(c));
    const bits = [];
    if (lost.length) bits.push(`this run DROPPED [${lost.join(', ')}]`);
    if (gained.length) bits.push(`this run ADDED [${gained.join(', ')}]`);
    return {
      ok: false,
      reason: 'predicate-mismatch',
      detail:
        `baseline predicate \`${prev.id}\` vs this run's \`${cur.id}\` — ${bits.join('; ')}. ` +
        'Dropping a conjunct can only raise the rate, so the difference would read as an improvement ' +
        'regardless of quality.',
    };
  }
  // Same conjunct set, different judge REACH: the coverage gap alone bounds how
  // much of any apparent movement is predicate drift rather than quality. If
  // that bound exceeds the threshold the check is testing against, the check
  // cannot distinguish the two — so it must not claim to.
  if (cur.judgeCoverage !== null && prev.judgeCoverage !== null) {
    const gapPoints = Math.abs(cur.judgeCoverage - prev.judgeCoverage) * 100;
    if (gapPoints > deltaPoints + EPS) {
      return {
        ok: false,
        reason: 'coverage-gap',
        detail:
          `same conjuncts (\`${cur.id}\`) but the judge reached ${(prev.judgeCoverage * 100).toFixed(0)}% of ` +
          `judgeable rows in the baseline vs ${(cur.judgeCoverage * 100).toFixed(0)}% here — a gap of ` +
          `${gapPoints.toFixed(1)} points, larger than the ${deltaPoints}-point threshold this check applies.`,
      };
    }
  }
  return { ok: true, reason: null, detail: null };
}

/** The exact remediation for a run whose judge never scored a row. */
const JUDGE_REMEDIATION =
  'Resolve a judge deployment (LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT → LOOM_AOAI_STRONG_DEPLOYMENT → ' +
  'LOOM_AOAI_MINI_DEPLOYMENT → LOOM_AOAI_DEPLOYMENT) and confirm the daily cap ' +
  '(LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP, default 5000 judged Q/day) is not already spent for this UTC day.';

/**
 * Split Cosmos `eval-run` docs into {latest, previous} normalized maps —
 * per surface, the newest run and the one before it (by startedAt).
 */
export function latestAndPrevious(docs) {
  const bySurface = new Map();
  for (const d of Array.isArray(docs) ? docs : []) {
    if (typeof d?.surface !== 'string') continue;
    const list = bySurface.get(d.surface) ?? [];
    list.push(d);
    bySurface.set(d.surface, list);
  }
  const latest = [];
  const previous = [];
  for (const list of bySurface.values()) {
    list.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    if (list[0]) latest.push(list[0]);
    if (list[1]) previous.push(list[1]);
  }
  return { latest: normalizeRuns(latest), previous: normalizeRuns(previous) };
}

/**
 * The gate: compare the current run against the floors and (optionally) the
 * previous run.
 *
 * @param {Map<string, object>} current   normalized current run (normalizeRuns)
 * @param {object} floorsDoc              parsed content/evals/eval-floors.json
 * @param {object} [opts]
 * @param {Map<string, object>|null} [opts.previous]  normalized previous run
 * @param {number} [opts.deltaPoints=5]   warn threshold, in points (see header)
 * @param {boolean} [opts.strictMissing=false]  a floored surface absent from
 *   the run FAILS (nightly full runs) instead of warning (partial runs).
 * @returns {{rows: object[], failures: string[], warnings: string[], notes: string[]}}
 *   rows: [{surface, status:'fail'|'warn'|'ok'|'no-floor'|'missing', metrics:{[k]:{value, floor, prev, deltaPoints, verdict}}, messages:[]}]
 */
export function evaluateGate(current, floorsDoc, opts = {}) {
  const floors = floorsDoc?.floors ?? {};
  const previous = opts.previous ?? null;
  const deltaPoints = Number.isFinite(opts.deltaPoints) ? opts.deltaPoints : 5;
  const strictMissing = !!opts.strictMissing;

  const failures = [];
  const warnings = [];
  const notes = [];
  const rows = [];
  const surfaces = [...new Set([...Object.keys(floors), ...current.keys()])].sort();

  for (const surface of surfaces) {
    const floor = floors[surface] ?? null;
    const cur = current.get(surface) ?? null;
    const prev = previous?.get(surface) ?? null;
    const row = { surface, status: 'ok', metrics: {}, messages: [] };

    if (!cur) {
      // floored surface missing from this run
      const msg = `${surface}: no eval-run in this artifact (floored surface not scored)`;
      if (strictMissing) {
        row.status = 'fail';
        failures.push(msg);
      } else {
        row.status = 'missing';
        warnings.push(`${msg} — partial run tolerated (pass --strict-missing on full runs)`);
      }
      rows.push(row);
      continue;
    }
    // A surface PRESENT in the artifact but with zero scored questions was not
    // measured either — the evaluator rolls an empty result set up as a hard
    // `retrievalHitRate: 0 / passRate: 0` (evaluator-core.rollupRun). Scoring
    // that against a floor states a fact about product quality that this run
    // never established: issue #2798 reported "retrieval returning NOTHING" on
    // four surfaces that had in truth run ZERO questions apiece, because every
    // probe call failed. Same policy as the absent case above, and as the
    // whole-artifact case in check-eval-regression.mjs ("a pipeline problem,
    // not a quality regression") — it is NOT a licence to pass: the run is
    // still reported, and --strict-missing (nightly) still fails it.
    if (cur.questions === 0) {
      row.status = strictMissing ? 'fail' : 'missing';
      row.notMeasured = true;
      const attempted = Number.isFinite(cur.rowsAttempted) ? cur.rowsAttempted : null;
      const errs =
        cur.probeErrors && Object.keys(cur.probeErrors).length
          ? ` eval-probe failures by status: ${JSON.stringify(cur.probeErrors)}.`
          : ' The run receipt carries no probe-error detail (evaluator predates #2798).';
      const msg =
        `${surface}: ZERO questions scored${attempted !== null ? ` of ${attempted} golden row(s)` : ''} — ` +
        `this surface was NOT measured, so its 0.00 is not a retrieval result and its floors were NOT evaluated.${errs}`;
      if (strictMissing) failures.push(msg);
      else warnings.push(`${msg} — partial run tolerated (pass --strict-missing on full runs)`);
      rows.push(row);
      continue;
    }
    if (!floor) {
      row.status = 'no-floor';
      notes.push(`${surface}: no floor yet — add one via the ratchet once runs accumulate`);
    }

    // #2992 — establish, BEFORE any metric is read, which conjuncts produced
    // this run's pass rate and which produced the baseline's.
    const predicate = passPredicateOf(cur);
    const prevPredicate = prev ? passPredicateOf(prev) : null;
    row.passPredicate = predicate;
    row.prevPassPredicate = prevPredicate;

    for (const m of METRICS) {
      const value = cur[m.key] ?? null;
      const floorVal = floor && Number.isFinite(floor[m.key]) ? floor[m.key] : null;
      const prevVal = prev ? prev[m.key] ?? null : null;
      const metric = { value, floor: floorVal, prev: prevVal, deltaPoints: null, verdict: 'ok' };

      // groundingAvg null = judge deferred → the GROUNDING FLOOR is no-change
      // per the E2 cap contract: skip both the floor check and the delta check
      // for this metric. (Scoped to grounding only — the same null makes the
      // pass predicate degraded, which the passRate branch below hard-fails.)
      if (m.key === 'groundingAvg' && value === null) {
        metric.verdict = 'deferred';
        if (floorVal !== null) {
          notes.push(`${surface}: grounding judge deferred (E2 daily cap / no judge deployment) — floor ${floorVal} not evaluated, treated as no-change`);
        }
        row.metrics[m.key] = metric;
        continue;
      }

      // #2992 — the judge scored NO row, so `passRate` here is a
      // deterministic-only rate wearing the judged metric's name. There is no
      // pass rate for this surface this run; there is an error. Do NOT check it
      // against a floor ratcheted from judged runs, do NOT subtract it from a
      // judged baseline, and do NOT print it under the pass-rate header.
      if (m.key === 'passRate' && predicate.degraded) {
        metric.verdict = 'degraded-predicate';
        metric.metricName = predicate.metricName;
        // The value still exists — it is simply a DIFFERENT metric. Carry it
        // under its own name so the receipt loses no information.
        metric.degradedValue = cur.deterministicPassRate ?? value;
        metric.value = null;
        row.status = 'fail';
        failures.push(
          `${surface}: the grounding judge scored ZERO of ${cur.questions} question(s), so this run has NO pass-rate — ` +
          `its ${m.display(metric.degradedValue)} is a \`deterministicPassRate\` (predicate \`${predicate.id}\`, ` +
          `missing the \`grounding >= 4\` conjunct), NOT the \`passRate\` its floor and baseline are expressed in. ` +
          `Dropping that conjunct can only raise the number, so this degradation would otherwise report as an ` +
          `improvement. ${JUDGE_REMEDIATION}`,
        );
        row.metrics[m.key] = metric;
        continue;
      }

      if (floorVal !== null && value !== null && value < floorVal - EPS) {
        metric.verdict = 'below-floor';
        row.status = 'fail';
        failures.push(
          `${surface}: ${m.label} ${m.display(value)} is BELOW the floor ${m.display(floorVal)} (content/evals/eval-floors.json)`,
        );
      }

      if (prevVal !== null && value !== null && !(m.key === 'groundingAvg' && prevVal === null)) {
        // #2992 — a pass-rate delta is only meaningful when both sides were
        // produced under the same conjunct set. Refuse rather than subtract.
        if (m.key === 'passRate' && prevPredicate) {
          const cmp = predicatesComparable(predicate, prevPredicate, { deltaPoints });
          if (!cmp.ok) {
            metric.verdict = 'delta-refused';
            metric.deltaRefused = { reason: cmp.reason, detail: cmp.detail, prev: prevPredicate.id, current: predicate.id };
            metric.deltaPoints = null;
            if (row.status === 'ok' || row.status === 'no-floor') row.status = 'warn';
            warnings.push(
              `${surface}: pass-rate delta REFUSED (${cmp.reason}) — ${cmp.detail} ` +
              `No delta is reported for this surface; the two rates are not the same quantity.`,
            );
            row.metrics[m.key] = metric;
            continue;
          }
        }
        const dropPoints = (prevVal - value) * m.pointsPerUnit;
        metric.deltaPoints = Math.round(-dropPoints * 10) / 10; // signed: negative = drop
        if (dropPoints > deltaPoints + EPS && metric.verdict !== 'below-floor') {
          metric.verdict = 'big-drop';
          if (row.status === 'ok' || row.status === 'no-floor') row.status = 'warn';
          warnings.push(
            `${surface}: ${m.label} dropped ${dropPoints.toFixed(1)} points in one run ` +
            `(${m.display(prevVal)} → ${m.display(value)}; > EVAL_REGRESSION_DELTA=${deltaPoints}) — above floor, flaky-judge tolerance: WARN only`,
          );
        }
      }
      row.metrics[m.key] = metric;
    }
    rows.push(row);
  }
  return { rows, failures, warnings, notes };
}

/**
 * Render the gate report as the sticky-PR-comment markdown table.
 * `meta` may carry {title, corpusCommit, trigger, deltaPoints, floorsProvisional}.
 */
export function renderMarkdown(report, meta = {}) {
  const icon = { fail: '❌', warn: '⚠️', ok: '✅', 'no-floor': '➖', missing: '⏭️' };
  const lines = [];
  lines.push(`## ${meta.title ?? 'Copilot quality evals'}`);
  const bits = [];
  if (meta.corpusCommit) bits.push(`corpus \`${String(meta.corpusCommit).slice(0, 8)}\``);
  if (meta.trigger) bits.push(`trigger \`${meta.trigger}\``);
  bits.push(`delta threshold ${meta.deltaPoints ?? 5} pts`);
  lines.push('');
  lines.push(bits.join(' · '));
  lines.push('');
  lines.push('| Surface | Q | Hit-rate (Δpts) | Grounding (Δpts) | Pass-rate (Δpts) | Pass predicate | Floor check |');
  lines.push('|---|---:|---|---|---|---|---|');
  for (const row of report.rows) {
    const cur = row.metrics;
    const cell = (key) => {
      const m = cur[key];
      if (!m) return '—';
      const metricDef = METRICS.find((x) => x.key === key);
      // #2992 — a degraded predicate produced a DIFFERENT metric. Never print
      // its value under the `Pass-rate` header: a number under a header that
      // does not describe it is the whole defect (same lesson as #2798's
      // never-measured 0.00). The value is reported below, under its own name.
      if (m.verdict === 'degraded-predicate') {
        return `**not computed** — no judged rows`;
      }
      let s = metricDef.display(m.value);
      if (m.verdict === 'delta-refused') {
        s += ' (Δ **refused**)';
      } else if (m.deltaPoints !== null && m.deltaPoints !== undefined) {
        s += ` (${m.deltaPoints > 0 ? '+' : ''}${m.deltaPoints})`;
      }
      if (m.verdict === 'below-floor') s += ` **< floor ${metricDef.display(m.floor)}**`;
      return s;
    };
    // Not scored in this run (absent, or present with zero questions — #2798).
    // NEVER print a rate for these: a rendered "0.00" is what got four
    // never-measured surfaces triaged as a retrieval outage.
    const unscored = row.status === 'missing' || row.notMeasured;
    const label = row.notMeasured ? 'not measured' : 'not run';
    const q = unscored
      ? (Number.isFinite(row.rowsAttempted) ? `0/${row.rowsAttempted}` : '—')
      : (cellQuestions(row) ?? '—');
    lines.push(
      `| ${row.surface} | ${q} | ${unscored ? label : cell('retrievalHitRate')} | ` +
      `${unscored ? '—' : cell('groundingAvg')} | ${unscored ? '—' : cell('passRate')} | ` +
      `${unscored ? '—' : predicateCell(row)} | ${icon[row.status] ?? row.status} ${row.status} |`,
    );
  }
  // #2992 — the predicate ledger. A silently-absent delta is a smaller version
  // of the same defect, so every refusal is stated with both sides named.
  const degraded = report.rows.filter((r) => r.metrics?.passRate?.verdict === 'degraded-predicate');
  const refused = report.rows.filter((r) => r.metrics?.passRate?.verdict === 'delta-refused');
  if (degraded.length || refused.length) {
    lines.push('', '### Pass-predicate provenance (#2992)', '');
    for (const r of degraded) {
      const m = r.metrics.passRate;
      lines.push(
        `- ❌ \`${r.surface}\` — the judge scored **no rows**, so there is no \`passRate\` for this run. ` +
        `Its deterministic-only rate is **\`deterministicPassRate\` = ${m.degradedValue ?? '—'}** ` +
        `(predicate \`${r.passPredicate?.id}\`). The \`grounding >= 4\` conjunct was applied to zero questions; ` +
        'dropping it can only raise the rate, so this is reported as a FAILURE rather than an improvement.',
      );
    }
    for (const r of refused) {
      const d = r.metrics.passRate.deltaRefused ?? {};
      lines.push(
        `- ⚠️ \`${r.surface}\` — pass-rate Δ **refused** (\`${d.reason}\`): ${d.detail} ` +
        `The two rates are not the same quantity, so no delta is shown.`,
      );
    }
  }
  if (report.failures.length) {
    lines.push('', '### Below-floor failures', '');
    for (const f of report.failures) lines.push(`- ❌ ${f}`);
  }
  if (report.warnings.length) {
    lines.push('', '### Warnings', '');
    for (const w of report.warnings) lines.push(`- ⚠️ ${w}`);
  }
  // #2979 — the parity-inversion channel, reported explicitly. Grounding cannot
  // see this class (a claim copied out of a parity doc's Fabric inventory IS
  // supported by the retrieved context), so its coverage has to be stated
  // rather than inferred from a healthy grounding average.
  const inverted = report.rows.filter((r) => Number.isFinite(r.parityInversions) && r.parityInversions > 0);
  const unmeasured = report.rows.filter(
    (r) => Number.isFinite(r.judged) && r.judged > 0 && r.productFidelityJudged === 0,
  );
  if (inverted.length || unmeasured.length) {
    lines.push('', '### Parity-inversion channel (#2979)', '');
    for (const r of inverted) {
      lines.push(
        `- ❌ \`${r.surface}\` — ${r.parityInversions} answer(s) reported another product's ` +
        'capability as CSA Loom\'s (deterministic detector).',
      );
    }
    for (const r of unmeasured) {
      lines.push(
        `- ⚠️ \`${r.surface}\` — the judge returned NO \`productFidelity\` score on any of ` +
        `${r.judged} judged question(s): this channel was NOT measured this run.`,
      );
    }
  }
  if (meta.floorsProvisional) {
    lines.push('', '_Floors are PROVISIONAL (set pre-first-run); `ratchet-eval-floors.mjs` raises them from measured runs — raise-only._');
  }
  return lines.join('\n') + '\n';
}

function cellQuestions(row) {
  // questions ride on the row only via the current map — the CLI attaches it
  return Number.isFinite(row.questions) ? row.questions : null;
}

/** #2992 — the conjunct set that produced this row's rate, stated per row. */
function predicateCell(row) {
  const p = row.passPredicate;
  if (!p || !p.measured) return '—';
  const cov = p.judgeCoverage === null ? '' : ` · judge ${(p.judgeCoverage * 100).toFixed(0)}%`;
  const mark = p.source === 'declared' ? '' : ' *(inferred)*';
  return `\`${p.id}\`${cov}${mark}`;
}

/** Attach `questions` onto gate rows from the normalized current map (display only). */
export function attachQuestions(report, current) {
  for (const row of report.rows) {
    const cur = current.get(row.surface);
    if (cur && Number.isFinite(cur.questions)) row.questions = cur.questions;
    if (cur && Number.isFinite(cur.rowsAttempted)) row.rowsAttempted = cur.rowsAttempted;
    // #2979 — display-only carry-through for the parity-inversion channel.
    if (cur && Number.isFinite(cur.judged)) row.judged = cur.judged;
    if (cur && Number.isFinite(cur.productFidelityAvg)) row.productFidelityAvg = cur.productFidelityAvg;
    if (cur && Number.isFinite(cur.productFidelityJudged)) row.productFidelityJudged = cur.productFidelityJudged;
    if (cur && Number.isFinite(cur.parityInversions)) row.parityInversions = cur.parityInversions;
  }
  return report;
}

// ── Ratchet (raise-only) ─────────────────────────────────────────────────────

/** Per-metric ratchet margins + rounding + ceilings (floors never ratchet above
 *  the cap — a flaky-perfect streak must not create an unclearable floor). */
export const RATCHET_RULES = {
  retrievalHitRate: { margin: 0.05, decimals: 2, cap: 0.95 },
  groundingAvg: { margin: 0.2, decimals: 1, cap: 4.6 },
  passRate: { margin: 0.05, decimals: 2, cap: 0.95 },
};

/**
 * Raise-only floor ratchet.
 *
 * @param {object} floorsDoc  parsed eval-floors.json (NOT mutated)
 * @param {Map<string, object[]>} observations  surface → array of normalized
 *   run observations (one per run in the streak window)
 * @param {object} [opts]
 * @param {number} [opts.minRuns=3]  a surface needs >= this many observations
 *   (the "sustained gain / green streak" guard) before its floors move
 * @returns {{next: object, changes: {surface, metric, from, to}[], skipped: string[]}}
 */
export function ratchetFloors(floorsDoc, observations, opts = {}) {
  const minRuns = Number.isFinite(opts.minRuns) ? opts.minRuns : 3;
  const next = JSON.parse(JSON.stringify(floorsDoc ?? { floors: {} }));
  next.floors = next.floors ?? {};
  const changes = [];
  const skipped = [];

  for (const [surface, allRuns] of observations) {
    // Drop never-measured runs BEFORE the streak count (#2798): such a run
    // rolls up as retrievalHitRate 0, which would become `observedMin` and pin
    // the proposal below every existing floor — one unmeasured run would
    // silently block this surface's floor from EVER ratcheting, while looking
    // like ordinary "no sustained gain".
    const runs = Array.isArray(allRuns) ? allRuns.filter((r) => r?.questions !== 0) : allRuns;
    const dropped = Array.isArray(allRuns) ? allRuns.length - runs.length : 0;
    if (!Array.isArray(runs) || runs.length < minRuns) {
      skipped.push(
        `${surface}: only ${runs?.length ?? 0} run(s) observed (need >= ${minRuns} for a sustained streak)` +
        (dropped > 0 ? ` — ${dropped} run(s) ignored: zero questions scored (not measured)` : ''),
      );
      continue;
    }
    const floor = next.floors[surface] ?? {};
    let raised = false;
    for (const [metric, rule] of Object.entries(RATCHET_RULES)) {
      const values = runs.map((r) => r?.[metric]).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
      // grounding ratchets ONLY on a fully-judged window: any 'deferred' run
      // (null groundingAvg) means the streak's grounding evidence is
      // incomplete — leave that floor untouched (conservative, per the E2 cap
      // contract).
      if (metric === 'groundingAvg' && values.length < runs.length) continue;
      // #2992 — passRate ratchets ONLY from a window whose runs all applied the
      // SAME conjunct set. Otherwise a run that lost the `grounding >= 4`
      // conjunct (its rate can only be HIGHER for it) would raise the floor on
      // evidence the judge never produced, permanently pinning a `passRate`
      // floor above what a healthy judged run can clear — the same
      // cross-predicate arithmetic the delta comparator refuses, but baked in
      // rather than merely reported.
      if (metric === 'passRate') {
        const predicates = runs.map((r) => passPredicateOf(r));
        const degradedRuns = predicates.filter((p) => p.degraded).length;
        const ids = new Set(predicates.map((p) => p.id));
        if (degradedRuns > 0 || ids.size > 1) {
          skipped.push(
            `${surface}: passRate floor NOT ratcheted — the ${runs.length}-run window mixes pass predicates ` +
            `(${[...ids].map((i) => `\`${i}\``).join(', ')}${degradedRuns ? `; ${degradedRuns} run(s) had NO judged rows` : ''}). ` +
            'A floor may only be raised from rates produced under one predicate.',
          );
          continue;
        }
      }
      if (values.length === 0) continue;
      const observedMin = Math.min(...values);
      const factor = 10 ** rule.decimals;
      // +EPS before floor(): FP-safe round-down ((1 − 0.05) × 100 is
      // 94.99999999999999 in IEEE754 — without the nudge the proposal would
      // land at 0.94 instead of 0.95).
      let proposed = Math.floor((observedMin - rule.margin) * factor + EPS * factor) / factor;
      proposed = Math.min(proposed, rule.cap);
      const currentFloor = Number.isFinite(floor[metric]) ? floor[metric] : -Infinity;
      if (proposed > currentFloor + EPS) {
        changes.push({ surface, metric, from: Number.isFinite(floor[metric]) ? floor[metric] : null, to: proposed });
        floor[metric] = proposed;
        raised = true;
      }
    }
    if (raised) {
      floor.provisional = false; // measured reality has replaced the seed
      next.floors[surface] = floor;
    }
  }
  return { next, changes, skipped };
}
