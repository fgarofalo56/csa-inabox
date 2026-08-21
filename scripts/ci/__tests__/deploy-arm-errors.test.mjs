/**
 * deploy-arm-errors.test.mjs — the drill-down actually reads the real thing,
 * and CANNOT turn "I could not read it" into "there was nothing there".
 *
 * The fixtures in scripts/ci/__fixtures__/arm-ops-31069329802/ are the VERBATIM
 * `az deployment operation … list` output of deploy-fiab-commercial run
 * 31069329802 (only the subscription GUID is replaced). They are not modelled
 * on the parser — the parser is measured against them
 * (csa_loom_fixtures_that_model_the_code).
 *
 * Run: node --test scripts/ci/__tests__/deploy-arm-errors.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  STATUS,
  EXIT,
  azArgs,
  errorLeaves,
  failedOperations,
  nestedDeploymentTargets,
  resourceGroupOf,
  collectArmLeafErrors,
  renderLeaves,
  parseArgs,
  formatStdout,
  formatStderr,
} from '../deploy-arm-errors.mjs';
import { classify } from '../deploy-classify.mjs';
import {
  streamWrites,
  stripComments,
  unboundedWrites,
  callCount,
  forbiddenPublishers,
  inheritedStreamSpawns,
  CONTROL_SOURCE_CRLF,
} from './_publication-surfaces.mjs';

const FIXTURES = path.resolve(import.meta.dirname, '..', '__fixtures__', 'arm-ops-31069329802');
const ROOT_DEPLOYMENT = 'csa-loom-ci-31069329802';
const SCRIPT = path.resolve(import.meta.dirname, '..', 'deploy-arm-errors.mjs');

/**
 * Replays the captured `az` output. Any call the fixtures do not cover is a
 * MISS, reported as az would report an unknown deployment — so a parser that
 * asks for the wrong thing fails rather than silently reading nothing.
 */
function fixtureRunner(calls = []) {
  return (args) => {
    calls.push(args.join(' '));
    const isGroup = args[2] === 'group';
    const name = args[args.indexOf('--name') + 1];
    const rg = isGroup ? args[args.indexOf('-g') + 1] : null;
    const file = isGroup ? `group--${rg}--${name}.json` : `sub--${name}.json`;
    const p = path.join(FIXTURES, file);
    if (!fs.existsSync(p)) {
      return {
        status: 1,
        stdout: '',
        stderr: `ERROR: (DeploymentNotFound) Deployment '${name}' could not be found.`,
      };
    }
    return { status: 0, stdout: fs.readFileSync(p, 'utf8'), stderr: '' };
  };
}

test('the captured run: both leaf causes are extracted from the real ARM output', () => {
  const calls = [];
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: fixtureRunner(calls) });

  assert.equal(r.status, STATUS.FOUND);
  const codes = r.leaves.map((l) => l.code).sort();
  assert.deepEqual(codes, ['BadRequest', 'RoleAssignmentExists']);

  const dns = r.leaves.find((l) => l.code === 'BadRequest');
  assert.match(dns.message, /cannot be linked to multiple zones with overlapping namespaces/);
  const ra = r.leaves.find((l) => l.code === 'RoleAssignmentExists');
  assert.match(ra.message, /The role assignment already exists/);

  // It recursed rather than reading only the top level.
  assert.ok(calls.some((c) => c.includes('operation sub list')), 'no sub-level enumeration');
  assert.ok(calls.some((c) => c.includes('--name admin-plane')), 'did not expand admin-plane');
  assert.ok(calls.some((c) => c.includes('--name network')), 'did not expand network');
  assert.ok(calls.some((c) => c.includes('--name swa-publish-rbac')), 'did not expand swa-publish-rbac');
});

test('MUTATION PROOF — the drilled text classifies; the run\'s own stderr does not', () => {
  // The stderr the classifier was ACTUALLY handed on run 31069329802: bicep
  // linter warnings, and the content-free ARM summary.
  const realStderr = [
    'WARNING: /home/runner/work/csa-inabox/csa-inabox/platform/fiab/bicep/modules/admin-plane/catalog.bicep(295,42) : Warning BCP318: The value of type "Microsoft.Purview/accounts | null" may be null at the start of the deployment, which would cause this access expression (and the overall deployment with it) to fail.',
    '/home/runner/work/csa-inabox/csa-inabox/platform/fiab/bicep/main.bicep(14,7) : Warning no-unused-params: Parameter "environment" is declared but never used.',
    'ERROR: {"code": "DeploymentFailed", "message": "At least one resource deployment operation failed. Please list deployment operations for details."}',
  ].join('\n');

  const before = classify(realStderr);
  assert.equal(before.class, 'unknown', 'the input the classifier really got must still be unclassifiable');

  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: fixtureRunner() });
  const after = classify(`${realStderr}\n${renderLeaves(r)}`);
  assert.notEqual(after.class, 'unknown');
  assert.equal(after.class, 'config');
  assert.ok(
    ['config.private-dns-namespace-overlap', 'config.role-assignment-exists'].includes(after.signalId),
    `unexpected signal ${after.signalId}`,
  );

  // BOTH causes must be visible to the operator, not only the winner.
  const rendered = renderLeaves(r);
  assert.match(rendered, /overlapping namespaces/);
  assert.match(rendered, /role assignment already exists/);

  // And each leaf, classified on its own, resolves to its own signal.
  assert.equal(
    classify(r.leaves.find((l) => l.code === 'BadRequest').message).signalId,
    'config.private-dns-namespace-overlap',
  );
  assert.equal(
    classify(r.leaves.find((l) => l.code === 'RoleAssignmentExists').message).signalId,
    'config.role-assignment-exists',
  );
});

test('MUTATION PROOF — az refusing the ROOT list is UNREADABLE, never "none"', () => {
  const denied = () => ({
    status: 1,
    stdout: '',
    stderr: "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Resources/deployments/operations/read'.",
  });
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: denied });
  assert.equal(r.status, STATUS.UNREADABLE);
  assert.equal(r.leaves.length, 0);
  assert.match(renderLeaves(r), /UNREADABLE/);
  assert.match(renderLeaves(r), /nothing\s+is asserted about the cause/);
  assert.doesNotMatch(renderLeaves(r), /none\./);
});

test('MUTATION PROOF — an EMPTY operation list is "none", and says so without asserting a cause', () => {
  const empty = () => ({ status: 0, stdout: '[]', stderr: '' });
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: empty });
  assert.equal(r.status, STATUS.NONE);
  assert.equal(r.leaves.length, 0);
  assert.match(renderLeaves(r), /none\b/);
  assert.match(renderLeaves(r), /NOT in the deployment operations/);
});

test('MUTATION PROOF — a non-JSON answer is UNREADABLE, not an empty result', () => {
  const junk = () => ({ status: 0, stdout: '<html>login required</html>', stderr: '' });
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: junk });
  assert.equal(r.status, STATUS.UNREADABLE);
  assert.match(r.reason, /not JSON/);
});

test('a nested list that cannot be read is PARTIAL, and the partial is disclosed', () => {
  // Root readable, every child refused: the nested details[] chain still
  // carries the causes, so leaves are found — but the failure to expand is
  // reported rather than hidden behind a clean-looking result.
  const rootOnly = (args) => {
    if (args[2] === 'sub') {
      return {
        status: 0,
        stdout: fs.readFileSync(path.join(FIXTURES, `sub--${ROOT_DEPLOYMENT}.json`), 'utf8'),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) read denied' };
  };
  const r = collectArmLeafErrors({ name: ROOT_DEPLOYMENT, scope: 'sub', run: rootOnly });
  assert.equal(r.status, STATUS.FOUND);
  assert.ok(r.warnings.length > 0, 'a blocked expansion must be disclosed');
  assert.match(renderLeaves(r), /\(partial\)/);
});

test('maxDepth stops the walk and SAYS it stopped', () => {
  const r = collectArmLeafErrors({
    name: ROOT_DEPLOYMENT,
    scope: 'sub',
    maxDepth: 0,
    run: fixtureRunner(),
  });
  // depth 0 still reads the root; the children are refused with a warning.
  assert.ok(r.warnings.some((w) => /stopped at depth 0/.test(w)), r.warnings.join('|'));
});

test('subscription ids never reach the rendered output', () => {
  const leaky = () => ({
    status: 1,
    stdout: '',
    stderr:
      "ERROR: (AuthorizationFailed) does not have authorization over scope '/subscriptions/e093f4fd-5047-4ee4-968d-a56942c665f3/resourceGroups/rg-x'",
  });
  const out = renderLeaves(collectArmLeafErrors({ name: 'x', scope: 'sub', run: leaky }));
  assert.doesNotMatch(out, /e093f4fd-5047-4ee4-968d-a56942c665f3/);
  assert.match(out, /<redacted>/);
});

// ── renderLeaves() IS A REDACTION BOUNDARY (#3829 round 2) ───────────────────
//
// deploy-retry.mjs writes this string straight to process.stderr, and on a
// PUBLIC repo the Actions run log is a publication surface exactly as an issue
// body is. Round 1 redacted `l.message` only, which left `l.resourceName`, the
// `warnings[]` lines and `result.reason` raw — and for the
// flexibleServers/administrators leaf that opened #3829, `resourceName` IS
// `<server>/<objectId>`. Measured at that head, the id reached stderr twice.
//
// These are written against the branch structure, because the hole reopens
// per-branch: one case per status.

const SYNTHETIC_OID = '11111111-2222-3333-4444-555555555555';
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test('FOUND — the leaf resourceName is redacted, and the server name survives', () => {
  const ops = [
    {
      operationId: 'DEADBEEF',
      properties: {
        provisioningState: 'Failed',
        statusCode: 'Conflict',
        targetResource: {
          id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-x/providers/Microsoft.DBforPostgreSQL/flexibleServers/administrators',
          resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers/administrators',
          resourceName: `psql-loom-weave-default-abc123/${SYNTHETIC_OID}`,
        },
        statusMessage: {
          error: { code: 'Conflict', message: 'the administrator could not be written', details: null },
        },
      },
    },
  ];
  const r = collectArmLeafErrors({ name: 'x', scope: 'sub', run: () => ({ status: 0, stdout: JSON.stringify(ops), stderr: '' }) });
  assert.equal(r.status, STATUS.FOUND, 'the fixture must actually produce a leaf');
  // Non-degenerate: the leaf really carries the id before rendering.
  assert.match(r.leaves[0].resourceName, GUID_RE, 'the collected leaf must carry the id or this proves nothing');

  const out = renderLeaves(r);
  assert.doesNotMatch(out, GUID_RE, 'the leaf resourceName published an object id (#3829 round 2)');
  assert.match(out, /psql-loom-weave-default-abc123\/<guid>/, 'redacted IN PLACE — the server name must survive');
});

test('UNREADABLE and PARTIAL — a GUID in the DEPLOYMENT NAME is redacted too', () => {
  // The unreadable/partial branches interpolate `node.name`, and this repo
  // generates deployment names off `newGuid()` seeds. Round 1 redacted neither
  // branch.
  const name = `admin_${SYNTHETIC_OID}`;
  const refuse = () => ({ status: 1, stdout: '', stderr: 'ERROR: (AuthorizationFailed) read denied' });
  const r = collectArmLeafErrors({ name, scope: 'sub', run: refuse });
  assert.equal(r.status, STATUS.UNREADABLE);
  // Non-degenerate: the reason really embeds the poisoned name.
  assert.match(r.reason, GUID_RE, 'the reason must carry the id or this proves nothing');

  const out = renderLeaves(r);
  assert.doesNotMatch(out, GUID_RE, 'the UNREADABLE render published a deployment-name GUID (#3829 round 2)');
  assert.match(out, /admin_<guid>/, 'redacted in place — and note `_` is a word char, which `\\b` did not stop');
});

test('errorLeaves walks past the boilerplate wrappers to the real code', () => {
  const err = {
    code: 'DeploymentFailed',
    message: 'At least one resource deployment operation failed.',
    details: [
      {
        code: 'ResourceDeploymentFailure',
        message: 'reached terminal provisioning state Failed',
        details: [{ code: 'BadRequest', message: 'the actual cause', target: '/x' }],
      },
    ],
  };
  assert.deepEqual(errorLeaves(err), [{ code: 'BadRequest', message: 'the actual cause', target: '/x' }]);
  assert.deepEqual(errorLeaves(null), []);
  assert.deepEqual(errorLeaves(undefined), []);
});

test('failedOperations / nestedDeploymentTargets read the real fixture shape', () => {
  const ops = JSON.parse(fs.readFileSync(path.join(FIXTURES, `sub--${ROOT_DEPLOYMENT}.json`), 'utf8'));
  assert.equal(failedOperations(ops).length, 1);
  const nested = nestedDeploymentTargets(ops);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].name, 'admin-plane');
  assert.equal(nested[0].resourceGroup, 'rg-csa-loom-admin-centralus');
});

test('resourceGroupOf is case-insensitive and null when there is no RG segment', () => {
  assert.equal(resourceGroupOf('/subscriptions/x/resourcegroups/rg-a/providers/y'), 'rg-a');
  assert.equal(resourceGroupOf('/subscriptions/x/providers/y'), null);
  assert.equal(resourceGroupOf(undefined), null);
});

test('azArgs builds the calls the CLI documents, and threads --subscription', () => {
  assert.deepEqual(azArgs({ scope: 'sub', name: 'd' }), [
    'deployment', 'operation', 'sub', 'list', '--name', 'd', '-o', 'json',
  ]);
  assert.deepEqual(azArgs({ scope: 'group', name: 'd', resourceGroup: 'rg', subscription: 's' }), [
    'deployment', 'operation', 'group', 'list', '-g', 'rg', '--name', 'd', '--subscription', 's', '-o', 'json',
  ]);
});

test('parseArgs rejects an unknown flag rather than ignoring it', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.equal(parseArgs(['--name', 'd', '--scope', 'group', '-g', 'rg']).resourceGroup, 'rg');
});

test('the three outcomes have three distinct exit codes', () => {
  assert.equal(new Set([EXIT.FOUND, EXIT.NONE, EXIT.UNREADABLE, EXIT.USAGE]).size, 4);
});

// ── --json IS OPERATOR-LOCAL, AND THAT IS NOW MECHANICAL (#3829 round 4) ─────
//
// The default render redacts; `--json` emits the raw `result`, which carries the
// unredacted ARM leaf (measured: default 0 GUIDs, --json 1 GUID). That is
// deliberate — an operator debugging their own subscription needs the real id —
// and it is safe ONLY while no CI surface invokes it, because a workflow's stdout
// is public on this public repo.
//
// "Documented local-only" is an assumption until something checks it. This is
// the check: it turns a sentence in a header into a condition that fails the
// suite the moment a workflow starts publishing the raw form.

test('RATCHET — no workflow invokes deploy-arm-errors.mjs with --json (its output is unredacted)', () => {
  const dir = path.resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows');
  const offenders = [];
  let scanned = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
    scanned += 1;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Each invocation plus its continuation lines — a `\`-wrapped `--json` on the
    // next line is the shape a line-at-a-time matcher would miss
    // (csa_loom_guard_blind_continuation_lines_scripts).
    const re = /deploy-arm-errors\.mjs([\s\S]*?)(?=\n\s*\n|\n\s{0,8}-\s|\n\s{0,6}[a-z-]+:\s|$)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (/--json\b/.test(m[1])) offenders.push(`${f}: ${m[0].split('\n')[0].trim()}`);
    }
  }
  // Fail closed on a broken scan: zero files read would mean the path drifted,
  // not that the repo is clean (guard_with_zero_population_needs_embedded_control).
  assert.ok(scanned >= 20, `expected to scan >=20 workflow files, scanned ${scanned} — the path drifted`);
  assert.deepEqual(
    offenders,
    [],
    'a workflow publishes deploy-arm-errors --json, whose output is UNREDACTED, to a public Actions log',
  );

  // EMBEDDED CONTROL — the population is zero today (no workflow calls this
  // script at all), so prove the matcher can actually see the violation it
  // guards, including across a continuation line.
  const bad = 'node scripts/ci/deploy-arm-errors.mjs \\\n  --name d --scope sub \\\n  --json';
  const re = /deploy-arm-errors\.mjs([\s\S]*?)(?=\n\s*\n|\n\s{0,8}-\s|\n\s{0,6}[a-z-]+:\s|$)/g;
  assert.match(re.exec(bad)[1], /--json\b/, 'the matcher cannot detect a --json invocation it is meant to catch');
  const good = 'node scripts/ci/deploy-arm-errors.mjs --name d --scope sub';
  re.lastIndex = 0;
  assert.doesNotMatch(re.exec(good)[1], /--json\b/, 'the matcher fires on a clean invocation');
});

// ── THIS FILE'S OWN PUBLICATION SURFACES (#3829 round 5) ─────────────────────
//
// renderLeaves() is a redaction boundary for the STRING IT BUILDS. It was never
// a boundary for this PROCESS: the CLI also writes four usage refusals to
// stderr, two of which interpolate operator-supplied argv, and it writes stdout
// twice — the redacted render and the deliberately-raw `--json`. Rounds 1-4 of
// #3829 bounded one surface at a time and each asserted the enumeration was
// complete; this section holds the whole file to the same mechanical rule the
// other two scripts in the lane are held to.

const ARM_SRC = fs.readFileSync(SCRIPT, 'utf8');

/** Two redaction boundaries and ONE disclosed-exception marker. */
const ARM_BOUNDARIES = ['formatStdout', 'formatStderr', 'unredactedByDesign'];

/** `--json`, and nothing else. Pinned so a second cannot appear silently. */
const ARM_DISCLOSED_EXCEPTIONS = 1;

test('MUTATION-VISIBLE — formatStdout()/formatStderr() are this file\'s boundaries', () => {
  // DIRECT, because renderLeaves() redacts as well: an end-to-end assertion on
  // the default stdout path cannot say which of the two did the work, and would
  // stay green with this boundary deleted
  // (csa_loom_mutation_that_does_not_move_the_verdict).
  const poisoned = `deploy-arm-errors: --scope must be sub|group (got ${SYNTHETIC_OID})`;
  assert.match(poisoned, GUID_RE, 'the input must carry a GUID or this proves nothing');
  assert.doesNotMatch(formatStderr(poisoned), GUID_RE, 'the stderr boundary published a GUID');
  assert.match(formatStderr(poisoned), /\(got <guid>\)/, 'redacted in place, not dropped');
  assert.doesNotMatch(formatStdout(`x${SYNTHETIC_OID}`), GUID_RE, 'the stdout boundary published a GUID');
  assert.equal(formatStdout(`x${SYNTHETIC_OID}`), 'x<guid>');
  // String() first — a refusal that printed nothing is worse than the refusal.
  assert.equal(formatStderr(42), '42');
  assert.equal(formatStdout(undefined), 'undefined');
});

test('STRUCTURAL — EVERY write to a public stream crosses a boundary or a COUNTED exception', () => {
  const writes = streamWrites(ARM_SRC);

  assert.ok(writes.length >= 6, `expected >=6 stream writes, found ${writes.length} — the enumerator drifted`);
  assert.ok(writes.some((w) => w.stream === 'stdout'), 'no stdout write found — the enumerator is stdout-blind');
  assert.ok(writes.some((w) => w.stream === 'stderr'), 'no stderr write found — the enumerator is stderr-blind');

  assert.deepEqual(
    unboundedWrites(ARM_SRC, ARM_BOUNDARIES).map((w) => `${w.line}: ${w.arg.split('\n')[0]}`),
    [],
    'a write to a PUBLIC stream bypasses both the redaction boundary and the disclosed-exception marker (#3829)',
  );
  assert.equal(
    callCount(ARM_SRC, 'unredactedByDesign'),
    ARM_DISCLOSED_EXCEPTIONS,
    'the number of UNREDACTED publications changed — `--json` is the only one, and it is only safe because the ' +
      'RATCHET above proves no workflow invokes it',
  );
  assert.deepEqual(forbiddenPublishers(ARM_SRC), [], 'a publication shape with no boundary to attach to');

  // THE SURFACE NO WRITE-BASED ASSERTION CAN SEE. This file spawns `az`, and a
  // single character — `['ignore','pipe','pipe']` becoming `['ignore','inherit',
  // 'pipe']` — would hand az's raw output straight to the public run log with no
  // `process.stdout.write` in this file at all. az prints subscription ids,
  // resource ids and object ids; azRunner() exists precisely to CAPTURE them.
  assert.deepEqual(
    inheritedStreamSpawns(ARM_SRC),
    [],
    'a spawn in this file publishes through an INHERITED stream — az output would reach the public log unredacted',
  );
  // Non-degenerate: the enumerator really can see the violation it is asserting
  // the absence of, and does not fire on an inherited STDIN.
  assert.deepEqual(inheritedStreamSpawns("x({ stdio: ['ignore', 'inherit', 'pipe'] })")[0].inherits, ['stdout']);
  assert.equal(inheritedStreamSpawns("x({ stdio: ['inherit', 'pipe', 'pipe'] })").length, 0);
});

test('SELF-DEFENCE — the surface enumerator can actually detect an unbounded write', () => {
  const found = unboundedWrites(CONTROL_SOURCE_CRLF, ARM_BOUNDARIES);
  assert.equal(found.length, 2, `expected the control's 2 violations, found ${found.length}`);
  assert.ok(found.some((w) => w.arg.startsWith('`deploy:')), 'a bare template-literal write was not detected');
  assert.ok(
    found.some((w) => w.arg.startsWith('redact(')),
    'a PER-SITE redact() was not detected — one boundary per surface is the rule; a per-field call is the defect',
  );
  assert.equal(streamWrites(CONTROL_SOURCE_CRLF).length, 5, 'the control source lost a write to CRLF handling');
  // The stripper keeps real code and drops prose — both directions.
  assert.match(stripComments(ARM_SRC), /process\.stdout\.write\(formatStdout\(/, 'the stripper ate real code');
  assert.doesNotMatch(stripComments(ARM_SRC), /DISCLOSED EXCEPTION, and the ONLY unredacted publication/, 'the stripper left prose');
  assert.match(ARM_SRC, /DISCLOSED EXCEPTION, and the ONLY unredacted publication/, 'the disclosure was removed from the source');
});

// ── THE CLI, END TO END — both stdout branches and a poisoned usage refusal ───

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-arm-test-'));
}

/** A fake `az` that prints one failed operation carrying the synthetic id. */
function fakeAz(dir) {
  const ops = [
    {
      operationId: 'DEADBEEF',
      properties: {
        provisioningState: 'Failed',
        statusCode: 'Conflict',
        targetResource: {
          id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-x/providers/Microsoft.DBforPostgreSQL/flexibleServers/administrators',
          resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers/administrators',
          resourceName: `psql-loom-weave-default-abc123/${SYNTHETIC_OID}`,
        },
        statusMessage: {
          error: { code: 'Conflict', message: 'the administrator could not be written', details: null },
        },
      },
    },
  ];
  const payload = path.join(dir, 'az-ops.json');
  fs.writeFileSync(payload, JSON.stringify(ops), 'utf8');
  if (process.platform === 'win32') {
    const p = path.join(dir, 'fake-az.cmd');
    fs.writeFileSync(p, `@echo off\r\ntype "${payload}"\r\n`, 'utf8');
    return p;
  }
  const p = path.join(dir, 'fake-az.sh');
  fs.writeFileSync(p, `#!/bin/sh\ncat '${payload}'\n`, 'utf8');
  fs.chmodSync(p, 0o755);
  return p;
}

function runCli(args, extraEnv = {}) {
  // NODE_TEST_CONTEXT is STRIPPED: a child that only redacts when it can see it
  // is being tested is the purest gate that cannot fail, and that exact mutation
  // survived a whole suite in round 4 of this fix.
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
}

test('ACCEPTANCE — the CLI\'s DEFAULT render publishes no id, and `--json` deliberately does', () => {
  const dir = scratchDir();
  const az = fakeAz(dir);

  const plain = runCli(['--name', 'csa-loom-ci-1', '--scope', 'sub'], { LOOM_AZ_BIN: az });
  assert.equal(plain.status, EXIT.FOUND, `the drill-down must have found a leaf; stderr=${plain.stderr}`);
  // Non-degenerate: the render really carried the leaf, so "no GUID" is not the
  // answer an empty stdout would also give.
  assert.match(plain.stdout, /psql-loom-weave-default-abc123/, 'the leaf never reached stdout');
  assert.doesNotMatch(plain.stdout, GUID_RE, 'the DEFAULT render published an object id to a public log (#3829)');
  assert.match(plain.stdout, /psql-loom-weave-default-abc123\/<guid>/, 'redacted in place, not dropped');
  assert.equal(plain.stderr, '', 'the happy path must not write to stderr at all');

  // THE DISCLOSED EXCEPTION, pinned in the direction it is claimed: `--json` IS
  // raw. If this goes green-to-red because someone redacted it, that breaks the
  // documented operator contract in docs/fiab/runbooks/deploy-failure.md and
  // needs its own argument — the same "pin the carve-out, do not broaden the
  // universal" rule the child-output carve-out in deploy-retry.mjs follows.
  const raw = runCli(['--name', 'csa-loom-ci-1', '--scope', 'sub', '--json'], { LOOM_AZ_BIN: az });
  assert.equal(raw.status, EXIT.FOUND);
  assert.match(raw.stdout, GUID_RE, '`--json` stopped emitting raw ids; the runbook and the RATCHET above assume it does');
});

test('ACCEPTANCE — a usage refusal redacts the argv it echoes back', () => {
  // `--scope must be sub|group (got …)` and `unknown argument: …` both
  // interpolate operator-supplied argv straight onto stderr, which is the public
  // Actions run log. Neither had a boundary before round 5.
  const badScope = runCli(['--name', 'd', '--scope', SYNTHETIC_OID]);
  assert.equal(badScope.status, EXIT.USAGE);
  assert.match(badScope.stderr, /--scope must be sub\|group/, 'the refusal did not run');
  assert.doesNotMatch(badScope.stderr, GUID_RE, 'a usage refusal published argv unredacted (#3829 round 5)');
  assert.match(badScope.stderr, /\(got <guid>\)/, 'redacted in place, not dropped');

  const badFlag = runCli([`--${SYNTHETIC_OID}`, 'x']);
  assert.equal(badFlag.status, EXIT.USAGE);
  assert.match(badFlag.stderr, /unknown argument/, 'the refusal did not run');
  assert.doesNotMatch(badFlag.stderr, GUID_RE, 'an unknown-argument refusal published argv unredacted (#3829 round 5)');
});
