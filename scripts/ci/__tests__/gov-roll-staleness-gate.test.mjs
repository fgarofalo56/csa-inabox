/**
 * gov-roll-staleness-gate — MUTATION PROOFS (#3730).
 *
 * WHAT IS BEING PINNED
 * --------------------
 * `gov-console-roll.yml` is the lane that puts an image on the LIVE Azure
 * Government console, and per the Gov access rule it cannot be exercised from a
 * workstation at all — the only receipt is a GitHub Actions run against a
 * sovereign estate. So the refusal logic is deliberately pure and lives here,
 * where it CAN be proven, and the workflow step is reduced to supplying
 * measurements.
 *
 * The defect class these tests exist to make impossible is not "the gate is
 * missing". It is the repo's dominant one: a gate that runs, observes the bad
 * state, and reads green — and its twin, a gate that reports "stale" when what
 * actually happened is "I could not reach the API" (deploy-integrity.md R7; the
 * `2>/dev/null` that cost two investigations on 2026-08-05).
 *
 * THE MUTATIONS EACH GROUP KILLS
 *   - drop the `ahead` branch, or make it fall through to CURRENT
 *       -> `main ahead by N REFUSES` goes red.
 *   - collapse UNKNOWN into CURRENT ("if we cannot tell, ship it")
 *       -> every `unreadable ... REFUSES` case goes red.
 *   - collapse UNKNOWN into STALE ("if we cannot tell, call it stale")
 *       -> the exit-code assertions go red: STALE is 3, UNKNOWN is 4, and the
 *          messages are asserted to say which one was established.
 *   - let `--allow-stale` waive UNKNOWN too
 *       -> `the valve does NOT waive UNKNOWN` goes red.
 *   - accept any truthy string for the valve (`--allow-stale yes`)
 *       -> `only the literal 'true' opens the valve` goes red.
 *
 * THE CONTROL. `identical SHAs pass` and `a current roll passes even when
 * ahead_by is unparseable` stay GREEN under every mutation above, so a gate
 * that has been broken open cannot hide behind them — a passing suite has to
 * mean the refusals still fire, not merely that the happy path still works.
 *
 * Run: node --test scripts/ci/__tests__/gov-roll-staleness-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPARE_STATES, EXIT, decide, parseArgs } from '../gov-roll-staleness-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, '..', 'gov-roll-staleness-gate.mjs');

/** The measured #3730 pair: what Gov was serving, and where main actually was. */
const GOV_LIVE = '28de89fb'.padEnd(40, '0');
const MAIN_TIP = '09ac2517'.padEnd(40, '1');

// ── CURRENT ─────────────────────────────────────────────────────────────────

test('identical SHAs pass (the control — stays green under every mutation)', () => {
  const r = decide({
    rolledSha: MAIN_TIP,
    mainSha: MAIN_TIP,
    compareStatus: 'identical',
    aheadBy: '0',
  });
  assert.equal(r.verdict, 'current');
  assert.equal(r.exitCode, EXIT.CURRENT);
  assert.equal(r.waived, false);
  assert.match(r.message, /CURRENT/);
});

test('a current roll passes even when ahead_by is unparseable (control)', () => {
  // On `identical` the distance carries no information, so an unrelated parse
  // problem must not block a roll that is demonstrably up to date. If this ever
  // goes red, the UNKNOWN checks have been hoisted above the identical branch.
  const r = decide({
    rolledSha: MAIN_TIP,
    mainSha: MAIN_TIP,
    compareStatus: 'identical',
    aheadBy: 'unknown',
  });
  assert.equal(r.exitCode, EXIT.CURRENT);
});

test('case and whitespace in the measured SHAs do not change the verdict', () => {
  const r = decide({
    rolledSha: `  ${MAIN_TIP.toUpperCase()}  `,
    mainSha: MAIN_TIP,
    compareStatus: 'identical',
    aheadBy: '0',
  });
  assert.equal(r.exitCode, EXIT.CURRENT);
});

// ── STALE — the #3730 case ──────────────────────────────────────────────────

test('main ahead by N REFUSES, with a non-zero exit and the count named', () => {
  const r = decide({
    rolledSha: GOV_LIVE,
    mainSha: MAIN_TIP,
    compareStatus: 'ahead',
    aheadBy: '251',
  });
  assert.equal(r.verdict, 'stale');
  assert.equal(r.exitCode, EXIT.STALE);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.message, /REFUSING TO ROLL/);
  assert.match(r.message, /251 commits BEHIND/);
  // The remediation must be the one the platform can actually perform.
  assert.match(r.message, /allow_stale_image=true/);
});

test('ahead by exactly 1 still refuses and reads grammatically', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'ahead', aheadBy: '1',
  });
  assert.equal(r.exitCode, EXIT.STALE);
  assert.match(r.message, /1 commit BEHIND/);
});

test('a branch build (behind/diverged) refuses as DIVERGED, not as stale', () => {
  for (const status of ['behind', 'diverged']) {
    const r = decide({
      rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: status, aheadBy: '0',
    });
    assert.equal(r.verdict, 'diverged', status);
    assert.equal(r.exitCode, EXIT.STALE, status);
    assert.match(r.message, /REFUSING TO ROLL/);
  }
});

// ── UNKNOWN — must never read as either of the other two ────────────────────

test('an unreadable main tip REFUSES as UNKNOWN and says it compared nothing', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: '', compareStatus: 'ahead', aheadBy: '251',
  });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.exitCode, EXIT.UNKNOWN);
  assert.notEqual(r.exitCode, EXIT.STALE);
  assert.match(r.message, /UNKNOWN, not stale and not current/);
  // R7: it must NOT assert the image is old — it never established that.
  assert.doesNotMatch(r.message, /commits BEHIND/);
});

test('an unreadable rolled SHA REFUSES as UNKNOWN', () => {
  const r = decide({
    rolledSha: 'HEAD', mainSha: MAIN_TIP, compareStatus: 'identical', aheadBy: '0',
  });
  assert.equal(r.exitCode, EXIT.UNKNOWN);
  assert.match(r.message, /could not be established/);
});

test('compare status "unknown" REFUSES and names unreachability, not staleness', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'unknown', aheadBy: 'unknown',
  });
  assert.equal(r.exitCode, EXIT.UNKNOWN);
  assert.match(r.message, /could not be READ/);
  assert.match(r.message, /Unreachable is not the same as stale/);
});

test('a compare status this gate has never reasoned about REFUSES', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'sideways', aheadBy: '3',
  });
  assert.equal(r.exitCode, EXIT.UNKNOWN);
  assert.match(r.message, /not one of/);
});

test('contradictory measurements REFUSE rather than picking one', () => {
  // 'identical' with two different SHAs, and 'ahead' with ahead_by 0. Both are
  // impossible; both previously would have been resolvable by trusting one
  // field over the other, which is how a gate quietly starts measuring nothing.
  const a = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'identical', aheadBy: '0',
  });
  assert.equal(a.exitCode, EXIT.UNKNOWN);
  assert.match(a.message, /contradict each other/);

  const b = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'ahead', aheadBy: '0',
  });
  assert.equal(b.exitCode, EXIT.UNKNOWN);
  assert.match(b.message, /cannot both\s+be true/);
});

test('a known direction with an unreadable distance still REFUSES', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'ahead', aheadBy: 'unknown',
  });
  assert.equal(r.exitCode, EXIT.UNKNOWN);
  assert.match(r.message, /direction is established and\s+the magnitude is not/);
});

// ── THE EMERGENCY VALVE, AND ITS LIMIT ──────────────────────────────────────

test('allow-stale waives STALE loudly, and says the roll is not current', () => {
  const r = decide({
    rolledSha: GOV_LIVE,
    mainSha: MAIN_TIP,
    compareStatus: 'ahead',
    aheadBy: '251',
    allowStale: true,
  });
  assert.equal(r.exitCode, EXIT.CURRENT);
  assert.equal(r.waived, true);
  assert.equal(r.verdict, 'stale-waived');
  assert.match(r.message, /WAIVED/);
  assert.match(r.message, /NOT current with main/);
});

test('allow-stale waives DIVERGED too', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'diverged', aheadBy: '0', allowStale: true,
  });
  assert.equal(r.exitCode, EXIT.CURRENT);
  assert.equal(r.verdict, 'diverged-waived');
});

test('the valve does NOT waive UNKNOWN', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: '', compareStatus: 'ahead', aheadBy: '251', allowStale: true,
  });
  assert.equal(r.exitCode, EXIT.UNKNOWN);
  assert.equal(r.waived, false);
  assert.match(r.message, /does NOT waive this/);
});

test('only the literal "true" opens the valve', () => {
  for (const v of ['yes', 'TRUE', '1', 'on', '', 'false']) {
    assert.equal(parseArgs(['--allow-stale', v]).allowStale, false, v);
  }
  assert.equal(parseArgs(['--allow-stale', 'true']).allowStale, true);
});

test('an absent valve flag is closed', () => {
  assert.equal(parseArgs([]).allowStale, false);
  assert.equal(decide({}).exitCode, EXIT.UNKNOWN);
});

// ── THE CONTRACT THE WORKFLOW READS ─────────────────────────────────────────

test('exit codes are distinct — the workflow branches on them', () => {
  const seen = new Set(Object.values(EXIT));
  assert.equal(seen.size, Object.keys(EXIT).length);
  assert.equal(EXIT.CURRENT, 0);
  assert.notEqual(EXIT.STALE, EXIT.UNKNOWN);
});

test('COMPARE_STATES covers every value the GitHub compare API returns', () => {
  for (const s of ['identical', 'ahead', 'behind', 'diverged']) {
    assert.ok(COMPARE_STATES.includes(s), s);
  }
});

// ── TRIGGER-AWARE ENFORCEMENT ───────────────────────────────────────────────
// The softening on `push` rests on ONE guarantee: GitHub fires
// `push: branches: [main]` only for commits already on main. These tests pin
// both halves — that the softening happens where that guarantee applies, and
// that it does NOT leak anywhere else.
//
// THE MUTATION THAT MATTERS: widen the push softening to cover DIVERGED (an
// easy "make push never fail" edit) -> `push does NOT soften DIVERGED` goes red.
// The mirror mutation — soften on any non-empty trigger string — is killed by
// `only the literal "push" softens`.

test('push + behind is a SUPERSEDE, not a failure', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'ahead', aheadBy: '2', trigger: 'push',
  });
  assert.equal(r.verdict, 'superseded');
  assert.equal(r.exitCode, EXIT.CURRENT);
  assert.equal(r.waived, false);
  assert.match(r.message, /SUPERSEDED/);
  // It must not claim to be the #3730 drift — that was a lane that never fired.
  assert.match(r.message, /not\s+the #3730 drift/);
});

test('dispatch + behind still REFUSES — the teeth are where the risk is', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'ahead', aheadBy: '2', trigger: 'workflow_dispatch',
  });
  assert.equal(r.exitCode, EXIT.STALE);
});

test('push does NOT soften DIVERGED — a broken premise never relaxes a control', () => {
  for (const status of ['behind', 'diverged']) {
    const r = decide({
      rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: status, aheadBy: '0', trigger: 'push',
    });
    assert.equal(r.exitCode, EXIT.STALE, status);
    assert.equal(r.verdict, 'diverged', status);
    assert.match(r.message, /should be unreachable here/);
  }
});

test('push + UNKNOWN proceeds, but LOUDLY and with the reason named', () => {
  const r = decide({
    rolledSha: GOV_LIVE, mainSha: '', compareStatus: 'ahead', aheadBy: '2', trigger: 'push',
  });
  assert.equal(r.exitCode, EXIT.CURRENT);
  assert.equal(r.verdict, 'unknown-on-push');
  assert.match(r.message, /CANNOT VERIFY/);
  // R7: it must say what it did NOT establish, and why proceeding is safe here.
  assert.match(r.message, /excluded by the trigger, not by this check/);
  assert.match(r.message, /On a manual dispatch the same UNKNOWN\s+REFUSES/);
});

test('only "push" softens — every other trigger name is the strict reading', () => {
  // Case and surrounding whitespace are normalised (the value is machine-supplied
  // — `${{ github.event_name }}` — so a stray space must not cause a FALSE
  // refusal, which is the same noise class the supersede path exists to avoid).
  // Anything that is not that word, however, gets full teeth: `workflow_run` and
  // `schedule` are real GitHub triggers that could be added to this lane later,
  // and neither carries the "the SHA is on main" guarantee that `push` does.
  for (const t of ['pushed', 'repush', 'workflow_run', 'schedule', 'workflow_dispatch', '', undefined, null]) {
    const r = decide({
      rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'ahead', aheadBy: '9', trigger: t,
    });
    assert.equal(r.exitCode, EXIT.STALE, String(t));
  }
  for (const t of ['push', '  push  ', 'Push', 'PUSH']) {
    assert.equal(
      decide({
        rolledSha: GOV_LIVE, mainSha: MAIN_TIP, compareStatus: 'ahead', aheadBy: '9', trigger: t,
      }).exitCode,
      EXIT.CURRENT,
      String(t),
    );
  }
});

test('push does not turn a CURRENT roll into anything else (control)', () => {
  const r = decide({
    rolledSha: MAIN_TIP, mainSha: MAIN_TIP, compareStatus: 'identical', aheadBy: '0', trigger: 'push',
  });
  assert.equal(r.verdict, 'current');
  assert.equal(r.exitCode, EXIT.CURRENT);
});

test('--trigger reaches decide through the CLI', () => {
  const stale = runGate([
    '--rolled-sha', GOV_LIVE, '--main-sha', MAIN_TIP,
    '--compare-status', 'ahead', '--ahead-by', '251', '--trigger', 'push', '--json',
  ]);
  assert.equal(stale.code, 0);
  assert.equal(JSON.parse(stale.stdout).verdict, 'superseded');

  const dispatched = runGate([
    '--rolled-sha', GOV_LIVE, '--main-sha', MAIN_TIP,
    '--compare-status', 'ahead', '--ahead-by', '251', '--trigger', 'workflow_dispatch', '--json',
  ]);
  assert.equal(dispatched.code, EXIT.STALE);
});

test('CLI: a proceed-but-not-current verdict prints ::warning::, never ::notice::', () => {
  // A supersede that logged ::notice:: would read as "all good" in the Actions
  // UI, which is how a roll shipping something other than main's tip disappears.
  const r = runGate([
    '--rolled-sha', GOV_LIVE, '--main-sha', MAIN_TIP,
    '--compare-status', 'ahead', '--ahead-by', '3', '--trigger', 'push',
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /::warning::/);
  assert.doesNotMatch(r.stdout, /::notice::/);
});

// ── END-TO-END: the CLI actually exits non-zero on a stale tag ──────────────
// The brief for #3730 asks for exactly this receipt — "point it at a stale tag,
// show it exits non-zero" — so it is asserted here rather than only described.
// Importing `decide` proves the decision; running the binary proves the PROCESS
// carries that decision out to its exit status, which is the half a workflow
// step actually consumes.

function runGate(args) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('CLI: a STALE tag exits 3 and prints an ::error::', () => {
  const r = runGate([
    '--rolled-sha', GOV_LIVE,
    '--main-sha', MAIN_TIP,
    '--compare-status', 'ahead',
    '--ahead-by', '251',
  ]);
  assert.equal(r.code, EXIT.STALE);
  assert.match(r.stdout, /::error::/);
  assert.match(r.stdout, /251 commits BEHIND/);
});

test('CLI: a CURRENT tag exits 0 and prints an ::notice::', () => {
  const r = runGate([
    '--rolled-sha', MAIN_TIP,
    '--main-sha', MAIN_TIP,
    '--compare-status', 'identical',
    '--ahead-by', '0',
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /::notice::/);
});

test('CLI: an UNKNOWN comparison exits 4, distinct from the stale exit', () => {
  const r = runGate([
    '--rolled-sha', GOV_LIVE,
    '--main-sha', MAIN_TIP,
    '--compare-status', 'unknown',
    '--ahead-by', 'unknown',
  ]);
  assert.equal(r.code, EXIT.UNKNOWN);
  assert.notEqual(r.code, EXIT.STALE);
});

test('CLI: an unknown flag is a usage error, not a silent pass', () => {
  const r = runGate(['--rolled-shhha', MAIN_TIP]);
  assert.equal(r.code, EXIT.USAGE);
});

test('CLI: --json emits a machine-readable verdict', () => {
  const r = runGate([
    '--rolled-sha', GOV_LIVE, '--main-sha', MAIN_TIP,
    '--compare-status', 'ahead', '--ahead-by', '7', '--json',
  ]);
  assert.equal(r.code, EXIT.STALE);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'stale');
  assert.equal(parsed.exitCode, EXIT.STALE);
});
