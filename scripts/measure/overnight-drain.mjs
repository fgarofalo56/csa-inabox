#!/usr/bin/env node
/**
 * overnight-drain.mjs — autonomous PR drain.
 *
 *   node scripts/measure/overnight-drain.mjs --dry-run
 *   node scripts/measure/overnight-drain.mjs --apply [--rounds N]
 *
 * Built on scripts/measure so a failed read can never be mistaken for a state.
 * Everything it refuses to do is as important as what it does:
 *
 *   - NEVER merges with a real failure, anything pending, or a closing reference.
 *   - Treats `cancelled` as UNKNOWN and RE-RUNS it, rather than as a verdict.
 *   - Waits for `mergeable` to settle instead of reading UNKNOWN as "no".
 *   - REQUIRES mergeStateStatus === 'CLEAN' and merges WITHOUT `--admin`.
 *     This is the whole safety model, so it is worth stating why: `--admin`
 *     bypasses branch protection, which means a loop using it has to re-derive
 *     every protection rule by hand -- up-to-date-ness, required reviews, and
 *     the PRESENCE of each required context. Getting any one of those wrong
 *     merges something GitHub was refusing. An earlier version of this file got
 *     all three wrong: it gated on "no red checks" alone, and a check that was
 *     never created is neither red nor pending, so a missing required context
 *     read as READY. `CLEAN` is GitHub's own answer to all of it, computed
 *     server-side. Once it is CLEAN a plain merge succeeds, so `--admin` is not
 *     merely unsafe here -- it is unnecessary.
 *   - AUDITS closed issues after every merge and HALTS on any unexpected change
 *     (the close parser is negation-blind: a close-keyword next to an issue
 *     number closes it even inside a sentence that means the opposite).
 *   - Halts on any anomaly rather than continuing on a guess.
 *
 * HOLD list: PRs it must never merge unattended, each with a stated reason.
 */

import { gh, checkRuns, checkRunHollowness, jobIdFromUrl, run, MeasurementError } from './measure.mjs';

const REPO = 'fgarofalo56/csa-inabox';
const APPLY = process.argv.includes('--apply');
const ROUNDS = Number((process.argv.find((a) => a.startsWith('--rounds=')) || '').split('=')[1] || 40);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Never merge these unattended. Reason is required — a hold without one rots. */
const HOLD = {
  3863: 'release PR — must merge LAST so its changelog covers everything before it',
  3873: 'MAJOR bump actions/github-script 7->9 across 7 workflows incl. deploy-fiab-il5 — operator deferred',
  3874: 'MAJOR bump actions/upload-artifact 4->7 across 23 workflows incl. deploy-fiab-gcch — operator deferred',
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function openPRs() {
  const prs = gh(['pr', 'list', '--state', 'open', '--limit', '60', '--json',
    'number,title,mergeable,mergeStateStatus,headRefOid,closingIssuesReferences,isDraft']);
  return prs.filter((p) => !p.isDraft);
}

function closedIssues() {
  return gh(['issue', 'list', '--state', 'closed', '--limit', '8', '--json', 'number'])
    .map((i) => i.number).join(',');
}

/**
 * Poll until GitHub finishes recomputing mergeability. UNKNOWN is not a verdict.
 *
 * Returns BOTH fields. `mergeable` only answers "would this apply without a
 * conflict"; `mergeStateStatus` is the one that knows about branch protection.
 * A PR can sit at MERGEABLE + BLOCKED indefinitely -- that pair means "no
 * conflicts, and GitHub is refusing anyway". Reading only the first is how the
 * earlier version of this loop decided a blocked PR was ready.
 */
function settle(pr) {
  for (let i = 0; i < 8; i++) {
    const v = gh(['pr', 'view', String(pr), '--json', 'mergeable,mergeStateStatus']);
    if (v.mergeable && v.mergeable !== 'UNKNOWN' && v.mergeStateStatus && v.mergeStateStatus !== 'UNKNOWN') {
      return { mergeable: v.mergeable, state: v.mergeStateStatus };
    }
    sleep(15000);
  }
  return { mergeable: 'UNKNOWN', state: 'UNKNOWN' };
}

let merged = 0, rerun = 0, halted = null;
let baseline = closedIssues();
log(`starting. mode=${APPLY ? 'APPLY' : 'DRY-RUN'} rounds=${ROUNDS}`);
log(`closed-issue baseline: [${baseline}]`);

for (let round = 1; round <= ROUNDS && !halted; round++) {
  let prs;
  try {
    prs = openPRs();
  } catch (e) {
    log(`round ${round}: cannot list PRs (${String(e.message).slice(0, 60)}) — waiting`);
    sleep(120000);
    continue;
  }

  const actionable = prs.filter((p) => !HOLD[p.number]);
  log(`round ${round}: ${prs.length} open, ${actionable.length} actionable, ${Object.keys(HOLD).length} held`);

  let didSomething = false;

  for (const p of actionable) {
    if (halted) break;
    sleep(1500);
    let c;
    try {
      c = checkRuns(REPO, p.headRefOid);
    } catch (e) {
      log(`  #${p.number} checks UNKNOWN (${String(e.message).slice(0, 50)}) — skip, not a verdict`);
      continue;
    }

    const closes = (p.closingIssuesReferences || []).map((x) => x.number);
    if (closes.length) {
      log(`  #${p.number} HOLD — carries closing reference(s) [${closes}]; a merge would close them`);
      continue;
    }

    // cancelled == UNKNOWN. Re-run it rather than treating it as a failure.
    if (c.cancelled > 0 && c.red === 0 && c.pending === 0) {
      const cx = c.runs.find((r) => r.conclusion === 'cancelled');
      const jid = jobIdFromUrl(cx?.details_url);
      const runId = String(cx?.details_url || '').match(/runs\/(\d+)/)?.[1];
      log(`  #${p.number} ${c.cancelled} cancelled check(s) — re-running "${cx?.name}"`);
      if (APPLY && runId) {
        try { run('gh', ['run', 'rerun', runId, '--failed']); rerun++; didSomething = true; }
        catch (e) { log(`     rerun failed: ${String(e.message).slice(0, 60)}`); }
      }
      continue;
    }

    if (c.red > 0 || c.pending > 0) {
      const names = c.runs.filter((r) => ['failure', 'timed_out'].includes(r.conclusion)).map((r) => r.name);
      log(`  #${p.number} not ready — red=${c.red}${names.length ? ' (' + names.join(', ').slice(0, 60) + ')' : ''} pending=${c.pending}`);
      continue;
    }

    const { mergeable, state } = settle(p.number);
    if (mergeable !== 'MERGEABLE') {
      log(`  #${p.number} mergeable=${mergeable} — skip`);
      continue;
    }
    // BLOCKED is the common one: required review missing, or a required context
    // absent. BEHIND means not up to date with the base. Both are states an
    // `--admin` merge would have steamrolled; neither is ours to override.
    if (state !== 'CLEAN') {
      log(`  #${p.number} mergeStateStatus=${state} (not CLEAN) — GitHub is refusing this; skip`);
      continue;
    }

    // A green required check that executed nothing is not evidence. Report it;
    // do not block on it, since a skip can be path-appropriate for the diff.
    try {
      const vt = c.runs.find((r) => /^vitest/i.test(r.name) && r.conclusion === 'success');
      if (vt) {
        const h = checkRunHollowness(REPO, jobIdFromUrl(vt.details_url));
        if (h.hollow) log(`  #${p.number} NOTE vitest green but HOLLOW (ran ${h.ran}, skipped ${h.skipped})`);
      }
    } catch { /* hollowness is advisory */ }

    log(`  #${p.number} READY (${c.total} checks, 0 red, 0 pending, state=CLEAN) — ${APPLY ? 'MERGING' : 'would merge'}`);
    if (!APPLY) { didSomething = true; continue; }

    try {
      // No `--admin`. CLEAN means branch protection is already satisfied, so a
      // plain merge succeeds; if it does NOT succeed, that refusal is a signal
      // worth surfacing rather than a flag worth adding.
      run('gh', ['pr', 'merge', String(p.number), '--squash']);
      merged++; didSomething = true;
      sleep(10000);
      const now = closedIssues();
      if (now !== baseline) {
        halted = `closed-issue set CHANGED after merging #${p.number}\n   before: [${baseline}]\n   after : [${now}]`;
        break;
      }
      log(`     merged. total this run: ${merged}`);
    } catch (e) {
      log(`     MERGE FAILED: ${String(e.message).slice(0, 90)}`);
    }
  }

  if (halted) break;
  if (!didSomething) {
    log(`  nothing actionable; sleeping 10min before round ${round + 1}`);
    sleep(600000);
  } else {
    sleep(90000);
  }
}

console.log('');
log(`DONE. merged=${merged} rerun=${rerun}`);
Object.entries(HOLD).forEach(([n, why]) => log(`HELD #${n}: ${why}`));
if (halted) {
  log(`HALTED: ${halted}`);
  process.exit(1);
}
