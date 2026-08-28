// Controls for the PER-REGION PROJECTION in the "Enumerate the ADX SKUs the
// Kusto RP offers in this subscription" step of
// .github/workflows/gov-adx-sku-probe.yml (#4139).
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
// That step guards the TOP-LEVEL enumeration carefully — a non-zero `az`, a
// non-array body, and a zero-length array each `exit 1` with an explicit "this
// is UNKNOWN, not none" message. It did not guard the PROJECTION:
//
//   [.[] | select(.locations | index($r))]
//
// where `$r` is the compact region name read out of the bicepparam files
// (`usgovvirginia`). If the Kusto RP ever returns `locations` in a form that
// does not string-match — display form ("US Gov Virginia"), different casing,
// or a schema change — then EVERY region projects to zero while TOTAL stays
// large, each region prints
//
//   (none — the enumeration RETURNED and listed no ADX SKU for this region)
//
// and the verdict step downstream emits, as fact, "the configured effective ADX
// SKU … is NOT offered in at least one PRIMARY Gov region. This is a MEASURED
// result". That is a confident false negative produced by a parse failure —
// deploy-integrity.md R7, reached through the one path this workflow's own
// header does not cover.
//
// The shape does not fire on Commercial today (`az kusto cluster list-sku`
// returns compact lowercase `locations`), which is why it is a hardening gap
// rather than a live defect. The Gov RP's response shape has not been observed
// by anyone, so "correct because the format happens to match" is the whole of
// the current assurance.
//
// ── WHAT IS ACTUALLY UNDER TEST ─────────────────────────────────────────────
// The REAL step body, extracted from the workflow YAML at run time — not a
// copy of its jq filter. Rename the step, delete it, or change the filter and
// this suite sees it. `az` is replaced by a bash function defined in a PRELUDE
// prepended to the script; the step's own text is never rewritten, and a test
// asserts that. `jq`, `wc`, `sed` and `awk` are the real binaries, so the
// projection under test is the projection that ships.
//
// The fixtures are `az kusto cluster list-sku -o json` entries in the shape the
// CLI actually returns — `name`, `tier`, `locations`, `locationInfo`,
// `resourceType`, `restrictions` — measured on Commercial and quoted in #4139.
// The only thing that varies between the two payloads is the FORM of the
// `locations` strings, which is the variable under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..', '..');
const WF = path.join(REPO, '.github', 'workflows', 'gov-adx-sku-probe.yml');
const STEP_NAME = 'Enumerate the ADX SKUs the Kusto RP offers in this subscription';

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const jqAvailable = spawnSync('bash', ['-c', 'command -v jq']).status === 0;
const CAN_RUN = bashAvailable && jqAvailable;

// ── Extracting the shipped step ─────────────────────────────────────────────

/**
 * Pull the step's `run:` block out of the workflow as text.
 *
 * Deliberately NOT a YAML library: the `guardrails` job that runs this suite
 * does `actions/setup-node` and no install, so a third-party import would make
 * the whole file throw — and a suite that cannot load is a suite that enforces
 * nothing. Same approach gov-bff-probe-scope.test.mjs takes.
 *
 * Every failure mode throws rather than returning something empty: an extractor
 * that silently yielded `''` would make every case below "pass" by running no
 * script at all.
 */
function enumerationStep() {
  const lines = readFileSync(WF, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${STEP_NAME}`);
  assert.ok(start >= 0, `workflow step "${STEP_NAME}" not found in ${WF} — renamed or removed?`);

  let runAt = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- name:/.test(lines[i])) break; // next step — no run block
    if (/^\s*run:\s*\|\s*$/.test(lines[i])) { runAt = i; break; }
  }
  assert.ok(runAt >= 0, `no "run: |" block under "${STEP_NAME}"`);

  const runIndent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.match(/^\s*/)[0].length <= runIndent) break;
    body.push(l.slice(runIndent + 2));
  }
  const script = body.join('\n');
  assert.ok(script.includes('az kusto cluster list-sku'), 'extracted block does not look like the enumeration step');
  assert.ok(
    script.includes('[.[] | select(.locations | index($r))]'),
    'extracted block carries no per-region projection filter — this suite would be testing nothing',
  );
  // The split/join above normalises line endings on purpose. A Windows checkout
  // hands this file back CRLF; the mutations below match on plain-LF needles,
  // and a stray \r would make those `replace()` calls silently no-op — the
  // mutation then "passes" by having changed nothing at all.
  assert.ok(!script.includes('\r'), 'extracted script carries CR — the mutation needles below would no-op');
  return script;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// One entry per (SKU, region) pair, which is what Skus_List returns. `mk`
// builds an entry whose `locations` carries whatever FORM the case is about.

const SKUS = [
  ['Dev(No SLA)_Standard_E2a_v4', 'Basic'],
  ['Standard_E2ads_v5', 'Standard'],
  ['Standard_E8as_v5+1TB_PS', 'Standard'],
];

const mk = (name, tier, location, restrictions = []) => ({
  resourceType: 'clusters',
  name,
  tier,
  locations: [location],
  locationInfo: [{ location, zones: [] }],
  restrictions,
});

/** The form the CLI returns today: compact, lowercase. Measured on Commercial. */
const COMPACT = [
  ...SKUS.map(([n, t]) => mk(n, t, 'usgovvirginia')),
  ...SKUS.map(([n, t]) => mk(n, t, 'usgovarizona')),
  // A region this repo does not target, so the projection legitimately drops it.
  mk('Standard_D11_v2', 'Standard', 'usgovtexas'),
];

/**
 * The same enumeration with `locations` in ARM DISPLAY form. Identical
 * information, one string form away — and the form is the only thing the
 * projection keys on.
 */
const DISPLAY = [
  ...SKUS.map(([n, t]) => mk(n, t, 'US Gov Virginia')),
  ...SKUS.map(([n, t]) => mk(n, t, 'US Gov Arizona')),
  mk('Standard_D11_v2', 'Standard', 'US Gov Texas'),
];

/** Mixed case — the other way the same class arrives. */
const MIXED_CASE = [
  ...SKUS.map(([n, t]) => mk(n, t, 'USGovVirginia')),
  ...SKUS.map(([n, t]) => mk(n, t, 'USGovArizona')),
];

const REGIONS = ['usgovarizona', 'usgovvirginia'];

// ── Running the extracted step ──────────────────────────────────────────────

/**
 * Run the step against a fixture.
 *
 * `az` is replaced by a bash FUNCTION defined in a prelude prepended to the
 * script — a function is resolved before PATH, so the step's own
 * `az kusto cluster list-sku -o json > … 2> …` line is executed verbatim,
 * redirections and `$?` included. Nothing inside the step is rewritten.
 *
 * The previous step's product (`regions-all.txt` / `regions-primary.txt`) is
 * seeded here because this step consumes it. `regions` is a parameter so the
 * zero-population case can be exercised.
 */
function runStep(script, { fixture, regions = REGIONS, azExit = 0, azStderr = '' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'adx-proj-'));
  const out = path.join(dir, 'adx-probe');
  mkdirSync(out, { recursive: true });
  const list = regions.length ? `${regions.join('\n')}\n` : '';
  writeFileSync(path.join(out, 'regions-all.txt'), list, 'utf8');
  writeFileSync(path.join(out, 'regions-primary.txt'), list, 'utf8');

  const fixturePath = path.join(dir, 'fixture.json');
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

  // POSIX path for bash — a Windows checkout hands node a `C:\…` path, which
  // bash would read as a relative name and never find.
  const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
  const prelude = [
    '# --- harness prelude (not part of the shipped step) ---',
    `az() { if [ -n "${azStderr}" ]; then printf '%s\\n' "${azStderr}" >&2; fi; `
      + `cat "${posix(fixturePath)}"; return ${azExit}; }`,
    '# --- end harness prelude ---',
    '',
  ].join('\n');

  const stepPath = path.join(dir, 'step.sh');
  writeFileSync(stepPath, prelude + script, 'utf8');

  const r = spawnSync('bash', [stepPath], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: posix(dir) },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dir: out, stepPath };
}

const errors = (out) => out.split('\n').filter((l) => l.includes('::error::'));

// ── Harness integrity ───────────────────────────────────────────────────────

test('HARNESS: the prelude only PREPENDS — the script bash runs ENDS WITH the shipped step, byte for byte', { skip: !CAN_RUN }, () => {
  // Without this, every case below could be a statement about a harness-edited
  // copy rather than about the workflow. Checked on the file bash actually
  // executed, not on the string this file intended to write.
  const script = enumerationStep();
  const r = runStep(script, { fixture: COMPACT });
  const executed = readFileSync(r.stepPath, 'utf8');
  assert.ok(executed.endsWith(script),
    'the executed script does not end with the extracted step — the harness is rewriting the subject');
  assert.ok(executed.length > script.length, 'no prelude was prepended — the az shim cannot be in effect');
  assert.ok(!executed.slice(0, executed.length - script.length).includes('PROJECTED_TOTAL'),
    'the prelude touches the guard under test');
});

test('HARNESS: the projection filter under test is the one in the workflow, character for character', () => {
  const script = enumerationStep();
  const wf = readFileSync(WF, 'utf8');
  const FILTER = "'[.[] | select(.locations | index($r))] | sort_by(.name) | .[] | \"\\(.name)\\t\\(.tier)\\t\\(.restrictions | length)\"'";
  assert.ok(wf.includes(FILTER), 'the workflow no longer carries the filter this suite replays — update the suite');
  assert.ok(script.includes(FILTER), 'the extracted step no longer carries the filter — extraction has drifted');
});

// ── The control ─────────────────────────────────────────────────────────────

test('COMPACT `locations` (the form measured today) projects normally -> exit 0', { skip: !CAN_RUN }, async () => {
  // The positive control. Without it, a guard that failed on EVERY payload
  // would look identical to a guard that discriminates.
  const r = runStep(enumerationStep(), { fixture: COMPACT });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /=== usgovvirginia — 3 ADX SKU\(s\) offered ===/);
  assert.match(r.out, /=== usgovarizona — 3 ADX SKU\(s\) offered ===/);
  assert.match(r.out, /Projection sanity: 2 region\(s\) projected, 6 \(SKU, region\) row\(s\) matched out of 7/);
  assert.deepEqual(errors(r.out), []);
  // And the per-region TSVs the verdict step reads really were written.
  assert.match(readFileSync(path.join(r.dir, 'skus-usgovvirginia.tsv'), 'utf8'), /Standard_E2ads_v5\tStandard\t0/);
});

test('DISPLAY-FORM `locations` FAILS as UNKNOWN — it is not reported as "not offered"', { skip: !CAN_RUN }, async () => {
  // The defect. Same enumeration, same SKUs, one string form away. Before this
  // guard the step exited 0 having printed "(none — the enumeration RETURNED
  // and listed no ADX SKU for this region)" for both regions, and the verdict
  // step then published that as a MEASURED absence.
  const r = runStep(enumerationStep(), { fixture: DISPLAY });
  assert.equal(r.status, 1, `a format mismatch must not be graded as an absence\n${r.out}`);
  const [line, ...rest] = errors(r.out);
  assert.equal(rest.length, 0, r.out);
  assert.match(line, /ALL 2 target regions projected to ZERO SKUs/);
  assert.match(line, /is not an absence/);
  assert.match(line, /UNVERIFIED/);
  assert.ok(!/NOT offered/.test(line), `the message must not assert absence:\n${line}`);
  // deploy-integrity.md R6 — it diagnoses itself rather than needing a re-run.
  assert.match(r.out, /distinct `locations` values the RP ACTUALLY returned/);
  assert.match(r.out, /^ {2}US Gov Virginia$/m);
  assert.match(r.out, /^ {2}US Gov Texas$/m);
  assert.match(r.out, /the region strings this run projected FOR/);
  assert.match(r.out, /^ {2}usgovvirginia$/m);
});

test('MIXED-CASE `locations` is the same class and fails the same way', { skip: !CAN_RUN }, async () => {
  // The issue names three arrival forms; keying the guard to the display form
  // alone would be the narrow-enumeration mistake this repo keeps paying for.
  // The guard keys on the OUTCOME (all-zero over a non-empty enumeration), so
  // it catches a form nobody enumerated.
  const r = runStep(enumerationStep(), { fixture: MIXED_CASE });
  assert.equal(r.status, 1, r.out);
  assert.match(errors(r.out)[0], /ALL 2 target regions projected to ZERO SKUs/);
  assert.match(r.out, /^ {2}USGovVirginia$/m);
});

test('A GENUINE single-region absence still passes — the guard is not a blanket refusal', { skip: !CAN_RUN }, async () => {
  // The counterfactual that keeps the guard honest in the other direction. One
  // region legitimately offering no ADX SKU is an ordinary, reportable result
  // and must reach the verdict step, which is what decides on it. Only the
  // all-zero combination is refused.
  const fixture = SKUS.map(([n, t]) => mk(n, t, 'usgovvirginia'));
  const r = runStep(enumerationStep(), { fixture });
  assert.equal(r.status, 0, `a real per-region absence must not be swallowed by the mismatch guard\n${r.out}`);
  assert.match(r.out, /=== usgovarizona — 0 ADX SKU\(s\) offered ===/);
  assert.match(r.out, /\(none — the enumeration RETURNED and listed no ADX SKU for this region\)/);
  assert.match(r.out, /Projection sanity: 2 region\(s\) projected, 3 \(SKU, region\) row\(s\) matched out of 3/);
});

test('POPULATION FLOOR: an empty region list fails rather than projecting over nothing', { skip: !CAN_RUN }, async () => {
  // With no regions the loop runs zero times, every per-region claim is vacuous
  // and PROJECTED_TOTAL is 0 for a reason that has nothing to do with the RP.
  // The message must say THAT, not the format-mismatch one.
  const r = runStep(enumerationStep(), { fixture: COMPACT, regions: [] });
  assert.equal(r.status, 1, r.out);
  const [line] = errors(r.out);
  assert.match(line, /the derived region list is EMPTY/);
  assert.match(line, /measured nothing about any of them/);
  assert.ok(!/projected to ZERO SKUs/.test(line),
    `zero regions is not a format mismatch — the two must not be conflated:\n${line}`);
});

test('the pre-existing top-level guards still fire (empty array, non-array)', { skip: !CAN_RUN }, async () => {
  // The new guard sits below these; a change that made it run FIRST would
  // relabel an empty enumeration as a projection mismatch. Pinned so it cannot.
  const empty = runStep(enumerationStep(), { fixture: [] });
  assert.equal(empty.status, 1, empty.out);
  assert.match(errors(empty.out)[0], /returned an EMPTY SKU list/);

  const notArray = runStep(enumerationStep(), { fixture: { error: 'nope' } });
  assert.equal(notArray.status, 1, notArray.out);
  assert.match(errors(notArray.out)[0], /is not a JSON array/);
});

// ── The mutations ───────────────────────────────────────────────────────────

test('MUTATION: removing the all-zero guard makes the display-form payload exit 0', { skip: !CAN_RUN }, async () => {
  // The counterfactual for the whole change. If this still failed, the red in
  // the display-form case above would not have been caused by this guard.
  const src = enumerationStep();
  const mutated = src.replace('if [ "$PROJECTED_TOTAL" -eq 0 ]; then', 'if false; then');
  assert.notEqual(mutated, src, 'the all-zero guard moved — this proof no longer targets it');
  const r = runStep(mutated, { fixture: DISPLAY });
  assert.equal(r.status, 0, `without the guard the mismatch must pass silently — that is the defect\n${r.out}`);
  // And this is exactly the text the verdict step would then read as an answer.
  assert.match(r.out, /=== usgovvirginia — 0 ADX SKU\(s\) offered ===/);
  assert.match(r.out, /\(none — the enumeration RETURNED and listed no ADX SKU for this region\)/);
});

test('MUTATION: removing the population floor MISDIAGNOSES an empty region list as a format mismatch', { skip: !CAN_RUN }, async () => {
  // Measured, not assumed. Without the floor the zero-region case still exits 1
  // — but through the all-zero arm, which reports "ALL 0 target regions
  // projected to ZERO SKUs" and sends the reader at the RP's response format
  // when the actual fault is that the derived region list was lost between
  // steps. A red for the wrong reason is the failure this floor prevents; the
  // exit code alone could never have told the two apart.
  const src = enumerationStep();
  const mutated = src.replace('if [ "$REGIONS_SEEN" -eq 0 ]; then', 'if false; then');
  assert.notEqual(mutated, src, 'the population floor moved — this proof no longer targets it');
  const r = runStep(mutated, { fixture: COMPACT, regions: [] });
  assert.equal(r.status, 1, r.out);
  const [line, ...rest] = errors(r.out);
  assert.equal(rest.length, 0, r.out);
  assert.match(line, /ALL 0 target regions projected to ZERO SKUs/);
  assert.ok(!/the derived region list is EMPTY/.test(line),
    'the floor must be the ONLY producer of the correct diagnosis');
});

test('MUTATION: breaking the projection filter itself is caught', { skip: !CAN_RUN }, async () => {
  // The failure the guard is a proxy for, injected at its real site: the filter
  // stops matching. This is the shape a schema change would produce, and it
  // must be caught by OUTCOME rather than by anyone having enumerated it.
  const src = enumerationStep();
  const mutated = src.replace('select(.locations | index($r))', 'select(.regions | index($r))');
  assert.notEqual(mutated, src, 'the projection filter moved — this proof no longer targets it');
  const r = runStep(mutated, { fixture: COMPACT });
  assert.equal(r.status, 1, `a filter that matches nothing must not report an absence\n${r.out}`);
  assert.match(errors(r.out)[0], /ALL 2 target regions projected to ZERO SKUs/);
});
