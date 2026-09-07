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
  writeFileSync(input, JSON.stringify(doc));
  const r = spawnSync(process.execPath, [SCRIPT, input, '--out-dir', dir, '--label', 'test'], {
    encoding: 'utf8',
  });
  return {
    code: r.status,
    stdout: r.stdout || '',
    driftList: readFileSync(join(dir, 'drift-list.txt'), 'utf8'),
    suppressedList: readFileSync(join(dir, 'suppressed-list.txt'), 'utf8'),
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
