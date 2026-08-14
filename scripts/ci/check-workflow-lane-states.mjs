#!/usr/bin/env node
/**
 * GUARDRAIL: a workflow that is switched OFF must be DECLARED, not discovered.
 *
 * WHY THIS EXISTS (#3345)
 * ----------------------
 * A disabled workflow is the quietest failure this repo has. It does not show
 * up red. It does not show up at all:
 *
 *     gh run list --workflow deploy-fiab-gcc.yml   # rows, but none since it was
 *                                                  # switched off — indistinguishable
 *                                                  # from "nothing to run"
 *
 * `gh run list` reports RUNS. A disabled lane produces none, so its dashboard
 * row looks exactly like a lane with nothing to do. The state lives in ONE
 * place — the workflows API:
 *
 *     gh api repos/OWNER/REPO/actions/workflows --paginate \
 *       --jq '.workflows[] | select(.state != "active") | "\(.state)\t\(.path)"'
 *
 * Nothing in CI read that. So a lane could be turned off in the GitHub UI —
 * one click, no commit, no review, no record — and every signal the repo has
 * would keep reading green. That is the `red_lane_disabled_not_fixed` shape,
 * and it is the deploy-side twin of `gates_that_measure_nothing`: the control
 * exists, reads as green, and is not executing.
 *
 * `check-deploy-staleness.mjs` already reports `disabled` for the ~15 lanes on
 * its WATCHED list. This guard is the population-complete half: EVERY workflow
 * the repo has, whether or not anyone thought to watch it.
 *
 * THE RULE
 * --------
 * Every workflow whose `state` is not `active` must have an entry in
 * scripts/ci/workflow-lane-states-allowlist.json carrying an OWNER, a written
 * REASON, and a REVIEW DATE. A disablement is then a reviewable, committed,
 * expiring decision instead of an invisible one.
 *
 * The allowlist is also checked in the other direction: an entry for a lane
 * that is active again — or gone — FAILS. A register nobody drains stops
 * describing reality, and this repo has been bitten by exactly that
 * (`stale_audit_items_propagate`).
 *
 * THIS GUARD DOES NOT RE-ENABLE ANYTHING, and must never be made to. Turning a
 * deploy lane back on is an operator decision with real-estate consequences —
 * `deploy-fiab-gcc` carries a daily 08:00 UTC cron over a live sovereign
 * boundary. The guard's whole job is to make the OFF state impossible to miss.
 * Read the lane's teardown `if:` before enabling it; see
 * check-teardown-not-on-schedule.mjs for why that sentence is here.
 *
 * FAILING CLOSED
 * --------------
 *   - The API is unreachable / `gh` fails  → FAIL, reported as UNREADABLE.
 *     Never "no disabled workflows" — an unmeasured thing rendered as a
 *     negative result is this repo's most repeated reporting bug
 *     (`unknown_as_negative_class`), and deploy-integrity.md R7 forbids
 *     asserting a cause we did not establish.
 *   - Zero workflows returned            → FAIL (vacuous pass).
 *   - Rows collected != `total_count`    → FAIL. The default page size is 30
 *     and this repo has 120+ workflows, so a half-read page would report a
 *     disabled lane as absent. `check-deploy-staleness.mjs` was bitten by the
 *     50-row default of `gh workflow list`; this is the same trap.
 *
 * THE EMBEDDED CONTROL (why this cannot go quiet at zero debt)
 * -----------------------------------------------------------
 * Today two workflows are non-active. When that reaches zero, "fail if the
 * population is empty" protects nothing — the guard would pass every day
 * without its detector ever executing, and a broken matcher would look
 * identical to a clean repo (`guard_with_zero_population_needs_embedded_control`).
 * So {@link runEmbeddedControl} drives {@link analyze} over a KNOWN-TRUE
 * synthetic fixture on EVERY run, before the real population is judged: a
 * disabled workflow against an empty allowlist MUST be reported. If the
 * detector has stopped detecting, this guard fails even on a repo with nothing
 * disabled. `--self-test` runs the fuller mutation suite.
 *
 * TWO HOSTS (the blind spot this guard cannot fix from one workflow)
 * -----------------------------------------------------------------
 * Landed as a single step in loom-guardrails.yml, this guard had one lane it
 * could never watch: ITS OWN. Switch off loom-guardrails.yml in the UI — the
 * exact one-click, no-commit act #3345 is about — and the guard stops running,
 * so nothing reports that the guard stopped running. `gh run list` shows its
 * old green runs and the repo reads clean. A control that cannot observe its
 * own removal is the `guard_adoption_gap` shape.
 *
 * It also only executed on `pull_request` / `push`, so a lane switched off
 * during a quiet stretch stayed invisible until someone happened to open a PR
 * — and "the repo went quiet" is CORRELATED with the incident this exists for
 * (deploy-integrity.md's 2026-08-05: machinery down, merges stalled).
 *
 * Both halves close with a SECOND host on a different trigger, so the two
 * workflows observe each other:
 *
 *   loom-guardrails.yml  pull_request + push       → catches hygiene-guard off
 *   hygiene-guard.yml    push(main) + weekly cron  → catches loom-guardrails off,
 *                                                    and runs when nobody merges
 *
 * {@link analyzeHosts} makes that invariant mechanical rather than a comment:
 * every run asserts this script is invoked from at least MIN_HOSTS DISTINCT
 * workflow files, counting only `run:` bodies (a whole-line `#` comment naming
 * the script does NOT count — a check a comment can satisfy is the defect being
 * closed). Delete either wiring and the guard fails on the PR that does it.
 *
 * MODES
 *   node scripts/ci/check-workflow-lane-states.mjs              # CHECK (control + hosts run first)
 *   node scripts/ci/check-workflow-lane-states.mjs --self-test  # prove it can fail
 *   node scripts/ci/check-workflow-lane-states.mjs --list       # print every state, judge nothing
 *
 * Env: GH_TOKEN (needs `actions: read`), GITHUB_REPOSITORY (owner/repo).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(__dirname, 'workflow-lane-states-allowlist.json');
const ALLOWLIST_REL = 'scripts/ci/workflow-lane-states-allowlist.json';
const REPO = process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox';
const WORKFLOW_DIR = join(__dirname, '..', '..', '.github', 'workflows');

/**
 * This script's own filename, as a workflow would name it. Derived, not
 * hard-coded: a renamed script must not silently stop finding its own wiring
 * and report "0 hosts" as a mystery.
 */
const SELF_BASENAME = 'check-workflow-lane-states.mjs';

/**
 * Two, because one host cannot observe its own disablement (see TWO HOSTS in
 * the header). This is a floor, not a target — more hosts is fine.
 */
const MIN_HOSTS = 2;

/**
 * A reason has to be a REASON. 60 characters is not a style preference: it is
 * the length at which "TODO" and "disabled" stop fitting and a sentence
 * naming what was turned off, when, and what has to be true to turn it back on
 * starts to. The placeholder list catches the rest.
 */
const MIN_REASON_CHARS = 60;
const PLACEHOLDER = /\b(tbd|todo|fixme|xxx|wip|n\/?a|unknown|placeholder|see above)\b/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── pure analysis ───────────────────────────────────────────────────────────

/**
 * Judge a measured workflow population against the committed allowlist. PURE —
 * no network, no fs, no clock. The self-test and the embedded control drive
 * this same function, so what CI proves is what CI runs.
 *
 * @param {object} input
 * @param {Array<{path:string,name:string,state:string}>} input.workflows measured population
 * @param {number} input.totalCount server-reported total, for truncation detection
 * @param {{allowed?:Array<object>}} input.allowlist parsed allowlist document
 * @param {Date} input.now clock, injected so date logic is testable
 * @returns {{violations:Array<{kind:string,subject:string,why:string}>, nonActive:Array<object>, examined:number}}
 */
export function analyze({ workflows, totalCount, allowlist, now }) {
  const violations = [];
  const push = (kind, subject, why) => violations.push({ kind, subject, why });

  if (!Array.isArray(workflows) || workflows.length === 0) {
    push(
      'empty-population',
      '(the whole repo)',
      'the workflows API returned ZERO workflows. This repo has over a hundred. ' +
        'That is a broken read, not a clean repo — refusing to report a green tick over it.',
    );
    return { violations, nonActive: [], examined: 0 };
  }

  if (typeof totalCount === 'number' && totalCount !== workflows.length) {
    push(
      'truncated',
      '(pagination)',
      `collected ${workflows.length} workflow(s) but the API reports total_count=${totalCount}. ` +
        'A partially-read population would report a disabled lane as ABSENT, which is the ' +
        'per_page truncation trap that has already produced one false green here.',
    );
  }

  const entries = Array.isArray(allowlist?.allowed) ? allowlist.allowed : [];
  const byPath = new Map();
  for (const e of entries) {
    const p = String(e?.path || '');
    if (!p) {
      push('allowlist-malformed', '(entry with no path)', 'every allowlist entry needs a `path`.');
      continue;
    }
    if (byPath.has(p)) {
      push('allowlist-duplicate', p, 'listed twice — one entry, one reason, or the reasons disagree silently.');
      continue;
    }
    byPath.set(p, e);
  }

  const nonActive = workflows.filter((w) => w.state !== 'active');
  const measuredByPath = new Map(workflows.map((w) => [w.path, w]));

  for (const w of nonActive) {
    const entry = byPath.get(w.path);
    if (!entry) {
      push(
        'not-allowlisted',
        w.path,
        `state=${w.state} ("${w.name}") and NOTHING in the repo records why. ` +
          'A lane switched off in the UI leaves no commit and no review — this file is the record. ' +
          `Add an entry to ${ALLOWLIST_REL} with an owner, a reason, and a reviewBy; or re-enable the lane ` +
          'AFTER reading its teardown `if:` and its schedule.',
      );
      continue;
    }
    if (String(entry.state || '') !== w.state) {
      push(
        'state-mismatch',
        w.path,
        `allowlisted as "${entry.state || '(none)'}" but measured "${w.state}". ` +
          'The state changed under the recorded reason — re-review it rather than let the old reason cover a new fact.',
      );
    }
    const owner = String(entry.owner || '').trim();
    if (!owner) {
      push('owner-missing', w.path, 'no `owner`. #3345 asks for an owner per disablement, not just a note.');
    }
    const reason = String(entry.reason || '').trim();
    if (!reason || PLACEHOLDER.test(reason) || reason.length < MIN_REASON_CHARS) {
      push(
        'reason-too-thin',
        w.path,
        `\`reason\` is ${reason ? `${reason.length} char(s)` : 'missing'}${
          reason && PLACEHOLDER.test(reason) ? ' and reads as a placeholder' : ''
        }. State what was turned off, why, and what must be true to turn it back on ` +
          `(minimum ${MIN_REASON_CHARS} characters, no TODO/TBD).`,
      );
    }
    const reviewBy = String(entry.reviewBy || '').trim();
    if (!ISO_DATE.test(reviewBy)) {
      push(
        'review-missing',
        w.path,
        `\`reviewBy\` is "${reviewBy || '(none)'}" — needs a YYYY-MM-DD date. ` +
          'Without an expiry a disablement is permanent by default, which is how a lane stays dark for months.',
      );
    } else if (Date.parse(`${reviewBy}T23:59:59Z`) < now.getTime()) {
      push(
        'review-overdue',
        w.path,
        `review was due ${reviewBy} and the lane is still ${w.state}. ` +
          'Re-enable it, retire it, or re-date the entry with a re-read of the reason — but decide.',
      );
    }
  }

  for (const [p, entry] of byPath) {
    const measured = measuredByPath.get(p);
    if (!measured) {
      push(
        'stale-entry',
        p,
        'allowlisted as non-active but the workflows API does not list it at all — deleted, renamed, ' +
          `or never registered. Drain the row from ${ALLOWLIST_REL}; a register that outlives its subject stops describing reality.`,
      );
      continue;
    }
    if (measured.state === 'active') {
      push(
        'stale-entry',
        p,
        `allowlisted as "${entry.state || '(none)'}" but it is ACTIVE now. ` +
          `Drain the row from ${ALLOWLIST_REL} so the file keeps meaning "these are off".`,
      );
    }
  }

  return { violations, nonActive, examined: workflows.length };
}

// ── multi-homing: this guard must be invoked from >= 2 workflow files ───────

/**
 * Count the DISTINCT workflow files that actually invoke this script.
 *
 * PURE — takes the already-read files so the self-test can drive it with
 * synthetic content and prove each branch.
 *
 * Whole-line `#` comments are stripped before matching, and this is the whole
 * difficulty of writing the check honestly. The header of loom-guardrails.yml
 * names this script in prose; the allowlist names it; another guard's
 * remediation text could name it. If a bare substring search counted, then
 *
 *     # TODO: wire scripts/ci/check-workflow-lane-states.mjs into a second lane
 *
 * would satisfy the requirement, and a check a COMMENT can satisfy is exactly
 * the defect class this file exists to close. Same convention as
 * check-ci-guard-reachability.mjs, deliberately.
 *
 * @param {{files: Array<{name:string, text:string}>}} input
 * @returns {{violations:Array<{kind:string,subject:string,why:string}>, hosts:string[]}}
 */
export function analyzeHosts({ files }) {
  const violations = [];

  if (!Array.isArray(files) || files.length === 0) {
    return {
      hosts: [],
      violations: [
        {
          kind: 'hosts-unreadable',
          subject: '.github/workflows',
          why:
            'no workflow files could be read, so the number of lanes invoking this guard is UNKNOWN. ' +
            'Unknown fails closed here rather than being rendered as "wiring is fine" ' +
            '(`unknown_as_negative_class`).',
        },
      ],
    };
  }

  const hosts = [];
  for (const f of files) {
    const code = String(f.text || '')
      // PHYSICAL-LINES-OK: reads the `on:` trigger block and the GitHub API's
      // workflow `state`, plus tab-separated `git` output. No shell body, no
      // continuations (#3420).
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    if (code.includes(SELF_BASENAME)) hosts.push(f.name);
  }

  if (hosts.length < MIN_HOSTS) {
    violations.push({
      kind: 'single-host',
      subject: hosts.length ? hosts.join(', ') : '(nothing)',
      why:
        `invoked from ${hosts.length} workflow file(s); at least ${MIN_HOSTS} are required. ` +
        'A guard hosted in ONE workflow cannot detect that workflow being switched off — the one ' +
        'click this guard exists to catch would silence the guard itself, and `gh run list` would ' +
        'keep showing its last green run. Re-add the step to a second lane on a DIFFERENT trigger ' +
        '(loom-guardrails.yml on pull_request/push, hygiene-guard.yml on push+cron) so the two ' +
        'observe each other. Comments do not count; the step must be in a `run:` body.',
    });
  }

  return { violations, hosts };
}

/** Read `.github/workflows/*.yml|*.yaml`. Errors are RETURNED, never swallowed. */
function readWorkflowFiles(dir = WORKFLOW_DIR) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'));
  } catch (e) {
    return { error: `cannot read ${dir} — ${String(e?.message || e).slice(0, 200)}` };
  }
  const files = [];
  for (const n of names) {
    try {
      files.push({ name: n, text: readFileSync(join(dir, n), 'utf8') });
    } catch (e) {
      return { error: `cannot read ${n} — ${String(e?.message || e).slice(0, 200)}` };
    }
  }
  return { files };
}

// ── the embedded known-true control ─────────────────────────────────────────

/**
 * A synthetic population that MUST produce a `not-allowlisted` violation.
 *
 * Deliberately does not resemble the repo: if it were a copy of today's real
 * disabled lanes it would go stale the moment they were re-enabled, and the
 * control would quietly stop being known-true.
 */
const CONTROL_WORKFLOWS = [
  { path: '.github/workflows/control-active.yml', name: 'control-active', state: 'active' },
  { path: '.github/workflows/control-switched-off.yml', name: 'control-switched-off', state: 'disabled_manually' },
];

/**
 * Prove the detector still detects, on EVERY run, whatever the real population
 * looks like. Returns true when the control behaves; false is a hard failure of
 * the guard itself.
 *
 * Two assertions, because either one alone can be satisfied by a broken guard:
 * a detector that flags everything passes the positive case, and a detector
 * that flags nothing passes the negative one.
 */
export function runEmbeddedControl(now = new Date()) {
  const positive = analyze({
    workflows: CONTROL_WORKFLOWS,
    totalCount: CONTROL_WORKFLOWS.length,
    allowlist: { allowed: [] },
    now,
  });
  const caught = positive.violations.some(
    (v) => v.kind === 'not-allowlisted' && v.subject === '.github/workflows/control-switched-off.yml',
  );

  const negative = analyze({
    workflows: [CONTROL_WORKFLOWS[0]],
    totalCount: 1,
    allowlist: { allowed: [] },
    now,
  });
  const quiet = negative.violations.length === 0;

  return { ok: caught && quiet, caught, quiet };
}

// ── self-test: mutation-prove every branch that can fail ─────────────────────

function selfTest() {
  let ok = true;
  const say = (pass, msg) => {
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!pass) ok = false;
  };
  console.log('[workflow-lane-states] self-test — the guard must FAIL on each defect it exists for');

  const now = new Date('2026-08-13T00:00:00Z');
  const GOOD_REASON =
    'Disabled 2026-08-06 while its YAML was invalid; every push produced a "workflow file issue" failure. ' +
    'Dispatch-only diagnostic, no schedule, no teardown.';
  const run = (workflows, allowed, clock = now) =>
    analyze({ workflows, totalCount: workflows.length, allowlist: { allowed }, now: clock }).violations;
  const kinds = (v) => v.map((x) => x.kind).sort().join(',') || '(none)';

  const off = CONTROL_WORKFLOWS[1];
  const entry = (over = {}) => ({
    path: off.path,
    state: 'disabled_manually',
    owner: 'fgarofalo56',
    reason: GOOD_REASON,
    reviewBy: '2026-11-13',
    ...over,
  });

  const control = runEmbeddedControl(now);
  say(control.ok, `embedded control is known-true (caught=${control.caught}, quiet-on-clean=${control.quiet})`);

  say(
    kinds(run(CONTROL_WORKFLOWS, [])) === 'not-allowlisted',
    `an undeclared disabled lane is caught — got [${kinds(run(CONTROL_WORKFLOWS, []))}]`,
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry()])) === '(none)',
    `a fully declared disablement is SILENT — got [${kinds(run(CONTROL_WORKFLOWS, [entry()]))}]`,
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry({ reason: 'TODO — look into this later on some day soon, honestly' })])) ===
      'reason-too-thin',
    'a placeholder reason is rejected even at full length',
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry({ reason: 'broken' })])) === 'reason-too-thin',
    'a one-word reason is rejected',
  );
  say(kinds(run(CONTROL_WORKFLOWS, [entry({ owner: '' })])) === 'owner-missing', 'a missing owner is rejected');
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry({ reviewBy: '' })])) === 'review-missing',
    'a missing reviewBy is rejected',
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry({ reviewBy: 'soon' })])) === 'review-missing',
    'a non-ISO reviewBy is rejected',
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry({ reviewBy: '2026-08-12' })])) === 'review-overdue',
    'an expired reviewBy is rejected',
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry({ reviewBy: '2026-08-13' })])) === '(none)',
    'reviewBy on TODAY is still in date (the boundary is end-of-day, not start)',
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry({ state: 'disabled_inactivity' })])) === 'state-mismatch',
    'a state that drifted from the recorded one is rejected',
  );
  say(
    kinds(run([CONTROL_WORKFLOWS[0]], [entry()])) === 'stale-entry',
    'an entry whose lane is gone from the API is rejected',
  );
  say(
    kinds(run([{ ...off, state: 'active' }], [entry()])) === 'stale-entry',
    'an entry whose lane is ACTIVE again is rejected',
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [entry(), entry()])) === 'allowlist-duplicate',
    'a duplicated path is rejected',
  );
  say(
    kinds(run(CONTROL_WORKFLOWS, [{ owner: 'x', reason: GOOD_REASON, reviewBy: '2026-11-13' }])) ===
      'allowlist-malformed,not-allowlisted',
    'an entry with no path is rejected AND does not cover the real lane',
  );

  const empty = analyze({ workflows: [], totalCount: 0, allowlist: { allowed: [] }, now });
  say(kinds(empty.violations) === 'empty-population', 'a zero-workflow read FAILS rather than reading as clean');

  const truncated = analyze({
    workflows: [CONTROL_WORKFLOWS[0]],
    totalCount: 122,
    allowlist: { allowed: [] },
    now,
  });
  say(kinds(truncated.violations) === 'truncated', 'a half-read page FAILS rather than reporting the rest absent');

  // ── multi-homing (TWO HOSTS) ──────────────────────────────────────────────
  // Synthetic files, so these assertions hold whatever the real wiring is.
  const RUN_STEP = `        run: node scripts/ci/${SELF_BASENAME}\n`;
  const COMMENT_ONLY = `      # someday wire scripts/ci/${SELF_BASENAME} in here\n`;
  const hostKinds = (files) =>
    analyzeHosts({ files }).violations.map((v) => v.kind).sort().join(',') || '(none)';

  say(
    hostKinds([
      { name: 'a.yml', text: RUN_STEP },
      { name: 'b.yml', text: RUN_STEP },
    ]) === '(none)',
    'two lanes invoking the guard is SILENT',
  );
  say(
    hostKinds([
      { name: 'a.yml', text: RUN_STEP },
      { name: 'b.yml', text: 'run: echo unrelated\n' },
    ]) === 'single-host',
    'ONE lane invoking the guard FAILS — a single host cannot observe its own disablement',
  );
  say(
    hostKinds([
      { name: 'a.yml', text: RUN_STEP },
      { name: 'b.yml', text: COMMENT_ONLY },
    ]) === 'single-host',
    'a whole-line COMMENT naming the script does NOT count as a host',
  );
  say(
    hostKinds([{ name: 'a.yml', text: 'run: echo nothing\n' }]) === 'single-host',
    'zero lanes invoking the guard FAILS',
  );
  say(hostKinds([]) === 'hosts-unreadable', 'an unreadable workflow dir FAILS rather than reading as wired');

  // The wiring as it actually stands in this checkout — the one non-synthetic
  // assertion here, because "the function works" and "the repo is wired" are
  // different claims and only the second one keeps the guard alive.
  const realWf = readWorkflowFiles();
  if (realWf.error) {
    say(false, `the real .github/workflows is readable — ${realWf.error}`);
  } else {
    const real = analyzeHosts({ files: realWf.files });
    say(
      real.violations.length === 0,
      `this checkout wires the guard into ${real.hosts.length} lane(s) [${real.hosts.join(', ') || 'none'}] ` +
        `— needs >= ${MIN_HOSTS}`,
    );
  }

  console.log(ok ? '[workflow-lane-states] self-test OK' : '[workflow-lane-states] self-test FAILED');
  return ok ? 0 : 1;
}

// ── IO ──────────────────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

/**
 * The measured population.
 *
 * `--paginate` is load-bearing: the endpoint's default page size is 30 and this
 * repo has 120+ workflows, so a single unpaginated read would report three
 * quarters of the repo as ABSENT. `total_count` is fetched as an independent
 * check on that, because "I paginated" and "I got everything" are different
 * claims and only the second one matters.
 *
 * Errors are RETURNED, never swallowed. A guard that cannot read its subject
 * must say so in those words.
 */
function fetchWorkflows() {
  let rows;
  try {
    const tsv = gh([
      'api',
      `repos/${REPO}/actions/workflows?per_page=100`,
      '--paginate',
      '--jq',
      '.workflows[] | [.state, .path, .name] | @tsv',
    ]);
    rows = tsv
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [state, path, ...rest] = l.split('\t');
        return { state, path, name: rest.join('\t') };
      });
  } catch (e) {
    return { error: `workflow listing failed — ${String(e?.stderr || e?.message || e).trim().slice(0, 400)}` };
  }

  let totalCount;
  try {
    totalCount = Number(gh(['api', `repos/${REPO}/actions/workflows?per_page=1`, '--jq', '.total_count']).trim());
  } catch (e) {
    return { error: `total_count read failed — ${String(e?.stderr || e?.message || e).trim().slice(0, 400)}` };
  }
  if (!Number.isFinite(totalCount)) {
    return { error: 'total_count was not a number; cannot prove the listing was complete' };
  }

  return { rows, totalCount };
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) {
    return { error: `${ALLOWLIST_REL} does not exist. It is the record of every deliberately-off lane; create it.` };
  }
  try {
    return { doc: JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) };
  } catch (e) {
    return { error: `${ALLOWLIST_REL} is not valid JSON — ${String(e?.message || e).slice(0, 200)}` };
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const now = new Date();

  // The control runs BEFORE the real population is judged, and its failure is
  // terminal. At zero disabled lanes this is the only thing that executes the
  // detector, so a guard that has stopped detecting fails here rather than
  // reporting a green tick over a matcher that matches nothing.
  const control = runEmbeddedControl(now);
  if (!control.ok) {
    console.error(
      '[workflow-lane-states] REFUSING TO RUN: the embedded known-true control did not behave.\n' +
        `  detects a disabled+undeclared lane: ${control.caught}\n` +
        `  silent on an all-active population: ${control.quiet}\n` +
        '  analyze() has stopped measuring what this guard claims to measure. Fix the analyser;\n' +
        '  do not ship a green check whose detector is dead.',
    );
    return 1;
  }

  // Then the wiring. This is a local fs read — deterministic, no network — and
  // it asserts the invariant that makes the guard observable: >= 2 distinct
  // workflow files invoke it, on different triggers, so neither can be switched
  // off without the other one going red. Checked BEFORE the API call so a
  // collapsed-to-one-host wiring fails even on a token-less runner.
  const wf = readWorkflowFiles();
  if (wf.error) {
    console.error(
      `[workflow-lane-states] UNREADABLE — ${wf.error}\n\n` +
        '  The workflow directory could not be read, so how many lanes invoke this guard is UNKNOWN.\n' +
        '  Unknown fails closed. (Is the repo checked out in this job?)\n',
    );
    return 1;
  }
  const hostCheck = analyzeHosts({ files: wf.files });
  if (hostCheck.violations.length > 0) {
    for (const v of hostCheck.violations) {
      console.error(`[workflow-lane-states] FAIL  ${v.subject}  [${v.kind}]\n      ${v.why}`);
    }
    return 1;
  }

  const listed = fetchWorkflows();
  if (listed.error) {
    console.error(
      `[workflow-lane-states] UNREADABLE — ${listed.error}\n\n` +
        `  This is NOT "no disabled workflows". The workflows API could not be read, so the state of\n` +
        `  every lane in ${REPO} is UNKNOWN, and unknown fails closed here.\n` +
        '  Most likely: GH_TOKEN is unset, or the job lacks `permissions: actions: read`.\n',
    );
    return 1;
  }

  if (argv.includes('--list')) {
    for (const w of [...listed.rows].sort((a, b) => a.path.localeCompare(b.path))) {
      console.log(`${w.state}\t${w.path}`);
    }
    console.log(`\n${listed.rows.length} workflow(s), total_count=${listed.totalCount}`);
    return 0;
  }

  const al = loadAllowlist();
  if (al.error) {
    console.error(`[workflow-lane-states] FAIL — ${al.error}`);
    return 1;
  }

  const { violations, nonActive, examined } = analyze({
    workflows: listed.rows,
    totalCount: listed.totalCount,
    allowlist: al.doc,
    now,
  });

  if (violations.length > 0) {
    console.error(`\n[workflow-lane-states] ${violations.length} finding(s):\n`);
    for (const v of violations) {
      console.error(`  ${v.subject}  [${v.kind}]`);
      console.error(`      ${v.why}`);
    }
    console.error(
      '\n  A disabled workflow is invisible to `gh run list` — it produces no runs, so it shows no\n' +
        '  failures. The state exists in exactly one place:\n' +
        `      gh api repos/${REPO}/actions/workflows --paginate \\\n` +
        "        --jq '.workflows[] | select(.state != \"active\") | \"\\(.state)\\t\\(.path)\"'\n" +
        '\n  BEFORE re-enabling anything: read the lane\'s `schedule:` and its teardown `if:`. Both\n' +
        '  sovereign lanes once carried a cron-reachable teardown, and "just turn it back on" would\n' +
        '  have destroyed a sovereign estate (see check-teardown-not-on-schedule.mjs). Declaring the\n' +
        `  disablement in ${ALLOWLIST_REL} is always the safe move; enabling is an operator decision.\n`,
    );
    return 1;
  }

  const declared = nonActive.length;
  console.log(
    `[workflow-lane-states] OK — ${examined} workflow(s) read (total_count=${listed.totalCount}), ` +
      `${declared} non-active and all ${declared === 1 ? 'is' : 'are'} declared in ${ALLOWLIST_REL}; ` +
      'embedded control detected its known-true fixture; ' +
      `hosted by ${hostCheck.hosts.length} lane(s): ${hostCheck.hosts.join(', ')}.`,
  );
  if (declared > 0) {
    for (const w of nonActive) console.log(`    ${w.state}  ${w.path}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
