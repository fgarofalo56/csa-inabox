/**
 * Gov topology-guard reachability + brownfield self-test (FINISHLINE L-GOV).
 *
 * WHY THIS EXISTS. The `topology_guard` step in deploy-fiab-gcch.yml /
 * deploy-fiab-il5.yml decides whether a Gov deploy may proceed. It has now been
 * wrong in three different ways, each of which a test like this would have
 * caught immediately:
 *
 *   1. `2>/dev/null || echo "0"` turned an unreadable subscription into
 *      "no hub exists", so a FIRST-RUN tenant stamp could proceed against a sub
 *      that already held one.
 *   2. The first fix wrote `if ! EXISTING=$(az … | tr -d '\r'); then` — which
 *      CANNOT FIRE, because a pipeline's exit status is the LAST command's, so
 *      `tr` (always 0) masked az's failure and the informative error was dead
 *      code. Fail-closed still held via the numeric `case`, but the diagnostic
 *      was unreachable: the assertion-that-cannot-fail class again.
 *   3. `az account show` failing aborted the whole step under `set -e` with no
 *      message at all.
 *
 * A guard that decides whether to deploy must be tested like one. This extracts
 * the REAL run body from each workflow (never a copy that can drift), renders
 * the `${{ }}` expressions and step `env:` block the way the runner does,
 * substitutes an `az` stand-in, and pins BOTH verdicts — every refusal branch
 * fires, and every success control still passes, so an over-broad guard that
 * simply refuses everything cannot hide either.
 *
 * Run: node --test scripts/ci/__tests__/gov-topology-guard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const LANES = [
  { file: '.github/workflows/deploy-fiab-gcch.yml', scheduled: true },
  { file: '.github/workflows/deploy-fiab-il5.yml', scheduled: false },
];

/**
 * Pull the `topology_guard` step's `run:` body and `env:` map out of a workflow
 * without a YAML dependency (the repo root has none): find the step by its
 * `id:`, then take the indented block-scalar that follows `run: |`.
 *
 * Line endings are normalised to LF FIRST. The workflow files are checked out
 * with CRLF on Windows, which (a) made an earlier `\n\s+env:\n` regex silently
 * fail to match, and (b) would have written `\r` into the generated .sh and
 * made bash fail on every line. A parser that silently finds nothing is the
 * same defect class this suite exists to catch, so the callers below assert the
 * extraction actually produced something.
 */
function extractGuard(rawYaml) {
  const yamlText = rawYaml.replace(/\r\n/g, '\n');
  const idIdx = yamlText.indexOf('id: topology_guard');
  assert.ok(idIdx > -1, 'topology_guard step not found');
  const after = yamlText.slice(idIdx);

  // env: block (optional) — `KEY: ${{ expr }}` lines before `run:`.
  const env = {};
  const envMatch = /\n(\s+)env:\n([\s\S]*?)\n\s+run:/.exec(after);
  if (envMatch) {
    for (const line of envMatch[2].split('\n')) {
      const m = /^\s+([A-Z_][A-Z0-9_]*):\s*(.+?)\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }

  const runIdx = after.indexOf('run: |');
  assert.ok(runIdx > -1, 'topology_guard has no `run: |` block');
  const lines = after.slice(runIdx).split('\n').slice(1);
  const indent = /^(\s*)/.exec(lines[0])[1].length;
  assert.ok(indent > 0, 'could not determine the run-block indent');
  const body = [];
  for (const line of lines) {
    if (line.trim() === '') { body.push(''); continue; }
    const lead = /^(\s*)/.exec(line)[1].length;
    if (lead < indent) break;
    body.push(line.slice(indent));
  }
  const text = body.join('\n');
  // Fail closed: an extractor that returns an empty or trivial body would make
  // every scenario below pass or fail for the wrong reason.
  assert.ok(text.includes('rg-csa-loom-admin-'), 'extracted guard body does not look like the topology guard');
  return { body: text, env };
}

// `az account show` succeeds; the caller decides what `az graph query` does.
const AZ_ACCOUNT_OK = 'if [ "$1" = "account" ]; then echo sub-id; return 0; fi;';

const SCENARIOS = [
  {
    name: 'REFUSES when the graph query fails (the previously UNREACHABLE branch)',
    az: `az() { ${AZ_ACCOUNT_OK} echo "ERROR: AuthorizationFailed" >&2; return 1; }`,
    env: {}, wantExit: 1, wantText: 'Could NOT read',
  },
  {
    name: 'REFUSES with a message when az account show fails (was a silent set -e abort)',
    az: 'az() { echo "ERROR: Please run az login" >&2; return 1; }',
    env: {}, wantExit: 1, wantText: 'Could not resolve the active subscription',
  },
  {
    name: 'REFUSES a zero-exit non-numeric result',
    az: `az() { ${AZ_ACCOUNT_OK} echo "<html>error</html>"; return 0; }`,
    env: {}, wantExit: 1, wantText: 'non-numeric',
  },
  {
    name: 'REFUSES a first-run stamp when a hub already exists',
    az: `az() { ${AZ_ACCOUNT_OK} printf "1\\r\\n"; return 0; }`,
    env: {}, wantExit: 1, wantText: 'already exists',
  },
  {
    name: 'CONTROL: proceeds when no hub exists',
    az: `az() { ${AZ_ACCOUNT_OK} printf "0\\r\\n"; return 0; }`,
    env: {}, wantExit: 0, wantText: null,
  },
  {
    name: 'BROWNFIELD: proceeds against an existing hub with allow_existing_hub=true',
    az: `az() { ${AZ_ACCOUNT_OK} printf "1\\r\\n"; return 0; }`,
    env: { INPUT_ALLOW_EXISTING_HUB: 'true' }, wantExit: 0, wantText: 'allow_existing_hub=true',
  },
  {
    name: 'BROWNFIELD: scheduled reconcile proceeds against an existing hub',
    az: `az() { ${AZ_ACCOUNT_OK} printf "1\\r\\n"; return 0; }`,
    env: { TRIGGER: 'schedule' }, wantExit: 0, wantText: 'Scheduled reconcile',
    scheduledOnly: true,
  },
];

for (const lane of LANES) {
  const yamlText = readFileSync(join(REPO, lane.file), 'utf8');
  const { body, env: stepEnv } = extractGuard(yamlText);

  // The schedule branch exists only where the step exports TRIGGER. Detecting
  // the WORD "schedule" in the body would be wrong — il5 mentions it only in a
  // comment saying it has no such branch.
  const hasSchedule = Object.prototype.hasOwnProperty.call(stepEnv, 'TRIGGER');
  assert.equal(hasSchedule, lane.scheduled, `${lane.file}: schedule-branch presence changed`);

  // Render the runner's ${{ }} substitutions for the step env defaults.
  const defaults = { CSA_LOOM_TOPOLOGY: '', CSA_LOOM_TARGET_SUBSCRIPTION: '' };
  for (const [k, v] of Object.entries(stepEnv)) {
    if (v.includes('inputs.allow_existing_hub')) defaults[k] = 'false';
    else if (v.includes('github.event_name')) defaults[k] = 'workflow_dispatch';
    else defaults[k] = v.replace(/\$\{\{.*?\}\}/g, '');
  }

  for (const sc of SCENARIOS) {
    if (sc.scheduledOnly && !hasSchedule) continue;
    test(`${lane.file} — ${sc.name}`, () => {
      const vars = { ...defaults, ...sc.env };
      const exports = Object.entries(vars).map(([k, v]) => `export ${k}='${v}'`).join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'govguard-'));
      const script = join(dir, 'guard.sh');
      try {
        writeFileSync(script, `${exports}\n${sc.az}\n${body}\n`, 'utf8');
        const r = spawnSync('bash', [script], { encoding: 'utf8' });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        assert.equal(
          r.status,
          sc.wantExit,
          `expected exit ${sc.wantExit}, got ${r.status}. Output:\n${out}`,
        );
        if (sc.wantText) {
          assert.ok(out.includes(sc.wantText), `expected output to contain ${JSON.stringify(sc.wantText)}. Output:\n${out}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
