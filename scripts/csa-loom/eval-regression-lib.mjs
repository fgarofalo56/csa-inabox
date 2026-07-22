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
 *                            (E2 daily cap / no judge deployment). Per the E2
 *                            cap contract the gate treats null as NO-CHANGE —
 *                            never a regression, never a fabricated pass.
 *   passRate          0..1  deterministic verdict (+ grounding>=4 when judged)
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
    questions: d.totals?.questions ?? d.questions ?? 0,
    retrievalHitRate: numOrNull(d.totals?.retrievalHitRate ?? d.retrievalHitRate),
    groundingAvg: numOrNull(d.totals?.groundingAvg ?? d.groundingAvg),
    passRate: numOrNull(d.totals?.passRate ?? d.passRate),
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
    if (!floor) {
      row.status = 'no-floor';
      notes.push(`${surface}: no floor yet — add one via the ratchet once runs accumulate`);
    }

    for (const m of METRICS) {
      const value = cur[m.key] ?? null;
      const floorVal = floor && Number.isFinite(floor[m.key]) ? floor[m.key] : null;
      const prevVal = prev ? prev[m.key] ?? null : null;
      const metric = { value, floor: floorVal, prev: prevVal, deltaPoints: null, verdict: 'ok' };

      // groundingAvg null = judge deferred → NO-CHANGE per the E2 cap contract:
      // skip both the floor check and the delta check for this metric.
      if (m.key === 'groundingAvg' && value === null) {
        metric.verdict = 'deferred';
        if (floorVal !== null) {
          notes.push(`${surface}: grounding judge deferred (E2 daily cap / no judge deployment) — floor ${floorVal} not evaluated, treated as no-change`);
        }
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
  lines.push('| Surface | Q | Hit-rate (Δpts) | Grounding (Δpts) | Pass-rate (Δpts) | Floor check |');
  lines.push('|---|---:|---|---|---|---|');
  for (const row of report.rows) {
    const cur = row.metrics;
    const cell = (key) => {
      const m = cur[key];
      if (!m) return '—';
      const metricDef = METRICS.find((x) => x.key === key);
      let s = metricDef.display(m.value);
      if (m.deltaPoints !== null && m.deltaPoints !== undefined) {
        s += ` (${m.deltaPoints > 0 ? '+' : ''}${m.deltaPoints})`;
      }
      if (m.verdict === 'below-floor') s += ` **< floor ${metricDef.display(m.floor)}**`;
      return s;
    };
    const q = row.status === 'missing' ? '—' : (cellQuestions(row) ?? '—');
    lines.push(
      `| ${row.surface} | ${q} | ${row.status === 'missing' ? 'not run' : cell('retrievalHitRate')} | ` +
      `${row.status === 'missing' ? '—' : cell('groundingAvg')} | ${row.status === 'missing' ? '—' : cell('passRate')} | ` +
      `${icon[row.status] ?? row.status} ${row.status} |`,
    );
  }
  if (report.failures.length) {
    lines.push('', '### Below-floor failures', '');
    for (const f of report.failures) lines.push(`- ❌ ${f}`);
  }
  if (report.warnings.length) {
    lines.push('', '### Warnings', '');
    for (const w of report.warnings) lines.push(`- ⚠️ ${w}`);
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

/** Attach `questions` onto gate rows from the normalized current map (display only). */
export function attachQuestions(report, current) {
  for (const row of report.rows) {
    const cur = current.get(row.surface);
    if (cur && Number.isFinite(cur.questions)) row.questions = cur.questions;
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

  for (const [surface, runs] of observations) {
    if (!Array.isArray(runs) || runs.length < minRuns) {
      skipped.push(`${surface}: only ${runs?.length ?? 0} run(s) observed (need >= ${minRuns} for a sustained streak)`);
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
