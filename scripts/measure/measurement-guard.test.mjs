#!/usr/bin/env node
/**
 * measurement-guard.test.mjs
 *
 * Run: node --test scripts/measure/measurement-guard.test.mjs
 *
 * NOTE ON LOCATION: this suite tests `.claude/hooks/measurement-guard.mjs` but
 * lives here on purpose. The repo's tree-wide discovery
 * (`scripts/ci/check-node-test-suites.mjs`) has `.claude` in SKIP_DIRS and
 * requires a literal `.test.` in the filename — so a suite named `selftest.mjs`
 * under `.claude/hooks/` is invisible to CI and would rot silently, which is the
 * exact failure #3968 was filed about. Measured, not assumed.
 *
 * POSITIVE cases are the real commands that produced false measurements on
 * 2026-08-23. NEGATIVE cases are legitimate commands that must NOT be blocked —
 * a false denial is the pressure that gets a guard deleted, so they carry equal
 * weight here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, denyBody } from '../../.claude/hooks/measurement-guard.mjs';

const has = (cmd, id) => evaluate(cmd).some((f) => f.id === id);

// ------------------------------------------------------------ rc-after-pipe
test('POSITIVE: the exact seven-apps command is blocked', () => {
  // Verbatim shape from the incident: RC read tr's status, not az's.
  const cmd = `R=$(az monitor metrics list --resource "$ID" --metric Requests -o tsv 2>temp/mx.err | tr -d '\\r')\nRC=$?\necho "requests=$R rc=$RC"`;
  assert.ok(has(cmd, 'rc-after-pipe'), 'must block $? after a pipeline');
});

test('POSITIVE: same-line pipeline then $? is blocked', () => {
  assert.ok(has(`gh pr list --json number | tr -d '\\r'; RC=$?`, 'rc-after-pipe'));
});

test('NEGATIVE: $? on the line after a NON-piped command is allowed', () => {
  const cmd = `az containerapp update -n x -g y --min-replicas 0 > out.txt 2>err.txt\nRC=$?`;
  assert.equal(has(cmd, 'rc-after-pipe'), false, 'the CORRECT form must not be blocked');
});

test('NEGATIVE: a pipeline with no $? capture is allowed', () => {
  assert.equal(has(`gh pr list --json number | python -c "import sys; print(len(sys.stdin.read()))"`, 'rc-after-pipe'), false);
});

test('NEGATIVE: `||` is not a pipe', () => {
  assert.equal(has(`test -f x || echo missing\nRC=$?`, 'rc-after-pipe'), false);
});

test('NEGATIVE: a `|` inside a --jq STRING is not a shell pipe (real false positive)', () => {
  // This exact command was denied by the first version of the guard. The pipe
  // belongs to the jq expression, not the shell. A guard that blocks correct
  // commands is the pressure that gets it deleted.
  const cmd = `gh api "repos/o/r/commits/$SHA/check-runs" --jq '[.check_runs[] | {n:.name,c:.conclusion}]' > out.json 2>err.txt\nRC=$?`;
  assert.equal(has(cmd, 'rc-after-pipe'), false, 'a jq pipe must not be read as a shell pipeline');
});

test('NEGATIVE: a `|` inside a double-quoted awk/sed program is not a shell pipe', () => {
  const cmd = `awk "/a|b/ {print}" file.txt > out.txt 2>err.txt\nRC=$?`;
  assert.equal(has(cmd, 'rc-after-pipe'), false);
});

test('POSITIVE CONTROL for quote-masking: a REAL pipe outside quotes is still caught', () => {
  // Guards the fix above: masking must not blind the rule to genuine pipelines.
  const cmd = `gh api "repos/o/r/x" --jq '.a[] | .b' | tr -d '\\r' > out.txt\nRC=$?`;
  assert.ok(has(cmd, 'rc-after-pipe'), 'a real shell pipe after a quoted jq must still be caught');
});

// ------------------------------------------------------------ msys-arm-id
test('POSITIVE: an ARM id passed to az without MSYS_NO_PATHCONV is blocked', () => {
  const cmd = `az monitor metrics list --resource /subscriptions/aaaaaaaa-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.App/containerApps/app --metric Requests`;
  assert.ok(has(cmd, 'msys-arm-id'), 'must block an unguarded leading-slash ARM id');
});

test('NEGATIVE: the SAME command with MSYS_NO_PATHCONV=1 is allowed', () => {
  const cmd = `MSYS_NO_PATHCONV=1 az monitor metrics list --resource /subscriptions/aaaaaaaa-0000-0000-0000-000000000000/rg --metric Requests`;
  assert.equal(has(cmd, 'msys-arm-id'), false, 'the documented FIX must not be blocked');
});

test('NEGATIVE: an ARM id inside a variable (already resolved) is allowed', () => {
  assert.equal(has(`MSYS_NO_PATHCONV=1 az monitor metrics list --resource "$ID" --metric Requests`, 'msys-arm-id'), false);
});

test('NEGATIVE: a /subscriptions/ path with no az or gh is allowed', () => {
  assert.equal(has(`echo /subscriptions/foo > notes.txt`, 'msys-arm-id'), false);
});

// ------------------------------------------------------------ discarded-stderr
test('POSITIVE: 2>/dev/null on an az call is blocked', () => {
  assert.ok(has(`az kusto cluster show -n c -g g --query state -o tsv 2>/dev/null`, 'discarded-stderr'));
});

test('POSITIVE: 2>/dev/null on a gh call is blocked', () => {
  assert.ok(has(`gh api repos/o/r/commits/abc/check-runs 2>/dev/null`, 'discarded-stderr'));
});

test('NEGATIVE: 2>/dev/null on a non-measurement command is allowed', () => {
  assert.equal(has(`ls .claude/hooks/ 2>/dev/null`, 'discarded-stderr'), false);
});

test('NEGATIVE: redirecting stderr to a FILE is allowed', () => {
  assert.equal(has(`az account show > acct.json 2>acct.err`, 'discarded-stderr'), false);
});

test('NEGATIVE: 2>/dev/null on a NON-measurement, in a script that also runs gh (real false positive)', () => {
  // The redirect belongs to `ps`; `gh` appears on a later line. The first
  // version tested the whole command string for a measurement binary and denied
  // this. Scope must follow the redirect, not the buffer.
  const cmd = `echo "alive: $(ps -ef 2>/dev/null | grep -c '[o]vernight')"\ngh pr list --state open --json number`;
  assert.equal(has(cmd, 'discarded-stderr'), false, 'a redirect on ps must not be attributed to gh');
});

test('POSITIVE CONTROL for segment-scoping: the redirect ON the gh call is still caught', () => {
  // Guards the fix above — narrowing must not blind the rule to the real case.
  const cmd = `echo hi\ngh api repos/o/r/commits/x/check-runs 2>/dev/null`;
  assert.ok(has(cmd, 'discarded-stderr'), 'a redirect on gh itself must still be caught');
});

test('POSITIVE: a piped gh call with the redirect on gh is caught', () => {
  assert.ok(has(`gh pr list --json number 2>/dev/null | head -3`, 'discarded-stderr'));
});

// ------------------------------------------- stderr discarding, by SHAPE
// The rule used to test the literal `2>/dev/null` and nothing else, so every
// other way of throwing stderr away -- including strictly worse ones -- passed.
// These pin the shape rather than the spelling.
test('POSITIVE: &>/dev/null is blocked (it discards BOTH streams — strictly worse)', () => {
  assert.ok(has(`az account show &>/dev/null`, 'discarded-stderr'));
});

test('POSITIVE: the canonical >/dev/null 2>&1 is blocked', () => {
  assert.ok(has(`az account show >/dev/null 2>&1`, 'discarded-stderr'));
});

test('POSITIVE: appending stderr to /dev/null is blocked', () => {
  assert.ok(has(`gh pr list 2>>/dev/null`, 'discarded-stderr'));
});

test('POSITIVE: closing stderr outright (2>&-) is blocked', () => {
  assert.ok(has(`az group list 2>&-`, 'discarded-stderr'));
});

test('NEGATIVE: discarding only STDOUT is allowed — stderr still readable', () => {
  // This is the control that keeps the shape match from widening into "any
  // /dev/null is a finding". Silencing stdout while keeping stderr is a normal,
  // correct thing to do and must not be denied.
  assert.equal(has(`az account show >/dev/null`, 'discarded-stderr'), false);
});

test('NEGATIVE: a non-measurement discarding stderr is still allowed', () => {
  assert.equal(has(`ps -ef 2>/dev/null | grep node`, 'discarded-stderr'), false);
});

// ------------------------------------------------ `python -` interactive REPL
// `python - <<'EOF'` that misses stdin becomes an interactive REPL and loops on
// a traceback forever. It has recurred repeatedly in one session, including by
// agents quoting the prohibition at the time — which is why this is a hook and
// not a note. No count is asserted here: the hook header explains why, and the
// itemised record is the project memory for this hazard.
// The POSITIVE cases below are the literal shapes that were run.
test('POSITIVE: the canonical heredoc is blocked', () => {
  assert.ok(has(`python - <<'EOF'\nprint(1)\nEOF`, 'python-dash-repl'));
});

test('POSITIVE: an EMPTY body is blocked — "harmless" is not a defence', () => {
  // Two of the six were deliberate no-ops. They still hung for the full 120s
  // and still left a REPL to be killed. The construct is the hazard, not what
  // it would have run.
  assert.ok(has(`python - <<'NEVER'\nNEVER`, 'python-dash-repl'));
});

test('POSITIVE: redirecting STDOUT does not make it safe — the loop is on stderr', () => {
  assert.ok(has(`python - > /dev/null 2>&1 <<'X'\nX`, 'python-dash-repl'));
});

test('POSITIVE: the QUIET shape (2>/dev/null) is blocked — no file ever grows', () => {
  // Measured: 8.3 GB of write IO and ~1h CPU with zero file-size movement. This
  // variant is invisible to every size check, so it survives longest.
  assert.ok(has(`python - 2>/dev/null <<'X'\nX`, 'python-dash-repl'));
});

test('POSITIVE: args before the heredoc are blocked', () => {
  assert.ok(has(`python - "$@" <<'PYEOF'\nPYEOF`, 'python-dash-repl'));
});

test('POSITIVE: python3 and a bare trailing dash are blocked', () => {
  assert.ok(has(`python3 - <<EOF\nEOF`, 'python-dash-repl'));
  assert.ok(has(`python -`, 'python-dash-repl'), 'end-of-string must match too');
});

test('POSITIVE: buried on a later line of a multi-line script', () => {
  assert.ok(has(`set -e\ncd /tmp\npython - <<'Z'\nZ`, 'python-dash-repl'));
});

test('NEGATIVE: `python -c` is the sanctioned escape and must not be blocked', () => {
  // If this rule denied -c it would be routed around within a day, and a guard
  // people delete protects nothing.
  assert.equal(has(`python -c "import sys; print(sys.version)"`, 'python-dash-repl'), false);
});

test('NEGATIVE: -m, -u, --version and a plain script path are allowed', () => {
  assert.equal(has(`python -m pytest tests/ -q`, 'python-dash-repl'), false);
  assert.equal(has(`python -u temp/s.py`, 'python-dash-repl'), false);
  assert.equal(has(`python --version`, 'python-dash-repl'), false);
  assert.equal(has(`python temp/script.py`, 'python-dash-repl'), false);
});

test('NEGATIVE: the trap INSIDE quotes is not a command (quote-masking)', () => {
  // Talking about the pattern must stay possible — in a -c program, in an echo,
  // and in a comment. A guard that cannot be discussed cannot be documented.
  assert.equal(has(`python -c "print('python - <<EOF')"`, 'python-dash-repl'), false);
  assert.equal(has(`echo "never run python - <<EOF"`, 'python-dash-repl'), false);
  assert.equal(has(`# python - <<'EOF' is forbidden`, 'python-dash-repl'), false);
});

// ---- false positives found by review; each one denied REAL work ------------
// The first version matched a bare `-` anywhere on the line. These six are the
// shapes that cost, and the first is the one that matters most: a heredoc is
// the only way an agent with no Write tool creates a file, and the rule's own
// FIX text pointed at that tool. A guard that blocks its own documented
// workaround gets deleted, and then it protects nothing.
test('NEGATIVE: writing a FILE whose body mentions the pattern is allowed', () => {
  // Measured: a reviewer was denied twice writing their own verdict file.
  const cmd = `cat > temp/notes.md <<'MD'\nNever run python - <<'EOF'\nit becomes a REPL\nMD\necho done`;
  assert.equal(has(cmd, 'python-dash-repl'), false, 'heredoc BODIES must be exempt');
});

test('NEGATIVE: a heredoc body line starting AT COLUMN 1 is still exempt', () => {
  // THIS is the arm that pins stripHeredocBodies, and the one above is not.
  // Caught by mutation M9: deleting the heredoc strip failed NOTHING, because
  // the body line there reads "Never run python - ..." and command-position
  // anchoring already rejects it. The test passed for a reason it did not
  // claim — the defect this repo keeps paying for.
  //
  // Here the body line IS `python - <<'EOF'` at column 1, which anchoring
  // alone cannot distinguish from a real command. Remove stripHeredocBodies
  // and this goes RED; that is the value that makes it fail.
  const cmd = `cat > temp/doc.md <<'MD'\npython - <<'EOF'\nMD\necho done`;
  assert.equal(has(cmd, 'python-dash-repl'), false,
    'a documented sample at column 1 inside a heredoc must not be read as a command');
});

test('NEGATIVE: a pipe-fed `python -` cannot become a REPL', () => {
  // stdin is a pipe; it reaches EOF. The hazard requires stdin on a terminal.
  assert.equal(has(`cat s.py | python -`, 'python-dash-repl'), false);
  assert.equal(has(`gh api x --jq '.a' | python -`, 'python-dash-repl'), false);
});

test('NEGATIVE: a herestring supplies stdin and has no delimiter to mismatch', () => {
  assert.equal(has(`python - <<<'print(1)'`, 'python-dash-repl'), false);
});

test('BLINDING: a SHORT herestring must not silence the rule for the rest of the command', () => {
  // The blocker from round 2's review, and the sharpest bug in this file's
  // history. `stripHeredocBodies` used `<<(?!<)` to exclude herestrings. A
  // negative LOOKAHEAD only guards the leftmost attempt, so against `<<<x` the
  // engine retried at offset 1, matched `<<` on chars 1-2, and read a heredoc
  // with delimiter `x`. Everything after was blanked as body and the guard
  // stopped watching -- installed, but blind.
  //
  // WHAT MAKES THIS FAIL: revert the `(?<!<)` lookbehind. Then this goes RED
  // while the `print(1)` case above stays GREEN, because `(` breaks the `\2`
  // backreference and accidentally avoids the bug. That is exactly why the
  // one-character delimiter is the arm that matters.
  const cmd = `python - <<<'x'\npython - <<'EOF'\nEOF`;
  assert.ok(has(cmd, 'python-dash-repl'),
    'a herestring must not blank the lines after it');
});

test('BLINDING: a herestring whose delimiter REAPPEARS later still must not blind', () => {
  // The terminator requirement added later subsumes the simple case above, so
  // that arm alone stopped killing the lookbehind mutant — a surviving arm
  // meaning the TEST SET is short, not that the code is right.
  //
  // Here `x` genuinely reappears at the end. Without the `(?<!<)` lookbehind
  // the herestring is read as an opener with delimiter `x`, the terminator
  // check is SATISFIED, and every line between is blanked — hiding the hazard
  // on line 2. WHAT MAKES THIS FAIL: revert the lookbehind.
  const cmd = `python - <<<'x'\npython - <<'EOF'\nEOF\nx`;
  assert.ok(has(cmd, 'python-dash-repl'),
    'lookbehind and terminator check are both load-bearing, for different inputs');
});

test('NEGATIVE: a FILE redirect supplies stdin too, and reaches EOF', () => {
  // Same reasoning as the herestring: the hazard needs stdin open on a
  // terminal. `<` is distinguished from `<<` and `<<<` by lookarounds.
  assert.equal(has(`python - < script.py`, 'python-dash-repl'), false);
});

test('POSITIVE: a redirect on a NON-stdin fd does not exempt a real heredoc', () => {
  // The lone-`<` exemption was too wide: `2<err.txt` redirects fd 2 and leaves
  // fd 0 on the terminal, so the heredoc hazard is fully present.
  assert.ok(has(`python - 2<err.txt <<'EOF'\nEOF`, 'python-dash-repl'));
  assert.ok(has(`python - 3<in.txt <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('POSITIVE: a NON-stdin fd redirect with NO heredoc is still a hazard', () => {
  // THIS is what pins the `[0-9]` in the `(?<![0-9<])` lookbehind, and the two
  // assertions above no longer do. Once heredoc-precedence landed, those were
  // caught by `hasHeredoc` whatever the fd logic did — mutation M12 survived,
  // which is how the lost witness surfaced. Third time in this file that a
  // broader check silently retired an older arm's kill power.
  //
  // Here there is no heredoc at all: fd 2 is redirected, fd 0 is still the
  // terminal, and `python -` becomes a REPL.
  // WHAT MAKES THIS FAIL: drop the `[0-9]` from that lookbehind.
  assert.ok(has(`python - 2>err.txt 2<in.txt`, 'python-dash-repl'));
  assert.ok(has(`python - 3<in.txt`, 'python-dash-repl'));
});

// ---- BLINDING, second class: an opener that is not a redirect --------------
// stripHeredocBodies scans the RAW line, before quote masking and with no
// comment handling, so any `<<IDENT` set delim and blanked the rest of the
// command. Requiring the delimiter to REAPPEAR downstream fixes it, and turns
// every future opener miss into a false positive rather than a silence.
//
// These four are not hypothetical: two of them are verbatim shapes from this
// very test file, and the population this rule serves is "agents quoting the
// prohibition" — exactly the traffic that writes such a line.
//
// EVERY ONE USES `EOF` AS THE HAZARD DELIMITER, DELIBERATELY. An earlier
// version used `Z` and all four passed for that reason alone: the terminator
// check asked whether the phantom delimiter reappears ANYWHERE downstream, not
// BEFORE the hazard, so a rare delimiter avoided the collision. Measured —
// switching the hazard to `EOF` flipped three of the four to ALLOWED. `EOF` is
// 91 of 171 heredoc-opener tokens in this repo (53%, five times the next), so
// the rare choice was the unrealistic one.
test('BLINDING: a `<<IDENT` in a COMMENT must not silence the rest', () => {
  const cmd = `# see the <<EOF trap\npython - <<'EOF'\nEOF`;
  assert.ok(has(cmd, 'python-dash-repl'), 'a comment must not blank the command');
});

test('BLINDING: a `<<IDENT` inside a QUOTED STRING must not silence the rest', () => {
  const cmd = `echo "never write <<EOF here"\npython - <<'EOF'\nEOF`;
  assert.ok(has(cmd, 'python-dash-repl'));
});

test('BLINDING: a `<<IDENT` in a grep PATTERN must not silence the rest', () => {
  const cmd = `grep -n '<<EOF' notes.md\npython - <<'EOF'\nEOF`;
  assert.ok(has(cmd, 'python-dash-repl'));
});

test('BLINDING: an UNTERMINATED opener must not swallow the command', () => {
  // The general form: no matching terminator downstream means it was never a
  // heredoc. Failing this way makes a miss LOUD instead of silent. This one
  // held even under the `Z` delimiter, because `NOPE` genuinely never recurs.
  const cmd = `echo start <<NOPE\npython - <<'EOF'\nEOF`;
  assert.ok(has(cmd, 'python-dash-repl'));
});

test('POSITIVE: a heredoc wins fd 0 even when a `< file` precedes it', () => {
  // The lone-`<` exemption ignored redirect ORDER. bash gives fd 0 to the LAST
  // redirect, and the heredoc is the hazard. Same defect M12 addressed for the
  // fd digit, reached through ordering instead.
  // WHAT MAKES THIS FAIL: drop the `hasHeredoc` precedence check.
  assert.ok(has(`python - < in.txt <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('CONTROL: a REAL terminated heredoc still exempts its body', () => {
  // Pairs with the four above — without this, requiring a terminator could be
  // satisfied by disabling the exemption entirely.
  const cmd = `cat > temp/doc.md <<'MD'\npython - <<'EOF'\nMD\necho done`;
  assert.equal(has(cmd, 'python-dash-repl'), false);
});

test('NEGATIVE: a `-` belonging to the SCRIPT, not to python, is allowed', () => {
  // `-` here means "read input from stdin" to fmt.py; python is not the reader.
  assert.equal(has(`python tools/fmt.py -`, 'python-dash-repl'), false);
});

test('NEGATIVE: the pattern after a trailing `#` comment is allowed', () => {
  assert.equal(has(`ls temp/ # python - <<EOF is the trap`, 'python-dash-repl'), false);
});

// ---- false NEGATIVES closed by anchoring at command position ---------------
test('POSITIVE: versioned and .exe interpreters no longer slip through', () => {
  // Substring matching missed both. Position matching catches them for free.
  assert.ok(has(`python3.11 - <<'EOF'\nEOF`, 'python-dash-repl'));
  assert.ok(has(`python.exe - <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('POSITIVE: env assignments and a path prefix do not hide it', () => {
  assert.ok(has(`PYTHONPATH=lib python - <<'EOF'\nEOF`, 'python-dash-repl'));
  assert.ok(has(`/usr/bin/python - <<'EOF'\nEOF`, 'python-dash-repl'));
  assert.ok(has(`env python - <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('POSITIVE: `||`, `&&`, `;` and `&` do NOT supply stdin, so they still fire', () => {
  // Only a BARE `|` is exculpatory. An earlier draft excluded all of these.
  assert.ok(has(`test -f x || python - <<'E'\nE`, 'python-dash-repl'));
  assert.ok(has(`cd /tmp && python - <<'E'\nE`, 'python-dash-repl'));
  assert.ok(has(`echo hi ; python - <<'E'\nE`, 'python-dash-repl'));
});

test('POSITIVE: the no-space heredoc `python -<<EOF` fires (M7 witness)', () => {
  // This branch of the lookahead had NO test, so deleting `[<>&|]` from it
  // survived the whole suite. Named here as the arm that kills that mutant.
  assert.ok(has(`python -<<EOF\nEOF`, 'python-dash-repl'));
});

test('POSITIVE: an OPTION RUN in front of the dash does not hide it', () => {
  // The dash need not be the first argument. All of these were ALLOWED while
  // carrying the identical hazard — the options in front concealed it.
  // WHAT MAKES THIS FAIL: require the `-` to follow the interpreter directly.
  assert.ok(has(`python -u - <<'EOF'\nEOF`, 'python-dash-repl'));
  assert.ok(has(`python -B - <<'EOF'\nEOF`, 'python-dash-repl'));
  assert.ok(has(`python -X dev - <<'EOF'\nEOF`, 'python-dash-repl'));
  assert.ok(has(`py -3 - <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('CONTROL: -c and -m still do NOT fire, even with options in front', () => {
  // The option run must not swallow `-c`/`-m`: those read from their argument,
  // never from stdin, so they cannot become a REPL. Without this control the
  // widening above would deny the sanctioned escape route.
  assert.equal(has(`python -u -c "print(1)"`, 'python-dash-repl'), false);
  assert.equal(has(`python -B -m pytest -q`, 'python-dash-repl'), false);
  assert.equal(has(`python -u script.py`, 'python-dash-repl'), false);
});

test('the -c/-m EXCLUSION has a witness — a trailing bare dash', () => {
  // Found by review to have NONE: deleting the exclusion left the suite at
  // 79/0, because the control above never reaches it — with no trailing dash,
  // neither version matches. The discriminating input needs the dash present.
  //
  // `python -c "x" -` must NOT fire: `-c` means the interpreter reads its
  // program from the argument, so stdin is never a REPL however the rest looks.
  // WHAT MAKES THIS FAIL: remove the `(?!-[cm](?:\s|$))` lookahead.
  assert.equal(has(`python -c "print(1)" -`, 'python-dash-repl'), false);
  assert.equal(has(`python -m mod -`, 'python-dash-repl'), false);
});

test('NEGATIVE: an option run must not swallow the SCRIPT PATH', () => {
  // A regression introduced by the option-run widening: the optional non-dash
  // token was allowed after ANY option, so the script path was eaten and the
  // trailing `-` (which belongs to the SCRIPT) read as the interpreter's.
  // `python tools/fmt.py -` was already covered; the sibling WITH an option in
  // front was not, so the break was silent.
  // WHAT MAKES THIS FAIL: allow the non-dash token after any option.
  assert.equal(has(`python -u tools/fmt.py -`, 'python-dash-repl'), false);
  assert.equal(has(`python -B setup.py -`, 'python-dash-repl'), false);
});

test('POSITIVE: -W and -X DO consume a word, and the dash after still fires', () => {
  // The paired positive for the narrowing above — without it, restricting the
  // arg-consuming set could be satisfied by removing the branch entirely.
  assert.ok(has(`python -X dev - <<'EOF'\nEOF`, 'python-dash-repl'));
  assert.ok(has(`python -W ignore - <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('the `<<-` TAB-STRIP has a witness — bash really runs the hazard', () => {
  // `allowIndent` and both tab-strips were dead code under `.trim()` and were
  // revived in round 9. Review found the revival had ZERO witness: two mutants
  // survived 79/0 and BOTH install a SILENCE rather than a false positive —
  // measured against real bash, the hazard EXECUTES after a tab-indented
  // dash-form terminator. The suite contained no dash-form heredocs at all.
  //
  // Here the body's terminator is tab-indented under `<<-`, which bash accepts,
  // so the heredoc really ends there and the `python -` on the next line is a
  // real command.
  // WHAT MAKES THIS FAIL: delete the `replace(/^\t+/, '')` in the body scan.
  const cmd = `cat > temp/d.md <<-'MD'\nbody\n\tMD\npython - <<'EOF'\nEOF`;
  assert.ok(has(cmd, 'python-dash-repl'),
    'a tab-indented dash-form terminator ends the heredoc, exposing the hazard');
});

test('CONTROL: a tab-indented terminator under PLAIN `<<` does NOT end it', () => {
  // Pairs with the above: bash strips tabs only for the `<<-` form. Without
  // this control the tab-strip could be applied unconditionally and still pass.
  const cmd = `cat > temp/d.md <<'MD'\nbody\n\tMD\npython - <<'EOF'\nMD\necho ok`;
  assert.equal(has(cmd, 'python-dash-repl'), false,
    'under plain `<<` a tab-indented lookalike is body, not the terminator');
});

test('NEGATIVE: an INDENTED delimiter lookalike must not end the heredoc', () => {
  // bash requires the terminator at COLUMN 0 (tabs-only for `<<-`). Comparing
  // with `.trim()` accepted it at any indentation, so an indented lookalike in
  // the BODY ended the heredoc early, un-blanked the rest, and DENIED a pure
  // file write — verified against a real bash run at exit 0.
  // WHAT MAKES THIS FAIL: compare with `.trim()` instead of `===`.
  const cmd = `cat > temp/doc.md <<'MD'\nexample:\n    MD\npython - <<'EOF'\nMD\necho ok`;
  assert.equal(has(cmd, 'python-dash-repl'), false,
    'an indented `MD` inside the body is not the terminator');
});

// ------------------------------------------------- the deny text is R7-bound
// These exist because a reviewer mutated the headline in BOTH directions and
// both mutants survived the whole suite: the rule-aware framing was a
// correctness fix with no kill power, and that was not disclosed. An
// untestable correctness fix is the shape this file polices.
test('deny text: a python-dash-repl finding must NOT claim a bad measurement', () => {
  // WHAT MAKES THIS FAIL: drop the rule-awareness and always emit the
  // measurement headline. The rule is resource exhaustion, not a wrong number,
  // and recommending measure.mjs for it is advice that does not apply (R7).
  const body = denyBody(evaluate(`python - <<'EOF'\nEOF`));
  assert.match(body, /carries a known hazard/);
  assert.doesNotMatch(body, /measurement you cannot trust/);
  assert.doesNotMatch(body, /measure\.mjs/);
  // Paired positive: the finding itself must still be reported in full.
  assert.match(body, /\[python-dash-repl\]/);
});

test('deny text: a measurement finding STILL gets the measurement framing', () => {
  // The control for the test above. Without this, deleting the feature and
  // always emitting "known hazard" would satisfy the absence assertions.
  const body = denyBody(evaluate(`az account show 2>/dev/null`));
  assert.match(body, /measurement you cannot trust/);
  assert.match(body, /measure\.mjs/);
});

test('deny text: a MIXED finding set gets the measurement framing', () => {
  // The classifier must not let one non-measurement finding suppress advice
  // that is correct for the others.
  const body = denyBody(evaluate(`python - <<'EOF'\nEOF\naz account show 2>/dev/null`));
  assert.match(body, /measurement you cannot trust/);
  assert.match(body, /\[python-dash-repl\]/);
});

test('deny text: an UNKNOWN rule id fails toward the measurement framing', () => {
  // Pins the chosen failure direction so it is a decision, not an accident: a
  // future measurement rule added without touching the set is still labelled
  // correctly; only a new NON-measurement rule would be mislabelled.
  const body = denyBody([{ id: 'some-future-rule', message: 'x' }]);
  assert.match(body, /measurement you cannot trust/);
});

// ---- BLINDING, fourth class: an apostrophe inside a `#` comment -----------
// `maskQuoted` had no comment awareness, so an apostrophe in a comment opened a
// phantom single-quote that masked everything to the next apostrophe or to end
// of input. Confirmed against a real `bash` run: bash executes precisely the
// line the guard blanked.
//
// This one blinded EVERY rule in the file, not just the newest — including
// `rc-after-pipe`, the rule the file was originally built for. Measured
// reachability: 708 comment lines with an odd apostrophe count across 840
// tracked shell/workflow/scripts files. The repo's dominant comment style.
//
// WHAT MAKES THESE FAIL: remove the `#` word-boundary branch from maskQuoted.
test('BLINDING: an apostrophe in a comment must not blank the next line', () => {
  assert.ok(has(`# don't do it\npython - <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('BLINDING: an apostrophe in a comment must not blank a LATER line', () => {
  const cmd = `# agent's note\necho one\necho two\necho three\npython -`;
  assert.ok(has(cmd, 'python-dash-repl'));
});

test('BLINDING: the same defect silenced rc-after-pipe, the original rule', () => {
  // The other maskQuoted consumer. It had no witness for this at all.
  const cmd = `# it's fine\nR=$(az monitor metrics list --resource "$ID" -o tsv | tr -d '\\r')\nRC=$?`;
  assert.ok(has(cmd, 'rc-after-pipe'), 'a comment apostrophe must not blind the pipeline rule');
});

test('CONTROL: a `#` that does NOT begin a word is not a comment', () => {
  // bash starts a comment only at a word boundary. Without this control the fix
  // could widen into "any # blanks the rest", which would mask real arguments.
  assert.ok(has(`python - file#1 <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('CONTROL: a QUOTED apostrophe still masks normally', () => {
  // Pairs with the four above — the comment branch must not disturb ordinary
  // quote handling, which is what keeps the jq false positive fixed.
  const cmd = `gh api "repos/o/r/x" --jq '.a[] | .b' > out.json 2>err.txt\nRC=$?`;
  assert.equal(has(cmd, 'rc-after-pipe'), false, 'a jq pipe must still not read as a shell pipe');
});

// ---- the witness M15 never had -------------------------------------------
// The explicit comment check in stripHeredocBodies was deleted once because
// mutation M15 survived at 68/0, read as "equivalent mutant". It was not: the
// SUITE HAD NO WITNESS. bash starts a comment after `)` and `}` closing a
// control structure, and maskQuoted's word-boundary class omits both.
//
// WHAT MAKES THESE FAIL: delete the `masked.indexOf('#')` check again.
//
// The obvious alternative — widening maskQuoted's class to include `)` — is
// WRONG and must not be adopted: `)` is context-dependent, and the control at
// the bottom of this block is what pins that.
test('BLINDING: a comment after `)` closing a control structure', () => {
  assert.ok(has(`(true)#<<EOF\npython - <<'EOF'\nEOF`, 'python-dash-repl'));
});

test('CONTROL: `}` does NOT start a comment — `{ true; }#x` is a syntax error', () => {
  // An earlier version had a BLINDING arm for `}` and put `}` in the hash
  // class. Measured with `bash -n` on Git Bash 5.3.15: `{ true; }#BOOM` is a
  // SYNTAX ERROR, because `}` is a reserved word only as a standalone word.
  // Defending a shape bash cannot parse bought a real false positive.
  // WHAT MAKES THIS FAIL: put `}` back in the hash class.
  const cmd = `cat > temp/v2}#final.md <<'MD'\npython - <<'EOF'\nMD\necho ok`;
  assert.equal(has(cmd, 'python-dash-repl'), false,
    'a `}` in a filename must not be read as a comment boundary');
});

test('the `)` disagreement is witnessed in BOTH directions', () => {
  // The code asserts the two comment classes must disagree about `)`. M19 pins
  // one direction (dropping `)` from the HASH class). The other — ADDING `)` to
  // maskQuoted's class — passed 75/75, so the assertion was half unwitnessed:
  // a blind test, not an equivalent mutant, which is the exact category the
  // previous round fixed, recurring inside the commit that fixed it.
  //
  // Measured premise: `echo $(echo a)#note with a | tr a-z A-Z` prints
  // `A#NOTE WITH A`, so that `|` is a REAL pipe. If maskQuoted treated `)` as a
  // comment boundary it would mask the pipe and `rc-after-pipe` would go BLIND
  // on correct-to-flag code.
  // WHAT MAKES THIS FAIL: add `)` to maskQuoted's boundary class.
  const cmd = `echo $(echo a)#x | tr a-z A-Z\nRC=$?`;
  assert.ok(has(cmd, 'rc-after-pipe'),
    'a pipe after a substitution-closing `)` must stay visible');
});

test('CONTROL: `)` closing a SUBSTITUTION does not start a comment', () => {
  // `echo $(echo a)#BOOM` prints `a#BOOM` — bash does not treat that `#` as a
  // comment. This is why the fix is a second narrow check rather than widening
  // maskQuoted's word-boundary class: widening would silence the guard here.
  const cmd = `echo $(echo a)#BOOM\npython - <<'EOF'\nEOF`;
  assert.ok(has(cmd, 'python-dash-repl'), 'a substitution `)` must not blank the command');
});

test('the `(` in the word-boundary class has a witness', () => {
  // Found by review to have NONE — dropping `(` survived the whole suite, and
  // 122 distinguishing inputs existed, so it was a BLIND TEST, not an
  // equivalent mutant. That distinction has already been got wrong once in
  // this file and is not being got wrong twice.
  //
  // My first attempt at this witness ALSO failed to discriminate: it used a
  // heredoc opener, which stripHeredocBodies' own hash scan already rejects
  // because THAT class includes `(`. The distinguishing inputs are in the other
  // rules, which consume maskQuoted directly and have no second check.
  //
  // Here a comment opened right after `(` contains a `|`. Without `(` in the
  // class the comment is not masked, the `|` reads as a real pipeline, and
  // `rc-after-pipe` fires on correct code — a false positive. The `RC=$?` must
  // be on the IMMEDIATELY following line; a second attempt at this witness put
  // another command in between and the adjacent-line check never engaged, so it
  // survived too.
  // WHAT MAKES THIS FAIL: remove `(` from maskQuoted's boundary class.
  const cmd = `(#note about a | pipe\nRC=$?`;
  assert.equal(has(cmd, 'rc-after-pipe'), false,
    'a comment opened right after `(` must be masked for every rule');
});

test('NEGATIVE: a `#` in a FILENAME is not a comment', () => {
  // Real false positive found by review: `masked.indexOf('#')` matched the `#`
  // in a filename, so writing a file with `#` in its name while the body quoted
  // the pattern was DENIED. A guard that blocks real work gets deleted.
  // WHAT MAKES THIS FAIL: revert the word-boundary scan to indexOf('#').
  const cmd = `cat > temp/v2#final.md <<'MD'\npython - <<'EOF'\nMD\necho ok`;
  assert.equal(has(cmd, 'python-dash-repl'), false, 'a `#` in a filename is not a comment');
});

test('a CRASHED non-measurement rule is not relabelled as a bad measurement', () => {
  // `${rule.id}-ERRORED` is not in NON_MEASUREMENT_RULES, so the decorated id
  // fell through to the measurement framing — R7 on the error path, which is
  // the path nobody reads until it fires.
  // WHAT MAKES THIS FAIL: classify on `f.id` instead of the base id.
  const body = denyBody([{ id: 'python-dash-repl-ERRORED', message: 'x' }]);
  assert.match(body, /carries a known hazard/);
  assert.doesNotMatch(body, /measurement you cannot trust/);
});

// ---- the deny message must name the RIGHT line ----------------------------
test('R7: a lost newline must not make the message accuse an innocent line', () => {
  // maskQuoted's double-quote escape branch emitted `__` for backslash+anything,
  // preserving LENGTH but destroying a LINE when the escape was a newline. The
  // raw-line index then desynced and the deny text named the wrong command.
  // WHAT MAKES THIS FAIL: restore `out += '__'` in that branch.
  const cmd = `echo "a\\\nb"\necho INNOCENT_BYSTANDER\npython - <<'EOF'\nEOF`;
  const hit = evaluate(cmd).find((f) => f.id === 'python-dash-repl');
  assert.ok(hit, 'the hazard must still be detected');
  assert.match(hit.message, /python -/, 'the offending line must be the hazard');
  assert.doesNotMatch(hit.message, /INNOCENT_BYSTANDER/, 'it must not accuse another line');
});

// ------------------------------------------------------- rule-level failure
test('a rule that THROWS becomes a finding — it is not silently a pass', () => {
  // A crashing rule produced no verdict. Swallowing the throw made a broken rule
  // indistinguishable from a satisfied one, which is the gate-that-cannot-fail
  // shape. Verified through the real evaluate(), by handing it input that is not
  // a string so `raw.split` throws inside every rule.
  const findings = evaluate({ not: 'a string' });
  assert.ok(findings.length > 0, 'a throwing rule must not read as a pass');
  assert.ok(
    findings.every((f) => /-ERRORED$/.test(f.id)),
    `expected only ERRORED findings, got ${findings.map((f) => f.id).join(', ')}`,
  );
  assert.ok(/NOT a pass/.test(findings[0].message));
});

// ------------------------------------------------------------ suite integrity
test('CONTROL: a plainly fine command produces NO findings at all', () => {
  assert.deepEqual(evaluate(`git status --porcelain`), []);
  assert.deepEqual(evaluate(`node --test scripts/measure/selftest.mjs`), []);
});

test('CONTROL: the evaluator returns findings at all (not vacuously empty)', () => {
  const f = evaluate(`R=$(az x | tr -d '\\r')\nRC=$?`);
  assert.ok(f.length > 0, 'if this is empty the whole suite proves nothing');
  assert.ok(/FIX:/.test(f[0].message), 'every finding must name the fix, not just the problem');
});
