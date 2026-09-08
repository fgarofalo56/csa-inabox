/**
 * whatif-drift-verdict self-test — index-wildcard allowlist paths (#3191).
 *
 * WHY THIS EXISTS. The Commercial drift lane reported 128 "real" deltas on run
 * 33406666389. A per-property census of that run's raw what-if document showed
 * the largest families were all server-defaulted or read-only, repeated once
 * per ARM array element: `properties.logs.0.retentionPolicy.days`,
 * `properties.logs.1.…`, `properties.privateDnsZoneConfigs.0.id`, and so on.
 * The allowlist matcher was an exact string compare, so those could only be
 * suppressed by enumerating every index — which would silently stop matching
 * the day the estate grew one more log category or DNS zone config.
 *
 * The wildcard has to stay NARROW or it becomes a way to blanket a resource
 * type and turn the whole drift lane into a guard that cannot go red. So every
 * test below pins one edge of that narrowness:
 *
 *   - `*` matches a numeric index at any depth, and more than one per path
 *   - `*` does NOT match a property name (the blanket-suppression hazard)
 *   - rule 1 holds: a Modify on an allowlisted path is never suppressed
 *   - rule 2 holds: one unmatched delta keeps the whole resource in the verdict
 *   - allowlist hygiene: every rule carries a reason, and a `*` may only stand
 *     for a whole path segment or a whole bracket index
 *
 * The fixtures below are verbatim shapes (paths AND `before` values) taken from
 * run 33406666389's whatif.json, so they exercise the matcher against what ARM
 * actually emitted, not an invented shape.
 *
 * Run: node --test scripts/ci/__tests__/whatif-drift-verdict.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'whatif-drift-verdict.mjs');
const ALLOWLIST = resolve(HERE, '..', 'whatif-noise-allowlist.json');

/** Run the real verdict script over a what-if document. */
function verdict(doc) {
  const dir = mkdtempSync(join(tmpdir(), 'whatif-verdict-'));
  const input = join(dir, 'whatif.json');
  const ghOutput = join(dir, 'gh-output.txt');
  writeFileSync(input, JSON.stringify(doc));
  writeFileSync(ghOutput, '');
  const r = spawnSync(process.execPath, [SCRIPT, input, '--out-dir', dir, '--label', 'test'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: ghOutput, GITHUB_STEP_SUMMARY: '' },
  });
  const rawOutputs = readFileSync(ghOutput, 'utf8');
  // $GITHUB_OUTPUT heredoc form: `key<<DELIM\n…value…\nDELIM\n`.
  const outputs = {};
  for (const m of rawOutputs.matchAll(/^(\w+)<<(EOF_\w+)\n([\s\S]*?)\n\2$/gm)) {
    outputs[m[1]] = m[3];
  }
  // Read defensively so an ABSENT list surfaces as a failed assertion in the
  // test that cares about it, rather than an ENOENT that reds every other test
  // in the file and buries the signal.
  const readOrEmpty = (name) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return {
    code: r.status,
    stdout: r.stdout || '',
    outputs,
    driftList: readOrEmpty('drift-list.txt'),
    suppressedList: readOrEmpty('suppressed-list.txt'),
    unresolvedList: readOrEmpty('unresolved-list.txt'),
    summary: readOrEmpty('summary.md'),
  };
}

function modify(type, resourceId, delta) {
  return { changeType: 'Modify', resourceId, before: { type }, after: { type }, delta };
}

/** A diagnosticSettings retention leaf exactly as run 33406666389 emitted it. */
function retentionLeaf(index, kind = 'logs') {
  return {
    path: `properties.${kind}.${index}.retentionPolicy.days`,
    propertyChangeType: 'Delete',
    before: 0,
    after: null,
  };
}

const DIAG_ID =
  '/subscriptions/S/resourceGroups/rg-csa-loom-admin-centralus/providers/Microsoft.ApiManagement/service/apim/providers/Microsoft.Insights/diagnosticSettings/diag-loom-stdz';
const PDZG_ID =
  '/subscriptions/S/resourceGroups/rg-csa-loom-admin-centralus/providers/Microsoft.Network/privateEndpoints/pe-acr/privateDnsZoneGroups/default';

test('index wildcard suppresses every element of a server-defaulted array', () => {
  // Five log categories plus a metric — no exact rule exists for any index.
  const doc = {
    changes: [
      modify('Microsoft.Insights/diagnosticSettings', DIAG_ID, [
        retentionLeaf(0),
        retentionLeaf(1),
        retentionLeaf(2),
        retentionLeaf(3),
        retentionLeaf(4),
        retentionLeaf(0, 'metrics'),
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 0, 'a resource whose every delta is allowlisted must be Clean');
  assert.match(r.stdout, /0 real delta\(s\), 1 what-if noise suppressed/);
  assert.equal(r.driftList.trim(), '');
  assert.match(r.suppressedList, /properties\.logs\.4\.retentionPolicy\.days/);
});

test('wildcard matches a numeric index NESTED under a deeper path, more than one per rule', () => {
  // properties.privateDnsZoneConfigs.*.properties.provisioningState — the index
  // sits mid-path, and the estate reaches double digits.
  const doc = {
    changes: [
      modify('Microsoft.Network/privateEndpoints/privateDnsZoneGroups', PDZG_ID, [
        { path: 'properties.privateDnsZoneConfigs.0.id', propertyChangeType: 'Delete', before: '/subscriptions/S/x', after: null },
        { path: 'properties.privateDnsZoneConfigs.0.etag', propertyChangeType: 'Delete', before: 'W/"abc"', after: null },
        { path: 'properties.privateDnsZoneConfigs.12.type', propertyChangeType: 'Delete', before: 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups/privateDnsZoneConfigs', after: null },
        { path: 'properties.privateDnsZoneConfigs.12.properties.provisioningState', propertyChangeType: 'Delete', before: 'Succeeded', after: null },
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 0);
  assert.match(r.suppressedList, /privateDnsZoneConfigs\.12\.properties\.provisioningState/);
});

test('wildcard survives what-if reporting the delta as a nested child tree', () => {
  // flattenDelta joins children with '.', so the same leaf arrives via nesting.
  const doc = {
    changes: [
      modify('Microsoft.Insights/diagnosticSettings', DIAG_ID, [
        {
          path: 'properties',
          children: [
            {
              path: 'logs.2',
              children: [retentionLeafChild()],
            },
          ],
        },
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 0, 'nesting must not change the flattened path the rule sees');
});

function retentionLeafChild() {
  return { path: 'retentionPolicy.days', propertyChangeType: 'Delete', before: 0, after: null };
}

test('NARROWNESS: `*` does NOT match a property name — no blanket suppression', () => {
  // If `*` were a general glob, `properties.logs.<anything>.retentionPolicy.days`
  // would match and a real per-category conflict would vanish.
  const doc = {
    changes: [
      modify('Microsoft.Insights/diagnosticSettings', DIAG_ID, [
        { path: 'properties.logs.AuditEvent.retentionPolicy.days', propertyChangeType: 'Delete', before: 30, after: null },
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 1, 'a non-numeric segment must stay real drift');
  assert.match(r.driftList, /properties\.logs\.AuditEvent\.retentionPolicy\.days/);
});

test('RULE 1: a Modify on an allowlisted path is never suppressed', () => {
  const doc = {
    changes: [
      modify('Microsoft.Insights/diagnosticSettings', DIAG_ID, [
        { path: 'properties.logs.0.retentionPolicy.days', propertyChangeType: 'Modify', before: 0, after: 30 },
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 1, 'Modify is a genuine template-vs-live conflict');
  assert.match(r.driftList, /Modify:properties\.logs\.0\.retentionPolicy\.days/);
});

test('RULE 2: one unmatched delta keeps the whole resource in the verdict', () => {
  // The real shape at head: retention leaves are noise, but a Delete of a whole
  // `properties.logs.N` category means the template declares fewer categories
  // than the estate has — that is real, and it must not be masked.
  const doc = {
    changes: [
      modify('Microsoft.Insights/diagnosticSettings', DIAG_ID, [
        retentionLeaf(0),
        retentionLeaf(1),
        { path: 'properties.logs.4', propertyChangeType: 'Delete', before: { category: 'GatewayLogs' }, after: null },
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 1);
  assert.match(r.driftList, /Delete:properties\.logs\.4/);
  assert.doesNotMatch(r.driftList, /retentionPolicy/, 'the noise is filtered out of the residual list');
});

test('the residual list stops hiding real deltas behind allowlistable ones', () => {
  // Regression on the head behaviour: the per-resource display is capped at six
  // paths, so four suppressible APIM customProperties consumed the whole line
  // and pushed natGatewayState / publicNetworkAccess / releaseChannel out of
  // sight. Verbatim shapes from run 33406666389.
  const APIM = '/subscriptions/S/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim-csa-loom-centralus';
  const p = 'properties.customProperties.Microsoft.WindowsAzure.ApiManagement.Gateway.Security';
  const doc = {
    changes: [
      modify('Microsoft.ApiManagement/service', APIM, [
        { path: `${p}.Backend.Protocols.Ssl30`, propertyChangeType: 'Delete', before: 'False', after: null },
        { path: `${p}.Backend.Protocols.Tls10`, propertyChangeType: 'Delete', before: 'False', after: null },
        { path: `${p}.Backend.Protocols.Tls11`, propertyChangeType: 'Delete', before: 'False', after: null },
        { path: `${p}.Protocols.Ssl30`, propertyChangeType: 'Delete', before: 'False', after: null },
        { path: 'properties.developerPortalStatus', propertyChangeType: 'Modify', before: 'Enabled', after: 'Disabled' },
        { path: 'properties.legacyPortalStatus', propertyChangeType: 'Modify', before: 'Enabled', after: 'Disabled' },
        { path: 'properties.natGatewayState', propertyChangeType: 'Modify', before: 'Unsupported', after: 'Disabled' },
        { path: 'properties.publicNetworkAccess', propertyChangeType: 'Delete', before: 'Enabled', after: null },
        { path: 'properties.releaseChannel', propertyChangeType: 'Delete', before: 'Default', after: null },
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 1, 'APIM still has real Modify deltas — rule 1 keeps the resource');
  assert.match(r.driftList, /natGatewayState/);
  assert.match(r.driftList, /publicNetworkAccess/);
  assert.match(r.driftList, /releaseChannel/);
  assert.doesNotMatch(r.driftList, /Ssl30|Tls10|Tls11/, 'documented noise must not crowd out the real deltas');
});

test('ALLOWLIST HYGIENE: every rule has a reason, and `*` only stands for an index', () => {
  const doc = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const types = doc.resourceTypes || {};
  assert.ok(Object.keys(types).length > 0, 'the allowlist must not be empty');
  for (const [type, rules] of Object.entries(types)) {
    assert.ok(Array.isArray(rules) && rules.length > 0, `${type} must carry at least one rule`);
    for (const rule of rules) {
      assert.equal(typeof rule.path, 'string', `${type}: every rule needs a path`);
      assert.ok(rule.path.length > 0, `${type}: empty rule path`);
      assert.equal(typeof rule.reason, 'string', `${type} ${rule.path}: every rule needs a reason`);
      // Allowlist rule 4: the reason must be grounded in the ARM schema, not a
      // label. The shortest legitimate one in the file is 31 chars
      // ("Read-only revision bookkeeping."), so 24 leaves headroom while still
      // rejecting a bare "noise" / "read-only".
      assert.ok(
        rule.reason.length >= 24,
        `${type} ${rule.path}: the reason must be schema-grounded, not a label`,
      );
      assert.match(
        rule.reason,
        /read-only|server-default|service-managed|default/i,
        `${type} ${rule.path}: the reason must say WHY it is noise (read-only / server-defaulted / service-managed)`,
      );
      for (const seg of rule.path.split('.')) {
        if (!seg.includes('*')) continue;
        assert.ok(
          seg === '*' || /^[A-Za-z0-9_]+\[\*\]$/.test(seg),
          `${type} ${rule.path}: '*' may only be a whole segment or a whole bracket index, got '${seg}'`,
        );
      }
    }
  }
});

// ===========================================================================
// PR #4343 review — the reasons cited a MEASURED value; the matcher never read
// one. Suppression was PATH-ONLY, so every rule justified by "defaulted to the
// SECURE value / before=0 / before='Default'" also suppressed the property at
// the INSECURE value it claims can never occur. That is a detection regression
// on exactly the properties whose reasons promise it cannot happen, and a
// deploy-integrity R7 violation: the reason asserted a condition the code did
// not establish. Allowlist rule 6 (whenBeforeEquals / whenBeforeIn) closes it.
// ===========================================================================

const APIM_ID = '/subscriptions/S/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim-csa-loom-centralus';
const APIM_SEC = 'properties.customProperties.Microsoft.WindowsAzure.ApiManagement.Gateway.Security';
const PE_ID = '/subscriptions/S/resourceGroups/rg/providers/Microsoft.Network/privateEndpoints/pe-acr';
const COSMOS_ID =
  '/subscriptions/S/resourceGroups/rg/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-loom/sqlDatabases/loom/containers/items';

/** The same delta at two values, so only the VALUE distinguishes the verdicts. */
function atValue(type, resourceId, path, before) {
  return verdict({ changes: [modify(type, resourceId, [{ path, propertyChangeType: 'Delete', before, after: null }])] });
}

test('VALUE PREDICATE: APIM legacy protocols ENABLED in live are real drift, not noise', () => {
  // The inversion that was suppressed at head: SSL 3.0 and TLS 1.0 actually ON.
  const doc = {
    changes: [
      modify('Microsoft.ApiManagement/service', APIM_ID, [
        { path: `${APIM_SEC}.Protocols.Ssl30`, propertyChangeType: 'Delete', before: 'True', after: null },
        { path: `${APIM_SEC}.Backend.Protocols.Tls10`, propertyChangeType: 'Delete', before: 'True', after: null },
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 1, "before='True' means the protocol is ENABLED — the lane must see it");
  assert.match(r.stdout, /1 real delta\(s\), 0 what-if noise suppressed/);
  assert.match(r.driftList, /Protocols\.Ssl30/);
  assert.match(r.driftList, /Backend\.Protocols\.Tls10/);
  assert.equal(r.suppressedList.trim(), '', 'nothing may be suppressed at the insecure value');
});

test("VALUE PREDICATE CONTROL: the same APIM paths at the secure 'False' are still suppressed", () => {
  // The rule must not have been turned off — only narrowed to what it claims.
  const doc = {
    changes: [
      modify('Microsoft.ApiManagement/service', APIM_ID, [
        { path: `${APIM_SEC}.Protocols.Ssl30`, propertyChangeType: 'Delete', before: 'False', after: null },
        { path: `${APIM_SEC}.Backend.Protocols.Tls10`, propertyChangeType: 'Delete', before: 'False', after: null },
      ]),
    ],
  };
  const r = verdict(doc);
  assert.equal(r.code, 0, "before='False' is the documented secure default and stays noise");
  assert.match(r.stdout, /0 real delta\(s\), 1 what-if noise suppressed/);
});

test('VALUE PREDICATE: a real 365-day retention being dropped is real drift', () => {
  // retentionPolicy.days is allowlisted because the RP materializes 0 on every
  // category. A live 365 is a legacy retention a redeploy WOULD delete.
  const real = atValue('Microsoft.Insights/diagnosticSettings', DIAG_ID, 'properties.logs.0.retentionPolicy.days', 365);
  assert.equal(real.code, 1);
  assert.match(real.driftList, /properties\.logs\.0\.retentionPolicy\.days/);

  const noise = atValue('Microsoft.Insights/diagnosticSettings', DIAG_ID, 'properties.logs.0.retentionPolicy.days', 0);
  assert.equal(noise.code, 0, 'the measured before=0 case is still suppressed');
});

test('VALUE PREDICATE: no coercion — a stringified default does not satisfy the rule', () => {
  // '0' is not 0 and 'false' is not false. The rule cites a measured SHAPE; a
  // different shape falls through to the verdict rather than being assumed away.
  const asString = atValue(
    'Microsoft.Insights/diagnosticSettings', DIAG_ID, 'properties.logs.0.retentionPolicy.days', '0',
  );
  assert.equal(asString.code, 1, "before='0' is not the measured numeric 0 — stay visible");
});

test('VALUE PREDICATE: a dual-stack private endpoint the template would turn OFF is real drift', () => {
  const T = 'Microsoft.Network/privateEndpoints';
  const P = 'properties.isIPv6EnabledPrivateEndpoint';
  assert.equal(atValue(T, PE_ID, P, false).code, 0, 'the measured false is server-default noise');
  assert.equal(atValue(T, PE_ID, P, true).code, 1, 'IPv6 actually enabled would be removed by a redeploy');
});

test('VALUE PREDICATE: a hand-tuned Cosmos indexing policy is not the server default', () => {
  const T = 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers';
  const P = 'properties.resource.indexingPolicy.includedPaths';
  assert.equal(atValue(T, COSMOS_ID, P, [{ path: '/*' }]).code, 0, "the measured [{path:'/*'}] default is noise");
  assert.equal(
    atValue(T, COSMOS_ID, P, [{ path: '/customerId/?' }]).code, 1,
    'a narrowed index set is a policy a redeploy would widen back to /* — real drift',
  );
  assert.equal(
    atValue(T, COSMOS_ID, P, [{ path: '/*' }, { path: '/extra/?' }]).code, 1,
    'an EXTRA element is a different shape — array length is part of the match',
  );
});

test('VALUE PREDICATE: resolutionPolicy is only noise at the measured Default', () => {
  const T = 'Microsoft.Network/privateDnsZones/virtualNetworkLinks';
  const ID = '/subscriptions/S/resourceGroups/rg/providers/Microsoft.Network/privateDnsZones/z/virtualNetworkLinks/l';
  assert.equal(atValue(T, ID, 'properties.resolutionPolicy', 'Default').code, 0);
  assert.equal(
    atValue(T, ID, 'properties.resolutionPolicy', 'NxDomainRedirect').code, 1,
    'a link deliberately set to NxDomainRedirect would be reset by a redeploy',
  );
});

/**
 * Does this reason justify suppression by citing the value the property was
 * MEASURED to hold? Those are the rules that MUST carry a value predicate — a
 * path-only match would suppress the property at every other value too.
 *
 * Deliberately narrow: it fires on "measured", on "before=", and on
 * "default(ed) to <literal>". It does NOT fire on a read-only reason that
 * merely names an example in passing ("Read-only lifecycle state
 * ('Succeeded')"), because such a property is never settable in a template and
 * so cannot carry a template-vs-live conflict at any value.
 */
const CITES_A_MEASURED_VALUE =
  /\bmeasured\b|\bbefore\s*=|\bdefault(?:ed)?\s+to\s+(?:'[^']*'|"[^"]*"|-?\d|true\b|false\b|\[|\{)/i;

function hasValuePredicate(rule) {
  return (
    Object.prototype.hasOwnProperty.call(rule, 'whenBeforeEquals') ||
    Array.isArray(rule.whenBeforeIn) ||
    Array.isArray(rule.whenBeforeKeysSubsetOf)
  );
}

test('ALLOWLIST HYGIENE (rule 6): a reason that cites a measured value carries a predicate', () => {
  const doc = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const offenders = [];
  let checked = 0;
  let predicated = 0;
  for (const [type, rules] of Object.entries(doc.resourceTypes || {})) {
    for (const rule of rules) {
      if (hasValuePredicate(rule)) predicated += 1;
      if (!CITES_A_MEASURED_VALUE.test(rule.reason)) continue;
      checked += 1;
      if (!hasValuePredicate(rule)) offenders.push(`${type} ${rule.path}`);
      if (Array.isArray(rule.whenBeforeIn)) {
        assert.ok(rule.whenBeforeIn.length > 0, `${type} ${rule.path}: whenBeforeIn must not be empty`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'these reasons justify suppression with a measured value but match on PATH ONLY, so they also '
    + 'suppress the property at the value the reason says it can never hold:\n  ' + offenders.join('\n  '),
  );
  // Floor, so the check cannot be satisfied by deleting the value claims.
  assert.ok(checked >= 15, `expected >= 15 value-citing rules, found ${checked} — did the reasons get gutted?`);
  assert.ok(predicated >= 15, `expected >= 15 predicated rules, found ${predicated}`);
});

test('ALLOWLIST HYGIENE (rule 6) HAS TEETH: the detector rejects a value claim with no predicate', () => {
  // The hygiene check above is only worth its runtime if it actually fires. The
  // exact head shape it would have missed, plus the shapes it must NOT flag.
  const mustFlag = [
    { reason: "Server-defaulted, and defaulted to the SECURE value. Measured before='False' in run 33406666389." },
    { reason: 'Server-defaulted remnant of a retired feature. Measured before=0 on every occurrence.' },
    { reason: "Server-defaulted to 'Default' on every link." },
    { reason: 'Server-defaulted to false on every private endpoint.' },
    { reason: 'Server-defaulted to 100. Omitted by the template.' },
    { reason: 'Server-defaulted to [{latestRevision:true, weight:100}] under activeRevisionsMode Single.' },
  ];
  for (const rule of mustFlag) {
    assert.ok(CITES_A_MEASURED_VALUE.test(rule.reason), `should be flagged: ${rule.reason}`);
    assert.equal(hasValuePredicate(rule), false, 'precondition: this synthetic rule has no predicate');
  }
  const mustNotFlag = [
    'Read-only revision bookkeeping.',
    'Read-only — RP-assigned ingress FQDN.',
    "Read-only lifecycle state ('Succeeded'), never settable in a template.",
    "Read-only runtime state ('Running'), never settable in a template.",
    'Service-managed lifecycle. Azure Managed Grafana upgrades the major version in place.',
    'Read-only — the ARM type discriminator the RP stamps on each generated config.',
  ];
  for (const reason of mustNotFlag) {
    assert.equal(CITES_A_MEASURED_VALUE.test(reason), false, `should NOT be flagged: ${reason}`);
  }
  // And the predicate detector itself, in both directions.
  assert.equal(hasValuePredicate({ whenBeforeEquals: 0 }), true, 'a falsy literal still counts as declared');
  assert.equal(hasValuePredicate({ whenBeforeIn: ['False'] }), true);
  assert.equal(hasValuePredicate({ whenBeforeKeysSubsetOf: ['clientId'] }), true);
  assert.equal(hasValuePredicate({ path: 'x', reason: 'y' }), false);
});

/* ── #2874 — UNRESOLVED: a value what-if never evaluated is not a conflict ─── */

// Verbatim shape from the Gov (GCC-High) lane of run 33406666389: the Sentinel
// Responder assignment on the Log Analytics workspace, whose template-side
// principalId came back as raw ARM source because what-if could not resolve
// `reference(<the conditional playbook>).identity.principalId`
// (platform/fiab/bicep/modules/admin-plane/ai-defense.bicep:251-261).
//
// That resource's delta has TWO entries, not one — see REAL_GOV_DELTA below.
// The single-entry helper here isolates the classifier; the two-entry case is
// the one the lane actually runs on.
const LAW_ROLE_ASSIGNMENT_ID =
  '/subscriptions/S/resourceGroups/rg-csa-loom-admin-usgovvirginia/providers/Microsoft.OperationalInsights/workspaces/law-csa-loom-usgovvirginia/providers/Microsoft.Authorization/roleAssignments/0912013f-1f0e-5c39-9a5d-2c7c2b6a3f41';
const LIVE_PRINCIPAL_ID = '1feb8cae-6b6a-4a0e-9f2f-3a1c9d7e5b42';
const UNEVALUATED_PRINCIPAL_ID =
  "[reference(resourceId('Microsoft.Logic/workflows', 'la-csa-loom-ai-alert-usgovvirginia'), '2019-05-01', 'full').identity.principalId]";

function roleAssignmentPrincipalIdChange(after) {
  return modify('Microsoft.Authorization/roleAssignments', LAW_ROLE_ASSIGNMENT_ID, [
    {
      path: 'properties.principalId',
      propertyChangeType: 'Modify',
      before: LIVE_PRINCIPAL_ID,
      after,
    },
  ]);
}

test('#2874 an UNEVALUATED ARM expression is UNRESOLVED, never drift, and never silent', () => {
  const r = verdict({ changes: [roleAssignmentPrincipalIdChange(UNEVALUATED_PRINCIPAL_ID)] });

  // The verdict this issue is about: what-if never produced a template-side
  // value here, so asserting a template-vs-live conflict asserts something the
  // tool did not establish (deploy-integrity R7).
  assert.equal(r.outputs.drift_count, '0', 'an unevaluated expression must not be counted as real drift');
  assert.equal(r.code, 0);
  assert.equal(r.driftList.trim(), '');

  // …but it is NOT absorbed into "clean". It is a third bucket, printed with
  // the resourceId and carried on the coverage line.
  assert.equal(r.outputs.unresolved_count, '1');
  assert.equal(r.outputs.suppressed_count, '0', 'this is a coverage gap, not allowlisted noise');
  assert.match(r.unresolvedList, /roleAssignments\/0912013f/);
  assert.match(r.unresolvedList, /not compared by what-if/);
  assert.match(r.unresolvedList, /properties\.principalId/);
  assert.match(r.outputs.coverage_note, /NOT COMPARED by what-if/);
  assert.match(r.summary, /NOT COMPARED/);
  assert.match(r.stdout, /::warning::\[test\].*did NOT evaluate/);
});

test('#2874 CONTROL: the same delta with a CONCRETE `after` stays real drift', () => {
  // A different GUID IS a template-vs-live conflict what-if actually evaluated.
  // If this ever goes green the new bucket has become a way to hide drift.
  const r = verdict({
    changes: [roleAssignmentPrincipalIdChange('9c4d0b22-77aa-4c11-8b3d-5e6f70a1c8d9')],
  });
  assert.equal(r.outputs.drift_count, '1');
  assert.equal(r.outputs.unresolved_count, '0');
  assert.equal(r.code, 1);
  assert.match(r.driftList, /roleAssignments\/0912013f/);
});

test('#2874 the UNRESOLVED bucket is NARROW — only ARM function-call source qualifies', () => {
  // Shapes that must stay REAL DRIFT. `[[…]` is ARM's escape for a literal
  // leading bracket — a genuine string value the deployment would write.
  const notExpressions = [
    '["allow","deny"]',
    '[]',
    '[[reference(resourceId())]',
    '[not-a-function]',
    'reference(x).identity.principalId',
    '[0]',
  ];
  for (const after of notExpressions) {
    const r = verdict({ changes: [roleAssignmentPrincipalIdChange(after)] });
    assert.equal(
      r.outputs.drift_count, '1',
      `after=${JSON.stringify(after)} is not ARM expression source and must remain real drift`,
    );
    assert.equal(r.outputs.unresolved_count, '0', `after=${JSON.stringify(after)} must not be swallowed`);
  }
  // …and shapes that ARE unevaluated ARM source.
  for (const after of [
    "[parameters('principalId')]",
    "[concat('a','b')]",
    '[reference(resourceId()).identity.principalId]',
  ]) {
    const r = verdict({ changes: [roleAssignmentPrincipalIdChange(after)] });
    assert.equal(r.outputs.unresolved_count, '1', `after=${JSON.stringify(after)} is unevaluated ARM source`);
  }
});

test('#2874 one REAL conflicting property keeps the whole resource in the drift verdict', () => {
  // The rescue hazard: an unresolved sibling must never pull a resource that
  // has a genuine delta out of the verdict.
  const change = modify('Microsoft.Authorization/roleAssignments', LAW_ROLE_ASSIGNMENT_ID, [
    { path: 'properties.principalId', propertyChangeType: 'Modify', before: LIVE_PRINCIPAL_ID, after: UNEVALUATED_PRINCIPAL_ID },
    { path: 'properties.principalType', propertyChangeType: 'Modify', before: 'ServicePrincipal', after: 'User' },
  ]);
  const r = verdict({ changes: [change] });
  assert.equal(r.outputs.drift_count, '1');
  assert.equal(r.code, 1);
  assert.match(r.driftList, /principalType/);
  // …and the unresolved sibling is still REPORTED. Staying in drift is a
  // verdict about the resource; "not compared" is a fact about the property.
  // An earlier revision returned unresolved_count '0' here and dropped
  // principalId from every output — see the real-input test below.
  assert.equal(r.outputs.unresolved_count, '1');
  assert.match(r.unresolvedList, /properties\.principalId/);
});

/* ── the REAL two-entry delta, byte-for-byte from the downloaded artifact ──── */

// This is the shape the lane actually produced, not a reduction of it. It is
// the input the whole bucket was built from, and the first revision of that
// bucket FAILED on it: `properties.principalType` is a concrete NoEffect on
// Microsoft.Authorization/roleAssignments, which whatif-noise-allowlist.json
// does not cover, so it stays unmatched and keeps the resource in drift —
// and because the bucket keyed on the RESOURCE, `properties.principalId` then
// appeared in neither drift-list.txt nor unresolved-list.txt, and the string
// "principalId" was absent from summary.md entirely. Strictly LESS information
// than before the bucket existed.
const REAL_GOV_DELTA = [
  {
    path: 'properties.principalId',
    propertyChangeType: 'Modify',
    before: '1feb8cae-15de-4f0f-9085-8863128949c9',
    after:
      "[reference(resourceId('Microsoft.Logic/workflows', format('la-csa-loom-ai-alert-{0}', parameters('location'))), '2019-05-01', 'full').identity.principalId]",
  },
  {
    path: 'properties.principalType',
    propertyChangeType: 'NoEffect',
    before: null,
    after: 'ServicePrincipal',
  },
];

test('#2874 the REAL Gov delta: still drift on principalType, and principalId is still REPORTED', () => {
  const r = verdict({
    changes: [modify('Microsoft.Authorization/roleAssignments', LAW_ROLE_ASSIGNMENT_ID, REAL_GOV_DELTA)],
  });

  // The verdict is unchanged from before this bucket existed, and must be:
  // principalType is a genuine unmatched property on a type the allowlist does
  // not cover. This bucket was never meant to turn this run green.
  assert.equal(r.code, 1);
  assert.equal(r.outputs.drift_count, '1');
  assert.match(r.driftList, /NoEffect:properties\.principalType/);

  // What DID have to change: the uncompared property must reach the reader.
  assert.equal(r.outputs.unresolved_count, '1', 'the resource carries a property what-if never evaluated');
  assert.match(r.unresolvedList, /properties\.principalId/);
  assert.match(r.unresolvedList, /ALSO has real drift/, 'the reader must not read this as a clean resource');
  assert.match(r.outputs.coverage_note, /1 resource\(s\) with property NOT COMPARED/);
  assert.match(r.stdout, /::warning::\[test\].*did NOT evaluate/);

  // The regression, stated as the reviewer measured it: `principalId` must not
  // vanish from the summary a human opens.
  assert.match(r.summary, /principalId/, 'principalId was ABSENT from summary.md in the first revision');
  assert.match(r.driftList, /not compared by what-if: properties\.principalId/,
    'the drift line is where a triager looks first — the uncompared property is named there too');
});

test('#2874 CONTROL: unresolved reporting does not fabricate a coverage gap on a clean resource', () => {
  // The opposite failure: if every property is concrete, unresolved_count must
  // be 0 and nothing may claim a property went uncompared.
  const r = verdict({
    changes: [modify('Microsoft.Authorization/roleAssignments', LAW_ROLE_ASSIGNMENT_ID, [
      { path: 'properties.principalType', propertyChangeType: 'NoEffect', before: null, after: 'ServicePrincipal' },
    ])],
  });
  assert.equal(r.outputs.drift_count, '1');
  assert.equal(r.outputs.unresolved_count, '0');
  assert.equal(r.unresolvedList.trim(), '');
  assert.doesNotMatch(r.driftList, /not compared by what-if/);
  assert.doesNotMatch(r.stdout, /did NOT evaluate/);
});
