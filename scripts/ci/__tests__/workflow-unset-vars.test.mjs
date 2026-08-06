/**
 * Unit tests for the workflow-shell guards.
 *
 * Run: node --test scripts/ci/__tests__/workflow-unset-vars.test.mjs
 * (also picked up by `node --test scripts/ci/__tests__/*.test.mjs` and by
 * check-node-test-suites.mjs.)
 *
 * FIXTURES ARE REAL SHAPES, NOT INVENTED ONES. The repo has been burned by
 * fixtures that modelled the code instead of reality (an `az` stub that emitted
 * a row shape real `az` never produces, so a deploy-breaking bug shipped past
 * its own guard). Every fixture below is copied from an actual workflow in
 * .github/workflows: the #3030 defect, the `{ … } >> "$GITHUB_ENV"` group
 * redirect from gov-provision-dataplane-images.yml, the `set -a; . ./vals.env`
 * hand-off from gov-discover.yml, and the `if [ -n "${X:-}" ]` guarded read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWorkflow } from '../check-workflow-unset-vars.mjs';
import { parseWorkflow, mapKeys, scalarValue } from '../_workflow-yaml.mjs';
import {
  unassignedReferences,
  isPosixShell,
  githubEnvWrites,
  defaultedNames,
  assignedNames,
} from '../_shell-vars.mjs';

const wf = (steps, extra = '') => `name: t
on: workflow_dispatch
${extra}jobs:
  j:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

// ── the defect this guard exists for ────────────────────────────────────────
test('#3030: a read of a never-assigned variable is reported, with its name', () => {
  const f = scanWorkflow(
    wf(`      - name: Resolve the registry
        run: |
          set -uo pipefail
          ACR=$(az acr list --query "[0].name" -o tsv)
          echo "acr_name=$ACR" >> "$GITHUB_OUTPUT"
          echo "admin_sub=$ADMIN_SUB" >> "$GITHUB_OUTPUT"`),
  ).findings;
  assert.deepEqual(
    f.map((x) => x.name),
    ['ADMIN_SUB'],
  );
});

test('#3030 fixed shape: assigning it clears the finding', () => {
  const f = scanWorkflow(
    wf(`      - run: |
          set -uo pipefail
          ADMIN_SUB=$(az account show --query id -o tsv)
          echo "admin_sub=$ADMIN_SUB" >> "$GITHUB_OUTPUT"`),
  ).findings;
  assert.equal(f.length, 0);
});

test('the reported line is the real file line, not an offset into the script', () => {
  const { findings } = scanWorkflow(
    wf(`      - run: |
          set -u
          echo "$MISSING_ONE"`),
  );
  const text = wf(`      - run: |
          set -u
          echo "$MISSING_ONE"`).split('\n');
  assert.equal(text[findings[0].line - 1].includes('MISSING_ONE'), true);
});

// ── the three env scopes + $GITHUB_ENV ──────────────────────────────────────
test('workflow-, job- and step-level env: all define a name', () => {
  const src = `name: t
on: workflow_dispatch
env:
  WF_LEVEL: a
jobs:
  j:
    runs-on: ubuntu-latest
    env:
      JOB_LEVEL: b
    steps:
      - env:
          STEP_LEVEL: c
        run: echo "$WF_LEVEL $JOB_LEVEL $STEP_LEVEL"
`;
  assert.equal(scanWorkflow(src).findings.length, 0);
});

test('a name written to $GITHUB_ENV by an earlier step is defined in a later one', () => {
  const f = scanWorkflow(
    wf(`      - run: echo "LATER=1" >> "$GITHUB_ENV"
      - run: echo "later=$LATER"`),
  ).findings;
  assert.equal(f.length, 0);
});

test('the `{ … } >> "$GITHUB_ENV"` GROUP redirect is understood (gov-provision-dataplane-images shape)', () => {
  // Nine variables are published this way in that workflow; a per-line scan
  // reports every consumer of them as an unassigned read.
  const f = scanWorkflow(
    wf(`      - run: |
          RG=rg-x
          ACR=acrx
          TAG=v0.1
          {
            echo "RG=$RG"; echo "ACR=$ACR"; echo "TAG=$TAG"
          } >> "$GITHUB_ENV"
      - run: |
          az acr build --registry "$ACR" -g "$RG" --image "app:$TAG" .`),
  ).findings;
  assert.deepEqual(f.map((x) => x.name), []);
});

test('githubEnvWrites collects both the one-line and the group form', () => {
  assert.equal(githubEnvWrites('echo "A=1" >> "$GITHUB_ENV"').has('A'), true);
  assert.equal(
    githubEnvWrites('{\n  echo "B=2"\n} >> "$GITHUB_ENV"').has('B'),
    true,
  );
});

test('#3040: a group whose CLOSER is inline with the last echo (gov-provision-trino.yml, verbatim)', () => {
  // P0 regression. The first implementation decided "is this a group?" from
  // whether the line STARTED with `}`. gov-provision-trino.yml closes on the
  // same line as its last echo, so the group went unparsed, only that final
  // line was collected — CONSOLE_IMAGE resolved, the six names on the earlier
  // lines were reported as never assigned — and a DEPLOY-CRITICAL file went
  // red on correct code. Block copied verbatim from lines 188-196.
  const r = scanWorkflow(
    wf(`      - name: Discover CAE + UAMI + lake account
        run: |
          if [ -n "\${LAKE:-}" ]; then
            LAKE_RG=$(az storage account show -n "$LAKE" --query resourceGroup -o tsv 2>/dev/null | tr -d '\\r' || echo "")
            [ -n "$LAKE_RG" ] || echo "::warning::lake account '$LAKE' not resolvable by name."
          fi
          { echo "CAE_ID=$CAE_ID"; echo "UAMI_ID=$UAMI_ID"; echo "UAMI_CLIENT=$UAMI_CLIENT";
            echo "UAMI_PRINCIPAL=$UAMI_PRINCIPAL"; echo "LOCATION=$LOCATION"; echo "LAKE=$LAKE";
            echo "LAKE_RG=$LAKE_RG"; echo "MSAL_CLIENT_ID=\${MSAL_CLIENT_ID:-}";
            echo "CONSOLE_IMAGE=$CONSOLE_IMAGE"; } >> "$GITHUB_ENV"
      - name: Deploy
        run: |
          az containerapp create --environment "$CAE_ID" --user-assigned "$UAMI_ID" \\
            --client-id "$UAMI_CLIENT" --location "$LOCATION" --lake "$LAKE" \\
            --principal "$UAMI_PRINCIPAL" --image "$CONSOLE_IMAGE"`),
  );
  assert.deepEqual(r.findings.map((f) => f.name), []);
  // and the names really were resolved via $GITHUB_ENV, not by some other route
  for (const n of ['CAE_ID', 'UAMI_ID', 'UAMI_CLIENT', 'UAMI_PRINCIPAL', 'LOCATION', 'LAKE']) {
    assert.equal(
      githubEnvWrites(
        '{ echo "CAE_ID=$CAE_ID"; echo "UAMI_ID=$UAMI_ID"; echo "UAMI_CLIENT=$UAMI_CLIENT";\n' +
          '  echo "UAMI_PRINCIPAL=$UAMI_PRINCIPAL"; echo "LOCATION=$LOCATION"; echo "LAKE=$LAKE";\n' +
          '  echo "CONSOLE_IMAGE=$CONSOLE_IMAGE"; } >> "$GITHUB_ENV"',
      ).has(n),
      true,
      `${n} must be recognised as published to $GITHUB_ENV`,
    );
  }
});

test('#3040: group detection survives both wrappings and a tee redirect', () => {
  const inline = '{ echo "A=1"; echo "B=2"; } >> "$GITHUB_ENV"';
  const wrapped = '{\n  echo "A=1"\n  echo "B=2"\n} >> "$GITHUB_ENV"';
  const teed = '{\n  echo "A=1"\n  echo "B=2"\n} | tee -a "$GITHUB_ENV"';
  for (const [label, src] of [['inline', inline], ['wrapped', wrapped], ['tee', teed]]) {
    const got = githubEnvWrites(src);
    assert.equal(got.has('A'), true, `${label}: A`);
    assert.equal(got.has('B'), true, `${label}: B`);
  }
});

// ── expansions that are SAFE under set -u ───────────────────────────────────
test('${V:-d} and friends are not violations', () => {
  const f = scanWorkflow(
    wf(`      - run: |
          set -u
          echo "\${A:-x} \${B-x} \${C:=x} \${D:+x} \${E:?msg}"`),
  ).findings;
  assert.equal(f.length, 0);
});

test('a name defaulted ANYWHERE exempts its bare reads (gov-discover guarded-read shape)', () => {
  // if [ -n "${X:-}" ]; then … $X … fi  — the bare read cannot be reached
  // when the name is unset, and flagging it buries the real defect in noise.
  const f = scanWorkflow(
    wf(`      - run: |
          set -u
          if [ -n "\${ADLS_ACCOUNT:-}" ]; then
            echo "using '$ADLS_ACCOUNT'"
          fi`),
  ).findings;
  assert.equal(f.length, 0);
  assert.equal(defaultedNames('echo "${X:-}"').has('X'), true);
});

test('a variable defined by a sourced env file is not a violation (gov-discover shape)', () => {
  const f = scanWorkflow(
    wf(`      - run: |
          echo "POSTGRES_HOST_SUFFIX=$(get LOOM_PG)" >> vals.env
      - run: |
          set -euo pipefail
          set -a; . ./vals.env; set +a
          echo "\${POSTGRES_HOST_SUFFIX}"`),
  ).findings;
  assert.equal(f.length, 0);
});

// ── quoting, comments, heredocs ─────────────────────────────────────────────
test('single-quoted text does not expand, so it yields no reference', () => {
  assert.equal(unassignedReferences("echo 'literal $NOT_A_REF'", new Set()).length, 0);
});

test('a comment does not yield a reference', () => {
  assert.equal(unassignedReferences('# see $NOT_A_REF\ntrue', new Set()).length, 0);
});

test('command substitution is popped, so quoting after it stays in sync', () => {
  // Regression: `$(` was pushed and never popped on `)`, which desynced every
  // quote afterwards and reported $GITHUB_OUTPUT and a jq `$p` as unassigned.
  const script = `{
  echo "stale_count=$(echo "$STALE" | grep -c '^-')"
} >> "$GITHUB_OUTPUT"`;
  const names = unassignedReferences(script, new Set(['STALE'])).map((r) => r.name);
  assert.deepEqual(names, []);
});

test("a jq program in single quotes does not leak its \\$var as a shell reference", () => {
  const script = `UAMI=x
curl -sf "https://$HOST/api" | jq -r --arg p "$UAMI" '.a[]? | select(.principal==$p)'`;
  const names = unassignedReferences(script, new Set(['HOST'])).map((r) => r.name);
  assert.deepEqual(names, []);
});

test('a quoted-delimiter heredoc is literal', () => {
  const script = "cat <<'EOF'\n$NOT_A_REF\nEOF";
  assert.equal(unassignedReferences(script, new Set()).length, 0);
});

test('GitHub ${{ }} expressions are not shell references', () => {
  assert.equal(unassignedReferences('echo "${{ inputs.tag }}"', new Set()).length, 0);
});

// ── assignment forms ────────────────────────────────────────────────────────
test('assignment forms are recognised', () => {
  for (const [src, name] of [
    ['A=1', 'A'],
    ['export B=1', 'B'],
    ['local -r C=1', 'C'],
    ['for D in 1 2; do :; done', 'D'],
    ['read -r E <<< x', 'E'],
    ['printf -v F "x"', 'F'],
    ['mapfile -t G < f', 'G'],
    ['H+=1', 'H'],
  ]) {
    assert.equal(assignedNames(src).has(name), true, `${src} should assign ${name}`);
  }
});

test('runner and shell built-ins are never reported', () => {
  const script = 'echo "$GITHUB_SHA $RUNNER_OS $HOME $PATH $IFS $RANDOM $BASH_SOURCE $1 $? $#"';
  assert.equal(unassignedReferences(script, new Set()).length, 0);
});

test('`-t` is an option for mapfile but takes an ARGUMENT for read (release-please.yml shape)', () => {
  // Regression: a shared "options with an argument" table made `-t` swallow
  // RELEASE_PRS in `mapfile -t RELEASE_PRS`, so every later `${RELEASE_PRS[@]}`
  // was reported as an unassigned read.
  assert.equal(assignedNames('mapfile -t RELEASE_PRS < <(gh pr list)').has('RELEASE_PRS'), true);
  assert.equal(assignedNames('readarray -t ITEMS < f').has('ITEMS'), true);
  assert.equal(assignedNames('read -t 5 ANSWER').has('ANSWER'), true);
  assert.equal(assignedNames('read -t 5 ANSWER').has('5'), false);
  assert.equal(assignedNames('read -r -a ARR <<< "a b"').has('ARR'), true);
  assert.equal(assignedNames('printf -v OUT "%s" x').has('OUT'), true);
  // printf without -v assigns nothing
  assert.equal(assignedNames('printf "%s" HELLO').has('HELLO'), false);
});

test('assignment scanning is linear on the CodeQL js/redos witness inputs', () => {
  // The option-skipping regex `(?:-\w+(?:\s+\S+)?\s+)*` was flagged high-severity
  // on this file. It is now a plain loop; these must return promptly rather than
  // hang. A generous bound — the point is exponential vs not.
  for (const evil of ['mapfile\t-0' + '\t-0'.repeat(400), 'read -t ' + '-0 '.repeat(400)]) {
    const t = Date.now();
    assignedNames(evil);
    assert.ok(Date.now() - t < 2000, 'assignedNames must not backtrack exponentially');
  }
});

// ── shell selection ─────────────────────────────────────────────────────────
test('non-POSIX shells are skipped; bash-family shells are scanned', () => {
  assert.equal(isPosixShell('pwsh'), false);
  assert.equal(isPosixShell('powershell'), false);
  assert.equal(isPosixShell('python'), false);
  assert.equal(isPosixShell('cmd'), false);
  assert.equal(isPosixShell('bash'), true);
  assert.equal(isPosixShell('bash -e {0}'), true);
  assert.equal(isPosixShell(undefined), true); // GitHub's Linux default
});

test('a pwsh step is not scanned for $Var', () => {
  const r = scanWorkflow(
    wf(`      - shell: pwsh
        run: Write-Host "$SomePwshVar"`),
  );
  assert.equal(r.findings.length, 0);
  assert.equal(r.steps, 0);
});

// ── the YAML reader ─────────────────────────────────────────────────────────
test('parseWorkflow reads block scalars, nesting and line numbers', () => {
  const doc = parseWorkflow(`name: t
on: push
env:
  A: 1
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: one
        run: |
          echo hi
`);
  assert.deepEqual(mapKeys(doc.env), ['A']);
  const step = doc.jobs.j.steps[0];
  assert.equal(scalarValue(step.name), 'one');
  assert.equal(scalarValue(step.run).trim(), 'echo hi');
  assert.equal(step.run.line, 11); // 1-based line of the first body line
});

test('parseWorkflow dedents a block scalar so shell analysis sees real columns', () => {
  const doc = parseWorkflow(`jobs:
  j:
    steps:
      - run: |
          set -u
            indented
`);
  assert.equal(scalarValue(doc.jobs.j.steps[0].run), 'set -u\n  indented');
});
