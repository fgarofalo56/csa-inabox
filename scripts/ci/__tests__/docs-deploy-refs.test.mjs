/**
 * docs-deploy-refs.test.mjs — teeth for the deployment-doc guard.
 *
 * The guard this covers used to be `existsSync` and nothing else, which proves
 * a weaker property than R8 needs: a path can exist while the construct the doc
 * publishes cannot run. The checks below are exercised against the ACTUAL
 * defect shape that motivated each one, and against the fixed shape, so each is
 * proven to DISTINGUISH them rather than merely to fire.
 *
 * The BCP259 wording asserted here is not invented. It was produced by running
 * the real compiler on the exact construct, 2026-08:
 *
 *   $ az bicep build-params --file platform/fiab/bicep/params/_probe.bicepparam
 *   _probe.bicepparam(4,1) : Error BCP259: The parameter "existingPurviewAccount"
 *   is assigned in the params file without being declared in the Bicep file.
 *
 * (Grounding the fixture in the real dependency rather than in the guard's own
 * model of it — csa_loom_fixtures_that_model_the_code.)
 *
 * Run: node --test scripts/ci/__tests__/docs-deploy-refs.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  declaredParams,
  templateOfParamFile,
  undeclaredParamAssignments,
  acceptsDispatch,
} from '../check-docs-deploy-refs.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MAIN = 'platform/fiab/bicep/main.bicep';

// ── the parse the whole check rests on ───────────────────────────────────────

test('declaredParams reads the template, and reads it PRECISELY', () => {
  const p = declaredParams(MAIN);
  assert.ok(p instanceof Set);
  // Broad enough to be real…
  assert.ok(p.size > 100, `main.bicep declares ${p?.size} params — the parse has degraded`);
  for (const known of ['adopt', 'capacitySku', 'deploymentMode', 'purviewEnabled', 'complianceTags']) {
    assert.ok(p.has(known), `${known} is declared in main.bicep but the parse missed it`);
  }
  // …and NOT so broad that everything looks declared, which is how this check
  // would come to measure nothing while still reporting green.
  assert.equal(p.has('existingPurviewAccount'), false);
  assert.equal(p.has('definitelyNotAParameter'), false);
});

test('declaredParams reports UNREADABLE as null, never as "declares nothing"', () => {
  // "I could not read it" rendered as "it declares no parameters" would flag
  // every assignment in every doc — deploy-integrity R7, one level down.
  assert.equal(declaredParams('platform/fiab/bicep/does-not-exist.bicep'), null);
});

// ── check 5: BCP259 ──────────────────────────────────────────────────────────

test('MUTATION PROOF — an assignment with no declaration is caught (BCP259)', () => {
  const doc = ['```bicepparam', `using '${MAIN}'`, "param existingPurviewAccount = '<name>'", '```'].join('\n');
  const hits = undeclaredParamAssignments(doc, 'x.md');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].param, 'existingPurviewAccount');
  assert.equal(hits[0].template, MAIN);
});

test('the same doc PASSES once it names a parameter that exists', () => {
  const doc = ['```bicepparam', `using '${MAIN}'`, 'param purviewEnabled = false', '```'].join('\n');
  assert.deepEqual(undeclaredParamAssignments(doc, 'x.md'), []);
});

test('a bicep DECLARATION quoted in a doc is not an assignment', () => {
  // `param foo string = 'x'` is how a TEMPLATE declares; only `param foo = 'x'`
  // is a params-file assignment. Confusing the two would flag every doc that
  // quotes a template.
  const doc = ['```bicep', "param someBrandNewParam string = 'x'", '```'].join('\n');
  assert.deepEqual(undeclaredParamAssignments(doc, 'x.md'), []);
});

test('the target template is resolved from the doc, not assumed', () => {
  // Discriminating on purpose: `consolePrincipalId` is declared by
  // modules/admin-plane/catalog.bicep and NOT by main.bicep. If the resolver
  // ignored the doc and fell back to the default, this snippet would be
  // reported as BCP259 — so the test fails if the `using` arm stops working,
  // rather than passing either way.
  const CATALOG = 'platform/fiab/bicep/modules/admin-plane/catalog.bicep';
  assert.equal(declaredParams(CATALOG).has('consolePrincipalId'), true);
  assert.equal(declaredParams(MAIN).has('consolePrincipalId'), false);

  const honoured = [`using '${CATALOG}'`, 'param consolePrincipalId = 1'].join('\n');
  assert.deepEqual(undeclaredParamAssignments(honoured, 'x.md'), []);

  // The same assignment with no template hint resolves to the default and IS
  // reported — the two halves together prove the resolution actually happened.
  const bare = undeclaredParamAssignments('param consolePrincipalId = 1', 'x.md');
  assert.equal(bare.length, 1);
  assert.equal(bare[0].template, MAIN);
});

test('templateOfParamFile follows `using` for every boundary params file', () => {
  const dir = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'params');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bicepparam'));
  assert.ok(files.length >= 4, `only ${files.length} params files found`);
  for (const f of files) {
    const t = templateOfParamFile(`platform/fiab/bicep/params/${f}`);
    assert.ok(t, `${f} has no resolvable \`using\``);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, t.split('/').join(path.sep))), `${f} -> ${t} does not exist`);
  }
});

// ── check 3: a documented dispatch must be dispatchable ──────────────────────

test('acceptsDispatch distinguishes dispatchable from not, and unreadable from false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-docsrefs-')).split(path.sep).join('/');
  fs.writeFileSync(`${dir.split('/').join(path.sep)}${path.sep}yes.yml`, 'on:\n  workflow_dispatch:\n    inputs: {}\n');
  fs.writeFileSync(`${dir.split('/').join(path.sep)}${path.sep}no.yml`, 'on:\n  push:\n    branches: [main]\n');
  assert.equal(acceptsDispatch(`${dir}/yes.yml`), true);
  assert.equal(acceptsDispatch(`${dir}/no.yml`), false);
  assert.equal(acceptsDispatch(`${dir}/absent.yml`), null, 'missing must be null, not false');
});

// ── whole-repo state ─────────────────────────────────────────────────────────

test('the deployment docs are clean — this guard has no baseline and no allow-list', () => {
  const r = execFileSync(process.execPath, ['scripts/ci/check-docs-deploy-refs.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.match(r, /\[docs-deploy-refs\] OK/);
});
