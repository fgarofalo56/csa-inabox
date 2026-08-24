#!/usr/bin/env node
/**
 * Name the red checks across PRs, to see whether they share one cause.
 *
 * `cancelled` is reported SEPARATELY from `failure`. A cancelled check did not
 * finish — usually a concurrency group superseding it — so it is UNKNOWN, not a
 * verdict. Flattening the two makes a docs-only PR look broken when its check
 * was merely pre-empted, and sends you hunting a defect that does not exist.
 */
import { gh, checkRuns } from './measure.mjs';

const REPO = 'fgarofalo56/csa-inabox';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const failTally = new Map();
const cancelTally = new Map();

for (const pr of process.argv.slice(2)) {
  sleep(1200);
  try {
    const v = gh(['pr', 'view', pr, '--json', 'headRefOid']);
    // Via checkRuns, NOT a raw single-page read. This file previously did its own
    // `per_page=100` fetch with `d.check_runs || []`, which is both of the things
    // this directory exists to prevent, in one line: an unpaginated read reports a
    // saturated page as the whole set, and `|| []` turns a missing array into a
    // confident `FAILED=0 CANCELLED=0`. checkRuns refuses both.
    const runs = checkRuns(REPO, v.headRefOid).runs;
    const failed = runs.filter((r) => ['failure', 'timed_out'].includes(r.conclusion)).map((r) => r.name);
    const cancelled = runs.filter((r) => r.conclusion === 'cancelled').map((r) => r.name);
    console.log(
      `#${pr}  FAILED=${failed.length} ${failed.join(' | ') || '-'}` +
      `   CANCELLED=${cancelled.length} ${cancelled.join(' | ') || '-'}`,
    );
    for (const n of failed) failTally.set(n, (failTally.get(n) || 0) + 1);
    for (const n of cancelled) cancelTally.set(n, (cancelTally.get(n) || 0) + 1);
  } catch (e) {
    console.log(`#${pr}  QUERY-FAILED: ${String(e.message).slice(0, 60)}`);
  }
}

const show = (label, m) => {
  console.log(`\n${label}:`);
  if (m.size === 0) { console.log('  (none)'); return; }
  [...m.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([n, c]) => console.log(`  ${String(c).padStart(2)}x  ${n}`));
};
show('REAL FAILURES (a verdict)', failTally);
show('CANCELLED (UNKNOWN — needs a re-run, not a fix)', cancelTally);
