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

// ── #3449: the three GCC-High ARM leaves that classified `unknown` ───────────
//
// deploy-fiab-gcch runs 31941086712 (2026-08-16) and 32019775757 (2026-08-17)
// failed on the SAME three ARM leaves, and all three were `unknown`, so the
// whole sovereign lane failed carrying no cause at all. These tests pin the
// three signals added for them.
//
// THIS BLOCK MUST FAIL WHEN THE TABLE IS MUTATED — that is its only reason to
// exist, so it checks four independent things and every failure message names
// apps/fiab-console/lib/deploy/failure-taxonomy.json:
//
//   1. POPULATION. Re-read from disk rather than trusting the loaded TAXONOMY:
//      an empty or truncated `signals` list must be a FAILURE, never a quiet
//      pass. A test that measures nothing when the table is emptied is the
//      repo's dominant defect class.
//   2. MATCHER SET, exactly. deepEqual, not "includes" — a floor like
//      `includes(needle)` is satisfied by the good entry while a bad entry
//      ADDED alongside it stays invisible. Every blind spot found in sprint 1
//      came from an additive mutation, so additive mutations must fail here.
//   3. BEHAVIOUR. Each verbatim leaf classifies to its own signal, per leaf,
//      with evidence that literally occurs in that leaf.
//   4. DISCRIMINATION. Near misses stay `unknown`. This is what catches an
//      over-broad entry added anywhere in the table: a signal keyed on the bare
//      code `badrequest` or `parameteroutofrange` would turn these green-to-red.
//
// CLOUD PARITY: the taxonomy is one boundary-agnostic table — no signal carries
// a cloud condition — so these three are matched identically in Commercial,
// GCC, GCC-High and IL5. Where the three CONDITIONS occur is a separate
// question: they were observed only in GCC-High (usgovvirginia), and the DNS
// one has a recorded mirror-image Commercial occurrence (#2775, admin-plane/
// network.bicep). Classifying them does NOT make any lane green — it converts
// "nothing is known" into three named causes. deploy-fiab-gcch still fails.

const TAXONOMY_REL_3449 = 'apps/fiab-console/lib/deploy/failure-taxonomy.json';

/** The real drilled leaves, verbatim from both runs, trimmed to the read fields. */
const GCCH_3449 = [
  {
    signalId: 'config.adx-cluster-stopped',
    matchers: { allOf: ['clusternotvalidforprincipals'], anyOf: ["in state 'stopped'"] },
    leaf: {
      code: 'ClusterNotValidForPrincipals',
      message: "[BadRequest] Cluster is in state 'Stopped', cannot retrieve list of principals",
      resourceType: 'Microsoft.Kusto/clusters/principalAssignments',
      resourceName: 'adx-csa-loom-fmezxj/console-uami-alldatabasesadmin',
    },
    remediationMatches: /az kusto cluster start/,
  },
  {
    signalId: 'config.dns-resolver-ip-allocation-immutable',
    matchers: { allOf: undefined, anyOf: ['ip allocation method cannot be changed after creation'] },
    leaf: {
      code: 'BadRequest',
      message:
        'IP allocation method cannot be changed after creation. inboundEndpointResourceId=/subscriptions/<redacted>/resourceGroups/rg-csa-loom-admin-usgovvirginia/dnsResolvers/dnspr-loom-usgovvirginia/inboundEndpoints/inbound, ipAllocationMethod=Dynamic, existingIpAllocationMethod=Static',
      resourceType: 'Microsoft.Resources/deployments',
      resourceName: 'admin-plane',
    },
    remediationMatches: /immutable/i,
  },
  {
    signalId: 'config.version-allowed-set-empty',
    matchers: { allOf: ['parameteroutofrange'], anyOf: ["the value of the 'version' should be in: []"] },
    leaf: {
      code: 'ParameterOutOfRange',
      message:
        "The value of the 'Version' should be in: []. Verify that the specified parameter value is correct.",
      resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers',
      resourceName: 'psql-loom-weave-default-dcmt6cqoezlgs',
    },
    remediationMatches: /list-skus/,
  },
];

test('#3449 population — the taxonomy on disk is non-empty and carries all three signals', () => {
  const onDisk = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
  assert.ok(
    Array.isArray(onDisk.signals) && onDisk.signals.length > 0,
    `${TAXONOMY_REL_3449} has an empty or missing "signals" list — an empty population means the ` +
      'table was gutted (or this test drifted off the schema), never that the repo is clean.',
  );
  // A floor, so a table truncated to a handful of entries cannot pass either.
  assert.ok(
    onDisk.signals.length >= 36,
    `${TAXONOMY_REL_3449} declares ${onDisk.signals.length} signals; 36 were present when the #3449 ` +
      'signals landed. A shrinking table is a deletion to justify, not a pass.',
  );
  for (const { signalId } of GCCH_3449) {
    assert.ok(
      onDisk.signals.some((s) => s.id === signalId),
      `${TAXONOMY_REL_3449} no longer declares signal "${signalId}" — the GCC-High leaf it names ` +
        '(deploy-fiab-gcch runs 31941086712 / 32019775757) would fall back to unknown.',
    );
  }
});

test('#3449 matcher sets are EXACTLY the observed strings — additive mutation fails here too', () => {
  const onDisk = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
  for (const { signalId, matchers } of GCCH_3449) {
    const sig = onDisk.signals.find((s) => s.id === signalId);
    assert.ok(sig, `${TAXONOMY_REL_3449} is missing signal "${signalId}"`);
    assert.deepEqual(
      sig.anyOf,
      matchers.anyOf,
      `${TAXONOMY_REL_3449}: the anyOf of "${signalId}" changed. Only strings OBSERVED in a real ` +
        'run belong here, and adding one alongside the observed entry is exactly the mutation this ' +
        'assertion exists to catch — update this test deliberately, with the run id, or revert.',
    );
    assert.deepEqual(
      sig.allOf,
      matchers.allOf,
      `${TAXONOMY_REL_3449}: the allOf of "${signalId}" changed. The allOf is the PIN that keeps ` +
        'this signal from claiming a condition it never established; loosening it silently is the ' +
        'defect.',
    );
    assert.equal(sig.class, 'config', `${TAXONOMY_REL_3449}: "${signalId}" changed class`);
    assert.ok(
      /31941086712|32019775757/.test(sig.observed ?? ''),
      `${TAXONOMY_REL_3449}: "${signalId}" must cite the run it was observed on — provenance is the ` +
        'only thing separating an observed signal from a guessed one.',
    );
  }
});

test('#3449 each verbatim leaf classifies to its own signal, with evidence taken from that leaf', () => {
  const diagnoses = classifyLeaves(GCCH_3449.map((c) => c.leaf));
  assert.equal(diagnoses.length, 3);
  diagnoses.forEach((d, i) => {
    const want = GCCH_3449[i];
    assert.equal(
      d.diagnosis.signalId,
      want.signalId,
      `${TAXONOMY_REL_3449}: leaf ${want.leaf.code} classified "${d.diagnosis.signalId ?? 'unknown'}" ` +
        `instead of "${want.signalId}"`,
    );
    assert.equal(d.diagnosis.class, 'config');
    assert.equal(d.diagnosis.retryable, false, 'none of the three is retryable — the estate must change');
    assert.ok(d.diagnosis.evidence.length > 0, `${want.signalId} matched with no evidence`);
    const leafText = `${want.leaf.code}: ${want.leaf.message}`.toLowerCase();
    for (const e of d.diagnosis.evidence) {
      assert.ok(
        leafText.includes(e.signal),
        `${TAXONOMY_REL_3449}: "${want.signalId}" quoted "${e.signal}" as evidence, but that string ` +
          'does not occur in the leaf it matched — evidence must be a substring of the input (R7).',
      );
    }
    assert.match(d.diagnosis.remediation ?? '', want.remediationMatches);
    const msg = render(d.diagnosis, 'az deployment sub create (gcch derived)');
    assert.doesNotMatch(msg, /could not classify/i);
    assert.match(msg, /Remediation:/);
  });
});

test('#3449 discrimination — near misses stay unknown, so no signal over-claims', () => {
  // Synthesised inputs, deliberately NOT in the shared corpus (whose inputs are
  // observed strings). Every expectation here is NEGATIVE: the taxonomy must
  // decline to name a cause it has not established.
  const nearMisses = [
    // The bare ARM code of leaf 2. `BadRequest` carries no cause on its own, and
    // the leaf-1 message contains "[BadRequest]" too — a signal keyed on the
    // code would have labelled a stopped ADX cluster a DNS problem.
    'BadRequest: the request could not be processed',
    // ClusterNotValidForPrincipals for a state that is NOT Stopped: "start the
    // cluster" would be a remediation for a condition never established.
    'ClusterNotValidForPrincipals: [BadRequest] Cluster is in state \'Starting\', cannot retrieve list of principals',
    // The same ARM code with a NON-empty allowed set: that one really is "pick a
    // valid value", which is a different remediation from the empty-set case.
    "ParameterOutOfRange: The value of the 'StorageSizeGB' should be in: [32, 64, 128, 256, 512].",
  ];
  for (const input of nearMisses) {
    const d = classify(input);
    assert.equal(
      d.class,
      'unknown',
      `${TAXONOMY_REL_3449}: "${input.slice(0, 60)}…" classified as ${d.class} (${d.signalId}). ` +
        'Something in the table is over-broad — most likely a signal keyed on a bare ARM code.',
    );
    assert.equal(d.signalId, null);
    assert.equal(d.remediation, null, 'an unknown must carry no remediation');
  }
});

test('#3449 the three leaves TOGETHER still fail closed and name every cause', () => {
  // The real shape of both runs: three independent leaves, none retryable.
  const dx = classifyLeaves(GCCH_3449.map((c) => c.leaf));
  assert.equal(dx.filter((d) => d.diagnosis.class === 'unknown').length, 0);
  assert.equal(dx.filter((d) => d.diagnosis.retryable).length, 0, 'no leaf may become retryable');
  const worst = worstLeafDiagnosis(dx);
  assert.equal(worst.class, 'config');
  assert.notEqual(worst.exitCode, 0, 'a classified failure still exits non-zero');
});
