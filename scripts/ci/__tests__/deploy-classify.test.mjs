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

// ── #3817: the PostgreSQL Entra-admin leaf that took a SCHEDULED deploy down ──
//
// deploy-fiab-commercial run 32341450273 (2026-08-20T06:52Z, schedule trigger,
// sha 043c1aa3) failed on ONE ARM leaf, and that leaf classified `unknown` — so
// decideRetryForLeaves failed closed on attempt 1 and the run exited 17. The
// classifier did the honest thing (that is R7 working, and it is not the bug).
// The bug is the OTHER half of R6: a GENUINELY TRANSIENT window took the whole
// scheduled Commercial deploy down on a single attempt, because nothing in the
// table named it.
//
// MEASURED AFTER THE RUN (Azure Resource Graph, 2026-08-20): that same server
// exists in rg-csa-loom-admin-centralus and reports state 'Ready'. The condition
// was therefore a WINDOW in which the server was not Entra-operable — not a
// dead, stopped, or missing resource — which is what makes it `transient` and
// not `config`. What PUT the server mid-operation during a scheduled reconcile
// is NOT established, is asserted nowhere in the entry, and is still open on
// #3817.
//
// WHY THIS BLOCK HAS TO BE ABLE TO FAIL. A RETRYABLE entry is the dangerous
// direction to get wrong: where an over-broad `config` entry merely mislabels, an
// over-broad `transient` entry converts a hard failure into a SLOW hard failure —
// it burns the whole retry budget and then reports "failed after N attempts",
// which is the exact 2026-08-05 quota shape this taxonomy exists to prevent. So
// the DISCRIMINATION test below is the load-bearing one: it pins that genuinely
// fatal Entra/auth failures never reach this signal.

const TAXONOMY_REL_3817 = 'apps/fiab-console/lib/deploy/failure-taxonomy.json';
const SIGNAL_3817 = 'transient.postgres-entra-admin-server-not-accessible';

/** The real drilled leaf, verbatim from run 32341450273 (object id redacted). */
const LEAF_3817 = {
  code: 'AadAuthOperationCannotBePerformedWhenServerIsNotAccessible',
  message:
    "Server 'psql-loom-weave-default-k6mvh5sm6z7do' is not in an accessible state to perform a " +
    'Microsoft Entra authentication principal operation. Make sure that the server is in an ' +
    'accessible before executing any Microsoft Entra authentication principal operation.',
  resourceType: 'Microsoft.DBforPostgreSQL/flexibleServers/administrators',
  resourceName: 'psql-loom-weave-default-k6mvh5sm6z7do/<console-uami-object-id>',
};

test('#3817 population — the taxonomy on disk still carries the signal', () => {
  const onDisk = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
  assert.ok(
    Array.isArray(onDisk.signals) && onDisk.signals.length > 0,
    `${TAXONOMY_REL_3817} has an empty or missing "signals" list — an empty population means the ` +
      'table was gutted, never that the repo is clean.',
  );
  assert.ok(
    onDisk.signals.length >= 37,
    `${TAXONOMY_REL_3817} declares ${onDisk.signals.length} signals; 37 were present when the ` +
      '#3817 signal landed. A shrinking table is a deletion to justify, not a pass.',
  );
  assert.ok(
    onDisk.signals.some((s) => s.id === SIGNAL_3817),
    `${TAXONOMY_REL_3817} no longer declares "${SIGNAL_3817}" — the leaf from run 32341450273 ` +
      'would fall back to unknown and a transient window would again fail the deploy on attempt 1.',
  );
});

test('#3817 matcher set is EXACTLY the observed strings — additive mutation fails here too', () => {
  const onDisk = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
  const sig = onDisk.signals.find((s) => s.id === SIGNAL_3817);
  assert.ok(sig, `${TAXONOMY_REL_3817} is missing signal "${SIGNAL_3817}"`);
  assert.deepEqual(
    sig.anyOf,
    [
      'aadauthoperationcannotbeperformedwhenserverisnotaccessible',
      'is not in an accessible state to perform a microsoft entra authentication principal operation',
    ],
    `${TAXONOMY_REL_3817}: the anyOf of "${SIGNAL_3817}" changed. Both entries are self-describing ` +
      'and name the CONDITION, not a bare ARM code; widening either (to "not in an accessible ' +
      'state", say, or to a bare auth code) would let this RETRYABLE signal swallow failures ' +
      'retrying cannot fix. Update this test deliberately, with the run id, or revert.',
  );
  assert.equal(
    sig.allOf,
    undefined,
    `${TAXONOMY_REL_3817}: "${SIGNAL_3817}" grew an allOf. Both anyOf strings are already specific ` +
      'enough to pin the condition on their own; an allOf here would only reduce recall.',
  );
  assert.equal(sig.class, 'transient', `${TAXONOMY_REL_3817}: "${SIGNAL_3817}" changed class`);
  assert.ok(
    /32341450273/.test(sig.observed ?? ''),
    `${TAXONOMY_REL_3817}: "${SIGNAL_3817}" must cite the run it was observed on — provenance is ` +
      'the only thing separating an observed signal from a guessed one.',
  );
});

test('#3817 the verbatim leaf classifies transient + retryable, with evidence taken from that leaf', () => {
  const [d] = classifyLeaves([LEAF_3817]);
  assert.equal(
    d.diagnosis.signalId,
    SIGNAL_3817,
    `${TAXONOMY_REL_3817}: the leaf classified "${d.diagnosis.signalId ?? 'unknown'}"`,
  );
  assert.equal(d.diagnosis.class, 'transient');
  assert.equal(d.diagnosis.retryable, true, 'the whole point of #3817 is that this leaf is retryable');
  assert.equal(d.diagnosis.exitCode, TAXONOMY.classes.transient.exitCode);
  assert.notEqual(d.diagnosis.exitCode, 0, 'a classified failure still exits non-zero');
  assert.ok(d.diagnosis.evidence.length > 0, 'matched with no evidence');
  const leafText = `${LEAF_3817.code}: ${LEAF_3817.message}`.toLowerCase();
  for (const e of d.diagnosis.evidence) {
    assert.ok(
      leafText.includes(e.signal),
      `${TAXONOMY_REL_3817}: quoted "${e.signal}" as evidence, but that string does not occur in ` +
        'the leaf it matched — evidence must be a substring of the input (R7).',
    );
  }
  const msg = render(d.diagnosis, 'az deployment sub create (commercial)');
  assert.doesNotMatch(msg, /could not classify/i);
  assert.match(msg, /Remediation:/);
});

test('#3817 discrimination — genuinely FATAL Entra/auth failures never reach this signal', () => {
  // The load-bearing negative control. Without it an over-broad retryable entry
  // looks exactly like a pass: the real error goes green and the damage (a
  // permission denial retried until the budget dies) is invisible.
  const mustNotBeTransient = [
    // A real RBAC denial on the very same sub-resource this signal covers.
    "ERROR: (AuthorizationFailed) The client does not have authorization to perform action " +
      "'Microsoft.DBforPostgreSQL/flexibleServers/administrators/write' over scope",
    // The MSAL shape behind a recorded production outage — never retryable.
    'AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is ' +
      'the client secret value, not the client secret ID.',
    'ERROR: (InvalidAuthenticationTokenTenant) The access token is from the wrong issuer.',
    // An Entra principal that is genuinely invalid: deterministic, not a window.
    "ERROR: (InvalidPrincipalId) The principal id is not a valid Microsoft Entra principal.",
    // The GENERIC half of this signal's own message, WITHOUT the Entra
    // principal-operation clause. If someone widens the matcher to "not in an
    // accessible state", this is what starts being retried.
    "Server 'psql-loom-weave-default-k6mvh5sm6z7do' is not in an accessible state.",
    // Entra words with no condition attached.
    'Microsoft Entra authentication is enabled on this server.',
  ];
  for (const input of mustNotBeTransient) {
    const d = classify(input);
    assert.notEqual(
      d.class,
      'transient',
      `${TAXONOMY_REL_3817}: "${input.slice(0, 60)}…" classified TRANSIENT (${d.signalId}). ` +
        'Something is over-broad — a retryable match on a fatal failure burns the whole budget ' +
        'and then reports "failed after N attempts" without naming the cause.',
    );
    assert.equal(
      d.retryable,
      false,
      `${TAXONOMY_REL_3817}: "${input.slice(0, 60)}…" became RETRYABLE (${d.class}/${d.signalId}).`,
    );
  }
});

test('#3817 R7 — the remediation asserts no server state, and names how to establish one', () => {
  // The taxonomy reads TEXT; it never queries the server. So the one thing this
  // remediation must not do is tell the operator what state the server is in —
  // the R7 incident this repo records is a message asserting "the tag does not
  // exist" when the truth was "I could not reach the registry".
  const [d] = classifyLeaves([LEAF_3817]);
  const rem = d.diagnosis.remediation ?? '';
  assert.ok(rem.length > 0, 'a classified signal must carry a remediation');
  assert.match(
    rem,
    /does not establish/i,
    'the remediation must say plainly that it read no server state',
  );
  assert.match(
    rem,
    /az postgres flexible-server show/,
    'it must name the exact command that WOULD establish the state',
  );
  assert.match(
    rem,
    /stopped/i,
    'it must name the case where this same code is NOT a transient window, so an exhausted ' +
      'budget is not read as "the window just had not closed yet"',
  );
  // It must not claim the server is fine — that is precisely what it did not read.
  assert.doesNotMatch(rem, /the server is (healthy|fine|ready|up)\b/i);
});
