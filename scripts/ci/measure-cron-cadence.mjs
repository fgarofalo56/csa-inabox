#!/usr/bin/env node
/**
 * measure-cron-cadence.mjs — what a `cron:` DECLARES vs what GitHub actually ran.
 *
 * WHY. A workflow's schedule is an assumption everything downstream reasons from:
 * detection latency, staleness allowances, "the keep-warm tops the pool up before
 * the idle TTL expires". Nothing in this repo had ever measured whether GitHub
 * honours it.
 *
 * Measured 2026-08-11 over ~2.4 days of real run history:
 *
 *   workflow                     declared   measured median   ratio
 *   ---------------------------  ---------  ----------------  -----
 *   csa-loom-spark-keepwarm          5m           52m         10.4x
 *   acr-firewall-sweeper            15m           56m          3.7x
 *   csa-loom-shir-idle-stop         15m           53m          3.5x
 *   loom-synthetic-monitor          15m           62m          4.1x
 *
 * For loom-synthetic-monitor across 55 consecutive intervals: min 31m, median
 * 55m, mean 63m, max 146m — and ZERO intervals at or under 20 minutes. It has
 * never once run at its declared cadence.
 *
 * This is documented GitHub behaviour (high-frequency schedules on busy repos are
 * delayed or dropped), not a defect in the workflows. The defect is reasoning
 * from the declared number as if it were the real one.
 *
 * REPORTS, DOES NOT FAIL, by default. GitHub's scheduler is not something this
 * repo controls, so failing CI on it would be a gate nobody can fix. `--max-ratio
 * <n>` makes it fail when the drift exceeds a threshold, for a caller that has
 * decided a particular cadence is load-bearing.
 *
 * FAIL CLOSED ON UNKNOWNS. A workflow with too few scheduled runs to measure is
 * reported as INSUFFICIENT DATA, never as healthy — the same distinction the rest
 * of this repo's checks make between "measured fine" and "not measured".
 *
 * USAGE
 *   node scripts/ci/measure-cron-cadence.mjs [--limit 60] [--max-ratio 3]
 *   (requires `gh` on PATH and repo read access)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const LIMIT = Number(argOf('--limit', '60'));
const MAX_RATIO = argOf('--max-ratio', null) === null ? null : Number(argOf('--max-ratio', null));
const MIN_INTERVALS = 5;

const WF_DIR = join(process.cwd(), '.github', 'workflows');

// Every workflow with a step-minute cron (the `slash-star-slash-N` form), and
// the N it declares. NOTE: written as a LINE comment on purpose — the literal
// star-slash inside a JSDoc block terminates the comment early and the file
// stops parsing, which is how the first version of this script died.
function declaredMinuteCrons() {
  const out = [];
  for (const f of readdirSync(WF_DIR)) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
    let text;
    try {
      text = readFileSync(join(WF_DIR, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s*-\s*cron:\s*['"]\*\/(\d+)\s/gm)) {
      out.push({ workflow: f, declaredMinutes: Number(m[1]) });
      break; // one entry per workflow is enough for a cadence claim
    }
  }
  return out;
}

function scheduledRunTimes(workflow) {
  let raw;
  try {
    raw = execFileSync(
      'gh',
      ['run', 'list', '--workflow', workflow, '--limit', String(LIMIT), '--json', 'createdAt,event',
       '--jq', '.[]|select(.event=="schedule")|.createdAt'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    return { error: (e.stderr || e.message || '').toString().trim().slice(0, 200) };
  }
  const ts = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return { ts };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows = [];
for (const { workflow, declaredMinutes } of declaredMinuteCrons()) {
  const { ts, error } = scheduledRunTimes(workflow);
  if (error) {
    rows.push({ workflow, declaredMinutes, state: 'UNREADABLE', detail: error });
    continue;
  }
  if (ts.length < MIN_INTERVALS + 1) {
    rows.push({
      workflow,
      declaredMinutes,
      state: 'INSUFFICIENT DATA',
      detail: `${ts.length} scheduled run(s); need ${MIN_INTERVALS + 1}`,
    });
    continue;
  }
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 60000);
  const med = median(gaps);
  rows.push({
    workflow,
    declaredMinutes,
    state: 'MEASURED',
    n: gaps.length,
    min: Math.min(...gaps),
    med,
    max: Math.max(...gaps),
    ratio: med / declaredMinutes,
  });
}

if (rows.length === 0) {
  console.error('::error::measure-cron-cadence: found NO workflow with a */N minute cron. Refusing to report a pass on an empty population.');
  process.exit(1);
}

console.log('cron cadence — DECLARED vs MEASURED (scheduled runs only)');
console.log('');
let worst = 0;
for (const r of rows.sort((a, b) => (b.ratio || 0) - (a.ratio || 0))) {
  if (r.state !== 'MEASURED') {
    console.log(`  ${r.workflow.padEnd(38)} */${r.declaredMinutes}m   ${r.state} — ${r.detail}`);
    continue;
  }
  worst = Math.max(worst, r.ratio);
  console.log(
    `  ${r.workflow.padEnd(38)} */${String(r.declaredMinutes).padStart(2)}m   ` +
      `min=${r.min.toFixed(0)}m med=${r.med.toFixed(0)}m max=${r.max.toFixed(0)}m   ` +
      `${r.ratio.toFixed(1)}x declared   (n=${r.n})`,
  );
}
console.log('');
console.log('  GitHub delays or drops high-frequency schedules on busy repositories. That is');
console.log('  documented behaviour, not a defect in these workflows. The defect is any design');
console.log('  that reasons from the DECLARED number — e.g. a keep-warm sized against an idle');
console.log('  TTL, or a staleness allowance sized against a detection interval.');

if (MAX_RATIO !== null && worst > MAX_RATIO) {
  console.error(
    `::error::measure-cron-cadence: the worst measured cadence is ${worst.toFixed(1)}x its declared interval, ` +
      `over the --max-ratio ${MAX_RATIO} this caller declared load-bearing.`,
  );
  process.exit(1);
}
