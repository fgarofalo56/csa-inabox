#!/usr/bin/env node
/**
 * check-bootstrap-rg-subscription-scope.mjs  (#4765)
 *
 * RULE. In the post-deploy bootstrap, every `az` command that names the admin
 * resource group (`-g`/`--resource-group` = `$ADMIN_RG`) must ALSO pass
 * `--subscription "$ADMIN_SUB"`, and every one that names the landing-zone group
 * (`$DLZ_RG`) must pass `--subscription "$DLZ_SUB"`. Two arms:
 *
 *   unscoped    — the command names the group and passes no `--subscription`.
 *   mis-scoped  — it passes one, but not the subscription that holds the group.
 *
 * WHY. An unscoped `az` call runs against whatever subscription the az CLI
 * profile happens to hold, and in this workflow that is NOT a fixed value: the
 * CLI profile persists across steps, and in several scripts the bootstrap calls
 * the last `az account set` targets "$DLZ_SUB" (grant-synapse-rbac-invnet-job.sh,
 * run-spark-storage-fix-invnet-job.sh, wire-spark-telemetry.sh,
 * provision-databricks-compute.sh). A later unscoped admin-RG call can then ask
 * the DLZ subscription for `rg-csa-loom-admin-<region>` and get
 * `(ResourceGroupNotFound)`. Run 36384158319 (#4765) shows that error for the
 * Foundry storage grant (exit 3), and "The containerapp 'loom-console' does not
 * exist" in the Content Safety / AOAI steps. Step-level
 * `continue-on-error: true` reported every one of them as success. Which
 * `az account set` left the profile where it was on that run is not established.
 *
 * The fix is explicit scoping on the call, not ordering of `az account set` —
 * an ordering invariant spread over 60 steps and a dozen scripts is exactly the
 * kind of thing that silently breaks again. This guard keeps it explicit.
 *
 * HOW IT READS THE FILE. Shell commands span `\` continuations, and the
 * `--subscription` routinely sits on a different physical line from the `-g`.
 * So the file is folded into LOGICAL lines first (scripts/ci/_logical-lines.mjs,
 * which also normalises CRLF — a physical-line guard over a CRLF file matches
 * nothing and reports clean). Each logical line is then split into SIMPLE
 * COMMANDS by a small quote-aware lexer: `$( … )` / backtick / `( … )` bodies
 * become their own commands, and `;` `&&` `||` `|` `&` end one. That matters
 * because `X=$(az a -g "$ADMIN_RG" --subscription "$ADMIN_SUB" || az b -g
 * "$ADMIN_RG")` is TWO commands and the second is unscoped — a line-level
 * "does it contain --subscription" would call it clean.
 *
 * EMBEDDED CONTROL. The arms are proven against MUST_FLAG / MUST_NOT_FLAG
 * fixtures before the file is judged; a control failure fails the guard. It also
 * refuses to pass when it finds ZERO admin-RG `az` commands in a target: this
 * workflow has dozens, so zero means the lexer drifted off the code.
 *
 * KNOWN LIMITS, stated rather than hidden:
 *   - An ALIAS is invisible: `RG="$ADMIN_RG"; az … -g "$RG"` is not judged.
 *   - Scripts the workflow calls (`bash scripts/csa-loom/*.sh`) are not scanned;
 *     the ones known to run unscoped `-g` calls are listed on #4789. For those
 *     whose ordering is not already safe, THIRD RULE below requires the calling
 *     step to pin the az profile first.
 *   - `--scope /subscriptions/$SUB/resourceGroups/$ADMIN_RG` and `--ids …`
 *     carry the subscription inside the id and are not `-g` calls; not judged.
 *   - The lexer resets per logical line, so a quoted string spanning physical
 *     lines WITHOUT a `\` is lexed approximately; heredoc bodies are lexed as
 *     shell. Neither changes a verdict in the target today.
 *
 * SECOND RULE — THE FAILURE GATE (#4765). Step-level `continue-on-error: true`
 * turns a step's exit 1 into job-level success. The bootstrap keeps it on the
 * steps listed in FAILURE_GATE.gatedIds (so the steps after them still run),
 * and a final step with id FAILURE_GATE.gateId reads their `outcome` and fails
 * the job. That only works while the gate step:
 *   - exists in the job,
 *   - is the LAST step (a step after it would not be covered),
 *   - runs `if: always()` (under the default `success()` it is SKIPPED on
 *     exactly the runs that need it),
 *   - does not itself carry continue-on-error,
 *   - emits `::error::` and `exit 1`, and
 *   - reads `steps.<id>.outcome` for every gated id, each of which must exist
 *     and precede it.
 * Each of those is checked on the parsed workflow (scripts/ci/_workflow-yaml.mjs),
 * not by regex over lines, and proven first against embedded fixtures
 * (GATE_MUST_FLAG / GATE_MUST_NOT_FLAG). Removing the gate, or dropping its
 * `always()`, fails this guard.
 *
 * THIRD RULE — PROFILE PINS (#4765 review S4). For each script in PROFILE_PINS,
 * every step that calls it must, before the call, run a bare
 * `az account set --subscription "$<SUB>"` naming the required subscription,
 * not suppressed and not after `set +e`. Proven first against PIN_MUST_FLAG /
 * PIN_MUST_NOT_FLAG.
 *
 * Usage:
 *   node scripts/ci/check-bootstrap-rg-subscription-scope.mjs              # CHECK the bootstrap
 *   node scripts/ci/check-bootstrap-rg-subscription-scope.mjs <file> …     # CHECK named files
 *   node scripts/ci/check-bootstrap-rg-subscription-scope.mjs --self-test  # controls only
 *
 * Tests: node --test scripts/ci/__tests__/bootstrap-rg-subscription-scope.test.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicalLines } from './_logical-lines.mjs';
import { parseWorkflow, scalarValue } from './_workflow-yaml.mjs';

export const DEFAULT_TARGETS = ['.github/workflows/csa-loom-post-deploy-bootstrap.yml'];

/** Resource-group variable -> the subscription variable that must scope it. */
export const RG_TO_SUB = Object.freeze({ ADMIN_RG: 'ADMIN_SUB', DLZ_RG: 'DLZ_SUB' });

/** Marker the lexer leaves where a `$( … )` / backtick / subshell body was lifted out. */
const SUBST = '\u0000SUBST\u0000';

/**
 * Split ONE logical line into simple commands, each a list of raw words (quotes
 * kept). Command substitutions and subshells are emitted as commands of their
 * own; the enclosing word keeps a placeholder. An unquoted `#` at a word start
 * ends the line.
 *
 * @param {string} text one logical line
 * @returns {string[][]} simple commands, each an array of raw words
 */
export function splitCommands(text) {
  const out = [];
  const s = String(text);
  // Frames: `cmd` frames collect words; `sq`/`dq` are quote states; `arith` is $(( … )).
  const stack = [{ t: 'cmd', words: [], word: '', close: null }];
  const cmdFrame = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].t === 'cmd') return stack[k];
    return stack[0];
  };
  const endWord = (f) => {
    if (f.word !== '') f.words.push(f.word);
    f.word = '';
  };
  const flush = (f) => {
    endWord(f);
    if (f.words.length) out.push(f.words);
    f.words = [];
  };
  const openSubst = (close) => {
    cmdFrame().word += SUBST;
    stack.push({ t: 'cmd', words: [], word: '', close });
  };

  let i = 0;
  scan: for (; i < s.length; i++) {
    const c = s[i];
    const n1 = s[i + 1];
    const top = stack[stack.length - 1];

    if (top.t === 'sq') {
      cmdFrame().word += c;
      if (c === "'") stack.pop();
      continue;
    }
    if (top.t === 'arith') {
      cmdFrame().word += c;
      if (c === '(') top.depth++;
      else if (c === ')' && --top.depth === 0) stack.pop();
      continue;
    }
    if (top.t === 'dq') {
      if (c === '\\') { cmdFrame().word += c + (n1 ?? ''); i++; continue; }
      if (c === '"') { cmdFrame().word += c; stack.pop(); continue; }
      if (c === '$' && n1 === '(' && s[i + 2] !== '(') { openSubst(')'); i++; continue; }
      if (c === '`') { openSubst('`'); continue; }
      cmdFrame().word += c;
      continue;
    }

    // top.t === 'cmd'
    if (c === '\\') { top.word += c + (n1 ?? ''); i++; continue; }
    if (c === "'") { top.word += c; stack.push({ t: 'sq' }); continue; }
    if (c === '"') { top.word += c; stack.push({ t: 'dq' }); continue; }
    if (c === '#' && top.word === '') break scan; // comment to end of line
    if (c === '$' && n1 === '(' && s[i + 2] === '(') {
      top.word += '$((';
      stack.push({ t: 'arith', depth: 2 });
      i += 2;
      continue;
    }
    if (c === '$' && n1 === '(') { openSubst(')'); i++; continue; }
    if (c === '`') {
      if (top.close === '`') { flush(top); stack.pop(); continue; }
      openSubst('`');
      continue;
    }
    if (c === '(') { openSubst(')'); continue; }
    if (c === ')') {
      if (top.close === ')') { flush(top); stack.pop(); continue; }
      top.word += c; // a stray `)` — e.g. a `case` pattern
      continue;
    }
    if (c === '&' && (top.word.endsWith('>') || top.word.endsWith('<') || n1 === '>')) {
      top.word += c; // `2>&1`, `>&2`, `&>` are redirections, not separators
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      flush(top);
      if ((c === '|' || c === '&' || c === ';') && n1 === c) i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(top); continue; }
    top.word += c;
  }
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k].t === 'cmd') flush(stack[k]);
  return out;
}

/** `$X`, `"$X"`, `${X}`, `"${X}"` (and single-quoted) -> `X`; anything else -> null. */
export function varName(word) {
  const m = /^(["']?)\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\1$/.exec(word ?? '');
  return m ? m[2] : null;
}

/** Value of a flag given as `--flag value` or `--flag=value`, for any of `names`. */
function flagValues(words, names) {
  const vals = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (names.includes(w)) {
      vals.push(words[k + 1] ?? '');
      continue;
    }
    for (const nm of names) {
      if (nm.startsWith('--') && w.startsWith(nm + '=')) vals.push(w.slice(nm.length + 1));
    }
  }
  return vals;
}

/**
 * Judge one simple command. Returns null when it is not an `az` command naming a
 * guarded resource group, else `{ rgVar, subVar, arm }` where `arm` is null for a
 * correctly scoped call.
 */
export function judgeCommand(words) {
  // `az` must be an UNQUOTED word; a message that merely mentions `az` inside
  // quotes is prose, not a call.
  if (!words.includes('az')) return null;
  const rgVars = flagValues(words, ['-g', '--resource-group']).map(varName).filter((v) => v in RG_TO_SUB);
  if (rgVars.length === 0) return null;
  const rgVar = rgVars[0];
  const want = RG_TO_SUB[rgVar];
  const subs = flagValues(words, ['--subscription']);
  if (subs.length === 0) return { rgVar, subVar: null, arm: 'unscoped' };
  const subVar = varName(subs[subs.length - 1]);
  if (subVar !== want) return { rgVar, subVar: subVar ?? subs[subs.length - 1], arm: 'mis-scoped' };
  return { rgVar, subVar, arm: null };
}

/**
 * Judge one file's text. Returns the population of guarded `az` commands found
 * (for the empty-population self-defence) and one record per violation.
 */
export function scanText(text) {
  const violations = [];
  let guarded = 0;
  for (const { line, text: logical } of readLogicalLines(text)) {
    if (/^\s*#/.test(logical)) continue;
    for (const words of splitCommands(logical)) {
      const v = judgeCommand(words);
      if (!v) continue;
      guarded++;
      if (v.arm) {
        violations.push({
          arm: v.arm,
          line,
          rgVar: v.rgVar,
          subVar: v.subVar,
          want: RG_TO_SUB[v.rgVar],
          text: words.join(' ').replaceAll(SUBST, '$(…)').slice(0, 160),
        });
      }
    }
  }
  return { guarded, violations };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMBEDDED CONTROL — proven on every run, before any file is judged.
// ─────────────────────────────────────────────────────────────────────────────

/** Fixtures the scanner MUST flag, with the arm each must trip. */
export const MUST_FLAG = [
  { why: 'unscoped, one line', arm: 'unscoped', src: 'az containerapp show -n loom-console -g "$ADMIN_RG" --query id -o tsv' },
  { why: 'unscoped, bare $ADMIN_RG', arm: 'unscoped', src: 'az identity list -g $ADMIN_RG -o tsv' },
  { why: 'unscoped, --resource-group long form', arm: 'unscoped', src: 'az keyvault list --resource-group "${ADMIN_RG}" -o tsv' },
  { why: 'unscoped DLZ group', arm: 'unscoped', src: 'az storage account list -g "$DLZ_RG" --query "[0].id" -o tsv' },
  {
    why: 'unscoped inside $( … ), wrapped over `\\` continuations',
    arm: 'unscoped',
    src: 'X=$(az containerapp show -n loom-console \\\n  -g "$ADMIN_RG" \\\n  --query id -o tsv 2>&1)',
  },
  {
    why: 'the SECOND command of an `||` pair is unscoped although the line contains --subscription',
    arm: 'unscoped',
    src: 'X=$(az a show -g "$ADMIN_RG" --subscription "$ADMIN_SUB" -o tsv || az a show -g "$ADMIN_RG" -o tsv)',
  },
  { why: 'admin group scoped to the DLZ subscription', arm: 'mis-scoped', src: 'az identity list -g "$ADMIN_RG" --subscription "$DLZ_SUB"' },
  { why: 'DLZ group scoped to the admin subscription', arm: 'mis-scoped', src: 'az resource list --subscription "$ADMIN_SUB" -g $DLZ_RG' },
  {
    why: 'unscoped, CRLF line endings with a continuation',
    arm: 'unscoped',
    src: 'az role assignment create --assignee "$P" \\\r\n  --role Reader -g "$ADMIN_RG"\r\n',
  },
];

/** Fixtures the scanner MUST NOT flag — the over-broad direction. */
export const MUST_NOT_FLAG = [
  { why: 'scoped, same line', src: 'az containerapp show -n loom-console -g "$ADMIN_RG" --subscription "$ADMIN_SUB" -o tsv' },
  { why: 'scoped, --subscription BEFORE -g', src: 'az cosmosdb list --subscription "$ADMIN_SUB" -g "$ADMIN_RG" -o tsv' },
  { why: 'scoped, --subscription= form', src: 'az acr list -g "$ADMIN_RG" --subscription="$ADMIN_SUB" -o tsv' },
  {
    why: 'scoped, --subscription on a CONTINUATION line',
    src: 'az containerapp update -n loom-console -g "$ADMIN_RG" \\\n  --subscription "$ADMIN_SUB" \\\n  --set-env-vars A=b',
  },
  { why: 'DLZ group scoped to DLZ', src: 'az storage account list --subscription "$DLZ_SUB" -g $DLZ_RG -o tsv' },
  { why: 'an unrelated resource group is not this rule', src: 'az cosmosdb show -n x -g "$COSMOS_RG" --subscription "$COSMOS_SUB"' },
  { why: 'az mentioned only inside a quoted message', src: 'echo "::warning::run az identity list -g $ADMIN_RG to check"' },
  { why: 'a comment describing the rule', src: '# az identity list -g "$ADMIN_RG"   <- unscoped, do not do this' },
  { why: 'a non-az command taking -g', src: 'grep -g "$ADMIN_RG" file' },
  // `az` must be a WHOLE word: a substring match would flag this on `lazy.txt`.
  { why: 'a word merely CONTAINING az is not an az call', src: 'grep -g "$ADMIN_RG" lazy.txt' },
  {
    why: 'scoped, CRLF with the --subscription on the continuation',
    src: 'az role assignment create --assignee "$P" \\\r\n  -g "$ADMIN_RG" --subscription "$ADMIN_SUB"\r\n',
  },
];

/** Runs the controls. Returns a list of failure descriptions (empty = healthy). */
export function runControls() {
  const failures = [];
  for (const c of MUST_FLAG) {
    const arms = scanText(c.src).violations.map((v) => v.arm);
    if (!arms.includes(c.arm)) failures.push(`MUST-FLAG missed (${c.arm}) — ${c.why}: ${JSON.stringify(c.src)}`);
  }
  for (const c of MUST_NOT_FLAG) {
    const hits = scanText(c.src).violations;
    if (hits.length > 0) failures.push(`MUST-NOT-FLAG tripped (${hits.map((h) => h.arm).join(',')}) — ${c.why}: ${JSON.stringify(c.src)}`);
  }
  return failures;
}

// ── Second rule: the failure gate (#4765) ─────────────────────────────────────

/** The job, the gate step's id, and the continue-on-error step ids it must cover. */
export const FAILURE_GATE = Object.freeze({
  job: 'bootstrap',
  gateId: 'bootstrap_failure_gate',
  gatedIds: Object.freeze(['dbx_sql_warehouse']),
});

/** `always()` or `${{ always() }}`, nothing else — `always() && x` would skip on !x. */
const ALWAYS_ONLY = /^\s*(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?\s*$/;
const TRUE_SCALAR = /^\s*(?:true|'true'|"true")\s*$/;

/**
 * Judge the failure gate in one workflow's text. Returns a list of problems
 * (empty = the gate is intact). Each message names what is missing.
 */
export function checkFailureGate(text, spec = FAILURE_GATE) {
  let doc;
  try {
    doc = parseWorkflow(text);
  } catch (e) {
    return [`cannot parse the workflow to find the failure gate (${e.message})`];
  }
  const steps = doc?.jobs?.[spec.job]?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return [`job '${spec.job}' has no steps, so it has no failure gate`];
  const idOf = (s) => scalarValue(s?.id);
  const gateIdx = steps.findIndex((s) => idOf(s) === spec.gateId);
  if (gateIdx < 0) {
    return [`no step with id '${spec.gateId}' in job '${spec.job}' — nothing turns a failed continue-on-error step (${spec.gatedIds.join(', ')}) into a failed job`];
  }
  const gate = steps[gateIdx];
  const problems = [];
  if (gateIdx !== steps.length - 1) {
    problems.push(`'${spec.gateId}' is step ${gateIdx + 1} of ${steps.length}, not the LAST step — a failure after it would not be gated`);
  }
  const cond = scalarValue(gate.if);
  if (cond === undefined || !ALWAYS_ONLY.test(String(cond))) {
    problems.push(`'${spec.gateId}' runs if: ${cond === undefined ? '(unset, i.e. success())' : cond} — it must be exactly always(), or it is skipped on the runs where an earlier step failed`);
  }
  if (TRUE_SCALAR.test(String(scalarValue(gate['continue-on-error']) ?? ''))) {
    problems.push(`'${spec.gateId}' has continue-on-error: true, so its own exit 1 never reaches the job conclusion`);
  }
  const run = String(scalarValue(gate.run) ?? '');
  if (!run.includes('::error::') || !/(^|[\s;])exit 1\b/m.test(run)) {
    problems.push(`'${spec.gateId}' run block must emit ::error:: and exit 1 when a gated step failed`);
  }
  const envVals = gate.env && typeof gate.env === 'object' ? Object.values(gate.env).map((n) => String(scalarValue(n) ?? '')) : [];
  const reads = `${envVals.join('\n')}\n${run}`;
  for (const id of spec.gatedIds) {
    const idx = steps.findIndex((s) => idOf(s) === id);
    if (idx < 0) problems.push(`gated step id '${id}' is not in job '${spec.job}' — the gate reads the outcome of a step that does not exist`);
    else if (idx > gateIdx) problems.push(`gated step '${id}' runs AFTER '${spec.gateId}'`);
    if (!reads.includes(`steps.${id}.outcome`)) problems.push(`'${spec.gateId}' does not read steps.${id}.outcome`);
  }
  return problems;
}

/** A minimal intact gate; the MUST_FLAG fixtures below are single edits of it. */
const GATE_GOOD = [
  'on: workflow_dispatch',
  'jobs:',
  '  bootstrap:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: gated',
  '        id: dbx_sql_warehouse',
  '        continue-on-error: true',
  '        run: |',
  '          exit 1',
  '      - name: gate',
  '        id: bootstrap_failure_gate',
  '        if: always()',
  '        env:',
  '          WH_OUTCOME: ${{ steps.dbx_sql_warehouse.outcome }}',
  '        run: |',
  '          if [ "$WH_OUTCOME" = failure ]; then',
  '            echo "::error::gated step failed"',
  '            exit 1',
  '          fi',
  '',
].join('\n');

const LAST_STEP = '      - name: after\n        run: echo after\n';

export const GATE_MUST_FLAG = [
  { why: 'the gate step removed', src: GATE_GOOD.replace(/ {6}- name: gate\n[\s\S]*$/, '') },
  { why: 'the gate loses always() (default success() skips it on a failed run)', src: GATE_GOOD.replace('        if: always()\n', '') },
  { why: 'the gate runs if: success()', src: GATE_GOOD.replace('if: always()', 'if: success()') },
  { why: 'the gate narrowed to always() && a condition', src: GATE_GOOD.replace('if: always()', "if: always() && github.ref == 'refs/heads/main'") },
  { why: 'a step added after the gate', src: GATE_GOOD + LAST_STEP },
  { why: 'the gate no longer reads the gated outcome', src: GATE_GOOD.replace('steps.dbx_sql_warehouse.outcome', 'job.status') },
  { why: 'the gated step lost its id', src: GATE_GOOD.replace('        id: dbx_sql_warehouse\n', '') },
  { why: 'the gate itself is continue-on-error', src: GATE_GOOD.replace('        if: always()\n', '        if: always()\n        continue-on-error: true\n') },
  { why: 'the gate never exits 1', src: GATE_GOOD.replace('            exit 1\n', '') },
];

export const GATE_MUST_NOT_FLAG = [
  { why: 'the intact gate', src: GATE_GOOD },
  { why: 'the intact gate written ${{ always() }}, CRLF', src: GATE_GOOD.replace('if: always()', 'if: ${{ always() }}').replace(/\n/g, '\r\n') },
];

/** Runs the gate controls. Returns a list of failure descriptions (empty = healthy). */
export function runGateControls() {
  const failures = [];
  for (const c of GATE_MUST_FLAG) {
    if (checkFailureGate(c.src).length === 0) failures.push(`GATE MUST-FLAG missed — ${c.why}`);
  }
  for (const c of GATE_MUST_NOT_FLAG) {
    const p = checkFailureGate(c.src);
    if (p.length > 0) failures.push(`GATE MUST-NOT-FLAG tripped — ${c.why}: ${p.join('; ')}`);
  }
  return failures;
}

// ── THIRD RULE — PROFILE PINS (#4765 review S4) ─────────────────────────────
// Some scripts the bootstrap calls run `az … -g <rg>` WITHOUT --subscription,
// so they act on whatever subscription the az profile holds, and the profile
// persists across steps. Until those scripts take the subscription themselves
// (#4789), the step that calls each one must pin the profile to the right
// subscription first. This rule checks, for every step whose run block calls
// the script, that the LAST `az account set --subscription …` before the call
// names the required variable, stands alone on its line (no `||`, `;`, `&&`,
// redirection), and is not preceded by `set +e` (under which a failed pin would
// not stop the step).
export const PROFILE_PINS = Object.freeze([
  Object.freeze({ script: 'scripts/csa-loom/provision-scc-labels-sidecar.sh', sub: 'ADMIN_SUB' }),
  Object.freeze({ script: 'scripts/csa-loom/bootstrap-weave-pg.sh', sub: 'DLZ_SUB' }),
]);

const ACCOUNT_SET = /^az\s+account\s+set\s+(?:--subscription|-s)\s+("?)\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\1(.*)$/;

/** Fold a run block into logical lines: CRLF-normalised, `\` continuations joined, trimmed. */
function foldRun(run) {
  const out = [];
  let acc = '';
  for (const raw of run.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.endsWith('\\')) { acc += `${line.slice(0, -1)} `; continue; }
    out.push((acc + line).trim());
    acc = '';
  }
  if (acc) out.push(acc.trim());
  return out;
}

/**
 * Judge the profile pins in one workflow's text. Returns a list of problems.
 * @param {string} text workflow YAML
 * @param {ReadonlyArray<{script: string, sub: string}>} pins
 */
export function checkProfilePins(text, pins = PROFILE_PINS, job = FAILURE_GATE.job) {
  let doc;
  try {
    doc = parseWorkflow(text);
  } catch (e) {
    return [`cannot parse the workflow to check profile pins (${e.message})`];
  }
  const steps = doc?.jobs?.[job]?.steps;
  if (!Array.isArray(steps)) return [`job '${job}' has no steps, so no profile pin can be checked`];
  const problems = [];
  for (const pin of pins) {
    const call = new RegExp(`(^|\\s)bash\\s+${pin.script.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\s|$)`);
    let callers = 0;
    for (const s of steps) {
      const name = String(scalarValue(s?.name) ?? '(unnamed step)');
      const lines = foldRun(String(scalarValue(s?.run) ?? ''));
      const callIdx = lines.findIndex((l) => !l.startsWith('#') && call.test(l));
      if (callIdx < 0) continue;
      callers += 1;
      let pinned = null;
      let setPlusE = false;
      for (let i = 0; i < callIdx; i++) {
        const l = lines[i];
        if (/^set\s+\+e\b/.test(l)) setPlusE = true;
        if (/^set\s+-e\b/.test(l)) setPlusE = false;
        const m = l.match(ACCOUNT_SET);
        if (m) pinned = { sub: m[2], rest: m[3].trim(), afterSetPlusE: setPlusE };
      }
      if (!pinned) {
        problems.push(`step '${name}' calls ${pin.script} with no \`az account set --subscription "$${pin.sub}"\` before it — the script's unscoped \`-g\` calls run against whatever subscription an earlier step left`);
      } else if (pinned.sub !== pin.sub) {
        problems.push(`step '${name}': the last \`az account set\` before ${pin.script} names $${pinned.sub}, not $${pin.sub}`);
      } else if (pinned.rest !== '') {
        problems.push(`step '${name}': the \`az account set --subscription "$${pin.sub}"\` before ${pin.script} is followed by \`${pinned.rest}\` — the pin must stand alone so a failure stops the step`);
      } else if (pinned.afterSetPlusE) {
        problems.push(`step '${name}': the pin before ${pin.script} runs after \`set +e\`, so a failed pin would not stop the step`);
      }
    }
    if (callers === 0) problems.push(`no step in job '${job}' calls ${pin.script} — the pin rule is aimed at a call that no longer exists; re-aim PROFILE_PINS`);
  }
  return problems;
}

const PIN_GOOD = [
  'on: workflow_dispatch',
  'jobs:',
  '  bootstrap:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: scc',
  '        run: |',
  '          az account set --subscription "$ADMIN_SUB"',
  '          set +e',
  '          bash scripts/csa-loom/provision-scc-labels-sidecar.sh || true',
  '      - name: weave',
  '        run: |',
  '          az account set --subscription "$DLZ_SUB"',
  '          SUB="$DLZ_SUB" DLZ_RG="$DLZ_RG" \\',
  '            bash scripts/csa-loom/bootstrap-weave-pg.sh \\',
  '            || echo "::warning::incomplete"',
  '',
].join('\n');

export const PIN_MUST_FLAG = [
  { why: 'the weave pin removed', src: PIN_GOOD.replace('          az account set --subscription "$DLZ_SUB"\n', '') },
  { why: 'the weave pin names the admin subscription', src: PIN_GOOD.replace('--subscription "$DLZ_SUB"', '--subscription "$ADMIN_SUB"') },
  { why: 'the weave pin suppressed with || true', src: PIN_GOOD.replace('--subscription "$DLZ_SUB"', '--subscription "$DLZ_SUB" || true') },
  { why: 'the weave pin moved after the call', src: PIN_GOOD.replace('          az account set --subscription "$DLZ_SUB"\n', '').replace('            || echo "::warning::incomplete"\n', '            || echo "::warning::incomplete"\n          az account set --subscription "$DLZ_SUB"\n') },
  { why: 'the scc pin removed', src: PIN_GOOD.replace('          az account set --subscription "$ADMIN_SUB"\n', '') },
  { why: 'the scc pin placed after set +e', src: PIN_GOOD.replace('          az account set --subscription "$ADMIN_SUB"\n          set +e\n', '          set +e\n          az account set --subscription "$ADMIN_SUB"\n') },
  { why: 'the weave script no longer called anywhere', src: PIN_GOOD.replace('bash scripts/csa-loom/bootstrap-weave-pg.sh', 'echo skipped') },
];

export const PIN_MUST_NOT_FLAG = [
  { why: 'the intact pins', src: PIN_GOOD },
  { why: 'the intact pins, CRLF, ${VAR} form', src: PIN_GOOD.replace('"$DLZ_SUB"\n          SUB', '"${DLZ_SUB}"\n          SUB').replace(/\n/g, '\r\n') },
];

/** Runs the profile-pin controls. Returns a list of failure descriptions (empty = healthy). */
export function runPinControls() {
  const failures = [];
  for (const c of PIN_MUST_FLAG) {
    if (checkProfilePins(c.src).length === 0) failures.push(`PIN MUST-FLAG missed — ${c.why}`);
  }
  for (const c of PIN_MUST_NOT_FLAG) {
    const p = checkProfilePins(c.src);
    if (p.length > 0) failures.push(`PIN MUST-NOT-FLAG tripped — ${c.why}: ${p.join('; ')}`);
  }
  return failures;
}

/** Judge a list of files against both rules. Returns an exit code; prints the verdict. */
export function checkFiles(files, root = process.cwd()) {
  const all = [];
  let gateBroken = 0;
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(resolve(root, rel), 'utf8');
    } catch (e) {
      console.error(`::error::bootstrap-rg-subscription-scope: cannot read ${rel} (${e.code || e.message}). Refusing to report a pass on a file that was not read.`);
      return 1;
    }
    const gateProblems = checkFailureGate(text);
    if (gateProblems.length > 0) {
      gateBroken += 1;
      console.error(
        `::error file=${rel}::bootstrap-rg-subscription-scope: the #4765 failure gate is broken, so a failed continue-on-error ` +
          `step (${FAILURE_GATE.gatedIds.join(', ')}) would conclude the job as SUCCESS: ${gateProblems.join('; ')}`,
      );
    } else {
      console.log(`bootstrap-rg-subscription-scope: ${rel} — failure gate '${FAILURE_GATE.gateId}' is last, always(), and reads ${FAILURE_GATE.gatedIds.map((id) => `steps.${id}.outcome`).join(', ')}.`);
    }
    const pinProblems = checkProfilePins(text);
    if (pinProblems.length > 0) {
      gateBroken += 1;
      for (const p of pinProblems) {
        console.error(`::error file=${rel}::bootstrap-rg-subscription-scope: profile pin broken (#4765): ${p}`);
      }
    } else {
      console.log(`bootstrap-rg-subscription-scope: ${rel} — ${PROFILE_PINS.length} profile pin(s) intact (${PROFILE_PINS.map((p) => `${p.script.split('/').pop()} -> $${p.sub}`).join(', ')}).`);
    }
    const r = scanText(text);
    if (r.guarded === 0) {
      console.error(
        `::error::bootstrap-rg-subscription-scope: found ZERO \`az\` commands naming $ADMIN_RG/$DLZ_RG in ${rel}. ` +
          'That file has dozens, so zero means the lexer has drifted off the code. Refusing to report a pass on an empty population.',
      );
      return 1;
    }
    for (const v of r.violations) all.push({ file: rel, ...v });
    if (r.violations.length === 0) {
      console.log(`bootstrap-rg-subscription-scope: ${rel} — ${r.guarded} admin/DLZ resource-group az command(s), all scoped to the matching subscription.`);
    }
  }
  if (all.length > 0) {
    console.error(
      `::error::bootstrap-rg-subscription-scope: ${all.length} az command(s) name the admin or DLZ resource group without ` +
        'the subscription that holds it. The az CLI profile persists across steps and several bootstrap scripts leave it on ' +
        '$DLZ_SUB, so an unscoped call can ask the wrong subscription and fail with (ResourceGroupNotFound), which ' +
        'continue-on-error then reports as success (#4765). Add --subscription "$ADMIN_SUB" to every -g "$ADMIN_RG" call ' +
        'and --subscription "$DLZ_SUB" to every -g "$DLZ_RG" call.',
    );
    for (const v of all) {
      const detail = v.arm === 'unscoped' ? `no --subscription; needs "$${v.want}"` : `--subscription is ${v.subVar}; needs "$${v.want}"`;
      console.error(`::error file=${v.file},line=${v.line}::${v.arm} ($${v.rgVar}: ${detail}): ${v.text}`);
    }
    return 1;
  }
  return gateBroken > 0 ? 1 : 0;
}

function main() {
  const args = process.argv.slice(2);
  const controlFailures = [...runControls(), ...runGateControls(), ...runPinControls()];
  if (controlFailures.length > 0) {
    console.error(
      `::error::bootstrap-rg-subscription-scope: the EMBEDDED CONTROL failed (${controlFailures.length}). The matcher no ` +
        'longer behaves as documented, so any verdict about the workflow would be meaningless.',
    );
    for (const f of controlFailures) console.error(`   - ${f}`);
    process.exit(1);
  }
  const controlCount = MUST_FLAG.length + MUST_NOT_FLAG.length;
  const gateControlCount = GATE_MUST_FLAG.length + GATE_MUST_NOT_FLAG.length;
  const pinControlCount = PIN_MUST_FLAG.length + PIN_MUST_NOT_FLAG.length;
  if (args.includes('--self-test')) {
    console.log(`bootstrap-rg-subscription-scope self-test OK — ${controlCount} scope + ${gateControlCount} failure-gate + ${pinControlCount} profile-pin control fixture(s) behaved as documented.`);
    return;
  }
  const files = args.filter((a) => !a.startsWith('--'));
  const code = checkFiles(files.length ? files : DEFAULT_TARGETS);
  if (code === 0) {
    console.log(`bootstrap-rg-subscription-scope OK — ${controlCount} scope + ${gateControlCount} failure-gate + ${pinControlCount} profile-pin embedded control fixture(s) proved every arm still detects.`);
  }
  process.exit(code);
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) main();
