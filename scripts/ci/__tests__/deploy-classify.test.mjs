/**
 * deploy-classify.test.mjs — the Node half of the failure-taxonomy conformance.
 *
 * Runs the MJS classifier over the SHARED corpus
 * (apps/fiab-console/lib/deploy/__fixtures__/failure-corpus.json). The TS
 * classifier is run over the same corpus by
 * apps/fiab-console/lib/deploy/__tests__/failure-taxonomy.test.ts. Either
 * implementation drifting from the table, or from the other, turns its own
 * suite red.
 *
 * Run: node --test scripts/ci/__tests__/deploy-classify.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  classify,
  classifyLeaves,
  worstLeafDiagnosis,
  render,
  classExitCode,
  isRetryableClass,
  TAXONOMY,
  TAXONOMY_PATH,
  REPO_ROOT,
} from '../deploy-classify.mjs';

const CORPUS = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, 'apps', 'fiab-console', 'lib', 'deploy', '__fixtures__', 'failure-corpus.json'),
    'utf8',
  ),
);

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'ci', 'deploy-classify.mjs');

test('the taxonomy the console imports is the same file CI reads', () => {
  assert.ok(fs.existsSync(TAXONOMY_PATH), `taxonomy missing at ${TAXONOMY_PATH}`);
  assert.match(TAXONOMY_PATH.replace(/\\/g, '/'), /apps\/fiab-console\/lib\/deploy\/failure-taxonomy\.json$/);
});

test('corpus is non-empty (an empty corpus would make this suite measure nothing)', () => {
  assert.ok(Array.isArray(CORPUS.cases));
  assert.ok(CORPUS.cases.length >= 15, `corpus has only ${CORPUS.cases?.length} cases`);
});

for (const c of CORPUS.cases) {
  test(`corpus: ${c.name}`, () => {
    const d = classify(c.input);
    assert.equal(d.class, c.expect.class, `class for: ${c.name}`);
    assert.equal(d.signalId, c.expect.signalId, `signalId for: ${c.name}`);
    assert.equal(d.retryable, c.expect.retryable, `retryable for: ${c.name}`);
  });
}

test('R7 — a classified diagnosis carries the literal strings it matched', () => {
  const d = classify('ERROR: QuotaExceeded: standardDDSv5Family Cores, Location: centralus');
  assert.equal(d.class, 'quota');
  assert.ok(d.evidence.length > 0, 'evidence must not be empty for a matched signal');
  assert.ok(
    d.evidence.every((e) => 'ERROR: QuotaExceeded: standardDDSv5Family Cores, Location: centralus'
      .toLowerCase()
      .includes(e.signal)),
    'every evidence signal must actually appear in the input',
  );
  assert.ok(d.evidence.some((e) => e.line.includes('QuotaExceeded')), 'evidence quotes the real line');
});

test('R7 — unknown asserts NOTHING and is not a pass', () => {
  const d = classify('ERROR: (SomeCodeNobodyHasEverSeen) the widget frobnicator declined');
  assert.equal(d.class, 'unknown');
  assert.equal(d.signalId, null);
  assert.equal(d.retryable, false);
  assert.deepEqual(d.evidence, []);
  assert.equal(d.remediation, null);

  const msg = render(d, 'provision');
  assert.match(msg, /could not classify/i);
  assert.doesNotMatch(msg, /does not exist/i);
  assert.doesNotMatch(msg, /not found/i);
  assert.notEqual(d.exitCode, 0, 'unknown must never exit 0');
});

test('R7 — an unreachable registry says "could not read", never "does not exist"', () => {
  // This is the exact incident deploy-integrity.md R7 was written about.
  const d = classify(
    'ERROR: Failed to connect: client with IP 20.1.2.3 is not allowed access. Refer to https://aka.ms/acr/firewall',
  );
  assert.equal(d.class, 'config');
  assert.equal(d.signalId, 'config.acr-unreachable');
  const msg = render(d);
  assert.doesNotMatch(
    msg,
    /tag does not exist|image does not exist|not in the registry/i,
    'an unreachable registry must never be rendered as absence',
  );
  assert.match(d.remediation, /network-locked|firewall lease/i);
});

test('R7 — absence may ONLY be claimed when the registry actually answered', () => {
  const answered = classify('ERROR: The specified tag does not exist in the repository loom-console');
  assert.equal(answered.signalId, 'config.image-tag-absent');
  assert.match(answered.remediation, /genuinely absent/i);

  const denied = classify('denied: requested access to the resource is denied');
  assert.notEqual(denied.signalId, 'config.image-tag-absent');
  assert.equal(denied.class, 'permission');
});

test('R6 — quota is never retryable, whatever else the message says', () => {
  for (const s of [
    'QuotaExceeded: standardDDSv5Family Cores',
    'ERROR: (SkuNotAvailable) The requested size for resource is currently not available in location',
    'ResourceQuotaExceeded',
  ]) {
    const d = classify(s);
    assert.equal(d.class, 'quota', s);
    assert.equal(d.retryable, false, s);
  }
});

test('R6 — the word "quota" reaches the operator-facing message', () => {
  const msg = render(classify('ERROR: QuotaExceeded: standardDDSv5Family Cores, Location: centralus'));
  assert.match(msg, /quota/i, 'the rendered message must name the cause');
});

test('precedence — a permanent class beats a transient one in the same output', () => {
  const d = classify(
    'ERROR: (AuthorizationFailed) does not have authorization to perform action. ' +
      'The service is temporarily unavailable to this principal.',
  );
  assert.equal(d.class, 'permission');
  assert.equal(d.retryable, false);
});

test('classPrecedence covers every class that any signal declares', () => {
  const declared = new Set(TAXONOMY.signals.map((s) => s.class));
  for (const c of declared) {
    assert.ok(
      TAXONOMY.classPrecedence.includes(c),
      `signal class "${c}" is missing from classPrecedence — it would sort LAST and could be ` +
        'silently outranked by every other class',
    );
    assert.ok(TAXONOMY.classes[c], `signal class "${c}" has no entry in classes{}`);
  }
});

test('every class has a DISTINCT non-zero exit code', () => {
  const codes = Object.entries(TAXONOMY.classes).map(([k, v]) => [k, v.exitCode]);
  for (const [k, code] of codes) assert.notEqual(code, 0, `${k} must not exit 0`);
  const seen = new Set(codes.map(([, c]) => c));
  assert.equal(seen.size, codes.length, 'exit codes collide; a caller could not branch on them');
});

test('every signal has evidence-bearing matchers and a remediation', () => {
  for (const s of TAXONOMY.signals) {
    assert.ok(
      (s.anyOf?.length ?? 0) > 0 || (s.allOf?.length ?? 0) > 0,
      `signal ${s.id} has neither anyOf nor allOf — it would match EVERY input`,
    );
    assert.ok(s.observed && s.observed.length > 20, `signal ${s.id} must record where it was observed`);
    assert.ok(s.remediation && s.remediation.length > 20, `signal ${s.id} must carry a remediation`);
    assert.ok(
      ['platform-will-fix', 'operator-action', 'not-remediable'].includes(s.remediationKind),
      `signal ${s.id} has an unknown remediationKind`,
    );
    for (const needle of [...(s.anyOf ?? []), ...(s.allOf ?? []), ...(s.not ?? [])]) {
      assert.equal(
        needle,
        needle.toLowerCase(),
        `signal ${s.id} matcher "${needle}" is not lower-case; matching lower-cases the input`,
      );
    }
  }
});

test('isRetryableClass / classExitCode agree with the table', () => {
  assert.equal(isRetryableClass('transient'), true);
  assert.equal(isRetryableClass('quota'), false);
  assert.equal(isRetryableClass('unknown'), false);
  assert.equal(classExitCode('quota'), TAXONOMY.classes.quota.exitCode);
  assert.equal(classExitCode('nope-not-a-class'), TAXONOMY.classes.unknown.exitCode);
});

// ── CLI behaviour ────────────────────────────────────────────────────────────

test('CLI exits with the class exit code, not 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--text', 'QuotaExceeded on the subscription'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, TAXONOMY.classes.quota.exitCode);
  assert.match(r.stdout, /quota/i);
});

test('CLI --query returns the data and exits 0 (for callers that only want the verdict)', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--text', 'ContainerAppOperationInProgress', '--json', '--query'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0);
  const d = JSON.parse(r.stdout);
  assert.equal(d.class, 'transient');
  assert.equal(d.retryable, true);
});

test('CLI on a MISSING file says the file is missing — it does not classify ""', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--file', path.join(REPO_ROOT, 'no-such-file.txt')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, 'a missing input is a usage error, not an "unknown" classification');
  assert.match(r.stderr, /does not exist/);
  assert.match(r.stderr, /no cause asserted/i);
});

// ── D6: per-ARM-leaf classification (run 31100384405) ───────────────────────
// The defect this closes: classify() over the CONCATENATED nine leaves of that
// run returned `defect` (the InvalidTemplate leaf wins precedence), so the
// retryable CapacityNotAvailable leaf was never retried and never even
// reported as retryable. The leaf shapes below are the REAL drilled leaves of
// that run, trimmed to the read fields.

const LEAF_CAPACITY = {
  code: 'CapacityNotAvailable',
  message: 'Capacity is not available in this region/zone. Please retry after some time.',
  resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers',
  resourceName: 'psql-loom-ducklake-k6mvh5sm6z7do',
};
const LEAF_DEFECT = {
  code: 'InvalidTemplate',
  message:
    "Unable to process template language expressions for resource '…/privateDnsZones/azure-api.net/A/apim-csa-loom-centralus'. 'The language expression property '0' can't be evaluated.'",
  resourceType: 'Microsoft.Network/privateDnsZones/A',
  resourceName: 'azure-api.net/apim-csa-loom-centralus',
};

test('D6: each leaf keeps ITS OWN class — capacity stays retryable, defect stays defect', () => {
  const dx = classifyLeaves([LEAF_CAPACITY, LEAF_DEFECT]);
  assert.equal(dx.length, 2);
  assert.equal(dx[0].diagnosis.class, 'capacity');
  assert.equal(dx[0].diagnosis.signalId, 'capacity.not-available');
  assert.equal(dx[0].diagnosis.retryable, true, 'the capacity leaf must be flagged retryable');
  assert.equal(dx[1].diagnosis.class, 'defect');
  assert.equal(dx[1].diagnosis.signalId, 'defect.invalid-template');
  assert.equal(dx[1].diagnosis.retryable, false);
});

test('D6: the CONCATENATED classify of the same two leaves is defect — the exact collapse per-leaf exists to avoid', () => {
  const concatenated = classify(
    `${LEAF_CAPACITY.code}: ${LEAF_CAPACITY.message}\n${LEAF_DEFECT.code}: ${LEAF_DEFECT.message}`,
  );
  assert.equal(concatenated.class, 'defect');
});

test('D6: worstLeafDiagnosis is the fail-fast headline (defect over capacity)', () => {
  const dx = classifyLeaves([LEAF_CAPACITY, LEAF_DEFECT]);
  assert.equal(worstLeafDiagnosis(dx).class, 'defect');
  assert.equal(worstLeafDiagnosis(classifyLeaves([LEAF_CAPACITY])).class, 'capacity');
});

test('D6: an unknown leaf among known ones does not bury the named cause; all-unknown stays unknown', () => {
  const junk = { code: 'Gibberish', message: 'no signal matches this', resourceType: null, resourceName: null };
  const mixed = classifyLeaves([junk, LEAF_CAPACITY]);
  assert.equal(worstLeafDiagnosis(mixed).class, 'capacity');
  const alone = classifyLeaves([junk]);
  assert.equal(worstLeafDiagnosis(alone).class, 'unknown');
  assert.equal(worstLeafDiagnosis([]), null);
});

test('D6: the capacity class is retryable in the taxonomy and quota is NOT — the split the class exists for', () => {
  assert.equal(isRetryableClass('capacity'), true);
  assert.equal(isRetryableClass('quota'), false);
  assert.equal(TAXONOMY.classPrecedence.includes('capacity'), true);
});
