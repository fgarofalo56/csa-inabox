/**
 * check-bootstrap-rg-subscription-scope tests (#4765).
 *
 * The guard exists because an unscoped `az … -g "$ADMIN_RG"` in the post-deploy
 * bootstrap asks whichever subscription the az profile happens to hold. When that
 * is not the admin subscription the call gets `(ResourceGroupNotFound)`, and
 * `continue-on-error` reports it as success.
 *
 * Every assertion below names, in its message or the comment above it, the
 * value that would turn it red (assertion-design.md). Three of them run against
 * the REAL workflow text with an in-memory plant, so a lexer that drifted off the
 * workflow's actual shapes cannot pass by agreeing with its own fixtures. The
 * tracked workflow is never written; the CLI tests plant into an OS temp dir.
 *
 * Run: node --test scripts/ci/__tests__/bootstrap-rg-subscription-scope.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanText,
  splitCommands,
  judgeCommand,
  runControls,
  MUST_FLAG,
  MUST_NOT_FLAG,
  DEFAULT_TARGETS,
  RG_TO_SUB,
} from '../check-bootstrap-rg-subscription-scope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const GUARD = resolve(HERE, '..', 'check-bootstrap-rg-subscription-scope.mjs');
const WORKFLOW = resolve(REPO, DEFAULT_TARGETS[0]);

const arms = (src) => scanText(src).violations.map((v) => v.arm);
const rows = (src) => scanText(src).violations.map((v) => ({ arm: v.arm, line: v.line, rgVar: v.rgVar }));

// ── The two arms, one line ─────────────────────────────────────────────────

test('unscoped: -g "$ADMIN_RG" with no --subscription is flagged', () => {
  // Breaks if judgeCommand stops treating a missing --subscription as a violation.
  assert.deepEqual(arms('az identity list -g "$ADMIN_RG" -o tsv'), ['unscoped']);
});

test('scoped: the same call with --subscription "$ADMIN_SUB" is clean — the positive pair of the test above', () => {
  // Breaks if the scanner flags every -g "$ADMIN_RG" regardless of scope (an
  // over-broad guard that would pass the unscoped test above by construction).
  assert.deepEqual(arms('az identity list -g "$ADMIN_RG" --subscription "$ADMIN_SUB" -o tsv'), []);
  // And the scan did SEE it: a guarded population of 1, not 0.
  assert.equal(scanText('az identity list -g "$ADMIN_RG" --subscription "$ADMIN_SUB" -o tsv').guarded, 1);
});

test('mis-scoped: the admin group under $DLZ_SUB and the DLZ group under $ADMIN_SUB are both flagged', () => {
  // Breaks if the guard only checks that SOME --subscription is present.
  assert.deepEqual(arms('az identity list -g "$ADMIN_RG" --subscription "$DLZ_SUB"'), ['mis-scoped']);
  assert.deepEqual(arms('az resource list --subscription "$ADMIN_SUB" -g $DLZ_RG'), ['mis-scoped']);
  // The correct DLZ pairing is clean — breaks if RG_TO_SUB maps DLZ_RG anywhere but DLZ_SUB.
  assert.equal(RG_TO_SUB.DLZ_RG, 'DLZ_SUB');
  assert.deepEqual(arms('az resource list --subscription "$DLZ_SUB" -g $DLZ_RG'), []);
});

test('flag spellings: --resource-group, ${ADMIN_RG}, bare $ADMIN_RG and --subscription= are all read', () => {
  // Each line breaks if the corresponding spelling stops being recognised: an
  // unrecognised -g spelling reads as "not guarded" (expected [] would still be
  // wrong for the first three, which must flag).
  assert.deepEqual(arms('az keyvault list --resource-group "${ADMIN_RG}"'), ['unscoped']);
  assert.deepEqual(arms('az keyvault list -g $ADMIN_RG'), ['unscoped']);
  assert.deepEqual(arms("az keyvault list -g '$ADMIN_RG'"), ['unscoped']);
  // Breaks if the `--subscription=value` form is not parsed (it would read as unscoped).
  assert.deepEqual(arms('az acr list -g "$ADMIN_RG" --subscription="$ADMIN_SUB"'), []);
});

// ── Continuations and CRLF — the shapes a physical-line guard gets wrong ────

test('wrapped: --subscription on a `\\` continuation line is scoped, and the verdict points at the FIRST line', () => {
  const src = [
    'echo start',
    'if az containerapp update -n loom-console -g "$ADMIN_RG" \\',
    '    --subscription "$ADMIN_SUB" \\',
    '    --set-env-vars "A=$B" -o none; then',
    '  echo ok',
    'fi',
  ].join('\n');
  // Breaks if continuations are not folded: line 2 alone has -g and no --subscription.
  assert.deepEqual(rows(src), []);
  assert.equal(scanText(src).guarded, 1, 'the wrapped `if az …` command must be SEEN (0 = the `if` keyword hid it)');
});

test('wrapped: -g on a continuation line with no --subscription anywhere is flagged at the command line', () => {
  const src = ['echo start', 'X=$(az containerapp show -n loom-console \\', '  -g "$ADMIN_RG" \\', '  --query id -o tsv)'].join('\n');
  // Breaks if continuations are not folded (the -g line has no `az` and is ignored),
  // or if the reported line is the -g line (3) rather than the invocation (2).
  assert.deepEqual(rows(src), [{ arm: 'unscoped', line: 2, rgVar: 'ADMIN_RG' }]);
});

test('CRLF: a CRLF file with a continuation is judged the same as LF, both directions', () => {
  const bad = 'az role assignment create --assignee "$P" \\\r\n  --role Reader -g "$ADMIN_RG"\r\n';
  const good = 'az role assignment create --assignee "$P" \\\r\n  -g "$ADMIN_RG" --subscription "$ADMIN_SUB"\r\n';
  // Breaks if `\\\r` is not recognised as a continuation (bad: the -g line has no az -> []),
  // or if a trailing `\r` is glued onto "$ADMIN_SUB" so varName() rejects it (good -> mis-scoped).
  assert.deepEqual(arms(bad), ['unscoped']);
  assert.deepEqual(arms(good), []);
});

// ── The lexer: commands, not lines ─────────────────────────────────────────

test('the second command of an `||` pair is judged on its own — a line containing --subscription is not enough', () => {
  const src = 'X=$(az a show -g "$ADMIN_RG" --subscription "$ADMIN_SUB" -o tsv || az a show -g "$ADMIN_RG" -o tsv)';
  // Breaks if the lexer does not split on `||` (the one merged command carries a
  // --subscription and reads as scoped -> []).
  assert.deepEqual(arms(src), ['unscoped']);
  assert.equal(scanText(src).guarded, 2);
});

test('splitCommands: separators and substitutions produce the expected command list', () => {
  // Breaks on: no split at `;`/`&&`/`|` (fewer commands), `2>&1` treated as a
  // separator (a spurious `1` command), or $( ) not lifted out (az hidden inside a word).
  const cmds = splitCommands('A=$(az x -g "$ADMIN_RG" 2>&1 | tail -1) && echo "done; ok" ; b c').map((w) => w[0]);
  assert.deepEqual(cmds, ['az', 'tail', 'A=\u0000SUBST\u0000', 'echo', 'b']);
});

test('not a call: az inside quotes, in a comment, or a non-az command taking -g', () => {
  // Each breaks if `az` is matched as a substring instead of an unquoted word, or
  // if a `#` comment is lexed as code. Paired with the unscoped tests above,
  // which show the same -g "$ADMIN_RG" IS flagged when it is a real az call.
  assert.deepEqual(arms('echo "::warning::run az identity list -g $ADMIN_RG to check"'), []);
  assert.deepEqual(arms('# az identity list -g "$ADMIN_RG"'), []);
  assert.deepEqual(arms('echo ok  # az identity list -g "$ADMIN_RG"'), []);
  assert.deepEqual(arms('grep -g "$ADMIN_RG" file'), []);
  assert.equal(judgeCommand(['grep', '-g', '"$ADMIN_RG"']), null);
  // Breaks if `az` is matched as a SUBSTRING of any word: `lazy.txt` contains "az"
  // and sits beside an unquoted -g "$ADMIN_RG". (The quoted-echo case above does
  // NOT witness this: its -g is inside the quoted word, so no -g flag is parsed
  // either way — measured, a substring mutant passed it.)
  assert.deepEqual(arms('grep -g "$ADMIN_RG" lazy.txt'), []);
});

test('splitCommands: a stray CR is whitespace (defence in depth — EQUIVALENT through scanText)', () => {
  // Breaks if `\r` is dropped from the lexer's whitespace set: the CR would glue
  // onto "$ADMIN_SUB" and varName() would reject it. DISCLOSED: through scanText
  // this mutant is equivalent, because readLogicalLines splits on /\r?\n/ and the
  // lexer never sees a CRLF's CR. This pins only direct callers of splitCommands.
  assert.deepEqual(splitCommands('az x -g "$ADMIN_RG" --subscription "$ADMIN_SUB"\r'), [
    ['az', 'x', '-g', '"$ADMIN_RG"', '--subscription', '"$ADMIN_SUB"'],
  ]);
});

test('an unrelated resource group is not in scope', () => {
  // Breaks if the guard widens to every -g (COSMOS_RG has its own subscription var).
  assert.deepEqual(arms('az cosmosdb show -n x -g "$COSMOS_RG"'), []);
});

// ── The embedded control ───────────────────────────────────────────────────

test('embedded control: every MUST_FLAG fixture trips its arm and every MUST_NOT_FLAG fixture is clean', () => {
  // Iterates the module's OWN fixture lists (lifted, not transcribed) so a fixture
  // edited in the guard is exercised here too. Breaks if any fixture misbehaves.
  assert.ok(MUST_FLAG.length >= 2 && MUST_NOT_FLAG.length >= 2, 'fixture lists must not be emptied');
  assert.deepEqual(new Set(MUST_FLAG.map((c) => c.arm)), new Set(['unscoped', 'mis-scoped']), 'both arms need a MUST_FLAG fixture');
  for (const c of MUST_FLAG) assert.ok(arms(c.src).includes(c.arm), `MUST_FLAG missed: ${c.why}`);
  for (const c of MUST_NOT_FLAG) assert.deepEqual(arms(c.src), [], `MUST_NOT_FLAG tripped: ${c.why}`);
  assert.deepEqual(runControls(), []);
});

// ── The real workflow, read but never written ──────────────────────────────

const REAL = readFileSync(WORKFLOW, 'utf8');
const realLines = () => REAL.split(/\r?\n/);

test('the real bootstrap workflow is clean and non-empty', () => {
  const r = scanText(REAL);
  // Breaks if any admin/DLZ az call in the workflow loses its --subscription.
  assert.deepEqual(r.violations, []);
  // Breaks if the lexer drifts off the file entirely (0 guarded). Weak on its own;
  // the two plant tests below are what show the scan reaches this file's text.
  assert.ok(r.guarded > 50, `expected dozens of guarded az calls, saw ${r.guarded}`);
});

test('a plant INTO the real workflow text is found at its exact line (ADMIN and DLZ)', () => {
  const lines = realLines();
  const anchor = lines.findIndex((l) => l.includes('echo "    SQL warehouse id: $WID"'));
  assert.ok(anchor > 0, 'anchor line moved — re-aim this plant rather than letting it silently scan nothing');
  lines.splice(anchor + 1, 0, '          az identity list -g "$ADMIN_RG" -o tsv', '          az storage account list -g $DLZ_RG -o tsv');
  // Breaks if the scan does not reach the workflow's run: blocks, or reports the
  // wrong line. Expected lines are the two 1-based positions just inserted.
  assert.deepEqual(rows(lines.join('\n')), [
    { arm: 'unscoped', line: anchor + 2, rgVar: 'ADMIN_RG' },
    { arm: 'unscoped', line: anchor + 3, rgVar: 'DLZ_RG' },
  ]);
});

test('removing --subscription from the real, WRAPPED warehouse update is caught (the #4765 site)', () => {
  const lines = realLines();
  const site = lines.findIndex((l) => /if az containerapp update -n loom-console -g "\$ADMIN_RG" --subscription "\$ADMIN_SUB" \\$/.test(l));
  assert.ok(site > 0, 'the wrapped warehouse `if az containerapp update … \\` line moved — re-aim this mutation');
  lines[site] = lines[site].replace(' --subscription "$ADMIN_SUB"', '');
  // Breaks if a wrapped `if az …` command is invisible to the scanner (-> []).
  assert.deepEqual(rows(lines.join('\n')), [{ arm: 'unscoped', line: site + 1, rgVar: 'ADMIN_RG' }]);
});

// ── The CLI ────────────────────────────────────────────────────────────────

const runGuard = (args, cwd = REPO) => spawnSync(process.execPath, [GUARD, ...args], { cwd, encoding: 'utf8' });

test('CLI: exits 0 on the real workflow', () => {
  const r = runGuard([]);
  // Breaks on any violation in the workflow, or a control failure (exit 1).
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /all scoped to the matching subscription/);
});

test('CLI: exits 1 on a planted file and annotates the planted line; exits 1 on an empty population and on an unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgscope-'));
  try {
    const planted = join(dir, 'planted.yml');
    writeFileSync(planted, 'steps:\r\n  - run: |\r\n      az keyvault list \\\r\n        -g "$ADMIN_RG" -o tsv\r\n');
    const r = runGuard([planted]);
    // Breaks if the CLI exits 0 on a violation, or annotates the -g line (4) not the az line (3).
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /line=3::unscoped \(\$ADMIN_RG/);

    const empty = join(dir, 'empty.yml');
    writeFileSync(empty, 'steps:\n  - run: echo nothing here\n');
    const e = runGuard([empty]);
    // Breaks if zero guarded commands is reported as a pass.
    assert.equal(e.status, 1, e.stdout);
    assert.match(e.stderr, /found ZERO/);

    const missing = runGuard([join(dir, 'does-not-exist.yml')]);
    // Breaks if an unreadable target is skipped instead of failing.
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(missing.stderr, /cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --self-test runs only the controls and passes', () => {
  const r = runGuard(['--self-test']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-test OK/);
});
