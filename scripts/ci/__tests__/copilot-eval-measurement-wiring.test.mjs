/**
 * copilot-eval-measurement-wiring.test.mjs — #4346: the workflow actually WIRES
 * eval-measurement.mjs where its result is read.
 *
 * eval-measurement.test.mjs proves the classifier. This file proves the
 * classifier is CALLED from the places whose output a reader sees, because a
 * correct module nobody invokes is the "control that watches nothing" shape
 * (assertion-design.md). Dependency-free, same region-slicing approach as
 * copilot-eval-gate-provenance.test.mjs (no YAML parser).
 *
 * Every assertion that checks ORDER first asserts each anchor EXISTS, so a
 * deleted anchor fails loudly instead of comparing -1 against a number.
 * Each test names the edit to the workflow that turns it red.
 *
 * Run: node --test scripts/ci/__tests__/copilot-eval-measurement-wiring.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { NOT_MEASURED_STATES } from '../eval-measurement.mjs';

const WF = path.resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'copilot-quality-evals.yml');
const SRC = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

function region(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  assert.ok(start >= 0, `anchor not found: ${JSON.stringify(startMarker)}`);
  const end = endMarker ? SRC.indexOf(endMarker, start + startMarker.length) : SRC.length;
  assert.ok(end > start, `end anchor not found after start: ${JSON.stringify(endMarker)}`);
  return SRC.slice(start, end);
}

const EVALS_JOB = () => region('\n  evals:\n', '\n  report-outcome:\n');
const REPORT_JOB = () => region('\n  report-outcome:\n');

/** Steps of a job region, keyed by the `- name:` line (6-space indent). */
function steps(jobText) {
  const re = /^ {6}- (?:name: (.+)|uses: (.+))$/gm;
  const hits = [...jobText.matchAll(re)];
  return hits.map((m, i) => ({
    name: (m[1] ?? `uses: ${m[2]}`).trim(),
    body: jobText.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : jobText.length),
  }));
}

function stepWithId(jobText, id) {
  const hit = steps(jobText).filter((s) => new RegExp(`^ {8}id: ${id}$`, 'm').test(s.body));
  assert.equal(hit.length, 1, `exactly one step with id: ${id}`);
  return hit[0];
}

function stepNamed(jobText, prefix) {
  const hit = steps(jobText).filter((s) => s.name.startsWith(prefix));
  assert.equal(hit.length, 1, `exactly one step named "${prefix}…"`);
  return hit[0];
}

function at(text, needle) {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `anchor not found: ${JSON.stringify(needle)}`);
  return i;
}

test('evals job exports measurement / gate_reported_only / gate_rc FROM the gate step', () => {
  // Breaks if the `outputs:` block is deleted, an output is renamed, or it
  // reads a different step (`steps.prov.outputs.measurement`) — report-outcome
  // would then receive '' and print "unrecorded" on every run.
  const job = EVALS_JOB();
  const header = job.slice(0, at(job, '\n    steps:\n'));
  assert.match(header, /^ {6}measurement: \$\{\{ steps\.gate\.outputs\.measurement \}\}$/m);
  assert.match(header, /^ {6}gate_reported_only: \$\{\{ steps\.gate\.outputs\.gate_reported_only \}\}$/m);
  assert.match(header, /^ {6}gate_rc: \$\{\{ steps\.gate\.outputs\.gate_rc \}\}$/m);
});

test('evals job ALSO exports coverage_unknown from the gate step (#4865 round 3)', () => {
  // Breaks if `coverage_unknown` is dropped from the job outputs, or still
  // read from a step other than `gate` -- the label step would then read ''
  // and never qualify the PASS heading when judgeCoverage is unrecorded.
  const job = EVALS_JOB();
  const header = job.slice(0, at(job, '\n    steps:\n'));
  assert.match(header, /^ {6}coverage_unknown: \$\{\{ steps\.gate\.outputs\.coverage_unknown \}\}$/m);
});

test('the gate step (id: gate) writes gate_reported_only and gate_rc, so the outputs above are not empty', () => {
  // Breaks if the gate step stops appending either key to $GITHUB_OUTPUT:
  // the job output would silently be '' and the REPORTED label unreachable.
  const gate = stepWithId(EVALS_JOB(), 'gate').body;
  assert.match(gate, /gate_reported_only=/);
  assert.match(gate, /gate_rc=/);
  assert.match(gate, /GITHUB_OUTPUT/);
});

test('the gate step runs eval-measurement --annotate on eval-run.json, after the answered-count MEASURED line', () => {
  // Breaks if the --annotate call is deleted (no ::warning::, and the
  // `measurement` output above is never written), moved to another step
  // (steps.gate.outputs.measurement would be ''), or placed before
  // `MEASURED=$(jq` where eval-run.json's surfaces have not been counted yet.
  const gate = stepWithId(EVALS_JOB(), 'gate').body;
  const call = 'node scripts/ci/eval-measurement.mjs --artifact eval-run.json --annotate';
  const iMeasured = at(gate, 'MEASURED=$(jq');
  const iCall = at(gate, call);
  assert.ok(iCall > iMeasured, '--annotate runs after the answered-count line');
  // No result discarding on the call: a read failure (exit 2) must fail the step.
  const line = gate.slice(iCall, gate.indexOf('\n', iCall));
  assert.doesNotMatch(line, /\|\||2>\/dev\/null/, 'exit 2 is not swallowed');
  assert.equal(line.trim(), call, 'the call line is exactly the call (positive pair)');
});

test('the fold step prepends the measurement banner BEFORE concatenating the summary', () => {
  // Breaks if --prepend-to is removed (the sticky PR comment loses the
  // NOT MEASURED banner) or moved after `if ! cat …` (the banner would land in
  // eval-summary.md after the comment body was already assembled).
  const fold = stepNamed(EVALS_JOB(), 'Fold the provenance banner').body;
  const iPrepend = at(fold, 'node scripts/ci/eval-measurement.mjs --artifact eval-run.json --prepend-to eval-summary.md');
  const iCat = at(fold, 'if ! cat corpus-provenance.md eval-summary.md');
  assert.ok(iPrepend < iCat, 'prepend happens before the concatenation');
});

test('report-outcome labels the summary through eval-measurement --label, with the evals job outputs', () => {
  // Breaks if the unconditional `echo "### Copilot quality evals — PASS"` is
  // restored, or if --measurement is fed something other than the evals job
  // output (e.g. a literal 'judged').
  const say = stepNamed(REPORT_JOB(), 'Say so in the job summary').body;
  assert.match(say, /MEASUREMENT: \$\{\{ needs\.evals\.outputs\.measurement \}\}/);
  assert.match(say, /REPORTED_ONLY: \$\{\{ needs\.evals\.outputs\.gate_reported_only \}\}/);
  assert.match(say, /GATE_RC: \$\{\{ needs\.evals\.outputs\.gate_rc \}\}/);
  assert.match(say, /node scripts\/ci\/eval-measurement\.mjs --label \\/);
  assert.match(say, /--measurement "\$MEASUREMENT"/);
  assert.match(say, /--reported-only "\$REPORTED_ONLY"/);
  // The defect this replaces, paired with the positive matches above.
  assert.doesNotMatch(say, /echo .*— PASS/);
});

test('the label step ALSO feeds coverage_unknown to --label (#4865 round 3)', () => {
  // Breaks if COVERAGE_UNKNOWN is read from a literal or a different output,
  // or if --coverage-unknown is dropped from the call: a PASS over a run
  // whose judgeCoverage was never recorded (#4875) would then read as plain
  // "PASS" again, the should-fix this test pins.
  const say = stepNamed(REPORT_JOB(), 'Say so in the job summary').body;
  assert.match(say, /COVERAGE_UNKNOWN: \$\{\{ needs\.evals\.outputs\.coverage_unknown \}\}/);
  assert.match(say, /--coverage-unknown "\$COVERAGE_UNKNOWN"/);
});

test('report-outcome checks the repo out BEFORE it runs a repo script', () => {
  // Breaks if the checkout step is dropped from report-outcome: the --label
  // call would fail with "Cannot find module" on every run.
  const all = steps(REPORT_JOB());
  const iCheckout = all.findIndex((s) => s.name.startsWith('uses: actions/checkout@'));
  const iSay = all.findIndex((s) => s.name.startsWith('Say so in the job summary'));
  assert.ok(iCheckout >= 0, 'checkout step present');
  assert.ok(iSay >= 0, 'label step present');
  assert.ok(iCheckout < iSay);
});

// ── the neutral "Copilot quality: not measured" check-run ──────────────────

const PUBLISH = () => stepNamed(REPORT_JOB(), 'Publish the neutral not-measured check-run').body;

test('evals exports measurement_text FROM the gate step, for the check-run summary', () => {
  // Breaks if the output is deleted or reads another step: the check-run would
  // then carry the fallback sentence instead of the measurement line.
  const job = EVALS_JOB();
  const header = job.slice(0, at(job, '\n    steps:\n'));
  assert.match(header, /^ {6}measurement_text: \$\{\{ steps\.gate\.outputs\.measurement_text \}\}$/m);
});

test('checks: write is granted to report-outcome ONLY, not to the workflow or the evals job', () => {
  // Breaks if `checks: write` is dropped from report-outcome (the POST would
  // be refused and the step would fail), or widened to the workflow-level
  // block or the evals job.
  const report = REPORT_JOB();
  const perms = report.slice(at(report, '\n    permissions:\n'), at(report, '\n    steps:\n'));
  assert.match(perms, /^ {6}checks: write$/m);
  const topLevel = SRC.slice(at(SRC, '\npermissions:\n'), at(SRC, '\njobs:\n'));
  assert.match(topLevel, /^ {2}contents: read$/m, 'the workflow-level block was found (positive control)');
  assert.doesNotMatch(topLevel, /checks:/);
  const evals = EVALS_JOB();
  assert.doesNotMatch(evals.slice(0, at(evals, '\n    steps:\n')), /checks:/);
  assert.equal([...SRC.matchAll(/^ *checks: write$/gm)].length, 1, 'exactly one `checks: write` key line in the file');
});

test('the publish step runs only on same-repo PRs, for EXACTLY the module\'s not-judged states', () => {
  // Breaks if the state list in `if:` drifts from NOT_MEASURED_STATES (e.g.
  // `judged` added, or `partial` dropped), or if the pull_request / same-repo
  // conditions are removed (a fork token cannot create a check-run). The
  // WHOLE `if:` expression is then compared, whitespace-normalised, instead
  // of matching three independent substrings: arm W1 (the first `&&` changed
  // to `||`) still matches each substring check individually, but changes
  // what the step actually runs on -- `a || (b && c)` would publish on every
  // pull_request, including fork PRs. Only comparing the full boolean kills it.
  const body = PUBLISH();
  const m = /contains\(fromJSON\('(\[[^\]]*\])'\), needs\.evals\.outputs\.measurement\)/.exec(body);
  assert.ok(m, 'the contains(fromJSON(...), needs.evals.outputs.measurement) condition is present');
  assert.deepEqual(JSON.parse(m[1]), [...NOT_MEASURED_STATES]);

  const ifStart = at(body, 'if: >-');
  const ifEnd = at(body, '\n        env:');
  assert.ok(ifEnd > ifStart, 'the if: block ends before env:');
  const normalized = body.slice(ifStart, ifEnd).replace(/\s+/g, ' ').trim();
  assert.equal(
    normalized,
    `if: >- \${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && contains(fromJSON('["deterministic-only","partial","none"]'), needs.evals.outputs.measurement) }}`,
  );
});

test('the publish step builds the body with --check-run from the evals outputs and POSTs it, nothing discarded', () => {
  // Breaks if --text / --measurement read a different source, if the head sha
  // is not the PR head, if the POST targets another endpoint, or if a failure
  // is swallowed (`|| true`, `2>/dev/null`, continue-on-error).
  const body = PUBLISH();
  assert.match(body, /^ {10}MEASUREMENT: \$\{\{ needs\.evals\.outputs\.measurement \}\}$/m);
  assert.match(body, /^ {10}MEASUREMENT_TEXT: \$\{\{ needs\.evals\.outputs\.measurement_text \}\}$/m);
  assert.match(body, /^ {10}HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}$/m);
  const iBuild = at(body, 'node scripts/ci/eval-measurement.mjs --check-run');
  const iPost = at(body, 'gh api --method POST "repos/$REPO/check-runs" --input not-measured-check-run.json');
  assert.ok(iBuild < iPost, 'the body is built before it is POSTed');
  assert.match(body, /--measurement "\$MEASUREMENT"/);
  assert.match(body, /--text "\$MEASUREMENT_TEXT"/);
  assert.match(body, /--head-sha "\$HEAD_SHA" > not-measured-check-run\.json/);
  assert.match(body, /set -euo pipefail/);
  assert.doesNotMatch(body, /\|\| *true|2>\/dev\/null|continue-on-error/);
});

test('the provenance step names an HTML 403 EDGE-BLOCKED, and checks it BEFORE the generic non-2xx branch', () => {
  // Breaks if the 403 branch is deleted, or reordered after
  // `elif [ "$HTTP" -lt 200 ] || [ "$HTTP" -ge 300 ]` — the generic branch
  // matches 403 first and the edge block is reported as an unexplained
  // TRANSPORT failure again.
  const prov = stepWithId(EVALS_JOB(), 'prov').body;
  const i403 = at(prov, 'elif [ "$HTTP" = "403" ] && [ "${PROV_LEAD:0:1}" = "<" ]; then');
  const iGeneric = at(prov, 'elif [ "$HTTP" -lt 200 ] || [ "$HTTP" -ge 300 ]; then');
  const iEdge = at(prov, 'PROV_WHY="EDGE-BLOCKED:');
  assert.ok(i403 < iEdge && iEdge < iGeneric, '403 test → EDGE-BLOCKED message → generic branch');
  // The leading-whitespace strip the `<` test depends on must exist and come first.
  assert.ok(at(prov, 'PROV_LEAD="${PROV_HEAD#') < i403);
});

/**
 * Behaviour, not string order: lift the provenance step's classification chain
 * (from the HTTP normalisation `case` to the chain's closing `fi`) out of the
 * workflow AT RUNTIME and run it under bash against fixture bodies. None of the
 * fixtures is 2xx, so the chain never reaches the jq branch.
 */
function runProvChain(http, body) {
  const prov = stepWithId(EVALS_JOB(), 'prov').body;
  const start = at(prov, '          case "$HTTP" in');
  const end = prov.indexOf('\n          fi\n', start);
  assert.ok(end > start, 'closing fi of the classification chain not found');
  const chain = prov.slice(start, end + '\n          fi\n'.length);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-chain-'));
  try {
    const bodyFile = path.join(dir, 'body');
    const errFile = path.join(dir, 'err');
    fs.writeFileSync(bodyFile, body);
    fs.writeFileSync(errFile, 'curl: (7) fixture transport error\n');
    const script = [
      'set -u',
      'PROV_BODY="$1"; PROV_ERR="$2"; HTTP="$3"; SERVED=""; PROV_WHY=""',
      chain,
      'printf "%s" "$PROV_WHY"',
      '',
    ].join('\n');
    const scriptFile = path.join(dir, 'chain.sh');
    fs.writeFileSync(scriptFile, script);
    const r = spawnSync('bash', [scriptFile, bodyFile, errFile, http], { encoding: 'utf8' });
    assert.equal(r.error, undefined, `bash could not be spawned: ${r.error?.message}`);
    assert.equal(r.status, 0, `chain exited ${r.status}; stderr: ${r.stderr}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const EDGE_HTML = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>The request is blocked.</body></html>';

test('behaviour: an HTML 403 (the measured block in front of the route) is EDGE-BLOCKED', () => {
  // Breaks if the 403 branch is deleted, or moved after the generic non-2xx
  // branch (which then claims it as TRANSPORT) — the reorder arm.
  const why = runProvChain('403', EDGE_HTML);
  assert.match(why, /^EDGE-BLOCKED: the eval-probe answered HTTP 403 with an HTML page: an HTML 403 returned in front of the route \(not the app's JSON 401\/403\)\./);
  // Breaks if the message claims which layer returned the page — the step
  // never established that (deploy-integrity R7).
  assert.match(why, /this step did not establish which layer returned it/);
  // Breaks if the page body is echoed again (`First 200 bytes: <<…>>`
  // appended): the message must END at the receipt sentence.
  assert.match(why, /report its corpus commit in the run receipt\.$/);
});

test('behaviour: an HTML 403 led by whitespace is still EDGE-BLOCKED', () => {
  // Breaks if the `<` test reads PROV_HEAD instead of PROV_LEAD (the leading
  // newline-turned-space would then be the first character).
  assert.match(runProvChain('403', '\n  ' + EDGE_HTML), /^EDGE-BLOCKED:/);
});

test('behaviour: a JSON 403 is NOT called an edge block — it stays TRANSPORT with its status', () => {
  // Breaks if the `<` half of the condition is dropped (every 403 → EDGE-BLOCKED,
  // a claim about what answered that the code did not establish — deploy-integrity R7).
  const why = runProvChain('403', '{"ok":false,"error":"forbidden"}');
  assert.match(why, /^TRANSPORT: the eval-probe answered HTTP 403, so no manifest was served/);
  assert.doesNotMatch(why, /EDGE-BLOCKED/);
});

test('behaviour: the route\'s own 401 JSON refusal stays TRANSPORT HTTP 401', () => {
  // Breaks if the edge branch is widened to any 4xx with a body, or to 401.
  assert.match(runProvChain('401', '{"ok":false,"error":"bad_internal_token"}'), /^TRANSPORT: the eval-probe answered HTTP 401/);
});

test('behaviour: an empty status (curl died) is normalised to 000 and reported as unreachable', () => {
  // Breaks if the `case` normalisation is removed: `[ "" -lt 200 ]` errors and
  // the chain no longer reports curl 000. Positive control that the lifted
  // chain starts where this file says it does.
  assert.match(runProvChain('', ''), /^TRANSPORT: the eval-probe could not be reached at all \(curl 000\)\. curl said: curl: \(7\) fixture transport error/);
});
