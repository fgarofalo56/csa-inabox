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
 * Run: node --test scripts/ci/__tests__/deploy-target-subscription.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveTargetSubscription,
  parseSubscriptionId,
} from '../deploy-trigger-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'ci', 'deploy-fiab-guard.mjs');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'deploy-fiab-commercial.yml');
const IS_WIN = process.platform === 'win32';

/** Syntactically valid, deliberately not a real subscription. */
const FAKE_SUB = '00000000-1111-2222-3333-444444444444';
const FAKE_DLZ_SUB = '00000000-5555-6666-7777-888888888888';

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

// ---------------------------------------------------------------------------
// Population — no step may hard-fail on a value whose contract permits empty.
// ---------------------------------------------------------------------------

test('POPULATION — no workflow step hard-fails on the legitimately-empty deploy_sub', () => {
  // Keyed to the PROPERTY, not to the removed message. #3888 added two steps
  // with this shape and only one ever ran; a third added tomorrow must fail
  // here, not on the estate at 06:48Z.
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  const steps = src.split(/^ {6}- name: /m).slice(1);
  assert.ok(steps.length > 20, `only ${steps.length} steps parsed — this assertion has too small a population`);

  const offenders = steps
    .filter((s) => /\bDEPLOY_SUB: \$\{\{ steps\.topology_guard\.outputs\.deploy_sub \}\}/.test(s)
      || /\bDEPLOY_SUB="\$\{\{ steps\.topology_guard\.outputs\.deploy_sub \}\}"/.test(s))
    // The defect shape: read deploy_sub, then treat empty as fatal.
    .filter((s) => /if \[ -z "\$\{DEPLOY_SUB:-\}" \]; then/.test(s))
    .map((s) => s.split(/\r?\n/)[0].trim());

  assert.deepEqual(
    offenders,
    [],
    'these steps hard-fail on deploy_sub, whose documented contract is that \'\' means '
    + '"use the login subscription" — it is empty on EVERY scheduled run. Read '
    + 'steps.topology_guard.outputs.target_sub instead (#3916).',
  );
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
