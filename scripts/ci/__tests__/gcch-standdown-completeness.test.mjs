#!/usr/bin/env node
/**
 * deploy-fiab-gcch: a DECLARED-PAUSED run must stand down COMPLETELY. (refs #4233)
 *
 * ── THE DEFECT THIS EXISTS TO CATCH ────────────────────────────────────────
 * The stand-down was PARTIAL. `Estate is DECLARED paused — this run measures
 * nothing` printed "This run is UNMEASURED, not clean", `Bicep what-if` and
 * `Provision` skipped on `steps.adx_preflight.outputs.estate_paused != 'true'`
 * — and three later steps were gated ONLY on `schedule || run_mode == 'full'`,
 * so they ran anyway. Run 33519232492 (2026-09-01) is the receipt:
 *
 *   ADX preflight                     success   estate_paused=true
 *   Estate is DECLARED paused         success   "UNMEASURED, not clean"
 *   Bicep what-if                     skipped
 *   Image preflight — Gov ACR …       success   ← opened the sovereign ACR firewall
 *   Image-tag revert gate             FAILURE   ← the run went red here
 *   Re-pin appImageTags               skipped   (only because the job had failed)
 *   Provision                         skipped
 *
 * So a run that declared it would measure nothing MUTATED the estate (the ACR
 * lease sets publicNetworkAccess=Enabled) and then failed. That is both halves
 * of deploy-integrity R7: the summary asserted something the run did not do,
 * and the red asserted a deploy problem on a deploy that never happened.
 *
 * ── WHY A DISPOSITION TABLE AND NOT A REGEX COUNT ──────────────────────────
 * scripts/ci/__tests__/estate-preflight.test.mjs already counts step-level
 * gates (`stepGates.length >= 3`). A COUNT cannot see the defect: at the head
 * this file was written against, three gates existed and three steps were
 * unguarded, and the count was satisfied. Population accounting is the fix —
 * EVERY step after the declaration is named below with a disposition, and an
 * unlisted step FAILS. A new step cannot slip past by being new.
 *
 * ── SEAM ───────────────────────────────────────────────────────────────────
 * LOOM_GCCH_WORKFLOW_PATH overrides the workflow read, so the RED half of this
 * ratchet is reproducible against any commit:
 *   git show <sha>:.github/workflows/deploy-fiab-gcch.yml > /tmp/head.yml
 *   LOOM_GCCH_WORKFLOW_PATH=/tmp/head.yml node --test <this file>
 *
 * Run: node --test scripts/ci/__tests__/gcch-standdown-completeness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_WF = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-fiab-gcch.yml');

/** The estate-pause stand-down clause, verbatim. */
const GUARD = "steps.adx_preflight.outputs.estate_paused != 'true'";
/** The declaration step every disposition below is measured relative to. */
const DECLARATION_STEP = 'Estate is DECLARED paused — this run measures nothing';

function workflowText() {
  // NORMALISED. `.github/workflows/**` is checked in CRLF here (measured: 1544
  // CRLF, 0 bare LF), and a `\n`-anchored regex silently matches nothing
  // against it — a guard that reads as "compliant" because it found no lines
  // at all is the shape this repo keeps re-finding.
  return readFileSync(process.env.LOOM_GCCH_WORKFLOW_PATH || DEFAULT_WF, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Steps of the `deploy-validate` job, in order.
 *
 * Hand-rolled because this repo's `node --test scripts/ci/__tests__/*.test.mjs`
 * lane (loom-guardrails.yml) runs on a bare node with no dependency install —
 * there is no YAML parser to import. Indentation is fixed and asserted: steps
 * are `      - name:` (6) and their keys `        <key>:` (8). Comment lines
 * are dropped FIRST, because this workflow quotes old `if:` conditions inside
 * its own comment blocks and a naive scan would read one as live config (the
 * exact false positive recorded in check-required-lane-concurrency.mjs).
 *
 * @param {string} src
 * @returns {{name:string, if:string, body:string}[]}
 */
export function parseSteps(src) {
  const lines = String(src).split(/\r?\n/);
  const start = lines.findIndex((l) => /^  deploy-validate:\s*$/.test(l));
  assert.ok(start >= 0, 'deploy-validate job not found');
  let i = lines.findIndex((l, n) => n > start && /^    steps:\s*$/.test(l));
  assert.ok(i > start, 'deploy-validate has no steps: block');

  const steps = [];
  let cur = null;
  for (i += 1; i < lines.length; i += 1) {
    const raw = lines[i];
    // A line at 2-space indent that is not blank ends the job.
    if (/^ {0,3}\S/.test(raw)) break;
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const stepStart = raw.match(/^ {6}- (?:name: (.*)|(uses|id|if|run): .*)$/);
    if (/^ {6}- /.test(raw)) {
      if (cur) steps.push(cur);
      cur = { name: stepStart && stepStart[1] ? stepStart[1].trim() : '(unnamed)', if: '', body: raw };
      continue;
    }
    if (!cur) continue;
    cur.body += `\n${raw}`;
    const ifKey = raw.match(/^ {8}if: (.*)$/);
    if (ifKey) cur.if = ifKey[1].trim();
  }
  if (cur) steps.push(cur);
  return steps;
}

/**
 * Disposition for EVERY step that follows the declaration step.
 *
 *   'guard'          — must carry GUARD in its own `if:`.
 *   'refuse'         — must NOT skip; must fail loudly on a paused estate.
 *                      Used only for Teardown: skipping a requested teardown
 *                      would leave the operator believing a sovereign estate
 *                      was destroyed when it was not.
 *   'via-provision'  — cannot run when `Provision` skipped, because its own
 *                      condition reads a Provision result. Transitively guarded.
 *   'exempt'         — touches no estate resource. Reason recorded, and the
 *                      reason is the point: an exemption with no reason is how
 *                      this table would rot into an allowlist.
 */
const DISPOSITIONS = new Map([
  ['Bicep what-if', { mode: 'guard' }],
  ['Deploy-verification evidence receipt (§7)', { mode: 'guard' }],
  ['Upload GCC-High verification receipt', { mode: 'guard' }],
  ['Image preflight — Gov ACR must already hold every referenced tag', { mode: 'guard' }],
  ['Image-tag revert gate — never flatten a pinned app to the default', { mode: 'guard' }],
  ['Re-pin appImageTags to the RUNNING images (narrows the roll race — #3683)', { mode: 'guard' }],
  ['Provision (with full Gov dispatch)', { mode: 'guard' }],
  [
    'Apply ACR compliance tags (merge-patch, out-of-band — #3714)',
    { mode: 'via-provision', needle: "steps.provision.conclusion == 'success'" },
  ],
  ['Approve the Front Door -> ACA private-endpoint connection', { mode: 'guard' }],
  [
    'Export bootstrap coordinates (for the chained Gov bootstrap)',
    {
      mode: 'exempt',
      why: '`az account show` reads the SUBSCRIPTION, not the estate — no Loom resource is read or written. Its only consumer, the post-deploy-bootstrap job, carries its own `needs.deploy-validate.outputs.estate_paused != \'true\'`.',
    },
  ],
  ['Publish DLZ template + wire deploy env (Gov)', { mode: 'guard' }],
  [
    'Smoke test (Gov-specific)',
    { mode: 'via-provision', needle: "steps.provision.outputs.console_url != ''" },
  ],
  ['Teardown', { mode: 'refuse' }],
  [
    'Note dry-run completion',
    { mode: 'exempt', why: 'echoes a line on `run_mode == whatif-only`; no az call, no network.' },
  ],
  [
    'Notify on failure (dedicated, OPEN issue - never a closed one)',
    {
      mode: 'exempt',
      why: 'the `failure()` notifier. Gating it on the pause verdict is the precise way 47 days of silent daily failure happened before (deploy-integrity R3) — it must always run.',
    },
  ],
]);

/**
 * @param {{name:string, if:string, body:string}[]} steps
 * @returns {string[]} one problem string per violation; empty means compliant.
 */
export function judge(steps) {
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  if (at < 0) return [`the declaration step '${DECLARATION_STEP}' is gone — the stand-down has no anchor at all`];
  const problems = [];
  for (const step of steps.slice(at + 1)) {
    const d = DISPOSITIONS.get(step.name);
    if (!d) {
      problems.push(
        `step '${step.name}' runs AFTER the declaration and has no disposition. ` +
          'Add it to DISPOSITIONS with a mode, or gate it on the estate_paused verdict.',
      );
      continue;
    }
    if (d.mode === 'guard' && !step.if.includes(GUARD)) {
      problems.push(`step '${step.name}' must carry \`${GUARD}\` in its if:, but its if: is \`${step.if || '(none)'}\``);
    }
    if (d.mode === 'via-provision' && !step.if.includes(d.needle)) {
      problems.push(
        `step '${step.name}' is dispositioned as transitively guarded through Provision, ` +
          `which requires \`${d.needle}\` in its if: — found \`${step.if || '(none)'}\``,
      );
    }
    if (d.mode === 'refuse') {
      if (step.if.includes(GUARD)) {
        problems.push(
          `step '${step.name}' must REFUSE on a paused estate, not skip: a silently skipped teardown ` +
            'leaves the operator believing a sovereign estate was destroyed when it was not',
        );
      }
      if (!/ESTATE_PAUSED/.test(step.body) || !/::error::/.test(step.body)) {
        problems.push(
          `step '${step.name}' must read the estate_paused verdict into its body and fail with an ::error:: ` +
            'naming the action that authorises the destruction',
        );
      }
    }
  }
  return problems;
}

test('every step after the declaration stands down, refuses, or is dispositioned', () => {
  const problems = judge(parseSteps(workflowText()));
  assert.deepEqual(problems, [], `deploy-fiab-gcch stand-down is incomplete:\n  - ${problems.join('\n  - ')}`);
});

test('the parser sees the real step list and is not matching comment text', () => {
  const steps = parseSteps(workflowText());
  assert.ok(steps.length >= 20, `expected the full deploy-validate step list, parsed ${steps.length}`);
  assert.ok(
    steps.some((s) => s.name === DECLARATION_STEP),
    'the declaration step must be found by NAME, not by a substring of a comment',
  );
  // The workflow quotes a retired condition inside a comment block above
  // Teardown; if that leaked into a step's `if:` this would trip.
  const teardown = steps.find((s) => s.name === 'Teardown');
  assert.ok(teardown, 'Teardown step not parsed');
  assert.equal(
    teardown.if,
    "success() && github.event_name != 'schedule' && inputs.run_mode == 'full' && !inputs.keep_resources",
    'Teardown if: parsed from the live mapping, not from the commented-out condition above it',
  );
});

test('MUTATION: dropping the guard from the revert gate is caught', () => {
  const steps = parseSteps(workflowText());
  const mutated = steps.map((s) =>
    s.name === 'Image-tag revert gate — never flatten a pinned app to the default'
      ? { ...s, if: "github.event_name == 'schedule' || inputs.run_mode == 'full'" }
      : s,
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got ${problems.length}`);
  assert.match(problems[0], /Image-tag revert gate/);
});

test('MUTATION: the #4233 head shape — three steps gated only on schedule/full — is caught', () => {
  const scheduleOnly = "github.event_name == 'schedule' || inputs.run_mode == 'full'";
  const regressed = new Set([
    'Image preflight — Gov ACR must already hold every referenced tag',
    'Image-tag revert gate — never flatten a pinned app to the default',
    'Re-pin appImageTags to the RUNNING images (narrows the roll race — #3683)',
  ]);
  const mutated = parseSteps(workflowText()).map((s) => (regressed.has(s.name) ? { ...s, if: scheduleOnly } : s));
  const problems = judge(mutated);
  assert.equal(problems.length, 3, `expected 3 problems, got ${problems.length}: ${problems.join(' | ')}`);
});

test('MUTATION: a NEW step added after the declaration must be dispositioned', () => {
  const steps = parseSteps(workflowText());
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  const mutated = [...steps];
  mutated.splice(at + 1, 0, { name: 'Reconcile something new', if: '', body: '        run: az group delete' });
  const problems = judge(mutated);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no disposition/);
});

test('MUTATION: turning Teardown into a silent skip is caught', () => {
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown' ? { ...s, if: `${s.if} && ${GUARD}` } : s,
  );
  const problems = judge(mutated);
  assert.ok(
    problems.some((p) => /must REFUSE on a paused estate, not skip/.test(p)),
    `expected the silent-skip refusal, got: ${problems.join(' | ')}`,
  );
});

test('the daily cron cannot stack at the approval gate, and cannot cancel a live apply', () => {
  const wf = workflowText();
  const block = /\nconcurrency:\n((?: {2}.*\n)+)/.exec(wf);
  assert.ok(block, 'deploy-fiab-gcch has no top-level concurrency: block — scheduled runs stack at gcc-high-deploy');
  const body = block[1]
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1').trimEnd())
    .join('\n');
  assert.match(body, /group:\s*\S/, 'concurrency needs a group');
  assert.match(
    body,
    /group:[^\n]*github\.event_name/,
    'the group must be keyed by event_name, or an operator dispatch queues behind a cron run waiting for an approval nobody intends to give',
  );
  assert.match(
    body,
    /cancel-in-progress:\s*false\s*$/m,
    'cancel-in-progress must be literally false: this lane holds an ACR firewall lease (publicNetworkAccess=Enabled) inside a step, and a cancel there leaves the sovereign registry open until the 75m lease TTL plus acr-firewall-sweeper re-lock it',
  );
});
