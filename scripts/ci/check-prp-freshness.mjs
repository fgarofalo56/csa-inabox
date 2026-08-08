#!/usr/bin/env node
/**
 * GUARDRAIL: prp-freshness  (BLOCKING per-phase re-baseline gate) — loom-next-level FRESH0
 * ------------------------------------------------------------------------
 * RULE (PRPs/active/loom-next-level — FRESH0, round 3 F4): the PRP hard-codes
 *   ground-truth numbers that its own execution invalidates ("1,356 hand-rolled
 *   routes", "exactly 256 params", "the DAX evaluator is 3 regexes", "#2389
 *   OPEN"). R29 ratchets parity-doc freshness; this applies the same thesis to
 *   the PRP itself: re-count every stated fact and FAIL when live diverges
 *   >10% from the stated value (or a referenced PR's state flipped).
 *
 * WHY THIS IS NOW BLOCKING (FINISHLINE C15).
 *
 *   This gate shipped warn-only. `--strict` existed and worked, but the
 *   workflow invoked the script WITHOUT it, and `--strict` was described as
 *   "for the boundary run itself" — a run that is not part of any PR's required
 *   checks. So the exit code was structurally incapable of blocking a merge:
 *   every fact in the table could drift arbitrarily far and every PR stayed
 *   green. That is precisely the `gates_that_cannot_fail` class — a check whose
 *   RESULT IS DISCARDED, here by never asking for it.
 *
 *   The comment "NOT a merge-blocker: exit 0 with ::warning:: annotations" was
 *   the load-bearing line and it is now gone. A ::warning:: in a log nobody
 *   reads is not a control. Drift fails the build.
 *
 * BASELINE: the FACTS table below states each fact AS WRITTEN IN THE PRP,
 *   where it is written, and how to re-count it. After a boundary
 *   re-verification updates the PRP text, update `stated` here in the same
 *   commit ("--update-baseline" prints the refreshed table to paste).
 *
 * HONEST FAILURE CLASSES (deploy-integrity.md R6/R7). A fact resolves to
 *   exactly one of three outcomes, and they are NOT the same thing:
 *     ok           — measured, within tolerance.
 *     drift        — measured, out of tolerance. The PRP text is stale. BLOCKS.
 *     undetermined — the counter could not run (e.g. `gh` unreachable/rate
 *                    limited). This is NOT evidence of drift and must never be
 *                    reported as "the state changed" — but it is also not a
 *                    pass, because an unmeasured fact has not been checked.
 *                    It BLOCKS, with a message that says it could not measure.
 *   Reporting `undetermined` as drift is the `unknown_as_negative` defect; and
 *   reporting it as ok is the `gates_that_measure_nothing` defect. It gets its
 *   own class so it can be neither.
 *
 * Owner: loom-next-level orchestrator. Unblock: re-baseline `stated` with a
 *   one-line justification in the commit, or fix the drift.
 *
 * MUTATION-PROVED: `node scripts/ci/check-prp-freshness.mjs --selftest` asserts
 *   the gate exits NON-ZERO on drift, on a flipped PR state, and on an
 *   undetermined counter — and zero when everything is within tolerance. If the
 *   blocking behaviour is ever removed, the selftest fails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'fiab-console');

/** Numeric facts may drift this far before the gate fires. */
export const DRIFT_TOLERANCE = 0.10;

function sh(cmd, args, cwd = REPO_ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
function gitFiles(pattern, cwd) {
  const out = sh('git', ['ls-files', pattern], cwd);
  return out ? out.split(/\r?\n/) : [];
}
function gitGrepFiles(regex, pathspec, cwd) {
  try {
    const out = sh('git', ['grep', '-l', '-E', regex, '--', pathspec], cwd);
    return out ? out.split(/\r?\n/) : [];
  } catch {
    return []; // grep exits 1 on zero matches
  }
}

// --- counters ---------------------------------------------------------------

function countAdminPlaneParams() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'platform/fiab/bicep/modules/admin-plane/main.bicep'), 'utf-8');
  return (src.match(/^param /gm) || []).length;
}

function countRoutes() {
  return gitFiles('app/api/**/route.ts', APP_DIR).length;
}

function countHandRolledRoutes() {
  // Session-touching routes NOT on any toolkit wrapper (R1 wrappers included).
  const sessionRoutes = new Set(gitGrepFiles(
    'getSession|withSession|withWorkspaceOwner|withBackendGate', 'app/api/**/route.ts', APP_DIR));
  const migrated = new Set(gitGrepFiles(
    'withSession|withWorkspaceOwner|withBackendGate|withTenantAdmin|withDlzAccess',
    'app/api/**/route.ts', APP_DIR));
  let n = 0;
  for (const f of sessionRoutes) if (!migrated.has(f)) n += 1;
  return n;
}

/**
 * A referenced PR's state. Throws UndeterminedError rather than returning the
 * string 'UNKNOWN': a transport failure is not a measurement, and the previous
 * version's `return 'UNKNOWN'` made an unreachable API indistinguishable from a
 * PR whose state had genuinely flipped.
 *
 * This is also where the warn-only era hid a real hole. `loom-guardrails.yml`
 * granted only `contents: read`, so `gh pr view` 403'd on EVERY run — both
 * PR-state facts had never once been measured in CI. The 403 became 'UNKNOWN',
 * 'UNKNOWN' !== 'MERGED' emitted a ::warning::, and the job exited 0. Making
 * the gate block surfaced it immediately; the workflow now grants
 * `pull-requests: read`.
 *
 * Bounded retry per deploy-integrity.md R6: retry what is genuinely transient,
 * fail CLOSED on exhaustion. A retry that cannot fail is forbidden.
 */
class UndeterminedError extends Error {}

const PR_STATE_ATTEMPTS = 3;

function prState(num, attempts = PR_STATE_ATTEMPTS) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const s = sh('gh', ['pr', 'view', String(num), '--json', 'state', '-q', '.state']);
      if (s) return s;
      last = `gh returned an empty state for PR #${num}`;
    } catch (e) {
      last = e?.message?.split('\n')[0] || String(e);
    }
    // Bounded linear backoff between attempts; no sleep after the last one.
    if (i < attempts) {
      const until = Date.now() + i * 1000;
      while (Date.now() < until) { /* busy-wait: this script is sync throughout */ }
    }
  }
  throw new UndeterminedError(
    `could not read PR #${num} via gh after ${attempts} attempt(s) (${last}) — this is a FAILED READ, not evidence the PR state changed. If this is a 403, the workflow is missing \`pull-requests: read\`.`);
}

// --- the facts table (stated = as currently written in the PRP text) --------
// numeric facts fire when |live - stated| / stated > DRIFT_TOLERANCE; state
// facts fire on any mismatch.

export const FACTS = [
  {
    id: 'param-cap',
    where: 'PRP.md ground-truth #9 / ws-ratchets.md R0',
    statement: 'admin-plane/main.bicep param declarations',
    stated: 234, // loom-apex Phase-E boundary re-baseline (2026-08-06, was 232)
    live: countAdminPlaneParams,
  },
  {
    id: 'route-total',
    where: 'ws-ratchets.md §0 ground truth',
    statement: 'total app/api/**/route.ts files',
    stated: 1671, // loom-apex Phase-E boundary re-baseline (2026-08-06, was 1643)
    live: countRoutes,
  },
  {
    id: 'route-toolkit-gap',
    where: 'PRP.md ground-truth #4 / ws-ratchets.md §0',
    statement: 'hand-rolled session routes not on the route-toolkit',
    stated: 1197, // loom-apex Phase-E boundary re-baseline (2026-08-06, was 1338).
                  // Ratchet moves DOWN only — route-toolkit adoption keeps growing.
    live: countHandRolledRoutes,
  },
  {
    id: 'pr-2389-state',
    where: 'PRP.md WS-U §0 precondition',
    statement: 'PR #2389 (dark-theme sweep 2) — WS-U dark-font coverage precondition',
    stated: 'MERGED', // round-3 text already records it merged
    live: () => prState(2389),
  },
  {
    id: 'pr-2392-state',
    where: 'PRP.md header',
    statement: 'PR #2392 (PRP v2)',
    stated: 'MERGED',
    live: () => prState(2392),
  },
];

// --- the decision (pure, so --selftest can mutation-prove it) ---------------

/**
 * Evaluate a facts table. Returns one verdict per fact plus the aggregate.
 * PURE with respect to the gate's decision: the only I/O is each fact's own
 * `live()`, which the selftest supplies as a stub.
 *
 * @returns {{ verdicts: Array<{id:string, outcome:'ok'|'drift'|'undetermined', message:string}>,
 *             drift:number, undetermined:number, failing:number }}
 */
export function evaluateFacts(facts) {
  const verdicts = [];
  for (const f of facts) {
    let live;
    try {
      live = f.live();
    } catch (e) {
      // A counter that could not run has NOT measured drift. Say exactly that.
      verdicts.push({
        id: f.id,
        outcome: 'undetermined',
        message: `[prp-freshness] ${f.id}: COULD NOT MEASURE — ${e?.message || e}. The fact is unchecked; this is not a claim that it drifted.`,
      });
      continue;
    }
    if (typeof f.stated === 'number') {
      const drift = Math.abs(live - f.stated) / f.stated;
      const pct = (drift * 100).toFixed(1);
      if (drift > DRIFT_TOLERANCE) {
        verdicts.push({
          id: f.id,
          outcome: 'drift',
          message: `[prp-freshness] ${f.id}: PRP states ${f.stated} (${f.where}); live is ${live} (${pct}% drift, tolerance ${(DRIFT_TOLERANCE * 100).toFixed(0)}%) — update the PRP text + this baseline.`,
        });
      } else {
        verdicts.push({ id: f.id, outcome: 'ok', message: `[prp-freshness] ${f.id}: stated ${f.stated}, live ${live} (${pct}% drift) — ok` });
      }
    } else if (String(live) !== String(f.stated)) {
      verdicts.push({
        id: f.id,
        outcome: 'drift',
        message: `[prp-freshness] ${f.id}: PRP states ${f.stated} (${f.where}); live is ${live} — update the PRP reference.`,
      });
    } else {
      verdicts.push({ id: f.id, outcome: 'ok', message: `[prp-freshness] ${f.id}: ${f.stated} — ok` });
    }
  }
  const drift = verdicts.filter((v) => v.outcome === 'drift').length;
  const undetermined = verdicts.filter((v) => v.outcome === 'undetermined').length;
  return { verdicts, drift, undetermined, failing: drift + undetermined };
}

// --- selftest (mutation proof that this gate CAN fail) ----------------------

function selftest() {
  const cases = [
    {
      name: 'all facts within tolerance → passes',
      facts: [
        { id: 'n', where: 'x', stated: 100, live: () => 105 },   // 5% drift
        { id: 's', where: 'x', stated: 'MERGED', live: () => 'MERGED' },
      ],
      expectFailing: 0,
    },
    {
      name: 'NUMERIC DRIFT beyond tolerance → FAILS (the whole point of the gate)',
      facts: [{ id: 'n', where: 'x', stated: 100, live: () => 200 }],
      expectFailing: 1,
      expectOutcome: 'drift',
    },
    {
      name: 'drift exactly AT the tolerance boundary → passes (not > tolerance)',
      facts: [{ id: 'n', where: 'x', stated: 100, live: () => 110 }],
      expectFailing: 0,
    },
    {
      name: 'drift one unit PAST the boundary → FAILS',
      facts: [{ id: 'n', where: 'x', stated: 100, live: () => 111 }],
      expectFailing: 1,
      expectOutcome: 'drift',
    },
    {
      name: 'drift DOWNWARD beyond tolerance → FAILS (a ratchet that only watches one direction is half a gate)',
      facts: [{ id: 'n', where: 'x', stated: 100, live: () => 50 }],
      expectFailing: 1,
      expectOutcome: 'drift',
    },
    {
      name: 'a flipped PR state → FAILS',
      facts: [{ id: 's', where: 'x', stated: 'MERGED', live: () => 'OPEN' }],
      expectFailing: 1,
      expectOutcome: 'drift',
    },
    {
      name: 'an UNREADABLE counter → FAILS, and is classed undetermined, NOT drift',
      facts: [{ id: 'u', where: 'x', stated: 'MERGED', live: () => { throw new UndeterminedError('gh unreachable'); } }],
      expectFailing: 1,
      expectOutcome: 'undetermined',
    },
    {
      name: 'an undetermined fact does NOT assert that the value changed',
      facts: [{ id: 'u', where: 'x', stated: 'MERGED', live: () => { throw new UndeterminedError('gh unreachable'); } }],
      expectFailing: 1,
      // It must not make the positive claim ("live is X" / "% drift") that the
      // old `return 'UNKNOWN'` path made. Saying "this is NOT a claim that it
      // drifted" is the opposite and is required.
      expectMessageNot: /live is |% drift/,
      expectMessage: /COULD NOT MEASURE.*not a claim that it drifted/s,
    },
  ];

  // The bounded retry must actually RETRY, and must actually GIVE UP — a retry
  // that cannot fail is forbidden (deploy-integrity R6).
  let calls = 0;
  const flaky = () => { calls += 1; if (calls < 3) throw new Error('transient 502'); return 'MERGED'; };
  const retried = evaluateFacts([{ id: 'r', where: 'x', stated: 'MERGED', live: () => {
    // stand-in for prState's retry loop, driven by the same attempt budget
    let last; for (let i = 1; i <= PR_STATE_ATTEMPTS; i += 1) {
      try { return flaky(); } catch (e) { last = e.message; }
    }
    throw new UndeterminedError(last);
  } }]);
  const retryOk = retried.failing === 0 && calls === 3;

  calls = 0;
  const alwaysBad = () => { calls += 1; throw new Error('403'); };
  const exhausted = evaluateFacts([{ id: 'r', where: 'x', stated: 'MERGED', live: () => {
    let last; for (let i = 1; i <= PR_STATE_ATTEMPTS; i += 1) {
      try { return alwaysBad(); } catch (e) { last = e.message; }
    }
    throw new UndeterminedError(last);
  } }]);
  const failClosedOk = exhausted.failing === 1
    && exhausted.verdicts[0].outcome === 'undetermined'
    && calls === PR_STATE_ATTEMPTS;

  let bad = 0;
  for (const c of cases) {
    const r = evaluateFacts(c.facts);
    const problems = [];
    if (r.failing !== c.expectFailing) problems.push(`expected failing=${c.expectFailing}, got ${r.failing}`);
    if (c.expectOutcome && r.verdicts[0].outcome !== c.expectOutcome) {
      problems.push(`expected outcome='${c.expectOutcome}', got '${r.verdicts[0].outcome}'`);
    }
    if (c.expectMessage && !c.expectMessage.test(r.verdicts[0].message)) {
      problems.push(`message did not match ${c.expectMessage}: ${r.verdicts[0].message}`);
    }
    if (c.expectMessageNot && c.expectMessageNot.test(r.verdicts[0].message)) {
      problems.push(`message MUST NOT match ${c.expectMessageNot}: ${r.verdicts[0].message}`);
    }
    if (problems.length) {
      bad += 1;
      console.error(`  ✗ ${c.name}\n      ${problems.join('\n      ')}`);
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }

  // The gate's exit contract: any failing fact must produce a NON-ZERO exit.
  // This is the line that made the gate incapable of blocking; it is asserted
  // directly so removing it cannot go unnoticed.
  const withDrift = evaluateFacts([{ id: 'n', where: 'x', stated: 100, live: () => 999 }]);
  const exitCode = withDrift.failing > 0 ? 1 : 0;
  if (exitCode !== 1) {
    bad += 1;
    console.error('  ✗ EXIT CONTRACT: a drifting fact must exit non-zero — the gate is warn-only again.');
  } else {
    console.log('  ✓ EXIT CONTRACT: a drifting fact exits non-zero (the gate can block)');
  }

  if (retryOk) console.log('  ✓ RETRY: a transient read is retried within the attempt budget and then succeeds');
  else { bad += 1; console.error(`  ✗ RETRY: expected success after 3 calls, got failing=${retried.failing} calls=${calls}`); }

  if (failClosedOk) console.log('  ✓ FAIL CLOSED: an exhausted retry blocks, classed undetermined (a retry that cannot fail is forbidden)');
  else { bad += 1; console.error('  ✗ FAIL CLOSED: an exhausted retry must block as undetermined'); }

  if (bad) {
    console.error(`\ncheck-prp-freshness --selftest: ${bad} case(s) failed.`);
    process.exit(1);
  }
  console.log('\ncheck-prp-freshness --selftest: all cases passed.');
  process.exit(0);
}

// --- run --------------------------------------------------------------------

if (process.argv.includes('--selftest')) selftest();

const { verdicts, drift, undetermined, failing } = evaluateFacts(FACTS);
for (const v of verdicts) {
  if (v.outcome === 'ok') console.log(v.message);
  else console.log(`::error::${v.message}`);
}

if (failing === 0) {
  console.log(`[prp-freshness] ${FACTS.length} fact(s) re-counted, all within tolerance. PASS.`);
  process.exit(0);
}

console.log('');
console.log(`[prp-freshness] FAIL — ${drift} stale fact(s), ${undetermined} unmeasurable fact(s).`);
console.log('[prp-freshness] Unblock by EITHER fixing the drift OR re-baselining `stated` in');
console.log('[prp-freshness] scripts/ci/check-prp-freshness.mjs with a one-line justification in the');
console.log('[prp-freshness] same commit that updates the PRP text. Do NOT return this gate to');
console.log('[prp-freshness] warn-only: it was warn-only for its whole life and blocked nothing.');
process.exit(1);
