// Behaviour tests for the curl-classification step of the three workflows that
// call the console's internal-token routes from a GitHub-hosted runner (#4869):
//
//   csa-loom-memory-consolidate.yml  job consolidate  step 'Trigger consolidation'
//   csa-loom-skill-learner.yml       job learn        step 'Run learner'
//   csa-loom-spark-keepwarm.yml      job keepwarm     step 'Ping keep-warm'
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
// The console's internal routes answer JSON. A 403 whose body is an HTML page
// was produced before the request reached the console. Before this change,
// the two scheduled workflows sent every 403 to the catch-all arm: they printed
// `::warning::` and exited 0, so a run that did no work showed as green. The
// change makes an HTML 403 an `::error::` with exit 1 that names #4869. It
// keeps the console's own JSON 403 on its existing path, and it keeps 000 as
// the transient warning.
//
// ── WHAT IS UNDER TEST ──────────────────────────────────────────────────────
// Each step's `run:` block is taken from the parsed workflow when the test runs
// (_workflow-yaml.mjs). It is never copied into this file. The block is run
// under `bash -e`, as the runner's default shell runs it, with a stub `curl`
// placed first on PATH.
//
// One rewrite is applied, and it is disclosed here: the blocks write the
// response to a fixed `/tmp/<name>.json`. Each scenario points that path at its
// own scratch directory. Otherwise a body left over from an earlier scenario,
// or from a parallel run, could be read as the current body. That would matter
// most in the 000 arm, where the stub writes no file. lift() asserts the path
// is present, and scenario() asserts that no `/tmp/` path survives the
// rewrite. So if the path is renamed, the suite fails; a scenario never
// silently reads a shared file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, scalarValue } from '../_workflow-yaml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..', '..');

const ISSUE = '#4869';
// The operator-specified wording, asserted verbatim. Breaks on any rewording,
// a different issue number, or the message being dropped.
const REFUSED_MSG =
  'the request was refused before it reached the Console (HTML 403). ' +
  `This job must reach the Console from inside the network; see ${ISSUE}.`;

const WORKFLOWS = [
  {
    key: 'memory-consolidate',
    file: 'csa-loom-memory-consolidate.yml',
    job: 'consolidate',
    step: 'Trigger consolidation',
    tmp: '/tmp/mc.json',
    prefix: 'consolidate',
    okLine: 'consolidation pass complete',
    okBody: '{"ok":true}',
    // Pre-existing behaviour this change must NOT alter.
    jsonForbiddenFails: false,
    unreachableFails: false,
  },
  {
    key: 'skill-learner',
    file: 'csa-loom-skill-learner.yml',
    job: 'learn',
    step: 'Run learner',
    tmp: '/tmp/learn.json',
    prefix: 'learn',
    okLine: 'learner run complete',
    okBody: '{"ok":true}',
    jsonForbiddenFails: false,
    unreachableFails: false,
  },
  {
    key: 'spark-keepwarm',
    file: 'csa-loom-spark-keepwarm.yml',
    job: 'keepwarm',
    step: 'Ping keep-warm',
    tmp: '/tmp/kw.json',
    prefix: 'keep-warm',
    okLine: 'warm pool topped up',
    okBody: '{"ok":true,"keptWarm":true}',
    // keep-warm already failed every non-2xx before this change.
    jsonForbiddenFails: true,
    unreachableFails: true,
  },
];

const bashOk = spawnSync('bash', ['-c', 'exit 0']).status === 0;
// A missing bash skips locally. In CI it fails, because a suite that skips in
// CI watches nothing.
const SKIP = !bashOk && !process.env.CI;

test('prerequisite: bash is on PATH (fails in CI when missing)', { skip: SKIP }, () => {
  assert.ok(bashOk, 'bash is not runnable, so no scenario below ran');
});

// ── Lifting ─────────────────────────────────────────────────────────────────
const lifted = new Map();
function lift(wf) {
  if (lifted.has(wf.key)) return lifted.get(wf.key);
  const doc = parseWorkflow(readFileSync(path.join(REPO, '.github', 'workflows', wf.file), 'utf8'));
  const steps = doc?.jobs?.[wf.job]?.steps;
  assert.ok(Array.isArray(steps) && steps.length > 0, `${wf.file}: job '${wf.job}' has no steps`);
  const step = steps.find((s) => scalarValue(s?.name) === wf.step);
  assert.ok(step, `${wf.file}: no step named '${wf.step}' in job '${wf.job}' (renamed or removed?)`);
  const run = String(scalarValue(step.run) ?? '');
  // Shape checks throw, so an empty or wrong extraction cannot pass by
  // reaching no arm at all.
  assert.match(run, /curl /, `${wf.file}: lifted block has no curl call`);
  assert.match(run, /case "\$code" in/, `${wf.file}: lifted block has no status classification`);
  assert.ok(run.includes(wf.tmp), `${wf.file}: lifted block never uses ${wf.tmp}; the sandbox rewrite would do nothing`);
  const result = { run };
  lifted.set(wf.key, result);
  return result;
}

// ── Stub curl ───────────────────────────────────────────────────────────────
// Writes S_BODY to the -o file and prints S_CODE, as `-w '%{http_code}'` does.
// When S_RC is non-zero it prints S_CODE (curl prints `000` on a connect
// failure, or the received status when a transfer times out after the status
// line), writes S_BODY only if S_PARTIAL=1, and exits S_RC.
const STUB_CURL = `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo call >> "$STUB_STATE/curl"
rc="\${S_RC:-0}"
if [ "$rc" = 0 ] || [ "\${S_PARTIAL:-0}" = 1 ]; then
  [ -n "$out" ] && printf '%s' "$S_BODY" > "$out"
fi
printf '%s' "$S_CODE"
exit "$rc"
`;

const posix = (p) => p.replace(/\\/g, '/');

function scenario(wf, env, blocks = lift(wf)) {
  const dir = mkdtempSync(path.join(tmpdir(), 'intcall4869-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  const scratch = path.join(dir, 'scratch');
  mkdirSync(bin); mkdirSync(state); mkdirSync(scratch);
  writeFileSync(path.join(bin, 'curl'), STUB_CURL, 'utf8');
  chmodSync(path.join(bin, 'curl'), 0o755);
  const respPath = `${posix(scratch)}/${path.posix.basename(wf.tmp)}`;
  const script = blocks.run.split(wf.tmp).join(respPath);
  assert.ok(!script.includes('/tmp/'), `${wf.file}: a /tmp/ path survived the sandbox rewrite`);
  const stepFile = path.join(dir, 'step.sh');
  writeFileSync(stepFile, script, 'utf8');
  // `bash -e`: the runner's default shell for a run step is `bash -e {0}`.
  const r = spawnSync('bash', ['-e', posix(stepFile)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      STUB_STATE: posix(state),
      CONSOLE_URL: 'https://console.invalid',
      INTERNAL_TOKEN: 'tok-STUB-4869-must-never-print',
      TENANT_ID: '',
      ...env,
    },
  });
  const log = `${r.stdout}${r.stderr}`;
  const curlFile = path.join(state, 'curl');
  const out = {
    rc: r.status,
    log,
    errors: log.split(/\r?\n/).filter((l) => l.includes('::error::')),
    warnings: log.split(/\r?\n/).filter((l) => l.includes('::warning::')),
    curlCalls: existsSync(curlFile) ? readFileSync(curlFile, 'utf8').split('\n').filter(Boolean).length : 0,
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

// An HTML error page, and a lower-case variant with leading whitespace. The
// console sends neither from its internal routes.
const HTML_403 = '<!DOCTYPE html>\n<html><head><title>403 Forbidden</title></head><body>Forbidden</body></html>';
const HTML_403_LOOSE = '\n   <html><body>Forbidden</body></html>';
const JSON_403 = '{"ok":false,"error":"forbidden"}';
// JSON whose string value contains an HTML tag. It is still the console's JSON.
// It breaks a classifier that does a substring match for `<html` instead of
// checking the start of the body.
const JSON_403_WITH_TAG = '{"ok":false,"error":"forbidden","detail":"<html> not allowed"}';

for (const wf of WORKFLOWS) {
  const ctx = (name) => `${wf.file} / ${name}`;

  test(ctx('HTML 403 fails the run with the named cause and issue'), { skip: SKIP }, () => {
    const r = scenario(wf, { S_CODE: '403', S_BODY: HTML_403 });
    // Breaks if the HTML-403 branch is reverted to `::warning::` + exit 0
    // (rc would be 0), if it exits 1 with different text, or if it is deleted.
    // HTML_403 starts '<!DOCTYPE', in upper case, so this also breaks if the
    // `${lead,,}` lower-casing is dropped.
    assert.equal(r.rc, 1, `${ctx('html')}: an HTML 403 must exit 1, got ${r.rc}\n${r.log}`);
    assert.equal(r.errors.length, 1, `${ctx('html')}: exactly one ::error:: line expected, got ${r.errors.length}\n${r.log}`);
    assert.ok(r.errors[0].includes(`::error::${wf.prefix} 403 — ${REFUSED_MSG}`),
      `${ctx('html')}: error line lacks the operator wording: ${r.errors[0]}`);
    assert.equal(r.warnings.length, 0, `${ctx('html')}: an HTML 403 must not also warn\n${r.log}`);
    assert.equal(r.curlCalls, 1, `${ctx('html')}: the stub curl ran ${r.curlCalls} times`);
  });

  test(ctx('HTML 403 is detected after leading whitespace'), { skip: SKIP }, () => {
    const r = scenario(wf, { S_CODE: '403', S_BODY: HTML_403_LOOSE });
    // Breaks if the leading-whitespace strip is dropped (this body starts
    // '\n   <html'). It does NOT pin the `${lead,,}` lower-casing, because this
    // body is already lower case. The upper-case '<!DOCTYPE' in HTML_403, in
    // the test above, is what pins that.
    assert.equal(r.rc, 1, `${ctx('html-loose')}: got ${r.rc}\n${r.log}`);
    assert.ok(r.errors.some((l) => l.includes(REFUSED_MSG)), `${ctx('html-loose')}: cause not named\n${r.log}`);
  });

  test(ctx('JSON 403 from the console keeps its existing handling'), { skip: SKIP }, () => {
    for (const body of [JSON_403, JSON_403_WITH_TAG]) {
      const r = scenario(wf, { S_CODE: '403', S_BODY: body });
      // Breaks if the classifier calls every 403 a refusal before the console
      // (REFUSED_MSG would appear), or does a substring match for `<html`
      // (JSON_403_WITH_TAG would then match).
      assert.ok(!r.log.includes(REFUSED_MSG), `${ctx('json')}: JSON 403 misclassified as refused-before-console: ${body}\n${r.log}`);
      if (wf.jsonForbiddenFails) {
        assert.equal(r.rc, 1, `${ctx('json')}: keep-warm fails every non-2xx; got ${r.rc}`);
        assert.equal(r.errors.length, 1, `${ctx('json')}: ${r.log}`);
        assert.ok(r.errors[0].includes(`::error::${wf.prefix} returned 403 — see body above`), `${ctx('json')}: ${r.errors[0]}`);
      } else {
        assert.equal(r.rc, 0, `${ctx('json')}: the console's JSON 403 keeps its existing warning + exit 0; got ${r.rc}\n${r.log}`);
        assert.equal(r.warnings.length, 1, `${ctx('json')}: ${r.log}`);
        assert.ok(r.warnings[0].includes(`::warning::${wf.prefix} returned 403 — see body above`), `${ctx('json')}: ${r.warnings[0]}`);
        assert.equal(r.errors.length, 0, `${ctx('json')}: ${r.log}`);
      }
    }
  });

  test(ctx('000 (connect failure) keeps its existing handling'), { skip: SKIP }, () => {
    const r = scenario(wf, { S_CODE: '000', S_RC: '7', S_BODY: '' });
    // Breaks if `|| code=000` is removed: under `bash -e` the failed curl
    // would abort the step with rc 7 before any arm ran. Also breaks if 000
    // goes to the refusal branch.
    assert.ok(!r.log.includes(REFUSED_MSG), `${ctx('000')}: ${r.log}`);
    assert.match(r.log, /HTTP 000\b/, `${ctx('000')}: status line is not 000 (was it concatenated?)\n${r.log}`);
    if (wf.unreachableFails) {
      assert.equal(r.rc, 1, `${ctx('000')}: ${r.log}`);
      assert.ok(r.errors.some((l) => l.includes('did not complete')), `${ctx('000')}: ${r.log}`);
    } else {
      assert.equal(r.rc, 0, `${ctx('000')}: a connect failure stays the transient warning; got ${r.rc}\n${r.log}`);
      assert.equal(r.warnings.length, 1, `${ctx('000')}: ${r.log}`);
      assert.ok(r.warnings[0].includes('console unreachable'), `${ctx('000')}: ${r.warnings[0]}`);
    }
  });

  test(ctx('2xx succeeds'), { skip: SKIP }, () => {
    const r = scenario(wf, { S_CODE: '200', S_BODY: wf.okBody });
    // Breaks if the new 403 handling, or the body capture that feeds it,
    // breaks the success path. For example, a body read that fails under
    // `bash -e` would give rc != 0.
    assert.equal(r.rc, 0, `${ctx('200')}: got ${r.rc}\n${r.log}`);
    assert.ok(r.log.includes(wf.okLine), `${ctx('200')}: success line '${wf.okLine}' missing\n${r.log}`);
    assert.equal(r.errors.length, 0, `${ctx('200')}: ${r.log}`);
    assert.equal(r.warnings.length, 0, `${ctx('200')}: ${r.log}`);
  });

  test(ctx('401 still fails as a token mismatch'), { skip: SKIP }, () => {
    const r = scenario(wf, { S_CODE: '401', S_BODY: '{"ok":false,"error":"unauthorized"}' });
    // Breaks if the new 403 arm is placed so that it shadows 401.
    assert.equal(r.rc, 1, `${ctx('401')}: ${r.log}`);
    assert.ok(r.errors.some((l) => l.includes(`${wf.prefix} 401 — LOOM_INTERNAL_TOKEN mismatch`)), `${ctx('401')}: ${r.log}`);
  });
}

// The `|| true` this change removed reported a transfer that timed out after
// the status line as that status (curl -w printed 200 and exited 28), so a
// truncated run read as complete. `|| code=000` reports it as 000. keep-warm
// already assigned 000, so this pins all three workflows to the same rule.
for (const wf of WORKFLOWS) {
  test(`${wf.file} / a transfer that timed out after a 200 status is not reported as success`, { skip: SKIP }, () => {
    const r = scenario(wf, { S_CODE: '200', S_RC: '28', S_PARTIAL: '1', S_BODY: wf.okBody });
    // Breaks if `|| code=000` reverts to `|| true`. code would stay "200" and
    // the success line would print.
    assert.ok(!r.log.includes(wf.okLine), `${wf.file}: a timed-out transfer printed the success line\n${r.log}`);
    assert.match(r.log, /HTTP 000\b/, `${wf.file}: ${r.log}`);
  });
}

test('the token never reaches the step log', { skip: SKIP }, () => {
  for (const wf of WORKFLOWS) {
    const r = scenario(wf, { S_CODE: '403', S_BODY: HTML_403 });
    // Breaks if a change echoes the request, headers, or env into the log.
    assert.ok(!r.log.includes('tok-STUB-4869'), `${wf.file}: token printed\n${r.log}`);
    // Positive pair: the scenario did run and classify.
    assert.ok(r.log.includes(REFUSED_MSG), `${wf.file}: scenario did not reach the classifier\n${r.log}`);
  }
});
