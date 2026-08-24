#!/usr/bin/env node
/**
 * drain-status.mjs — PR merge-readiness, using scripts/measure so a failed
 * query can never be mistaken for a real state.
 *
 * The old bash version reported `0/0/0` for twenty PRs during an HTTP 403 and
 * `UNKNOWN` for eight more from a `2>/dev/null`. Here a failed read prints
 * QUERY-FAILED with the reason, which is a different thing from a verdict.
 */

import { gh, checkRuns, MeasurementError } from './measure.mjs';

const REPO = 'fgarofalo56/csa-inabox';
const PACE_MS = 1500; // secondary limits fire on burst rate, not quota

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scripts/measure/drain-status.mjs <pr> [pr...]');
  process.exit(2);
}

let failedReads = 0;
const ready = [];

console.log(`${'PR'.padStart(6)}  ${'mergeable'.padEnd(13)} ${'t/red/pend'.padEnd(12)} closes`);
console.log('-'.repeat(58));

for (const pr of targets) {
  sleep(PACE_MS);
  let view, runs, closes;
  try {
    view = gh(['pr', 'view', pr, '--json', 'mergeable,mergeStateStatus,headRefOid,closingIssuesReferences']);
  } catch (e) {
    failedReads++;
    console.log(`${pr.padStart(6)}  QUERY-FAILED: ${String(e.message).slice(0, 70)}`);
    continue;
  }
  closes = (view.closingIssuesReferences || []).map((c) => c.number).join(',');
  try {
    runs = checkRuns(REPO, view.headRefOid);
  } catch (e) {
    failedReads++;
    // A throw here is the whole point: `checkRuns` refuses to report 0/0/0.
    console.log(`${pr.padStart(6)}  ${String(view.mergeable).padEnd(13)} CHECKS-UNKNOWN: ${String(e.message).slice(0, 46)}`);
    continue;
  }
  const ok = view.mergeable === 'MERGEABLE' && runs.red === 0 && runs.pending === 0 && !closes;
  if (ok) ready.push(pr);
  console.log(
    `${pr.padStart(6)}  ${String(view.mergeable).padEnd(13)} ` +
    `${`${runs.total}/${runs.red}/${runs.pending}`.padEnd(12)} ` +
    `[${closes}] ${ok ? '<< READY' : ''}`,
  );
}

console.log(`\nREADY: ${ready.length ? ready.join(' ') : '(none)'}`);
if (failedReads > 0) {
  console.log(`FAILED READS: ${failedReads} — these are UNKNOWN, not verdicts. Re-run them.`);
  process.exit(1);
}
