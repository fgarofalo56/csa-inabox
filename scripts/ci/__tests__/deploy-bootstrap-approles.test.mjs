#!/usr/bin/env node
/**
 * The post-deploy bootstrap RUNS the shipped Graph app-role script — it does not
 * carry a second copy of it, and it does not tell the operator to run it (#3374,
 * auto-bind-by-default.md §5).
 *
 * ## What was measured, 2026-08-22
 *
 *   grep -rl grant-graph-approles   .github/workflows/  ->  0 files
 *   grep -rl openlineage-pool-setup .github/workflows/  ->  0 files
 *   POSITIVE CONTROLS, same command, same corpus:
 *   grep -rl grant-identity-graph-approles .github/workflows/ -> 2 files
 *   grep -rl grant-shortcut-graph-approles .github/workflows/ -> 1 file
 *
 * So the scan was working and the two scripts genuinely were invoked by nothing.
 *
 * ## …and what the issue's premise got HALF right
 *
 * `grant-graph-approles.sh` was not an unperformed remediation. The bootstrap had
 * been granting the SAME five Graph app-role ids INLINE, in ~75 lines of bash
 * that duplicated the script it never called. That is worse than an omission and
 * quieter: two copies of one grant list drift, and the only symptom is
 * /admin/security silently missing a role nobody noticed was added to just one
 * of them. The fix is not a second step — it is deleting the copy and invoking
 * the script.
 *
 * ## What these assertions pin, and why each is keyed to the SAFE state
 *
 * A guard keyed to the removed pattern (`const AZ`, the inline `curl -X POST`)
 * goes green the moment someone renames it. Every assertion below names the
 * property that must HOLD:
 *
 *   1. the workflow EXECUTES the script — decided by the repo's own
 *      isExecution(), so this guard and check-deploy-paths-coverage cannot
 *      disagree about what "executes" means;
 *   2. check-platform-runs-it-not-you.mjs now SEES it as invoked, which is what
 *      makes any future in-product "run this yourself" string a class-A failure
 *      there rather than a silently-tolerated class B;
 *   3. the five app-role ids live in exactly ONE place — the script — with the
 *      script itself as the positive control, so a zero count cannot be produced
 *      by a broken scan;
 *   4. the 403 marker the workflow branches on still exists in the script.
 *      Renaming it in the script would make that branch unreachable and the
 *      operator would lose the annotation silently; this turns it red instead;
 *   5. the invocation's result is not discarded — no `|| true`, no
 *      `continue-on-error`, no `2>/dev/null` on that step. `bash script.sh`
 *      inherits NO `set -e` from an inline `run:` block, so the RC has to be
 *      taken explicitly or the failure is swallowed;
 *   6. the script is declared in that lane's WATCHED entry, or a commit to it
 *      could never register as deploy drift.
 *
 * Run: node --test scripts/ci/__tests__/deploy-bootstrap-approles.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExecution } from '../check-deploy-paths-coverage.mjs';
import { WATCHED } from '../check-deploy-staleness.mjs';
import { scriptsInvokedByWorkflows } from '../check-platform-runs-it-not-you.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = 'csa-loom-post-deploy-bootstrap.yml';
const SCRIPT_REL = 'scripts/csa-loom/grant-graph-approles.sh';

const wf = readFileSync(path.join(REPO, '.github', 'workflows', WORKFLOW), 'utf8');
const script = readFileSync(path.join(REPO, SCRIPT_REL), 'utf8');

/** The app-role ids the SCRIPT declares — the single source of truth. */
function declaredAppRoleIds() {
  return [...script.matchAll(/"([A-Za-z.]+):([0-9a-fA-F-]{36})"/g)].map((m) => m[2].toLowerCase());
}

test('the bootstrap EXECUTES the shipped script (not merely mentions it)', () => {
  const lines = wf.replace(/\r\n/g, '\n').split('\n');
  const executing = lines.filter((l) => isExecution(l, SCRIPT_REL));
  assert.equal(
    executing.length,
    1,
    `expected exactly ONE execution of ${SCRIPT_REL} in ${WORKFLOW}; found ${executing.length}`,
  );
});

test('check-platform-runs-it-not-you now SEES the script as workflow-invoked', () => {
  // Before this change the script was invoked by nothing, so any in-product
  // string naming it imperatively could only ever be the WEAKER class-B finding
  // ("no workflow runs it — wire it or ACKNOWLEDGE it"). It is now class A:
  // "a workflow already runs it, so stop telling the operator to".
  const invoked = scriptsInvokedByWorkflows(REPO);
  assert.ok(invoked.size > 0, 'the workflow scan found NOTHING — it is broken, so this assertion proves nothing');
  assert.ok(invoked.has('grant-graph-approles.sh'), 'the platform still does not demonstrably run it');
  // Positive controls from the same scan, on the same corpus: the two siblings
  // #3374 named as already-invoked.
  assert.ok(invoked.has('grant-identity-graph-approles.sh'), 'positive control missing — the scan is not measuring what it claims');
  assert.ok(invoked.has('grant-shortcut-graph-approles.sh'), 'positive control missing — the scan is not measuring what it claims');
});

test('the five Graph app-role ids live in exactly ONE place — the script', () => {
  const ids = declaredAppRoleIds();
  // POSITIVE CONTROL for this whole assertion: a broken parse yields an empty
  // list, and an empty list would make "zero of them appear in the workflow"
  // trivially true. The count is pinned.
  assert.equal(ids.length, 5, `the script should declare 5 app-role ids; parsed ${ids.length} — the parse drifted`);
  assert.equal(new Set(ids).size, 5, 'duplicate app-role id in the script');

  const wfLower = wf.toLowerCase();
  const leaked = ids.filter((id) => wfLower.includes(id));
  assert.deepEqual(
    leaked,
    [],
    `${WORKFLOW} still carries app-role id(s) the script owns: ${leaked.join(', ')}. `
    + 'Two copies of one grant list is a drift generator — add a sixth role to the script and the copy silently keeps granting five.',
  );
});

test('the 403 marker the workflow branches on still exists in the script', () => {
  // The script exits 0 on a 403 (the remediation is a one-time TENANT action,
  // not a deploy defect), so the workflow cannot distinguish it by exit code and
  // greps for this marker instead. Renaming it in the script would make that
  // branch silently unreachable and the operator would lose the annotation.
  const MARKER = 'grant 403 FORBIDDEN';
  assert.ok(script.includes(MARKER), `${SCRIPT_REL} no longer prints "${MARKER}" — the workflow's 403 annotation is now dead code`);
  assert.ok(wf.includes(MARKER), `${WORKFLOW} no longer greps for "${MARKER}" — the 403 annotation was dropped`);
});

test('the invocation\'s result is CAPTURED, not discarded', () => {
  // `bash script.sh` inherits NO `set -e` from an inline `run:` block (which
  // GitHub runs as `bash -e {0}`), so removing a `|| true` without capturing the
  // RC changes nothing at all. The step takes the RC on the line immediately
  // after the call and branches on it.
  const lines = wf.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => isExecution(l, SCRIPT_REL));
  assert.ok(at >= 0, 'the invocation was not found — this assertion has a zero population');

  const call = lines[at];
  assert.doesNotMatch(call, /\|\|\s*true/, 'the invocation swallows its own failure with `|| true`');
  assert.doesNotMatch(call, /2>\/dev\/null/, 'the invocation discards stderr — a guard that cannot say why it failed');

  const after = lines.slice(at + 1, at + 4).join('\n');
  assert.match(after, /\$\{PIPESTATUS\[0\]\}|\$\?/, 'no exit status is captured immediately after the invocation');

  // …and the captured status is actually USED. A computed-then-discarded verdict
  // is the "gate that cannot fail" shape.
  const window = lines.slice(at, at + 12).join('\n');
  assert.match(window, /if \[ "\$AR_RC" -ne 0 \]/, 'the captured RC is never branched on');
  assert.match(window, /::warning title=/, 'a non-zero RC produces no operator-visible signal');

  // The step itself must not be excused wholesale.
  const stepStart = lines.slice(0, at).map((l, i) => [l, i]).reverse()
    .find(([l]) => /^\s{6}- name:/.test(l));
  assert.ok(stepStart, 'could not locate the enclosing step');
  const step = lines.slice(stepStart[1], at).join('\n');
  assert.doesNotMatch(step, /continue-on-error:\s*true/, 'the step is excused with continue-on-error — its result cannot fail anything');
});

test('the newly-executed script is DECLARED in that lane\'s WATCHED entry', () => {
  // check-deploy-paths-coverage enforces this too; asserting it here means the
  // reason is recorded next to the change that created the requirement, and a
  // future removal of the entry fails in two independent places.
  const entry = WATCHED.find((e) => e.workflow === WORKFLOW);
  assert.ok(entry, `${WORKFLOW} is not watched at all`);
  assert.ok(
    entry.paths.includes(SCRIPT_REL),
    `${SCRIPT_REL} is executed by ${WORKFLOW} but absent from its paths — a commit to it could never register as deploy drift`,
  );
});
