#!/usr/bin/env node
/**
 * gov-roll-staleness-gate.mjs — REFUSE to roll the Azure Government console
 * onto an image that is not the current tip of `main`.
 *
 * WHY THIS EXISTS (#3730, deploy-integrity.md R1/R7, cloud-parity.md)
 * ------------------------------------------------------------------
 * Measured 2026-08-18: the Gov console served `28de89fb`, stamped 2026-08-11,
 * while `main` was 251 commits further on. Commercial read 0-behind. The
 * difference was not attention, it was trigger configuration — every Gov lane
 * was `workflow_dispatch`-only, so a Gov roll only ever happened when a human
 * remembered, and a human dispatching `gov-console-roll` from a stale ref (or
 * simply from a branch) had NOTHING telling them the SHA they were about to
 * ship was older than `main`.
 *
 * The image build that lane runs is honest — it builds the checked-out tree and
 * verifies the pushed digest. That is exactly why the staleness question cannot
 * be answered downstream: the image genuinely exists and the registry genuinely
 * answers, so every existence gate passes. "This image is real" and "this image
 * is CURRENT" are different questions, and only the second one closes #3730.
 *
 * ── THE THREE STATES, KEPT APART ───────────────────────────────────────────
 * This repo's dominant reporting defect is an UNKNOWN rendered as a NEGATIVE
 * (or, worse, as a pass). So the verdicts are:
 *
 *   CURRENT   the rolled commit IS the tip of main            → exit 0
 *   STALE     main has commits the rolled commit does not     → exit 3, REFUSE
 *   DIVERGED  the rolled commit is not on main's line at all  → exit 3, REFUSE
 *   UNKNOWN   the comparison could not be established         → exit 4, REFUSE
 *
 * UNKNOWN never collapses into either of the others, and its message says so in
 * those words (R7: an error must not assert a cause it did not establish). A
 * gate that cannot tell "main moved" from "I could not reach the API" is the
 * `unknown_as_negative_class` defect, and this file is written to fail closed on
 * both rather than to guess between them.
 *
 * ── WHY THE INPUTS COME FROM GITHUB, NOT AZURE ─────────────────────────────
 * Deliberate. Every value this gate consumes is derived from the runner's own
 * checkout and the GitHub REST API — the same host the job already cloned from.
 * NOTHING here touches the sovereign boundary. So an Azure Gov outage, an ACR
 * firewall propagation window, or an expired Gov SP secret can never turn this
 * gate into an UNKNOWN and block an emergency roll on an unrelated fault. The
 * gate is only unknown when the thing it actually measures is unknown.
 *
 * ── THE EMERGENCY VALVE, AND ITS LIMIT ─────────────────────────────────────
 * `--allow-stale true` waives STALE and DIVERGED with a loud warning: rolling a
 * known-older good tag is a legitimate recovery action and this gate must never
 * be the thing that permanently blocks it.
 *
 * It does NOT waive UNKNOWN, and that asymmetry is the point. Waiving STALE is
 * an operator consenting to a risk they have been shown ("main is 251 commits
 * ahead — roll anyway"). There is no equivalent consent for UNKNOWN, because
 * nobody has been shown anything: the run does not know what it would be
 * shipping relative to main, so "yes, ship it anyway" is not an informed
 * decision. Per the paragraph above, UNKNOWN cannot be caused by a Gov-side
 * fault, so this cannot wedge a recovery roll on infrastructure grounds.
 *
 * ── WHY ENFORCEMENT IS TRIGGER-AWARE (and is not a hole) ───────────────────
 * `--trigger push` softens two verdicts, and the reason is a GUARANTEE rather
 * than a preference: GitHub fires `push: branches: [main]` only for commits that
 * ARE on main. So on that path the risk this gate exists to stop — shipping the
 * sovereign console a commit that never merged — is not merely unlikely, it is
 * unreachable.
 *
 * What "stale" can still mean there is exactly one thing: a NEWER commit landed
 * while this run was queued. That is a SUPERSEDE, not a defect. The runs are
 * serialized by the workflow's concurrency group, so the newer commit's own run
 * follows this one and the estate converges on it — the same ordering Commercial
 * relies on. Failing the older run would paint a normal merge sequence red and
 * teach everyone to ignore this gate's failures, which is how a control stops
 * being read at all.
 *
 * UNKNOWN on `push` is likewise a loud warning rather than a refusal: refusing
 * would block a legitimate roll of a commit that is on main in order to guard
 * against an outcome the trigger has already made impossible.
 *
 * DIVERGED on `push` is the one verdict that gets STRICTER by comparison — it
 * contradicts the guarantee above, so something is wrong with an assumption this
 * file rests on, and it refuses on every trigger.
 *
 * On `--trigger dispatch` (the default, and what an unrecognised value falls
 * back to) every verdict keeps full teeth. A dispatch is the path where a human
 * can aim this lane at any ref at all, and it is the path #3730 measured: the
 * one gov-console-roll run in seventeen days was a dispatch.
 *
 * Usage:
 *   node scripts/ci/gov-roll-staleness-gate.mjs \
 *     --rolled-sha <40-hex> --main-sha <40-hex> \
 *     --compare-status identical|ahead|behind|diverged|unknown \
 *     --ahead-by <integer|unknown> \
 *     [--trigger push|dispatch] [--allow-stale true|false] [--json]
 *
 * `--compare-status` / `--ahead-by` are the verbatim `status` and `ahead_by`
 * fields of `GET /repos/{owner}/{repo}/compare/{ROLLED}...{MAIN}` — i.e. base is
 * the commit being rolled and head is main, so `ahead` means MAIN is ahead and
 * the roll is behind. Passing the literal string `unknown` for either is how the
 * caller reports "the API did not answer"; it is never inferred from an empty
 * string, because an empty string is exactly how a swallowed error looks.
 *
 * Tests: node --test scripts/ci/__tests__/gov-roll-staleness-gate.test.mjs
 */

/** Exit codes. Read by .github/workflows/gov-console-roll.yml — a CONTRACT. */
export const EXIT = Object.freeze({
  CURRENT: 0,
  USAGE: 2,
  STALE: 3,
  UNKNOWN: 4,
});

const SHA_RE = /^[0-9a-f]{40}$/;

/** GitHub's compare `status` values, plus our explicit not-established marker. */
export const COMPARE_STATES = Object.freeze([
  'identical',
  'ahead',
  'behind',
  'diverged',
  'unknown',
]);

/**
 * Decide whether a Gov console roll may proceed.
 *
 * Pure: no I/O, no process exit. The workflow step supplies the measurements
 * and this decides. That split is what makes the refusal mutation-provable
 * offline, which matters more here than usual — the lane it guards cannot be
 * exercised from a workstation at all (the Gov access rule forbids local `az`).
 *
 * @param {object} input
 * @param {string} [input.rolledSha]      40-hex commit the roll would ship.
 * @param {string} [input.mainSha]        40-hex current tip of origin/main.
 * @param {string} [input.compareStatus]  identical|ahead|behind|diverged|unknown
 * @param {string|number} [input.aheadBy] commits main has that rolled does not,
 *                                        or the literal 'unknown'.
 * @param {string} [input.trigger]        'push' softens STALE to a supersede and
 *                                        UNKNOWN to a warning — see the header.
 *                                        Anything else is treated as 'dispatch',
 *                                        which is the strict reading.
 * @param {boolean} [input.allowStale]    emergency valve (STALE/DIVERGED only).
 * @returns {{verdict:string, exitCode:number, waived:boolean, message:string}}
 */
export function decide({
  rolledSha,
  mainSha,
  compareStatus,
  aheadBy,
  trigger,
  allowStale = false,
} = {}) {
  const rolled = String(rolledSha ?? '').trim().toLowerCase();
  const main = String(mainSha ?? '').trim().toLowerCase();
  const status = String(compareStatus ?? '').trim().toLowerCase();
  const ahead = String(aheadBy ?? '').trim().toLowerCase();
  // FAIL TOWARDS STRICT. Only the word 'push' softens anything — case and
  // surrounding whitespace are normalised because the value is machine-supplied
  // (`${{ github.event_name }}`) and a stray space causing a FALSE refusal is
  // the same noise this gate's supersede path exists to avoid. Every OTHER
  // trigger name gets the dispatch reading, including real ones this lane might
  // grow later (`workflow_run`, `schedule`): neither carries the "the SHA is
  // already on main" guarantee that the softening rests on. A gate whose teeth
  // come out for an unrecognised value is not a gate.
  const onPush = String(trigger ?? '').trim().toLowerCase() === 'push';

  // ── UNKNOWN inputs. Each is reported for WHAT IT IS, never merged. ────────
  if (!SHA_RE.test(rolled)) {
    return unknown(
      `the commit this roll would ship could not be established (got ${describe(rolled)}). ` +
        'That is NOT a statement that the image is stale — nothing was compared. ' +
        'The rolled SHA comes from `git rev-parse HEAD` in this job\'s own checkout, ' +
        'so an empty or malformed value means the checkout step did not do what this gate assumes.',
      onPush,
    );
  }
  if (!SHA_RE.test(main)) {
    return unknown(
      `the current tip of main could not be established (got ${describe(main)}). ` +
        `This says NOTHING about whether ${short(rolled)} is current — the question was never answered. ` +
        'Most likely the GitHub API read failed; the step above prints its stderr.',
      onPush,
    );
  }

  if (!COMPARE_STATES.includes(status)) {
    return unknown(
      `the GitHub compare between ${short(rolled)} and main (${short(main)}) returned ` +
        `${describe(status)}, which is not one of ${COMPARE_STATES.join('/')}. ` +
        'Refusing on an answer this gate has not reasoned about rather than picking the nearest verdict.',
      onPush,
    );
  }
  if (status === 'unknown') {
    return unknown(
      `the GitHub compare between ${short(rolled)} and main (${short(main)}) could not be READ. ` +
        'Unreachable is not the same as stale and not the same as current; this run established neither.',
      onPush,
    );
  }

  // ── IDENTICAL. The only state that ships without an argument. ─────────────
  // Checked BEFORE ahead_by is validated: when the two SHAs are the same commit
  // the distance is not load-bearing, and demanding a well-formed count here
  // would let an unrelated parse problem block a perfectly current roll.
  if (status === 'identical') {
    if (rolled !== main) {
      return unknown(
        `GitHub reported the compare between ${short(rolled)} and ${short(main)} as 'identical', ` +
          'but the two SHAs differ. The measurements contradict each other, so nothing here is ' +
          'established. Refusing rather than trusting whichever one happens to be read first.',
        onPush,
      );
    }
    return {
      verdict: 'current',
      exitCode: EXIT.CURRENT,
      waived: false,
      message:
        `CURRENT — ${short(rolled)} IS the tip of main. The image this roll builds and ships ` +
        'is the newest merged commit; there is no drift to introduce.',
    };
  }

  // ── AHEAD: main has moved on. This is the #3730 case. ────────────────────
  if (status === 'ahead') {
    if (!/^\d+$/.test(ahead)) {
      return unknown(
        `GitHub reported main as AHEAD of ${short(rolled)} — so this roll IS behind — but the ` +
          `distance could not be read (got ${describe(ahead)}). The direction is established and ` +
          'the magnitude is not, so this refuses on the direction alone.',
        onPush,
      );
    }
    const n = Number(ahead);
    if (n === 0) {
      return unknown(
        `GitHub reported main as AHEAD of ${short(rolled)} yet ahead_by is 0. Those cannot both ` +
          'be true, so the comparison is not trustworthy and nothing is established.',
        onPush,
      );
    }
    const plural = `${n} commit${n === 1 ? '' : 's'}`;
    // On `push` the rolled SHA is on main by construction, so "behind" can only
    // mean a newer merge landed while this run was queued. That is a SUPERSEDE.
    // See the header: failing here would redden an ordinary merge sequence.
    if (onPush) {
      return {
        verdict: 'superseded',
        exitCode: EXIT.CURRENT,
        waived: false,
        message:
          `SUPERSEDED — ${short(rolled)} is ${plural} behind main (${short(main)}), which on a ` +
          'push-triggered run means newer commits landed while this one was queued. Proceeding: ' +
          'this SHA is on main, the roll is serialized by the workflow concurrency group, and the ' +
          "newer commit's own run follows this one, so the estate converges on it. This is not " +
          'the #3730 drift — that was a lane that never fired at all.',
      };
    }
    return staleVerdict(
      allowStale,
      `${short(rolled)} is ${plural} BEHIND main (${short(main)}). ` +
        'Rolling it would ship the Gov console an image older than the newest merged code, ' +
        'which is exactly the drift #3730 was filed for.',
    );
  }

  // ── BEHIND / DIVERGED: the rolled commit is not on main's line. ───────────
  // `behind` here means MAIN is behind ROLLED, i.e. the roll carries commits
  // main does not have — a branch build. `diverged` means both.
  //
  // This is the ONE verdict that does not soften on `push`. GitHub fires
  // `push: branches: [main]` only for commits on main, so reaching here from
  // that trigger CONTRADICTS the guarantee the push-path softening rests on —
  // and a broken premise is the worst possible moment to relax a control.
  const why =
    status === 'behind'
      ? `${short(rolled)} carries commits that main (${short(main)}) does not. This is a build of ` +
        'a ref that has not merged.'
      : `${short(rolled)} and main (${short(main)}) have DIVERGED — each carries commits the other ` +
        'does not.';
  const pushNote = onPush
    ? ' THIS RAN ON A `push` TRIGGER, which GitHub fires only for commits on main — so this ' +
      'verdict should be unreachable here and something is wrong with an assumption this gate ' +
      'rests on. Investigate before overriding.'
    : '';
  return staleVerdict(
    allowStale,
    `${why} Shipping it puts the Gov console on code that is not what main says is released, ` +
      `and the next merge-triggered roll would silently revert it.${pushNote}`,
    'diverged',
  );
}

function staleVerdict(allowStale, detail, verdict = 'stale') {
  if (allowStale) {
    return {
      verdict: `${verdict}-waived`,
      exitCode: EXIT.CURRENT,
      waived: true,
      message:
        `WAIVED (allow_stale_image) — ${detail} Rolling anyway because the emergency valve is set. ` +
        'This roll knowingly ships a Gov console that is NOT current with main; the next ' +
        'merge-triggered roll will supersede it.',
    };
  }
  return {
    verdict,
    exitCode: EXIT.STALE,
    waived: false,
    message:
      `REFUSING TO ROLL — ${detail} Merge to main and let the push-triggered roll ship it, or ` +
      're-dispatch this workflow from main. Emergency only: re-dispatch with ' +
      'allow_stale_image=true, which ships the older image with a loud warning.',
  };
}

/**
 * @param {string} detail
 * @param {boolean} [onPush] see the header — on the push trigger the risk an
 *   UNKNOWN would guard against (shipping an unmerged commit) is already
 *   excluded by the trigger itself, so refusing there blocks a legitimate roll
 *   to protect against nothing. It stays LOUD either way.
 */
function unknown(detail, onPush = false) {
  if (onPush) {
    return {
      verdict: 'unknown-on-push',
      exitCode: EXIT.CURRENT,
      waived: false,
      message:
        `CANNOT VERIFY — ${detail} Proceeding anyway, and ONLY because this ran on a \`push\` ` +
        'trigger: GitHub fires it solely for commits already on main, so the outcome an UNKNOWN ' +
        'would guard against — shipping the sovereign console a commit that never merged — is ' +
        'excluded by the trigger, not by this check. On a manual dispatch the same UNKNOWN ' +
        'REFUSES. Fix the GitHub API read; a roll that cannot say what it is shipping relative ' +
        'to main is a roll nobody can audit.',
    };
  }
  return {
    verdict: 'unknown',
    exitCode: EXIT.UNKNOWN,
    waived: false,
    message:
      `REFUSING TO ROLL — UNKNOWN, not stale and not current: ${detail} ` +
      'This gate reads only the runner\'s checkout and the GitHub API, never Azure, so an ' +
      'UNKNOWN here is never caused by a Gov-side outage and re-running will not clear it on its ' +
      'own. allow_stale_image does NOT waive this: waiving STALE is consenting to a risk you have ' +
      'been shown, and nothing has been shown here.',
  };
}

const short = (sha) => String(sha).slice(0, 8);
const describe = (v) => (v === '' ? 'an empty value' : `'${v}'`);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { allowStale: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      i += 1;
      return v;
    };
    switch (a) {
      case '--rolled-sha': out.rolledSha = next(); break;
      case '--main-sha': out.mainSha = next(); break;
      case '--compare-status': out.compareStatus = next(); break;
      case '--ahead-by': out.aheadBy = next(); break;
      // Passed straight through; `decide` is what decides that only the exact
      // string 'push' softens anything, so the strict default lives in ONE place
      // rather than being re-derived by every caller.
      case '--trigger': out.trigger = next(); break;
      // Only the literal string 'true' enables the valve. A typo, a YAML
      // `true`-ish value, or an unset input must never open it by accident.
      case '--allow-stale': out.allowStale = String(next() ?? '').trim() === 'true'; break;
      case '--json': out.json = true; break;
      default:
        if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    }
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// `process.argv[1]` comparison rather than an import.meta.main check so this
// stays importable by the test suite without executing (the repo has a guard,
// check-guard-import-side-effects.mjs, for exactly that hazard).
const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/ci/gov-roll-staleness-gate.mjs');

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`::error::gov-roll-staleness-gate: ${args.error}`);
    process.exit(EXIT.USAGE);
  }
  const result = decide(args);
  if (args.json) {
    console.log(JSON.stringify(result));
  } else if (result.exitCode !== EXIT.CURRENT) {
    console.log(`::error::Gov roll staleness gate: ${result.message}`);
  } else if (result.verdict === 'current') {
    console.log(`::notice::Gov roll staleness gate PASSED — ${result.message}`);
  } else {
    // Everything else that still exits 0 — waived, superseded, unknown-on-push.
    // It PROCEEDS, but it does not get to read as a clean pass: each of these is
    // a roll shipping something other than "the current tip of main", and a
    // ::notice:: would let that disappear into the log.
    console.log(`::warning::Gov roll staleness gate — ${result.verdict.toUpperCase()}: ${result.message}`);
  }
  process.exit(result.exitCode);
}
