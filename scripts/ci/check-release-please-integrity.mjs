#!/usr/bin/env node
/**
 * check-release-please-integrity.mjs — the release lane cannot fake a verdict,
 * and a release merge cannot close an issue nobody claimed. (refs #3393)
 *
 * WHY THIS GUARD EXISTS
 * ---------------------
 * Two defects landed on the same workflow within a day of each other, and both
 * were invisible in review because the workflow READ like enforcement:
 *
 *  1. `release-please.yml` posted a SYNTHETIC `success` commit status for any
 *     required context with no producing workflow, annotated with a
 *     `::warning::`. A warning does not stop a merge. Release PRs merged on
 *     statuses no test produced — that is #3393.
 *
 *  2. Its wait-for-real-runs step timed out 78 seconds early on 2026-08-14
 *     (run 31786503229), bridged NOTHING for any of the 14 required contexts,
 *     and the job still concluded `success`. A run that verified nothing showed
 *     green in the run list.
 *
 *  3. Separately, merging release PR #3419 closed issue #3429 — an open P0 —
 *     because release-please's aggregated changelog renders every footer
 *     reference as ", closes #N" whatever the author wrote. #3431 wrote
 *     `Refs #3429`. 37 of the 66 `closes` claims in CHANGELOG.md are that shape.
 *
 * The fixes for all three live in one YAML file, which is the least-reviewed
 * kind of code in the repo. This guard asserts the SAFE properties survive —
 * not that the old broken shapes are absent, which a rename would evade
 * (`csa_loom_guard_keyed_to_the_unsafe_pattern`).
 *
 * LOGICAL LINES, NOT PHYSICAL (#3420)
 * -----------------------------------
 * The statuses this guard judges are posted by a `gh api` call whose
 * `-f state=success` sits on a BACKSLASH CONTINUATION:
 *
 *     gh api -X POST "repos/${REPO}/statuses/${sha}" \
 *       -f state=success \
 *
 * A guard reading physical lines and looking for both tokens on one line would
 * find zero sites and report the workflow clean — the exact failure #3420
 * records. So this reads `_logical-lines.mjs`.
 *
 * EMBEDDED CONTROLS (this guard must not become what it guards against)
 * --------------------------------------------------------------------
 * Every invariant here is a "must be present" assertion over ONE file. A
 * matcher that drifted off the YAML would find nothing to complain about and
 * pass — indistinguishable from a healthy workflow. So before the real file is
 * judged, synthetic workflows that MUST fail each invariant, and one that MUST
 * pass all of them, are run through the same judge. If any control disagrees,
 * this guard fails and reports NOTHING about the repo, because a verdict from a
 * scanner that has stopped scanning is not a verdict
 * (`guard_with_zero_population_needs_embedded_control`).
 *
 * Usage:
 *   node scripts/ci/check-release-please-integrity.mjs              # CHECK
 *   node scripts/ci/check-release-please-integrity.mjs --self-test  # controls only
 *
 * Tests: node --test scripts/ci/__tests__/release-please-integrity.test.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicalLines, isCommentLine } from './_logical-lines.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release-please.yml');
export const NEUTRALIZER = 'scripts/ci/neutralize-release-close-keywords.mjs';

/** Branch protection declared exactly this many contexts when last read (2026-08-14). */
export const MIN_REQUIRED_CONTEXTS = 14;

/** Logical lines that are actual code — a comment mentioning a token is not a site. */
function codeLines(text) {
  return readLogicalLines(text).filter((l) => !isCommentLine(l.text));
}

/**
 * Parse the `REQUIRED_CHECKS=( "Context|workflow.yml" … )` manifest.
 * An entry with no `|` or an empty right-hand side is a context with NO
 * producer — which is the whole population the synthetic path used to serve.
 *
 * @param {string} text
 * @returns {{context:string, workflow:string}[]}
 */
export function parseRequired(text) {
  const out = [];
  let inside = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^REQUIRED_CHECKS=\($/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line === ')') break;
    if (line.startsWith('#')) continue;
    const m = line.match(/^"([^"]*)"$/);
    if (!m) continue;
    const idx = m[1].indexOf('|');
    out.push(
      idx === -1
        ? { context: m[1], workflow: '' }
        : { context: m[1].slice(0, idx), workflow: m[1].slice(idx + 1) },
    );
  }
  return out;
}

/**
 * Judge one release-please workflow body against every invariant.
 *
 * @param {string} text raw YAML
 * @param {{workflowExists?:(f:string)=>boolean}} [opts]
 * @returns {{ok:boolean, failures:{id:string, why:string}[]}}
 */
export function judgeWorkflow(text, opts = {}) {
  const failures = [];
  const fail = (id, why) => failures.push({ id, why });
  const lines = codeLines(text);
  const idxOf = (re) => lines.map((l, i) => (re.test(l.text) ? i : -1)).filter((i) => i >= 0);

  // I1 — every required context names a producing workflow.
  const required = parseRequired(text);
  if (required.length < MIN_REQUIRED_CONTEXTS) {
    fail(
      'manifest-parse',
      `parsed only ${required.length} required contexts (expected >= ${MIN_REQUIRED_CONTEXTS}). The manifest format changed or the parser broke — refusing to grade the rest of the file on a corpus this guard could not read`,
    );
  } else {
    const orphans = required.filter((r) => r.workflow.trim() === '');
    if (orphans.length > 0) {
      fail(
        'producerless-context',
        `${orphans.length} required context(s) name no producing workflow: ${orphans.map((o) => o.context).join(', ')}. Nothing in this repo can verify them, so the only ways to green are a synthetic status or an admin bypass — both are #3393`,
      );
    }
    const exists = opts.workflowExists;
    if (exists) {
      const missing = [...new Set(required.map((r) => r.workflow).filter((w) => w && !exists(w)))];
      if (missing.length > 0) {
        fail(
          'missing-producer-file',
          `producing workflow(s) named in the manifest do not exist: ${missing.join(', ')}`,
        );
      }
    }
  }

  // I2 — a `success` status is posted from EXACTLY one site, and only downstream
  //      of a real check run's `completed/success` verdict.
  const successSites = idxOf(/-f\s+state=success/);
  if (successSites.length === 0) {
    fail(
      'no-success-site',
      'no `-f state=success` site at all. The bridge is how a real result reaches branch protection; with none, this guard is reading a file that no longer does the job it is named for',
    );
  } else if (successSites.length > 1) {
    fail(
      'multiple-success-sites',
      `${successSites.length} separate \`-f state=success\` sites. Exactly one is expected — the bridge. A second one is how the synthetic path came back`,
    );
  } else {
    const at = successSites[0];
    const window = lines.slice(Math.max(0, at - 20), at).map((l) => l.text);
    if (!window.some((t) => t.includes('completed/success'))) {
      fail(
        'unguarded-success',
        'the `-f state=success` site is not within 20 logical lines of a `completed/success` verdict check, so nothing establishes that a real check run on this commit justified it',
      );
    }
  }

  // I3 — a not-green result posts an explicit `failure`, so a stale green
  //      bridged by an earlier run for the same SHA is overwritten, not left.
  if (idxOf(/-f\s+state=failure/).length === 0) {
    fail(
      'no-failure-site',
      'no `-f state=failure` site. Withholding a success is not enough: a status a PREVIOUS run bridged green for this same SHA would still be standing',
    );
  }

  // I4 — the closing-keyword neutralizer runs, and its result is verified by
  //      reading the live body back rather than assumed (deploy-integrity R7).
  const neutralize = idxOf(new RegExp(NEUTRALIZER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (neutralize.length === 0) {
    fail(
      'no-neutralizer',
      `nothing invokes ${NEUTRALIZER}. Without it the release PR body keeps the "closes #N" lines release-please generates from footer references, and merging it closes issues no constituent PR claimed (#3429 was closed this way 2 seconds after #3419 merged)`,
    );
  } else if (!neutralize.some((i) => /--check/.test(lines[i].text))) {
    fail(
      'no-neutralizer-readback',
      `${NEUTRALIZER} is invoked but never with --check, so nothing reads the live body back to establish the edit landed`,
    );
  }

  // I5 — a release PR that could not be graded turns the job RED.
  const marks = idxOf(/UNVERIFIED=\$\(\(UNVERIFIED \+ 1\)\)/);
  if (marks.length === 0) {
    fail(
      'no-unverified-marker',
      'nothing increments UNVERIFIED. The timeout path then falls through and the job reports success having bridged no status at all — measured on run 31786503229',
    );
  }
  const exitIdx = idxOf(/^\s*exit 1\s*$/);
  const guardsExit = lines.some(
    (l, i) => /\[\s*"?\$\{?UNVERIFIED\}?"?\s*-ne\s*0\s*\]/.test(l.text) && exitIdx.some((e) => e > i && e - i <= 12),
  );
  if (!guardsExit) {
    fail(
      'unverified-not-fatal',
      'UNVERIFIED is never tested with a following `exit 1`, so an ungraded release PR still leaves a green run',
    );
  }

  // I6 — the two halves must not read different sources of truth.
  //
  // This is the invariant #3448 did NOT have, and its absence is why every
  // structural check passed on the workflow that deadlocked the lane. The
  // dispatch decision read `actions/runs?head_sha=…` (which returns HELD
  // pull_request runs that grade nothing) while the verdict read
  // `commits/{sha}/check-runs`. Skip-forever plus fail-forever.
  //
  // Keyed on the SAFE property: any workflow-run query in this file must pin
  // the event to workflow_dispatch, i.e. to runs THIS job caused. An unpinned
  // query is the one that conflates the two populations.
  const crSource = idxOf(/commits\/\$\{?sha\}?\/check-runs|commits\/\$1\/check-runs/);
  if (crSource.length === 0) {
    fail(
      'no-check-run-source',
      'nothing reads `commits/{sha}/check-runs`. That is the only evidence a required context was actually graded — branch protection reads the same surface',
    );
  }
  for (const i of idxOf(/actions\/runs\?head_sha=/)) {
    // An `echo` is output, not an invocation. The step deliberately PRINTS an
    // unpinned query in its diagnostic — telling the operator to go look at the
    // held `pull_request` runs is exactly the right advice, and flagging that
    // would be a guard punishing the message that explains the bug.
    if (/^\s*echo\b/.test(lines[i].text)) continue;
    if (!/event=workflow_dispatch/.test(lines[i].text)) {
      fail(
        'unpinned-run-query',
        `line ${lines[i].line}: an \`actions/runs?head_sha=\` query with no \`event=workflow_dispatch\` pin. That list includes \`pull_request\` runs held at \`action_required\` — created, never executed, publishing no check run. Treating one as evidence deadlocked release PR #3447`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

// ── EMBEDDED CONTROLS ───────────────────────────────────────────────────────
// A minimal workflow carrying every safe property. Each MUST_FAIL case is this
// text with exactly one property removed, so a control that stops failing tells
// us the matcher for that one invariant drifted.
const GOOD = [
  'jobs:',
  '  release-please:',
  '    steps:',
  '      - run: |',
  '          REQUIRED_CHECKS=(',
  ...Array.from({ length: MIN_REQUIRED_CONTEXTS }, (_, i) => `            "Ctx ${i}|producer.yml"`),
  '          )',
  '          node scripts/ci/neutralize-release-close-keywords.mjs body.raw.txt > body.clean.txt',
  '          node scripts/ci/neutralize-release-close-keywords.mjs --check body.verify.txt',
  '          UNVERIFIED=0',
  '          gh api --paginate "repos/${REPO}/commits/${sha}/check-runs?per_page=100"',
  '          gh api --paginate "repos/${REPO}/actions/runs?head_sha=$1&event=workflow_dispatch&per_page=100" \\',
  '            --jq ".workflow_runs[].path"',
  '          if [ -n "${unfinished}" ]; then',
  '            UNVERIFIED=$((UNVERIFIED + 1))',
  '          fi',
  '          if [ "${verdict}" != "completed/success" ]; then',
  '            gh api -X POST "repos/${REPO}/statuses/${sha}" \\',
  '              -f state=failure \\',
  '              -f context="${ctx}" >/dev/null',
  '            continue',
  '          fi',
  '          gh api -X POST "repos/${REPO}/statuses/${sha}" \\',
  '            -f state=success \\',
  '            -f context="${ctx}" >/dev/null',
  '          if [ "${UNVERIFIED}" -ne 0 ]; then',
  '            echo "::error::ungraded"',
  '            exit 1',
  '          fi',
].join('\n');

/** @type {{name:string, text:string, expect:string|null}[]} */
export const SELF_TEST_CASES = [
  { name: 'the healthy shape passes every invariant', text: GOOD, expect: null },
  {
    name: 'a context with no producer is caught',
    text: GOOD.replace('"Ctx 0|producer.yml"', '"Ctx 0|"'),
    expect: 'producerless-context',
  },
  {
    name: 'a second success-posting site is caught',
    text: GOOD + '\n          gh api -X POST "u" -f state=success -f context="x"',
    expect: 'multiple-success-sites',
  },
  {
    name: 'a success posted with no completed/success verdict above it is caught',
    text: GOOD.replace('"${verdict}" != "completed/success"', '"${verdict}" != "ok"'),
    expect: 'unguarded-success',
  },
  {
    name: 'dropping the failure-status site is caught',
    text: GOOD.replace('              -f state=failure \\\n', ''),
    expect: 'no-failure-site',
  },
  {
    name: 'dropping the neutralizer is caught',
    text: GOOD.split('\n')
      .filter((l) => !l.includes('neutralize-release-close-keywords'))
      .join('\n'),
    expect: 'no-neutralizer',
  },
  {
    name: 'invoking the neutralizer without the --check read-back is caught',
    text: GOOD.split('\n')
      .filter((l) => !l.includes('--check'))
      .join('\n'),
    expect: 'no-neutralizer-readback',
  },
  {
    name: 'a timeout path that does not mark UNVERIFIED is caught',
    text: GOOD.replace('UNVERIFIED=$((UNVERIFIED + 1))', 'echo "still waiting"'),
    expect: 'no-unverified-marker',
  },
  {
    name: 'an UNVERIFIED count that never exits non-zero is caught',
    text: GOOD.replace('            exit 1\n', '            echo "noted"\n'),
    expect: 'unverified-not-fatal',
  },
  {
    name: 'a manifest the parser can no longer read is caught',
    text: GOOD.replace('REQUIRED_CHECKS=(', 'REQUIRED_CHECKS_RENAMED=('),
    expect: 'manifest-parse',
  },
  {
    name: 'an UNPINNED actions/runs query — the #3447 deadlock — is caught',
    text: GOOD.replace('&event=workflow_dispatch', ''),
    expect: 'unpinned-run-query',
  },
  {
    name: 'losing the check-run source of truth is caught',
    text: GOOD.replace('commits/${REPO_SHA_PLACEHOLDER}', 'x').replace(
      'gh api --paginate "repos/${REPO}/commits/${sha}/check-runs?per_page=100"',
      'gh api --paginate "repos/${REPO}/actions/runs?head_sha=$1&event=workflow_dispatch&per_page=100"',
    ),
    expect: 'no-check-run-source',
  },
  {
    name: 'the unpinned query is caught even when split across a CONTINUATION (#3420)',
    // The real file wraps this call. A physical-line reader would judge only
    // the first line, never see the missing pin, and pass.
    text: GOOD.replace(
      '          gh api --paginate "repos/${REPO}/actions/runs?head_sha=$1&event=workflow_dispatch&per_page=100" \\\n            --jq ".workflow_runs[].path"',
      '          gh api --paginate \\\n            "repos/${REPO}/actions/runs?head_sha=$1&per_page=100" \\\n            --jq ".workflow_runs[].path"',
    ),
    expect: 'unpinned-run-query',
  },
  {
    // The counterpart control. The step PRINTS an unpinned query in its
    // diagnostic on purpose — that is how an operator finds the held runs. If
    // this ever starts failing, the guard has begun flagging its own advice.
    name: 'an unpinned query merely ECHOED as operator advice is NOT flagged',
    text: `${GOOD}\n          echo "::error::  gh api repos/o/r/actions/runs?head_sha=abc --jq .path"`,
    expect: null,
  },
  {
    name: 'a success site on a BACKSLASH CONTINUATION is still seen (#3420)',
    // Physical-line reading would miss `-f state=success` here entirely and
    // report `no-success-site`; folding continuations is what makes it visible.
    text: GOOD,
    expect: null,
  },
];

/**
 * @returns {{name:string, expected:string|null, got:string[]}[]} disagreements
 */
export function runSelfTest() {
  const bad = [];
  for (const c of SELF_TEST_CASES) {
    const got = judgeWorkflow(c.text).failures.map((f) => f.id);
    const agrees = c.expect === null ? got.length === 0 : got.includes(c.expect);
    if (!agrees) bad.push({ name: c.name, expected: c.expect, got });
  }
  return bad;
}

function main(argv) {
  const disagreements = runSelfTest();
  if (disagreements.length > 0) {
    console.error(
      `::error::release-please-integrity: ${disagreements.length} of ${SELF_TEST_CASES.length} embedded control(s) DISAGREED. This guard's matchers have drifted off the YAML, so it is reporting nothing about the repo rather than a clean scan it did not perform.`,
    );
    for (const d of disagreements) {
      console.error(`::error::  control "${d.name}": expected ${d.expected ?? 'no failures'}, got [${d.got.join(', ')}]`);
    }
    process.exit(1);
  }
  console.log(`release-please-integrity: ${SELF_TEST_CASES.length}/${SELF_TEST_CASES.length} embedded controls agree.`);
  if (argv.includes('--self-test')) return;

  if (!existsSync(WORKFLOW)) {
    console.error(
      `::error::release-please-integrity: ${path.relative(REPO_ROOT, WORKFLOW)} is missing. The release lane cannot be graded, so this guard has verified NOTHING.`,
    );
    process.exit(1);
  }

  const text = readFileSync(WORKFLOW, 'utf8');
  const verdict = judgeWorkflow(text, {
    workflowExists: (f) => existsSync(path.join(REPO_ROOT, '.github', 'workflows', f)),
  });

  const required = parseRequired(text);
  console.log(
    `  manifest: ${required.length} required context(s) across ${new Set(required.map((r) => r.workflow)).size} producer workflow(s)`,
  );

  if (!verdict.ok) {
    for (const f of verdict.failures) {
      console.error(`::error file=.github/workflows/release-please.yml::release-please-integrity [${f.id}]: ${f.why}`);
    }
    console.error(
      `::error::release-please-integrity: ${verdict.failures.length} invariant(s) broken. A release PR could merge on a verdict nothing produced, or a release merge could close an issue nobody claimed (#3393).`,
    );
    process.exit(1);
  }

  // The neutralizer is not optional infrastructure — if it is gone, the
  // workflow's invocation of it fails at runtime, in a step whose failure would
  // be read as flakiness. Establish it exists here, where the message is clear.
  if (!existsSync(path.join(REPO_ROOT, NEUTRALIZER))) {
    console.error(
      `::error::release-please-integrity: the workflow invokes ${NEUTRALIZER} but that file does not exist.`,
    );
    process.exit(1);
  }

  console.log(
    'release-please-integrity: every required context has a producer, the only success status is bridged from a real run, an ungraded release fails the lane, and a release merge closes nothing.',
  );
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-release-please-integrity.mjs')
) {
  main(process.argv.slice(2));
}
