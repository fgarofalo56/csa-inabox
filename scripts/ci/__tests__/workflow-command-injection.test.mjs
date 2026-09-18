// Pins the ONE property `full-app-deploy-commercial.yml`'s eval-re-baseline
// step depends on for its injection defence: text that came out of an ARM
// RESPONSE cannot BEGIN (or contain) a GitHub Actions workflow command.
//
// WHY THIS FILE EXISTS. PR #4564 round 5 shipped a mitigation that mitigated
// nothing — `sed 's/^::/  ::/'`, indenting a leading `::` by two spaces — on
// the stated rule "response-sourced text never reaches COLUMN 1". The runner's
// rule is not column 1; it is "begins the line AFTER leading whitespace is
// trimmed", so the two spaces were removed by the parser before it looked. The
// two call sites were `>&2`, and round 5 explicitly declined to claim the
// runner command-parses stderr. It does. Both halves are pinned below.
//
// THE RUNNER'S RULE, cited to actions/runner source (fetched, not recalled):
//   src/Runner.Worker/Handlers/ScriptHandler.cs:332-336
//       using (var stdoutManager = new OutputManager(ExecutionContext, ActionCommandManager))
//       using (var stderrManager = new OutputManager(ExecutionContext, ActionCommandManager))
//       ... StepHost.ErrorDataReceived += stderrManager.OnDataReceived;
//     -> stdout AND stderr are both command-parsed, through the SAME manager.
//   src/Runner.Worker/Handlers/OutputManager.cs:83
//       line.IndexOf(ActionCommand.Prefix) >= 0 || line.IndexOf(ActionCommand._commandKey) >= 0
//     -> any line containing `##[` or `::` is handed on.
//   src/Runner.Worker/ActionCommandManager.cs:70-71
//       TryParseV2(...) || TryParse(...)
//   src/Runner.Common/ActionCommand.cs:35-36   Prefix = "##["   _commandKey = "::"
//   src/Runner.Common/ActionCommand.cs:62-64   (TryParseV2, the `::` form)
//       message = message.TrimStart();
//       if (!message.StartsWith(_commandKey)) { return false; }
//   src/Runner.Common/ActionCommand.cs:132     (TryParse, the `##[` form)
//       int prefixIndex = message.IndexOf(Prefix);   // UNANCHORED — anywhere
//
// AND WHAT A "LINE" IS, which round 7 found this file had wrong:
//   src/Runner.Worker/Handlers/ProcessInvoker.cs:511
//       while (!reader.EndOfStream) { string line = reader.ReadLine();
//   dotnet-api-docs xml/System.IO/TextReader.xml:1096 — "A line is defined as
//   a sequence of characters followed by a carriage return (0x000d), a line
//   feed (0x000a), a carriage return followed by a line feed, ... or the end
//   of the reader's input."
// So a BARE CR ends a runner line and `sed` does not split on one. Modelling
// runner lines as LF-split — which this file did — made a CR-bearing attack
// unrepresentable, so the guard could not fail on it. `runnerLines()` below is
// the fix, and the CR entry in ATTACKS is what exercises it.
//
// Only `set-env` and `add-path` consult ACTIONS_ALLOW_UNSECURE_COMMANDS
// (ActionCommandManager.cs:244 and :463 — the only two reads). `add-mask`,
// `stop-commands`, `add-matcher` and `error` are live on a default runner, in
// a PUBLIC repo. `notice` is NOT: ActionCommandManager.cs:75-79 drops it
// unless the server sets `DistributedTask.EnhancedAnnotations`.
//
// NOT A TAUTOLOGY. The sed under test is LIFTED OUT OF THE WORKFLOW at run
// time, never transcribed, so a typo in the workflow cannot pass here. Both
// polarities are present: the retired indent mitigation is kept as a NEGATIVE
// CONTROL and MUST read PARSED, and an undefended line MUST read PARSED, so a
// simulator that had lost the ability to say "command" fails this file rather
// than reporting everything clean.
//
// Run: node --test scripts/ci/__tests__/workflow-command-injection.test.mjs
// CI:  loom-guardrails.yml runs `node --test scripts/ci/__tests__/*.test.mjs`
//      in the required `guardrails` context.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF = resolve(REPO, '.github/workflows/full-app-deploy-commercial.yml');

// `\r` is stripped FIRST: a JS regex `.` does not match `\r`, so every
// line-anchored read below would silently no-op on a CRLF checkout.
const SRC = readFileSync(WF, 'utf8').replace(/\r/g, '');

/**
 * The runner's decision, modelled from the source cited above.
 *
 * Deliberately models the PREFIX step only (not the registered-command-name
 * lookup or the `::` separator scan). That is the fail-CLOSED direction: this
 * can say "command" where the real runner would go on to reject, never the
 * reverse. Every ATTACK string below is a complete, well-formed command, so
 * the approximation costs no kill power on the arms that matter.
 *
 * @returns {false|'v2'|'v1'} false = the runner logs it as ordinary text.
 */
function runnerWouldParse(line) {
  if (typeof line !== 'string' || line.length === 0) return false;
  // OutputManager.cs:83 — the cheap pre-filter.
  if (!(line.includes('##[') || line.includes('::'))) return false;
  // ActionCommand.cs:62-64 — TrimStart() THEN StartsWith("::").
  if (line.trimStart().startsWith('::')) return 'v2';
  // ActionCommand.cs:132 — unanchored IndexOf("##["), so position is irrelevant.
  if (line.includes('##[')) return 'v1';
  return false;
}

/** Split a `sed …` command line into argv, respecting single quotes. */
function argvOf(cmdline) {
  return [...cmdline.matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
}

/**
 * Split text the way the RUNNER does, not the way `sed` does.
 *
 * TextReader.ReadLine() ends a line on CR, LF, or CRLF (cited in the header),
 * so this is `/\r\n|\r|\n/` and NOT `split('\n')`. The difference is the whole
 * of round 7's blocker: `sed 's|^|az> |'` prefixes per LF-line, so one 0x0D
 * inside a sed line yields a SECOND runner line that carries no prefix.
 *
 * WHAT VALUE WOULD MAKE A CALLER OF THIS FAIL: any defused output still
 * containing a raw 0x0D before a `::` — which is exactly what the live sed
 * produced before the `s|\r|%0D|g` expression was added.
 */
function runnerLines(text) {
  return text.replace(/(?:\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/);
}

/** Run a real sed with the given args over `input`, failing closed if sed did not run. */
function runSed(args, input) {
  const r = spawnSync('sed', args, { input, encoding: 'utf8' });
  // Positive control on the INSTRUMENT: a missing/failed sed must not read as
  // "produced no dangerous output". Blind-instrument class, csa-inabox memory.
  assert.equal(r.error, undefined, `sed did not run (${r.error && r.error.message}) — this file measured NOTHING`);
  assert.equal(r.status, 0, `sed exited ${r.status}: ${r.stderr}`);
  // Deliberately the RUNNER's line rule. Splitting on LF here is what made the
  // CR attack below unrepresentable; do not "simplify" it back.
  return runnerLines(r.stdout);
}

// --- The mitigation, LIFTED from the workflow (never transcribed) ------------

let _lifted;
/** Pull defuse_cmds()'s real sed argv out of the workflow. Memoized. */
function liveSed() {
  if (_lifted) return _lifted;
  const fnMatch = SRC.match(/\n[ \t]*defuse_cmds\(\)[ \t]*\{[^\n]*\n([\s\S]*?)\n[ \t]*\}\n/);
  assert.ok(
    fnMatch,
    'defuse_cmds() is not defined in full-app-deploy-commercial.yml. FAILS IF: the function is renamed or deleted — in which case nothing here measured the live mitigation.',
  );
  const sedLine = fnMatch[1]
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.startsWith('sed '));
  assert.ok(sedLine, `defuse_cmds() has no sed line; body was:\n${fnMatch[1]}`);
  const argv = argvOf(sedLine);
  assert.equal(argv[0], 'sed', `expected defuse_cmds to shell out to sed, got: ${sedLine}`);
  _lifted = argv.slice(1);
  return _lifted;
}

// The retired round-5 mitigation, kept ONLY as the negative control.
const RETIRED_INDENT_SED = ['-e', 's/^::/  ::/'];

const ATTACKS = [
  '::add-mask::AAAAAAAAAAAA',
  '::stop-commands::x9f2a1',
  '::error::forged by ARM',
  '##[add-mask]AAAAAAAAAAAA',
  'ERROR: the resource ##[stop-commands]x9f2a1 was not found', // `##[` mid-line: unanchored
  // ROUND 7. A BARE CR, mid-line. `sed` sees ONE line and prefixes it once;
  // the runner's ReadLine() sees TWO and the second begins `::`. Reachable at
  // the op19 site: check-retired-function-timers.sh echoes the raw
  // `AzureWebJobs.<fn>.Disabled` app-setting value on its ENABLED arm, and an
  // app-setting value is writable by exactly the out-of-band portal persona
  // that job exists to detect — so a stop-commands directive planted there
  // would suppress the `::error::` that names the hazard.
  // WHAT VALUE MAKES THE LIVE-DEFUSE TEST FAIL: this one, against any sed that
  // lacks the `s|\r|%0D|g` expression. Demonstrated RED in the PR receipt.
  'ERROR: bad\r::stop-commands::x9f2a1',
];
const BENIGN = [
  'ERROR: (AuthorizationFailed) The client does not have authorization',
  "ERROR: ResourceNotFound: the Resource 'Microsoft.App/jobs/x' was not found",
  'az::note - a mid-line double colon is not a command',
];

test('positive control: an UNDEFENDED attack line IS parsed as a workflow command', () => {
  // WHAT VALUE MAKES THIS FAIL: any ATTACKS entry that is not actually a
  // command. Without this arm, a simulator that had lost the ability to ever
  // return non-false would report the mitigation perfect.
  //
  // Split through runnerLines() first, because that IS the runner's rule — the
  // CR entry is a command only on the second runner line it produces, and
  // asserting on the undefended string whole would read it as harmless.
  for (const attack of ATTACKS) {
    const lines = runnerLines(attack);
    assert.ok(
      lines.some((l) => runnerWouldParse(l) !== false),
      `undefended attack read as harmless: ${JSON.stringify(attack)}`,
    );
  }
});

test('negative control: a PREFIX-ONLY sed is defeated by one bare CR (the round-7 defect)', () => {
  // The round-7 blocker, pinned as its own fact so a future 'simplification'
  // of runnerLines() back to split(LF) goes red HERE, with a message that says
  // why, rather than silently disarming the CR arm in ATTACKS.
  // WHAT VALUE MAKES THIS FAIL: a runnerLines() that splits on LF only (then
  // out.length is 1 and the assertion on the second line throws), or a
  // TextReader that did not end a line on 0x0D -- TextReader.xml:1096 says it
  // does.
  assert.deepEqual(runnerLines('a\rb'), ['a', 'b'], 'runnerLines() must end a line on a bare CR (TextReader.xml:1096)');
  assert.deepEqual(runnerLines('a\r\nb'), ['a', 'b'], 'CRLF is ONE terminator, not two');

  // The mitigation as it stood BEFORE this round: prefix + hash-bracket, no CR
  // expression. sed emits ONE line; the runner reads TWO; the second is a live
  // command. This is the exact shape the live sed must no longer produce, and
  // it is what the CR entry in ATTACKS catches over there.
  const PREFIX_ONLY_SED = ['-e', 's|^|az> |', '-e', 's|##\\[|## [|g'];
  const out = runSed(PREFIX_ONLY_SED, 'ERROR: bad\r::stop-commands::x9f2a1\n');
  assert.equal(out.length, 2, 'the CR fixture must yield TWO runner lines out of ONE sed line');
  assert.equal(out[0], 'az> ERROR: bad', 'only the FIRST runner line got the prefix');
  assert.equal(
    runnerWouldParse(out[1]),
    'v2',
    `the unprefixed second runner line must still be a command, or this control proves nothing: ${JSON.stringify(out[1])}`,
  );
});

test('negative control: the RETIRED indent mitigation does NOT stop a command (this is the round-5 defect)', () => {
  // WHAT VALUE MAKES THIS FAIL: a runner that did not TrimStart() before
  // testing the prefix. ActionCommand.cs:62-64 says it does.
  const out = runSed(RETIRED_INDENT_SED, '::add-mask::AAAAAAAAAAAA\n::stop-commands::x9f2a1\n');
  assert.deepEqual(out, ['  ::add-mask::AAAAAAAAAAAA', '  ::stop-commands::x9f2a1']);
  for (const line of out) {
    assert.equal(
      runnerWouldParse(line),
      'v2',
      `indenting was supposed to be the defence, and it is not: ${JSON.stringify(line)} still parses`,
    );
  }
});

test('the LIVE defuse_cmds neutralises every attack shape, on stdout AND stderr alike', () => {
  // WHAT VALUE MAKES THIS FAIL: a defuse_cmds whose prefix is whitespace (it
  // would be trimmed), or that leaves `##[` intact anywhere in the line, or —
  // the round-7 arm — that leaves a bare CR in place, which splits ONE sed
  // line into TWO runner lines and prefixes only the first.
  const out = runSed(liveSed(), ATTACKS.join('\n') + '\n');
  assert.equal(
    out.length,
    ATTACKS.length,
    `defuse_cmds changed the RUNNER LINE COUNT — it must not. More lines out than attacks in means a ` +
      `terminator survived defusing (a bare CR is one: TextReader.xml:1096), so some runner line got no prefix.`,
  );
  out.forEach((line, i) => {
    assert.equal(
      runnerWouldParse(line),
      false,
      `defuse_cmds left a parseable command: ${JSON.stringify(ATTACKS[i])} -> ${JSON.stringify(line)}`,
    );
  });
});

test('defuse_cmds truncates nothing — the full az diagnostic survives', () => {
  // WHAT VALUE MAKES THIS FAIL: swapping defuse_cmds for `flatten`, or adding
  // a `cut`. Keeping the whole diagnostic is the reason this is not `flatten`.
  const long = 'ERROR: ' + 'x'.repeat(900) + ' :: tail';
  const [out] = runSed(liveSed(), long + '\n');
  assert.ok(out.endsWith(long), `defuse_cmds altered or truncated the payload: ${JSON.stringify(out.slice(-40))}`);
  assert.ok(out.length > 900, `expected the full ${long.length}-char line, got ${out.length}`);
});

test('defuse_cmds leaves benign az output readable', () => {
  // WHAT VALUE MAKES THIS FAIL: a defence that mangles ordinary diagnostics —
  // the failure mode that would push a future author back to bare `cat`.
  const out = runSed(liveSed(), BENIGN.join('\n') + '\n');
  out.forEach((line, i) => {
    assert.equal(runnerWouldParse(line), false, `benign line became a command: ${line}`);
    assert.ok(line.endsWith(BENIGN[i]), `benign line was altered beyond a prefix: ${JSON.stringify(line)}`);
  });
});

test('both ARM-stderr sites go through defuse_cmds, and the retired name is gone', () => {
  // WHAT VALUE MAKES THIS FAIL: a third `cat arm_err.txt >&2` added later, or
  // either existing site reverted to `cat`. This is the reachability half —
  // the mitigation being correct is worth nothing if a site bypasses it.
  const defused = [...SRC.matchAll(/^[ \t]*defuse_cmds < arm_err\.txt >&2$/gm)];
  assert.equal(defused.length, 2, `expected 2 defuse_cmds sites over arm_err.txt, found ${defused.length}`);
  const raw = [...SRC.matchAll(/^[ \t]*(?:cat|tee|printf|echo)[^\n]*arm_err\.txt[^\n]*>&2/gm)];
  assert.deepEqual(raw.map((m) => m[0].trim()), [], 'arm_err.txt reaches stderr without defuse_cmds');
  assert.equal(SRC.includes('indent_cmds'), false, 'the retired indent_cmds name is still present');
  assert.equal(/sed [^\n]*\^::/.test(SRC), false, 'an indent-only `^::` defence has come back');
});

// --- The second site in this class: loom-drift-check.yml's op19 step ---------
//
// `check-retired-function-timers.sh` runs az with its stderr UNCAPTURED, so
// wiring it into a workflow made that stderr command-parseable. The step pipes
// the whole thing through the same shape as defuse_cmds; that is pinned here
// rather than trusted, and lifted from the workflow the same way.

const DRIFT = readFileSync(resolve(REPO, '.github/workflows/loom-drift-check.yml'), 'utf8').replace(/\r/g, '');

test('loom-drift-check op19: the script is invoked, and its output is defused', () => {
  // WHAT VALUE MAKES THIS FAIL: dropping the `2>&1`, dropping the sed, or
  // swapping the prefix for whitespace. Each is checked by running the LIFTED
  // sed over a real attack line, not by matching on its text.
  const invoke = DRIFT.match(
    /^[ \t]*bash scripts\/csa-loom\/check-retired-function-timers\.sh 2>&1[ \t]*\\\n([\s\S]*?)\n[ \t]*\|[ \t]*tee /m,
  );
  assert.ok(
    invoke,
    'the op19 step no longer invokes check-retired-function-timers.sh with `2>&1 | … | tee`. FAILS IF: the pipeline is restructured — re-pin it here, do not delete this arm.',
  );
  const sedLine = invoke[1]
    .split('\n')
    .map((s) => s.trim().replace(/\\$/, '').trim())
    .find((s) => s.startsWith('| sed ') || s.startsWith('sed '));
  assert.ok(sedLine, `no sed stage in the op19 pipeline; captured:\n${invoke[1]}`);
  const args = argvOf(sedLine.replace(/^\|\s*/, '')).slice(1);
  const out = runSed(args, ATTACKS.join('\n') + '\n');
  out.forEach((line, i) => {
    assert.equal(
      runnerWouldParse(line),
      false,
      `op19's filter left a parseable command: ${JSON.stringify(ATTACKS[i])} -> ${JSON.stringify(line)}`,
    );
  });
  // Paired positive assertion: "no command survived" must not be satisfiable
  // by a filter that ate the output.
  assert.equal(out.length, ATTACKS.length, "op19's filter changed the line count");
});
