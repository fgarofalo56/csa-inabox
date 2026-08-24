#!/usr/bin/env node
/**
 * #3916 — the deploy's TARGET SUBSCRIPTION is resolved, never assumed, and an
 * unresolvable one REFUSES rather than reaching a step as the empty string.
 *
 * ## What was wrong
 *
 * `deploy-fiab-commercial.yml` failed at 06:48Z on 2026-08-23, ~3h after #3888
 * merged, with:
 *
 *     No target subscription, so the live DNS resolver inbound endpoint cannot
 *     be located. It comes from the topology guard's deploy_sub output; it is
 *     empty.
 *
 * The guard was NOT defective and `deploy_sub` was NOT wrong. `deploy_sub`'s
 * documented contract (deploy-fiab-guard.mjs:18) is that '' means "the login
 * subscription" — omit `--subscription`. It is empty on EVERY scheduled run by
 * construction: it derives from `CSA_LOOM_SUBSCRIPTION_OVERRIDE` =
 * `inputs.subscription`, and a `schedule` event carries no inputs. The passing
 * 2026-08-22 run had it empty at all eight consumption sites and deployed fine.
 *
 * #3888 ported two steps written for an operator dispatch onto the scheduled
 * lane. Both compose a LITERAL ARM resource id (`/subscriptions/<id>/...`),
 * which cannot inherit the CLI's active subscription — so both needed a value
 * that no guard output produced, read `deploy_sub`, found the documented empty
 * string, and hard-failed the P0 deploy path.
 *
 * The fix adds `target_sub`: the literal subscription this deploy lands in,
 * resolved from the explicit input or the login subscription, and NEVER empty
 * on a proceed — the guard refuses instead.
 *
 * ## Why the arms are shaped this way
 *
 * The BROAD control removes the fail-closed entirely. The NARROW control is the
 * one that matters in this repo: a bypass scoped to a single topology value
 * passes a guard that only checks the common case, while the broad form goes red
 * instantly. So the reachable-unresolved population is enumerated and asserted
 * ELEMENT BY ELEMENT — '' / 'tenant' / 'single-sub'. ('dlz-attach' is excluded
 * with cause: resolveTopologyGuard refuses it before this code when its
 * target_subscription is absent, so "unresolved" is unreachable there.)
 *
 * ## What #3947 added
 *
 * Independent review of the above found two of its own arms hollow:
 *
 *   F1  the workflow population filter was keyed to the SPELLING #3888 used, so
 *       7 of 8 ordinary bash emptiness idioms walked past it, and one step —
 *       the one that binds deploy_sub to ADMIN_SUB — was outside its population
 *       entirely. It is now keyed to the property, with a per-idiom control.
 *   F2  no case supplied BOTH an explicit subscription and a login one, so
 *       swapping their precedence (a cross-subscription deploy) left the suite
 *       green. Both the assertion and its mutation control are below.
 *
 * Run: node --test scripts/ci/__tests__/deploy-target-subscription.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveTargetSubscription,
  parseSubscriptionId,
} from '../deploy-trigger-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'ci', 'deploy-fiab-guard.mjs');
const POLICY = path.join(REPO, 'scripts', 'ci', 'deploy-trigger-policy.mjs');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'deploy-fiab-commercial.yml');
const IS_WIN = process.platform === 'win32';

/** Syntactically valid, deliberately not a real subscription. */
const FAKE_SUB = '00000000-1111-2222-3333-444444444444';
const FAKE_DLZ_SUB = '00000000-5555-6666-7777-888888888888';
/** A THIRD distinct fake, so precedence assertions cannot pass by coincidence. */
const FAKE_LOGIN_SUB = '00000000-9999-aaaa-bbbb-cccccccccccc';

/**
 * The topology values on which "no subscription could be established" is
 * REACHABLE. Enumerated as data so the narrow-mutation arm below can iterate it:
 * a fail-closed scoped to one of these leaves the others emitting empty, which
 * is exactly the bypass shape that has passed broad guards in this repo before.
 */
const UNRESOLVABLE_TOPOLOGIES = ['', 'tenant', 'single-sub'];

// ---------------------------------------------------------------------------
// The pure resolver — the contract, stated as assertions.
// ---------------------------------------------------------------------------

test('an explicit subscription input wins, and costs no az call', () => {
  const r = resolveTargetSubscription({ topology: 'tenant', subscriptionOverride: FAKE_SUB });
  assert.equal(r.targetSub, FAKE_SUB);
  assert.equal(r.source, 'subscription_input');
});

test('with BOTH supplied, the INPUT beats the login subscription (#3947 F2)', () => {
  // Unasserted until #3947: no case supplied both, so swapping the two blocks
  // in resolveTargetSubscription left the whole suite green (mutation 12 on
  // #3944). The failure mode that swap produces is a CROSS-SUBSCRIPTION deploy
  // — an operator names a subscription, the runner is logged in elsewhere, and
  // the estate is built in the wrong one. Materially worse than the outage
  // #3916 fixed, and silent.
  //
  // Two DISTINCT fakes: the dlz-attach case below passes the same value as both
  // override and login, so it discriminates nothing about precedence.
  const r = resolveTargetSubscription({
    topology: 'tenant',
    subscriptionOverride: FAKE_SUB,
    loginSubscription: FAKE_LOGIN_SUB,
  });
  assert.equal(r.targetSub, FAKE_SUB, 'the login subscription overrode an explicitly named one');
  assert.equal(r.source, 'subscription_input');
});

test('with NO input, the LOGIN subscription is the answer — this is the #3916 path', () => {
  // The scheduled reconcile: no inputs, so deploy_sub is legitimately '' and
  // target_sub must still resolve to a literal id.
  const r = resolveTargetSubscription({ topology: '', loginSubscription: FAKE_SUB });
  assert.equal(r.targetSub, FAKE_SUB);
  assert.equal(r.source, 'login');
});

test('dlz-attach resolves ONLY from target_subscription, never the login sub', () => {
  // Silently attaching a landing zone to whatever subscription the CLI happened
  // to point at is the mis-target the topology guard exists to prevent, so the
  // login fallback must NOT apply here.
  const r = resolveTargetSubscription({
    topology: 'dlz-attach',
    targetSubscription: FAKE_DLZ_SUB,
    subscriptionOverride: FAKE_SUB,
    loginSubscription: FAKE_SUB,
  });
  assert.equal(r.targetSub, FAKE_DLZ_SUB);
  assert.equal(r.source, 'target_subscription');

  const none = resolveTargetSubscription({ topology: 'dlz-attach', loginSubscription: FAKE_SUB });
  assert.equal(none.source, 'unresolved');
  assert.equal(none.targetSub, '', 'the login sub leaked into a dlz-attach target');
});

test('nothing established -> UNRESOLVED, and targetSub is empty ONLY then', () => {
  for (const topology of UNRESOLVABLE_TOPOLOGIES) {
    const r = resolveTargetSubscription({ topology });
    assert.equal(r.source, 'unresolved', `topology=${JSON.stringify(topology)}`);
    assert.equal(r.targetSub, '', `topology=${JSON.stringify(topology)}`);
  }
});

test('parseSubscriptionId keeps UNKNOWN distinct from a subscription id', () => {
  // az writes a trailing CR on some runners; a subscription id carrying one
  // builds an ARM resource id that 404s while LOOKING correct in the log.
  assert.equal(parseSubscriptionId(`${FAKE_SUB}\r\n`), FAKE_SUB);
  assert.equal(parseSubscriptionId(`  ${FAKE_SUB}  `), FAKE_SUB);
  // A FAILED az call leaves an empty string or an error blob. Neither may ever
  // render as a subscription (deploy-integrity R7).
  for (const notASub of ['', '   ', '\r\n', 'ERROR: Please run az login', 'null', 'None',
    'not-a-guid', `${FAKE_SUB}-extra`, `x${FAKE_SUB}`]) {
    assert.equal(parseSubscriptionId(notASub), '', `accepted ${JSON.stringify(notASub)} as a subscription`);
  }
});

// ---------------------------------------------------------------------------
// The guard, spawned — does the fail-closed actually have teeth?
// ---------------------------------------------------------------------------

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-target-sub-'));
const FAKE_AZ = path.join(SCRATCH, 'loom-not-a-real-cli');
test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/**
 * Spawn the guard with an UNREACHABLE Azure CLI and read what it wrote to
 * $GITHUB_OUTPUT.
 *
 * `schedule` is the trigger under test and the one that broke: on a schedule an
 * UNKNOWN hub count PROCEEDS, so the run reaches the target-subscription
 * resolution instead of refusing earlier for an unrelated reason.
 *
 * PATH is scrubbed so a workstation or runner that HAS the Azure CLI cannot let
 * a real `az account show` answer and turn the refuse arms green by accident.
 */
function runGuard(extraEnv = {}, script = SCRIPT) {
  const scrubbedPath = IS_WIN
    ? [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      process.env.SystemRoot || 'C:\\Windows',
    ].join(';')
    : '';
  const outFile = path.join(SCRATCH, `out-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(outFile, '');
  const env = {
    PATH: scrubbedPath,
    Path: scrubbedPath,
    ...(IS_WIN
      ? { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() }
      : {}),
    GITHUB_OUTPUT: outFile,
    GITHUB_EVENT_NAME: 'schedule',
    LOOM_AZ_BIN: FAKE_AZ,
    CSA_LOOM_TOPOLOGY: '',
    CSA_LOOM_TARGET_SUBSCRIPTION: '',
    CSA_LOOM_SUBSCRIPTION_OVERRIDE: '',
    INPUT_ALLOW_EXISTING_HUB: '',
    INPUT_PURVIEW_ENABLED: '',
    INPUT_AZURE_MAPS_ENABLED: '',
    INPUT_FIREWALL_ENABLED: '',
    INPUT_DEPLOY_APPS_ENABLED: '',
    INPUT_SKIP_ROLE_GRANTS: '',
    INPUT_FRONT_DOOR_ENABLED: '',
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, cwd: REPO });
  const outputs = new Map(
    fs.readFileSync(outFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const eq = l.indexOf('=');
        return [l.slice(0, eq), l.slice(eq + 1)];
      }),
  );
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, outputs };
}

test('CLEAN — a scheduled run with an UNREADABLE login subscription REFUSES', () => {
  const r = runGuard();

  assert.equal(r.status, 1, `an unresolvable target subscription must REFUSE; output:\n${r.out}`);
  assert.match(r.out, /could not establish which subscription this deploy targets/, r.out);
  // R7: the message must say UNKNOWN, not "absent".
  assert.match(r.out, /This is UNKNOWN, not absent/, r.out);
  // The lookup was actually ATTEMPTED, and the attempt named the binary it
  // spawned — proof the resolver reaches a real spawn rather than being a
  // string nothing consults.
  assert.ok(
    r.out.includes(`could not read the login subscription (az binary: ${FAKE_AZ})`),
    `the guard never attempted an az account show:\n${r.out}`,
  );
  // And it must NOT have emitted the empty string that broke the deploy.
  assert.equal(
    r.outputs.get('target_sub'),
    undefined,
    `the guard emitted target_sub='${r.outputs.get('target_sub')}' instead of refusing — this IS the #3916 defect`,
  );
});

test('CLEAN — deploy_sub is still EMPTY on a schedule, and that is correct', () => {
  // The load-bearing negative. `deploy_sub`'s contract is that '' means "the
  // login subscription"; sixteen steps in the workflow rely on it. "Fixing" the
  // guard to stop emitting empty would make all of them start pinning a
  // subscription they deliberately inherit. This pins that the #3916 fix did
  // NOT do that.
  const r = runGuard({ CSA_LOOM_SUBSCRIPTION_OVERRIDE: FAKE_SUB });
  assert.equal(r.status, 0, `the guard should proceed with an explicit subscription:\n${r.out}`);
  assert.equal(r.outputs.get('target_sub'), FAKE_SUB);

  const sched = runGuard({ CSA_LOOM_SUBSCRIPTION_OVERRIDE: '', LOOM_AZ_BIN: FAKE_AZ });
  assert.equal(sched.outputs.get('deploy_sub'), '',
    'deploy_sub must still be emitted, and still be EMPTY, on a schedule — sixteen steps depend on that contract');
});

test('CLEAN — the guard emits the RESOLVED topology, not inputs.topology', () => {
  // The dead-branch half of #3916: both #3888 steps early-exit on
  // `topology == 'dlz-attach'` read from CSA_LOOM_TOPOLOGY, which IS
  // inputs.topology and is '' on a schedule — so the branch was unreachable on
  // the trigger that runs daily.
  const r = runGuard({ CSA_LOOM_SUBSCRIPTION_OVERRIDE: FAKE_SUB, CSA_LOOM_TOPOLOGY: '' });
  assert.equal(r.outputs.get('topology'), 'tenant',
    'an empty inputs.topology must be emitted RESOLVED, or consumers keep re-deriving it wrong');
});

// ---------------------------------------------------------------------------
// Mutation controls — does the measurement MOVE?
// ---------------------------------------------------------------------------

/**
 * Apply a line mutation to a COPY of the guard and run it.
 *
 * The copy sits beside the original so its relative import of
 * ./deploy-trigger-policy.mjs still resolves. The original is asserted
 * byte-identical afterwards: a suite that rewrites a deploy script in place can
 * leave the tree dirty if it dies mid-test.
 *
 * `needle` MUST match exactly once. These files are CRLF, and a needle written
 * with LF matches ZERO times — which reads exactly like a passing mutation test
 * while proving nothing.
 */
function withMutatedGuard(needle, replacement, fn) {
  const original = fs.readFileSync(SCRIPT, 'utf8');
  const hits = original.split(needle).length - 1;
  assert.equal(hits, 1, `the mutation needle matched ${hits} times, not once — this control proves NOTHING`);
  const mutant = path.join(REPO, 'scripts', 'ci', `deploy-fiab-guard.__control_${Math.random().toString(36).slice(2)}__.mjs`);
  fs.writeFileSync(mutant, original.replace(needle, replacement));
  try {
    return fn(mutant);
  } finally {
    fs.rmSync(mutant, { force: true });
    assert.equal(fs.readFileSync(SCRIPT, 'utf8'), original, 'the real guard must be untouched by this control');
  }
}

test('CONTROL (BROAD) — removing the fail-closed re-emits the EMPTY target_sub', () => {
  // The exact pre-#3916 behaviour: proceed, emit '', and let a downstream step
  // discover it. If this arm still refused, the assertion above would be
  // measuring something other than the fail-closed.
  const r = withMutatedGuard(
    "if (target.source === 'unresolved') {",
    'if (false) {',
    (mutant) => runGuard({}, mutant),
  );
  assert.equal(r.status, 0, `the mutant must PROCEED — otherwise the arms do not differ:\n${r.out}`);
  assert.equal(r.outputs.get('target_sub'), '',
    'the mutant did not reproduce the empty output, so the CLEAN arm proves nothing');
});

test('CONTROL (NARROW) — a fail-closed scoped to ONE topology is still caught', () => {
  // The bypass shape this repo keeps shipping: narrow the guard to a single
  // value and it passes a check that only exercises the common case. Every
  // reachable topology is asserted individually, so scoping the refusal to
  // 'tenant' leaves '' and 'single-sub' emitting empty and this goes red.
  const r = withMutatedGuard(
    "if (target.source === 'unresolved') {",
    "if (target.source === 'unresolved' && effectiveTopology === 'tenant') {",
    (mutant) => {
      const results = {};
      for (const topology of UNRESOLVABLE_TOPOLOGIES) {
        results[topology] = runGuard({ CSA_LOOM_TOPOLOGY: topology }, mutant);
      }
      return results;
    },
  );

  // 'tenant' still refuses under the narrow mutation — that is the whole point:
  // a suite asserting only this value would go GREEN on the bypass.
  assert.equal(r.tenant.status, 1, 'the narrow mutation should still refuse for topology=tenant');

  // MEASURED, not assumed: '' and 'tenant' are NOT independent inputs. The
  // resolver collapses '' -> 'tenant', so a mutation scoped to 'tenant' covers
  // both and only 'single-sub' can leak. The first cut of this control expected
  // ['', 'single-sub'] and went red for that reason — two inputs that cannot
  // differ cannot discriminate anything, and pinning the collapse here stops a
  // later reader from re-deriving a population that looks larger than it is.
  assert.equal(r[''].status, r.tenant.status,
    "'' and 'tenant' must resolve identically — if they ever diverge this control's population is wrong");

  const leaked = UNRESOLVABLE_TOPOLOGIES.filter((t) => r[t].outputs.get('target_sub') === '');
  assert.deepEqual(
    leaked,
    ['single-sub'],
    `the narrow mutation did not leak where expected — the population is wrong, so this control cannot discriminate. statuses: ${
      UNRESOLVABLE_TOPOLOGIES.map((t) => `${JSON.stringify(t)}=${r[t].status}`).join(' ')}`,
  );
});

test('CLEAN — the un-mutated guard refuses on EVERY reachable topology', () => {
  // The positive form of the narrow control: the property the fix must hold.
  for (const topology of UNRESOLVABLE_TOPOLOGIES) {
    const r = runGuard({ CSA_LOOM_TOPOLOGY: topology });
    assert.equal(r.status, 1, `topology=${JSON.stringify(topology)} did not refuse:\n${r.out}`);
    assert.equal(r.outputs.get('target_sub'), undefined,
      `topology=${JSON.stringify(topology)} emitted an empty target_sub`);
  }
});

/**
 * The same control, one layer down: mutate the PURE resolver and import the
 * copy. Same contract as {@link withMutatedGuard} — needle matches exactly
 * once, sibling copy so the relative imports resolve, original asserted
 * byte-identical afterwards.
 */
async function withMutatedPolicy(needle, replacement, fn) {
  const original = fs.readFileSync(POLICY, 'utf8');
  const hits = original.split(needle).length - 1;
  assert.equal(hits, 1, `the mutation needle matched ${hits} times, not once — this control proves NOTHING`);
  const mutant = path.join(REPO, 'scripts', 'ci', `deploy-trigger-policy.__control_${Math.random().toString(36).slice(2)}__.mjs`);
  fs.writeFileSync(mutant, original.replace(needle, replacement));
  try {
    return await fn(await import(pathToFileURL(mutant).href));
  } finally {
    fs.rmSync(mutant, { force: true });
    assert.equal(fs.readFileSync(POLICY, 'utf8'), original, 'the real policy must be untouched by this control');
  }
}

/** The precedence block of resolveTargetSubscription, and the same two halves swapped. */
const PRECEDENCE_INPUT_FIRST = [
  '  const override = String(subscriptionOverride).trim();',
  "  if (override) return { targetSub: override, source: 'subscription_input' };",
  '',
  '  const login = String(loginSubscription).trim();',
  "  if (login) return { targetSub: login, source: 'login' };",
].join('\r\n');
const PRECEDENCE_LOGIN_FIRST = [
  '  const login = String(loginSubscription).trim();',
  "  if (login) return { targetSub: login, source: 'login' };",
  '',
  '  const override = String(subscriptionOverride).trim();',
  "  if (override) return { targetSub: override, source: 'subscription_input' };",
].join('\r\n');

test('CONTROL (F2) — swapping override/login precedence is CAUGHT, and by nothing else', async () => {
  await withMutatedPolicy(PRECEDENCE_INPUT_FIRST, PRECEDENCE_LOGIN_FIRST, async (mod) => {
    const swapped = mod.resolveTargetSubscription({
      topology: 'tenant',
      subscriptionOverride: FAKE_SUB,
      loginSubscription: FAKE_LOGIN_SUB,
    });
    assert.equal(swapped.targetSub, FAKE_LOGIN_SUB,
      'the swap did not change the answer, so the precedence assertion above proves nothing');
    assert.equal(swapped.source, 'login');

    // WHY the assertion had to be added rather than assumed covered: under this
    // exact swap every OTHER case in this file returns an identical answer.
    // That is why #3944's suite stayed green on it.
    assert.deepEqual(
      mod.resolveTargetSubscription({ topology: 'tenant', subscriptionOverride: FAKE_SUB }),
      { targetSub: FAKE_SUB, source: 'subscription_input' });
    assert.deepEqual(
      mod.resolveTargetSubscription({ topology: '', loginSubscription: FAKE_SUB }),
      { targetSub: FAKE_SUB, source: 'login' });
    assert.deepEqual(
      mod.resolveTargetSubscription({
        topology: 'dlz-attach',
        targetSubscription: FAKE_DLZ_SUB,
        subscriptionOverride: FAKE_SUB,
        loginSubscription: FAKE_SUB,
      }),
      { targetSub: FAKE_DLZ_SUB, source: 'target_subscription' });
    for (const topology of UNRESOLVABLE_TOPOLOGIES) {
      assert.deepEqual(mod.resolveTargetSubscription({ topology }), { targetSub: '', source: 'unresolved' });
    }
  });
});

// ---------------------------------------------------------------------------
// Population — no step may hard-fail on a value whose contract permits empty.
// ---------------------------------------------------------------------------

/**
 * The guard output, as it is written in the workflow's `env:`/shell bindings.
 */
const DEPLOY_SUB_OUTPUT = String.raw`\$\{\{\s*steps\.topology_guard\.outputs\.deploy_sub\s*\}\}`;
const DEPLOY_SUB_BINDING = String.raw`([A-Za-z_][A-Za-z0-9_]*)\s*(?::|=)\s*"?` + DEPLOY_SUB_OUTPUT + '"?';

/**
 * A HARD FAIL. `exit 0` is not one, and neither is a bare `exit` (whose status
 * is the previous command's, so it asserts nothing about emptiness).
 */
const HARD_FAIL = /\bexit\s+[1-9][0-9]*\b/;

/**
 * A shell reference to `name` whose value is `name` OR the empty string:
 * `$N`, `${N}`, `${N:-}`, `${N:=}`.
 *
 * Deliberately NOT `${N:-something}`. A non-empty default is the CORRECT
 * remediation for deploy_sub's contract — the workflow already does exactly
 * that at `SUB="${DEPLOY_SUB:-$(az account show ...)}"` — and after it the
 * value is no longer deploy_sub, so an emptiness test on it means "even the
 * fallback failed", which SHOULD be fatal. Matching it here would flag the fix.
 */
function deploySubRef(name) {
  return String.raw`\$(?:\{` + name + String.raw`(?::[-=?+])?\}|` + name + String.raw`\b)`;
}

/**
 * Every name in `text` carrying the guard's `deploy_sub` value.
 *
 * Keyed to the OUTPUT, not to a variable name. The filter this replaced was
 * keyed to the literal string `DEPLOY_SUB`, so the one step that binds the same
 * output to `ADMIN_SUB` (the dlz_adopt step) was outside its population
 * entirely — it could not have caught an offender there however it was written.
 *
 * A second pass follows PLAIN copies (`SUB="$DEPLOY_SUB"`), which is the
 * cheapest way to launder a value past a name-keyed check. Per-step, so a
 * `SUB=` in one step never widens another.
 */
function boundDeploySubNames(text) {
  const names = new Set();
  for (const m of text.matchAll(new RegExp(DEPLOY_SUB_BINDING, 'g'))) names.add(m[1]);
  for (const n of [...names]) {
    const alias = new RegExp(String.raw`^\s*([A-Za-z_][A-Za-z0-9_]*)="?` + deploySubRef(n) + '"?\\s*$', 'gm');
    for (const m of text.matchAll(alias)) names.add(m[1]);
  }
  return names;
}

/**
 * An emptiness test on `name`, in any of the idioms bash actually spells it.
 *
 * COVERED — verified element-wise by the per-shape control below:
 *   `-z REF`            → `[ -z … ]`, `[[ -z … ]]`, `test -z …`
 *   `! -n REF`
 *   `REF = ""` / `== ''`  (and reversed)
 *   `xREF = x`            (and reversed) — the portable-`test` idiom
 *   `-n REF` on a line that also contains `||` — the inverted guard
 *
 * NOT COVERED, and named rather than implied (the R7 half of #3947 was a
 * comment claiming coverage the code did not have): `case "$V" in "")`,
 * `${V:?msg}`, arithmetic tests, and a value laundered through a command
 * substitution or a defaulted expansion before being tested.
 */
function emptinessTestRe(name) {
  const R = deploySubRef(name);
  const Q = '"?';
  return new RegExp([
    String.raw`-z\s+` + Q + R + Q,
    String.raw`!\s+-n\s+` + Q + R + Q,
    Q + R + Q + String.raw`\s*={1,2}\s*(?:""|'')`,
    String.raw`(?:""|'')\s*={1,2}\s*` + Q + R + Q,
    'x' + Q + R + Q + String.raw`\s*={1,2}\s*x(?![A-Za-z0-9_])`,
    'x' + String.raw`\s*={1,2}\s*x` + Q + R + Q,
  ].join('|'));
}
function nonEmptinessTestRe(name) {
  return new RegExp(String.raw`-n\s+"?` + deploySubRef(name) + '"?');
}

/**
 * Steps that read deploy_sub and treat EMPTY as fatal.
 *
 * The property, stated once: a line that tests a deploy_sub-carrying name for
 * emptiness, AND a hard fail either on that same line or inside the `then`
 * block it opens. Requiring the exit is what keeps a benign default —
 * `if [ -z "${DEPLOY_SUB:-}" ]; then DEPLOY_SUB=$(az account show …); fi` —
 * out of the result; the filter this replaced flagged that one.
 *
 * The forward scan is deliberately conservative: an exit nested deeper inside
 * the branch still counts, and an unbalanced `fi` scans to the end of the step
 * rather than stopping early. Over-flagging is a review conversation;
 * under-flagging is a 06:48Z outage.
 */
function findDeploySubOffenders(src) {
  const offenders = [];
  for (const step of src.split(/^ {6}- name: /m).slice(1)) {
    const names = boundDeploySubNames(step);
    if (names.size === 0) continue;
    const stepName = step.split(/\r?\n/)[0].trim();
    const lines = step.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const tested = [...names].some((n) => emptinessTestRe(n).test(line)
        || (nonEmptinessTestRe(n).test(line) && line.includes('||')));
      if (!tested) continue;
      if (HARD_FAIL.test(line)) {
        offenders.push(`${stepName} :: ${line.trim()}`);
        continue;
      }
      // A `then` whose whole block is on this line was already covered above.
      const thenAt = line.indexOf('then');
      if (thenAt < 0 || /\bfi\b/.test(line.slice(thenAt))) continue;
      let depth = 1;
      for (let j = i + 1; j < lines.length && depth > 0; j += 1) {
        const t = lines[j].trim();
        if (/^if\b/.test(t)) depth += 1;
        if (/^fi\b/.test(t)) { depth -= 1; continue; }
        if (depth === 1 && /^(else|elif)\b/.test(t)) break;
        if (HARD_FAIL.test(lines[j])) {
          offenders.push(`${stepName} :: ${line.trim()} … ${t}`);
          depth = 0;
        }
      }
    }
  }
  return offenders;
}

/**
 * Apply a text mutation to the workflow IN MEMORY and hand the result to `fn`.
 *
 * Mirrors {@link withMutatedGuard}, with the same load-bearing assertion: the
 * needle MUST match exactly once. This file and the workflow are both CRLF, and
 * a needle written with LF matches ZERO times — which reads exactly like a
 * passing mutation test while proving nothing.
 *
 * The mutant is a STRING, never a file: a `.yml` written into
 * `.github/workflows/` is a real workflow GitHub would try to parse, and a
 * suite that dies mid-test would leave it there. The on-disk workflow is
 * asserted byte-identical afterwards anyway, so a future `fn` that writes is
 * caught rather than tolerated.
 */
function withMutatedWorkflow(needle, replacement, fn) {
  const original = fs.readFileSync(WORKFLOW, 'utf8');
  const hits = original.split(needle).length - 1;
  assert.equal(hits, 1, `the mutation needle matched ${hits} times, not once — this control proves NOTHING`);
  try {
    return fn(original.replace(needle, replacement));
  } finally {
    assert.equal(fs.readFileSync(WORKFLOW, 'utf8'), original, 'the real workflow must be untouched by this control');
  }
}

/**
 * Injection anchors — one step per bound name, each verified unique above.
 * `ADMIN_SUB_ANCHOR` sits in the ONLY step the previous filter could not see.
 */
const DEPLOY_SUB_ANCHOR = '          echo "Registering providers on sub $(az account show --query id -o tsv)…"\r\n';
const ADMIN_SUB_ANCHOR = '          INPUT_DLZ_SUBSCRIPTION=""; INPUT_DLZ_DOMAIN=""\r\n';

/**
 * One entry per bash emptiness idiom, each a THIRD offending sibling added to a
 * step that already legitimately consumes deploy_sub — the narrow shape, not a
 * broad "delete the guard" mutation.
 *
 * MEASURED against the filter this replaces (2026-08-24): only `#3888 original
 * spelling` produced an offender. The other SEVEN survived at 0 offenders, so
 * every one of them could have landed on the estate exactly as #3888 did —
 * which is precisely what the old comment promised could not happen.
 */
const OFFENDING_IDIOMS = [
  ['#3888 original spelling', DEPLOY_SUB_ANCHOR,
    'if [ -z "${DEPLOY_SUB:-}" ]; then\r\n            echo "::error::no sub"\r\n            exit 1\r\n          fi\r\n'],
  ['[ -z "$V" ], no :- expansion', DEPLOY_SUB_ANCHOR,
    'if [ -z "$DEPLOY_SUB" ]; then\r\n            exit 1\r\n          fi\r\n'],
  ['[[ -z ]] bashism, one line', DEPLOY_SUB_ANCHOR,
    'if [[ -z "${DEPLOY_SUB:-}" ]]; then exit 1; fi\r\n'],
  ['test -z, no brackets', DEPLOY_SUB_ANCHOR,
    'test -z "$DEPLOY_SUB" && exit 1\r\n'],
  ['string comparison against ""', DEPLOY_SUB_ANCHOR,
    'if [ "${DEPLOY_SUB:-}" = "" ]; then\r\n            exit 1\r\n          fi\r\n'],
  ['the portable x-prefix idiom', DEPLOY_SUB_ANCHOR,
    'if [ x"$DEPLOY_SUB" = x ]; then\r\n            exit 1\r\n          fi\r\n'],
  ['laundered through a plain alias', DEPLOY_SUB_ANCHOR,
    'SUB="$DEPLOY_SUB"\r\n          if [ -z "$SUB" ]; then\r\n            exit 1\r\n          fi\r\n'],
  // The blind spot, not merely an unmatched spelling: this step binds the same
  // output to ADMIN_SUB, so the old filter's consumer population (16 of the 17
  // binding sites) did not contain it at all.
  ['on the ADMIN_SUB-bound step', ADMIN_SUB_ANCHOR,
    'if [ -z "${ADMIN_SUB:-}" ]; then\r\n            exit 1\r\n          fi\r\n'],
];

test('POPULATION — the deploy_sub binding sites are enumerated EXACTLY', () => {
  // An EXACT integer, not a floor. `steps.length > 20` was a floor on TOTAL
  // steps: it would still have passed with the consumer filter matching
  // nothing, which is the zero-population failure mode this repo keeps paying
  // for. If you add a consumer, raise this number IN THE SAME PR and confirm
  // the offender assertion below is still empty.
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  const steps = src.split(/^ {6}- name: /m).slice(1);
  assert.ok(steps.length > 20, `only ${steps.length} steps parsed — the step split is broken`);

  const bindings = [...src.matchAll(new RegExp(DEPLOY_SUB_BINDING, 'g'))];
  assert.equal(bindings.length, 17, 'the deploy_sub consumer population changed');

  const consumerSteps = steps.filter((s) => new RegExp(DEPLOY_SUB_BINDING).test(s));
  assert.equal(consumerSteps.length, 17,
    'binding sites and consumer steps diverged — a step binds deploy_sub twice, or the split lost one');

  assert.deepEqual(
    [...boundDeploySubNames(src)].sort(),
    ['ADMIN_SUB', 'DEPLOY_SUB'],
    'a new name now carries deploy_sub — confirm nothing hard-fails on it',
  );
});

test('POPULATION — no workflow step hard-fails on the legitimately-empty deploy_sub', () => {
  // Keyed to the PROPERTY: an emptiness test on a deploy_sub-carrying name plus
  // a hard fail. NOT to the spelling #3888 happened to use — that filter caught
  // 1 of the 8 idioms the control below injects (#3947 F1).
  //
  // An empty result here is only meaningful because CONTROL (PER-SHAPE) is its
  // embedded positive control: a detector that silently matched NOTHING would
  // report the same [] as a clean workflow, and would go red there instead.
  assert.deepEqual(
    findDeploySubOffenders(fs.readFileSync(WORKFLOW, 'utf8')),
    [],
    'these steps hard-fail on deploy_sub, whose documented contract is that \'\' means '
    + '"use the login subscription" — it is empty on EVERY scheduled run. Read '
    + 'steps.topology_guard.outputs.target_sub instead (#3916).',
  );
});

test('CONTROL (PER-SHAPE) — every emptiness idiom is caught, on every bound name', () => {
  // Eight narrow mutations, each asserted individually. A guard that catches
  // only the shape the last offender used is the "keyed to the unsafe pattern"
  // class, and it is what #3947 measured this one to be.
  const survived = [];
  for (const [label, anchor, injected] of OFFENDING_IDIOMS) {
    const found = withMutatedWorkflow(
      anchor,
      `${anchor}          ${injected}`,
      (mutated) => findDeploySubOffenders(mutated),
    );
    if (found.length !== 1) survived.push(`${label} → ${found.length} offenders`);
  }
  assert.deepEqual(survived, [], 'these emptiness idioms walk past the guard, exactly as #3888 did');
});

test('CONTROL (NEGATIVE) — an emptiness test with NO hard fail is NOT an offender', () => {
  // The discriminator in the opposite direction. Without it, "flag every line
  // mentioning DEPLOY_SUB" would pass every mutation above, and the rewrite
  // would be match-everything rather than keyed to the property.
  //
  // Both of these are CORRECT code. The first is the ordinary default; the
  // second is the #3916 remediation itself — resolve a fallback, then refuse if
  // even that failed. The filter this replaced flagged the first one.
  const benign = [
    ['supplies a default instead of failing',
      'if [ -z "${DEPLOY_SUB:-}" ]; then DEPLOY_SUB=$(az account show --query id -o tsv); fi\r\n'],
    ['fails only after a non-empty fallback also failed',
      'if [ -z "${DEPLOY_SUB:-$(az account show --query id -o tsv)}" ]; then exit 1; fi\r\n'],
  ];
  for (const [label, injected] of benign) {
    const found = withMutatedWorkflow(
      DEPLOY_SUB_ANCHOR,
      `${DEPLOY_SUB_ANCHOR}          ${injected}`,
      (mutated) => findDeploySubOffenders(mutated),
    );
    assert.deepEqual(found, [], `false positive — this step ${label} and is not a defect`);
  }
});

test('POPULATION — every consumer of target_sub reads it from the guard', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  const uses = [...src.matchAll(/TARGET_SUB: (.+)/g)].map((m) => m[1].trim());
  assert.ok(uses.length >= 2, `expected at least the two #3888 steps to consume target_sub, found ${uses.length}`);
  assert.deepEqual(
    [...new Set(uses)],
    ['${{ steps.topology_guard.outputs.target_sub }}'],
    'a TARGET_SUB was wired from something other than the guard output',
  );
});
