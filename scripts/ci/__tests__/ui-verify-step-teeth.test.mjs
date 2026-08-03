/**
 * check-ui-verify-step-teeth.mjs self-test (refs #2875).
 *
 * THE DEFECT BEING GUARDED
 * ------------------------
 * `Run publish-version E2E` in loom-ui-verify.yml carried `continue-on-error:
 * true` and no `id:`. Run 30824614880 concluded SUCCESS while Playwright
 * printed "1 failed, 6 passed" for `version timeline + restore — report`. The
 * missing id is the sharp end: with no id there is no `steps.<id>.outcome`, so
 * the final gate added by #2871 could not have consumed the result at all.
 *
 * WHAT THIS SUITE HAS TO PROVE, BEYOND "the guard runs"
 * -----------------------------------------------------
 * This repo has just been bitten three times by controls that a comment, a stub
 * or a string literal could satisfy. So the fixtures below deliberately try to
 * satisfy the guard dishonestly — a mention in a `#` comment, in a step `name:`,
 * and in an `if:` condition — and each MUST still fail. A guard that accepted
 * any of those would read as enforcement and enforce nothing.
 *
 * The first draft of the guard had exactly that flaw, in the vacuity checks:
 * they were scoped to "am I looking at the real workflow", so pointing it at an
 * EMPTY FILE printed "OK — 0 step(s) … every verdict reaches the job
 * conclusion" and exited 0. `decide()` and the zero-steps tests below exist
 * because of that, not in anticipation of it.
 *
 * MUTATION-PROVEN (counts in the PR body):
 *   - the real pre-fix loom-ui-verify.yml from origin/main: guard exits 1 and
 *     names BOTH offending steps by line.
 *   - re-adding `continue-on-error: true` to the publish-version step: guard
 *     exits 1 naming that step; restoring it returns to exit 0.
 *   - CONTROL fixtures stay green through every mutation.
 *
 * Run: node --test scripts/ci/__tests__/ui-verify-step-teeth.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  analyze,
  decide,
  parseSteps,
  consumingText,
  BROWSER_STEP_FLOOR,
  DEFAULT_WORKFLOW,
} from '../check-ui-verify-step-teeth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW = readFileSync(DEFAULT_WORKFLOW, 'utf8');
const PW_CONFIG = readFileSync(
  resolve(REPO_ROOT, 'apps/fiab-console/playwright.config.ts'),
  'utf8',
);

/** Wrap step lines in a minimal but structurally real workflow. */
const wf = (...stepLines) =>
  ['name: fx', 'on: [workflow_dispatch]', 'jobs:', '  verify:', '    runs-on: ubuntu-latest', '    steps:', ...stepLines].join('\n');

/** A browser step, optionally id-less / tolerated. */
const browserStep = ({ name = 'Run playwright', id = 'pw', coe = false } = {}) => [
  `      - name: ${name}`,
  ...(id ? [`        id: ${id}`] : []),
  ...(coe ? ['        continue-on-error: true'] : []),
  '        run: |',
  '          pnpm exec playwright test --project=verify',
];

/** The final gate, reading whichever ids it is told to. */
const gateStep = ({ ids = ['pw'], always = true, coe = false } = {}) => [
  '      - name: Enforce login-health verdict + blocking suite results',
  ...(always ? ['        if: always()'] : []),
  ...(coe ? ['        continue-on-error: true'] : []),
  '        env:',
  `          UVG_BLOCKING: '${ids.map((i) => `${i}=\${{ steps.${i}.outcome }}`).join(',')}'`,
  '        run: bash scripts/ci/ui-verify-gate-verdict.sh',
];

const names = (v) => v.map((x) => x.name);

// ---------------------------------------------------------------------------
// THE CORE RULE
// ---------------------------------------------------------------------------

test('CONTROL: a browser step with an id, consumed by an always() gate → clean', () => {
  const { violations, browser } = analyze(wf(...browserStep(), ...gateStep()));
  assert.deepEqual(violations, []);
  assert.equal(browser.length, 1);
});

test('a browser step with NO id is a violation (the #2875 shape)', () => {
  const { violations } = analyze(wf(...browserStep({ id: null }), ...gateStep()));
  assert.equal(violations.length, 1);
  assert.match(violations[0].why, /no `id:`/);
  assert.match(violations[0].why, /#2875/);
});

test('a browser step with an id that nothing consumes is a violation', () => {
  const { violations } = analyze(wf(...browserStep({ id: 'lonely' }), ...gateStep({ ids: ['other'] })));
  assert.equal(violations.length, 1);
  assert.match(violations[0].why, /nothing later in the job reads `steps\.lonely\.outcome`/);
});

test('continue-on-error is ALLOWED when the outcome is consumed by the gate', () => {
  // The honest way to keep a step non-fatal, and the remedy
  // check-annotation-teeth.mjs itself prescribes. The guard must not forbid it,
  // or the only escape becomes deleting the step.
  const { violations } = analyze(wf(...browserStep({ coe: true }), ...gateStep()));
  assert.deepEqual(violations, []);
});

test('BOTH siblings are reported, not just the first (the recurrence mechanism)', () => {
  // #2787 fixed one step and left its neighbour; #2875 was that neighbour. A
  // guard that stopped at the first hit would reproduce the same partial fix.
  const { violations } = analyze(
    wf(
      ...browserStep({ name: 'Run A', id: null }),
      ...browserStep({ name: 'Run B', id: null }),
      ...gateStep({ ids: ['x'] }),
    ),
  );
  assert.equal(violations.length, 2);
  assert.deepEqual(names(violations), ['Run A', 'Run B']);
});

// ---------------------------------------------------------------------------
// THE CONSUMER MUST REALLY BE A GATE (R3)
// ---------------------------------------------------------------------------

test('a consumer without if: always() does not count — it is skipped by the failure it judges', () => {
  const { violations } = analyze(wf(...browserStep(), ...gateStep({ always: false })));
  assert.equal(violations.length, 1);
  assert.match(violations[0].why, /none of those is a gate/);
  assert.match(violations[0].why, /if: always\(\)/);
});

test('a consumer that is itself continue-on-error does not count', () => {
  // TWO violations, and the second one is the more interesting: a gate that
  // tolerates its own failure is a discarded verdict in its own right (R4), so
  // it is reported alongside the browser step it failed to protect. Asserting
  // only the first would have let the guard quietly stop noticing the gate.
  const { violations } = analyze(wf(...browserStep(), ...gateStep({ coe: true })));
  assert.equal(violations.length, 2);
  const browserV = violations.find((v) => v.name === 'Run playwright');
  assert.match(browserV.why, /none of those is a gate/);
  const gateV = violations.find((v) => v.name.startsWith('Enforce'));
  assert.match(gateV.why, /continue-on-error: true/);
});

test('a consumer that runs BEFORE the step does not count', () => {
  // Reading steps.pw.outcome ahead of the step yields '' — which the gate
  // script reads as "did not run", i.e. it would pass.
  const { violations } = analyze(wf(...gateStep(), ...browserStep()));
  assert.equal(violations.length, 1);
  assert.match(violations[0].why, /nothing later in the job reads/);
});

// ---------------------------------------------------------------------------
// PROSE CANNOT SATISFY THIS GUARD — the trap that has bitten this repo 3x
// ---------------------------------------------------------------------------

test('a mention in a # COMMENT does not establish consumption', () => {
  const commentGate = [
    '      - name: Enforce',
    '        if: always()',
    '        # we should really wire steps.pw.outcome in here',
    '        run: bash scripts/ci/ui-verify-gate-verdict.sh',
  ];
  const { violations } = analyze(wf(...browserStep(), ...commentGate));
  assert.equal(violations.length, 1, 'a comment must be worth zero');
});

test('a mention in a step NAME does not establish consumption', () => {
  const nameGate = [
    '      - name: Enforce steps.pw.outcome',
    '        if: always()',
    '        run: bash scripts/ci/ui-verify-gate-verdict.sh',
  ];
  const { violations } = analyze(wf(...browserStep(), ...nameGate));
  assert.equal(violations.length, 1, 'a label is prose, not a data flow');
});

test('a mention in an `if:` CONDITION does not establish consumption', () => {
  // `if: steps.pw.outcome == 'failure'` decides whether a step RUNS. It does
  // not make that failure fatal — an annotate-only step conditioned this way
  // still concludes success.
  //
  // The violation assertion alone would be a WEAK test: this fixture is also
  // rejected because `always() && …` is not a bare `always()`, so it stayed
  // green when the `if:` filter was mutated away. The consumingText assertion
  // is what actually pins the exclusion, and it goes red under that mutation.
  const announce = [
    '      - name: Announce',
    '        if: always() && steps.pw.outcome == \'failure\'',
    '        run: echo "the suite failed"',
  ];
  assert.ok(
    !consumingText(announce).includes('steps.pw.'),
    'an `if:` reference must not be counted as consumption',
  );
  const { violations } = analyze(wf(...browserStep(), ...announce));
  assert.equal(violations.length, 1, 'a condition is not enforcement');
});

test('a browser command that appears only in a COMMENT is not a browser step', () => {
  // The mirror image: prose must not ENLARGE the population either, or the
  // guard starts failing on documentation.
  const commentOnly = [
    '      - name: Install Playwright browsers (Chromium)',
    '        run: |',
    '          # this is not `playwright test`, it only installs',
    '          pnpm exec playwright install --with-deps chromium',
  ];
  const { violations, browser } = analyze(wf(...commentOnly, ...browserStep(), ...gateStep()));
  assert.equal(browser.length, 1, 'the install step must not be counted as a browser step');
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// SCOPE — what this guard must NOT flag
// ---------------------------------------------------------------------------

test('a NON-verification step with continue-on-error is not flagged', () => {
  // e.g. `az logout` cleanup. Tolerating a teardown discards no verdict.
  const logout = [
    '      - name: Azure logout',
    '        if: always()',
    '        continue-on-error: true',
    '        run: az logout',
  ];
  const { violations } = analyze(wf(...browserStep(), ...gateStep(), ...logout));
  assert.deepEqual(violations, []);
});

test('a NON-browser verification step with continue-on-error IS flagged when unconsumed', () => {
  // R4: a *-verdict.sh / scripts/ci check whose result is thrown away is the
  // same defect wearing different clothes.
  const tolerated = [
    '      - name: Login-health preflight',
    '        continue-on-error: true',
    '        run: bash scripts/ci/login-health-verdict.sh',
  ];
  const { violations } = analyze(wf(...tolerated, ...browserStep(), ...gateStep()));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, 'Login-health preflight');
  assert.match(violations[0].why, /no `id:`/);
});

test('a NON-browser verification step WITHOUT continue-on-error needs no wiring', () => {
  // It already fails the job on its own; demanding an id would be noise.
  const blocking = [
    '      - name: Login-health preflight',
    '        id: login_health',
    '        run: bash scripts/ci/login-health-verdict.sh',
  ];
  const { violations } = analyze(wf(...blocking, ...browserStep(), ...gateStep()));
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// REFUSE TO PASS VACUOUSLY — decide(). The first draft failed exactly here.
// ---------------------------------------------------------------------------

test('decide: ZERO parsed steps FAILS, for every caller, not just the real file', () => {
  // The first draft gated this on "is this the real workflow", so an empty
  // fixture printed OK and exited 0. Both callers are asserted.
  for (const isDefault of [true, false]) {
    const d = decide({ steps: [], browser: [], violations: [] }, { isDefault });
    assert.equal(d.code, 1, `isDefault=${isDefault} must not pass on zero steps`);
    assert.match(d.reason, /REFUSING TO PASS: parsed ZERO steps/);
  }
});

test('an empty workflow parses to zero steps (so the check above is reachable)', () => {
  assert.equal(parseSteps('').length, 0);
  assert.equal(analyze('').steps.length, 0);
});

test('decide: fewer browser steps than the floor FAILS on the real file', () => {
  const steps = [{}, {}];
  const d = decide({ steps, browser: [{}], violations: [] }, { isDefault: true, floor: 4 });
  assert.equal(d.code, 1);
  assert.match(d.reason, /floor is 4/);
});

test('decide: the floor does NOT apply to fixtures (they legitimately have one)', () => {
  const d = decide({ steps: [{}, {}], browser: [{}], violations: [] }, { isDefault: false });
  assert.equal(d.code, 0);
});

test('decide: violations fail even when the floor is satisfied', () => {
  const d = decide(
    { steps: [{}], browser: [{}, {}, {}, {}], violations: [{ name: 'x' }] },
    { isDefault: true },
  );
  assert.equal(d.code, 1);
});

test('a TRAILING comment on a real data line does not establish consumption', () => {
  // `UVG_BLOCKING: '…'  # also steps.pw.outcome` — the same prose trick, hidden
  // at the end of a line that IS otherwise a real data flow. Separately pinned
  // from the whole-line case because a single over-broad strip covered both and
  // left one of the two mechanisms inert.
  const trailing = [
    '      - name: Enforce',
    '        if: always()',
    '        env:',
    '          UVG_BLOCKING: \'other=x\'  # steps.pw.outcome',
    '        run: bash scripts/ci/ui-verify-gate-verdict.sh',
  ];
  assert.ok(!consumingText(trailing).includes('steps.pw.'), 'a trailing comment must be worth zero');
  const { violations } = analyze(wf(...browserStep(), ...trailing));
  assert.equal(violations.length, 1);
});

test('consumingText drops comments, names and ifs but keeps env/run', () => {
  const body = [
    '      - name: steps.a.outcome',
    '        if: steps.b.outcome == \'failure\'',
    '        # steps.c.outcome',
    '        env:',
    '          X: ${{ steps.d.outcome }}',
    '        run: echo ${{ steps.e.outcome }}',
  ];
  const t = consumingText(body);
  for (const dead of ['steps.a.', 'steps.b.', 'steps.c.']) {
    assert.ok(!t.includes(dead), `${dead} must not survive`);
  }
  for (const live of ['steps.d.', 'steps.e.']) {
    assert.ok(t.includes(live), `${live} must survive`);
  }
});

// ---------------------------------------------------------------------------
// THE REAL FILE — the guard only helps if today's workflow satisfies it, and
// if the specific #2875 wiring is present rather than merely "clean".
// ---------------------------------------------------------------------------

test('REAL: loom-ui-verify.yml has no violations', () => {
  const { violations } = analyze(WORKFLOW);
  assert.deepEqual(
    violations.map((v) => `${v.name}: ${v.why}`),
    [],
  );
});

test('REAL: all four browser steps are discovered, at or above the floor', () => {
  const { browser } = analyze(WORKFLOW);
  assert.ok(
    browser.length >= BROWSER_STEP_FLOOR,
    `expected >= ${BROWSER_STEP_FLOOR} browser steps, found ${browser.length}`,
  );
  assert.deepEqual(
    browser.map((b) => b.id).sort(),
    ['extra_projects', 'publish_version', 'receipt', 'verify_project'],
  );
});

test('REAL: the publish-version step has an id and NO continue-on-error', () => {
  const { steps } = analyze(WORKFLOW);
  const s = steps.find((x) => x.name.includes('publish-version E2E'));
  assert.ok(s, 'the publish-version step is gone');
  assert.equal(s.id, 'publish_version');
  assert.equal(s.continueOnError, false, 'the flag that made run 30824614880 green is back');
});

test('REAL: the receipt step has an id and NO continue-on-error', () => {
  const { steps } = analyze(WORKFLOW);
  const s = steps.find((x) => x.name.includes('browser-E2E receipt'));
  assert.ok(s, 'the receipt step is gone');
  assert.equal(s.id, 'receipt');
  assert.equal(s.continueOnError, false);
});

test('REAL: UVG_BLOCKING carries every browser step, not just the two that had ids', () => {
  // The precise regression: the gate listed verify + extra-projects only, with
  // a comment blessing the other two as "deliberate tolerance".
  const line = WORKFLOW.split(/\r?\n/).find((l) => l.includes('UVG_BLOCKING:'));
  assert.ok(line, 'UVG_BLOCKING is gone from the gate step');
  for (const id of ['verify_project', 'extra_projects', 'publish_version', 'receipt']) {
    assert.ok(line.includes(`steps.${id}.outcome`), `UVG_BLOCKING does not read steps.${id}.outcome`);
  }
});

test('REAL: publish-version carries retries, so flaky is distinguishable from failed', () => {
  // Dropping continue-on-error WITHOUT this trades a silent-green for a
  // noisy-red, and the flag comes straight back (that is the #2787 lesson).
  const proj = PW_CONFIG.slice(
    PW_CONFIG.indexOf("name: 'publish-version'"),
    PW_CONFIG.indexOf("name: 'journey'"),
  );
  assert.ok(proj.length > 0, 'the publish-version project is gone from playwright.config.ts');
  assert.match(proj, /^\s*retries:\s*[1-9]\d*\s*,?\s*$/m, 'publish-version has no retries override');
});
