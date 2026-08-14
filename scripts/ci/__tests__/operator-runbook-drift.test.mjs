/**
 * check-operator-runbook-drift self-test (#3375).
 *
 * A guard that cannot fail reads as coverage and enforces nothing, so this
 * drives the detector against synthetic fixtures and pins BOTH verdicts:
 * the forbidden click-path prose must trip, and the legitimate prose that
 * merely NAMES an automated action must not.
 *
 * It also pins the direction that matters most: `hasEvidence` must report
 * FALSE when the automation is absent. Without that, deleting the Graph
 * role-assignment step from the bootstrap would leave a doc that correctly
 * says nothing and a platform that does nothing.
 *
 * Run: node --test scripts/ci/__tests__/operator-runbook-drift.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RULES,
  violations,
  hasEvidence,
  selfTest,
  main,
} from '../check-operator-runbook-drift.mjs';

const rule = (id) => {
  const r = RULES.find((x) => x.id === id);
  assert.ok(r, `rule ${id} must exist`);
  return r;
};

test('the guard carries rules at all (a zero-population guard measures nothing)', () => {
  assert.ok(RULES.length >= 4, `expected >= 4 rules, got ${RULES.length}`);
});

test('embedded control passes against the shipped detectors', () => {
  assert.deepEqual(selfTest(), []);
});

test('the real repo passes (this is the merge-blocking verdict)', () => {
  assert.equal(main(), 0);
});

// ── forbidden instructions must TRIP ────────────────────────────────────────

test('detects the Power Platform Administrator portal click-path', () => {
  const hits = violations(
    '3. Left nav -> Settings -> Roles and administrators (Microsoft Entra roles).',
    rule('pp-admin-role'),
  );
  assert.equal(hits.length, 1);
});

test('detects "Power Platform Administrator ... Assign"', () => {
  const hits = violations(
    '4. Find the Power Platform Administrator role row and click Assign.',
    rule('pp-admin-role'),
  );
  assert.equal(hits.length, 1);
});

test('detects the Dataverse Application User click-path', () => {
  const hits = violations(
    'PPAC -> Environment -> Users + permissions -> Application users -> + New app user',
    rule('dataverse-app-user'),
  );
  assert.equal(hits.length, 1);
});

test('detects the dev-console bootstrap-catalogs POST', () => {
  const hits = violations(
    '  - POST /api/admin/bootstrap-catalogs from the browser dev console, OR',
    rule('catalog-dev-console-post'),
  );
  assert.equal(hits.length, 1);
});

test('detects the Fabric admin-portal click-path', () => {
  const r = rule('fabric-tenant-toggle');
  assert.equal(violations('1. Go to https://app.fabric.microsoft.com', r).length, 1);
  assert.equal(violations('2. Open https://app.fabric.microsoft.us/admin-portal', r).length, 1);
  assert.equal(violations('3. Left nav -> Tenant settings -> Developer settings.', r).length, 1);
  assert.equal(
    violations('- "Service principals can call Fabric public APIs" -> Enabled, same group', r).length,
    1,
  );
});

test('a bare portal-host MENTION with no navigation imperative does not trip', () => {
  // Precision boundary + the CodeQL js/regex/missing-regexp-anchor fix: the
  // branch requires a navigate verb alongside the fabric.microsoft fragment,
  // so a cross-reference that merely names the host stays legal.
  const r = rule('fabric-tenant-toggle');
  assert.deepEqual(
    violations('The Fabric admin portal (app.fabric.microsoft.com) is covered there, not here.', r),
    [],
  );
});

// ── legitimate prose must STAY CLEAN (an over-broad guard hides nothing) ────

test('does not flag prose that says the BOOTSTRAP performs the action', () => {
  assert.deepEqual(
    violations(
      'Power Platform Administrator directory role -> assigned to the Console UAMI via Microsoft Graph.',
      rule('pp-admin-role'),
    ),
    [],
  );
  assert.deepEqual(
    violations(
      'registered on every environment that has a Dataverse database, via dataverse-add-appuser.sh.',
      rule('dataverse-app-user'),
    ),
    [],
  );
  assert.deepEqual(
    violations(
      'The admin route still exists for an explicit re-seed, but bootstrap-catalogs is not part of first-run setup.',
      rule('catalog-dev-console-post'),
    ),
    [],
  );
});

test('does not flag NAMING the Fabric toggle while pointing at the opt-in doc', () => {
  const r = rule('fabric-tenant-toggle');
  assert.deepEqual(
    violations('tenant toggle ("Service principals can use Fabric APIs"), the Power BI', r),
    [],
  );
  assert.deepEqual(
    violations('They are documented in Tenant-admin walkthroughs -> (c) Microsoft Fabric.', r),
    [],
  );
});

// ── evidence probes must FAIL when the automation is gone ───────────────────

test('hasEvidence is FALSE when the bootstrap loses the Graph role assignment', () => {
  const ev = rule('pp-admin-role').evidence;
  const withStep =
    'curl POST https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments ' +
    'roleDefinitionId 11648597-926c-4cf3-9c36-bcebb0ba8dcc';
  assert.equal(hasEvidence(withStep, ev), true);
  // Drop the role template id -> the automation is no longer the one we mean.
  assert.equal(
    hasEvidence('curl POST https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments', ev),
    false,
  );
  // Drop the endpoint entirely.
  assert.equal(hasEvidence('11648597-926c-4cf3-9c36-bcebb0ba8dcc', ev), false);
  assert.equal(hasEvidence('', ev), false);
});

test('hasEvidence is FALSE when the bootstrap stops calling dataverse-add-appuser.sh', () => {
  const ev = rule('dataverse-app-user').evidence;
  assert.equal(hasEvidence('bash scripts/csa-loom/dataverse-add-appuser.sh', ev), true);
  assert.equal(hasEvidence('bash scripts/csa-loom/something-else.sh', ev), false);
});

test('hasEvidence is FALSE when the workloads route loses its seed backstop', () => {
  const ev = rule('catalog-dev-console-post').evidence;
  const real =
    'import { WORKLOAD_SEEDS } from "@/lib/apps/workloads-catalog-seed";\n' +
    'createdBy: "workloads-catalog-backstop",';
  assert.equal(hasEvidence(real, ev), true);
  // The backstop block deleted, a stale import left behind.
  assert.equal(
    hasEvidence('import { WORKLOAD_SEEDS } from "@/lib/apps/workloads-catalog-seed";', ev),
    false,
  );
  // REGRESSION (mutation-found): a bare /WORKLOAD_SEEDS/ substring probe let a
  // rename to WORKLOAD_SEEDS_GONE keep the guard green while the backstop was
  // gone. The word boundary must reject it.
  assert.equal(
    hasEvidence(
      'import { WORKLOAD_SEEDS_GONE } from "@/lib/apps/workloads-catalog-seed";\n' +
        'createdBy: "workloads-catalog-backstop",',
      ev,
    ),
    false,
  );
  assert.equal(hasEvidence('return NextResponse.json({ ok: true, workloads: resources });', ev), false);
});
