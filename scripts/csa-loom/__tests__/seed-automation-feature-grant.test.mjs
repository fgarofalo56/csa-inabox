import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildGrantDoc, isConverged, seed, main, resolveOid, SeedError,
  CAPABILITY_ID, ROLE, PRINCIPAL_TYPE,
} from '../seed-automation-feature-grant.mjs';

const OID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
const FIXED_TID = '99999999-9999-4999-8999-999999999999';
const src = (rel) => readFileSync(fileURLToPath(new URL(`../../../apps/fiab-console/${rel}`, import.meta.url)), 'utf8');
const routeSrc = src('app/api/admin/permissions/grants/route.ts');
const gateSrc = src('lib/auth/feature-gate.ts');
const catalogSrc = src('lib/auth/feature-catalog.ts');

/** Keys of `const doc: FeatureGrant = { ... }` lifted from the route source. */
function routeDocKeys() {
  const body = routeSrc.match(/const doc: FeatureGrant = \{([\s\S]*?)\n  \};/)[1];
  return [...body.matchAll(/^\s{4}(\w+)[:,]/gm)].map((m) => m[1]);
}
function interfaceKeys() {
  const body = gateSrc.match(/export interface FeatureGrant \{([\s\S]*?)\n\}/)[1];
  return [...body.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
}

function memCosmos(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const writes = [];
  return {
    docs, writes,
    async read(id, pk) { const d = docs.get(id); return d && d.tenantId === pk ? d : null; },
    async upsert(doc) { writes.push(doc); docs.set(doc.id, doc); },
  };
}

test('doc keys equal the keys the grants route writes (lifted from route.ts source)', () => {
  const routeKeys = routeDocKeys();
  assert.ok(routeKeys.includes('grantedAt') && routeKeys.length >= 8, `route parse is blind: ${routeKeys}`);
  const ours = Object.keys(buildGrantDoc(OID));
  // principalUpn is the route's only optional field the seed has no value for.
  const expected = routeKeys.filter((k) => k !== 'principalUpn').sort();
  assert.deepEqual(ours.sort(), expected, 'a field added/removed in route.ts breaks this');
  for (const k of interfaceKeys().filter((k) => !['principalUpn'].includes(k))) assert.ok(ours.includes(k), `FeatureGrant.${k} missing`);
});

test('id scheme equals the route template and the capability exists in the catalog', () => {
  assert.match(routeSrc, /const stableId = `\$\{capabilityId\}::\$\{principalType\}::\$\{principalId\}`;/);
  assert.equal(buildGrantDoc(OID).id, `health.tenant-admin::user::${OID}`);
  assert.ok(catalogSrc.includes(`id: '${CAPABILITY_ID}'`), 'capability id not in feature-catalog.ts');
  assert.ok(gateSrc.includes(`'${ROLE}'`) && ['user', 'group'].includes(PRINCIPAL_TYPE));
});

test('tenantId === principalId === automation oid (a tid here would be invisible to a tid-less minted session)', () => {
  const d = buildGrantDoc(OID);
  assert.equal(d.tenantId, OID);
  assert.equal(d.principalId, OID);
  assert.notEqual(d.tenantId, FIXED_TID);
  // The scoping rule this depends on: tid || oid, and the minted session has no tid.
  assert.match(src('lib/auth/session.ts'), /return session\.claims\.tid \|\| session\.claims\.oid;/);
});

test('first run seeds (one write, read back); second run is unchanged with ZERO writes', async () => {
  const c = memCosmos();
  const logs = [];
  const r1 = await seed({ oid: OID, cosmos: c, log: (l) => logs.push(l) });
  assert.equal(r1.outcome, 'seeded');
  assert.equal(c.writes.length, 1);
  assert.equal(c.docs.get(r1.id).role, 'Contributor');
  const r2 = await seed({ oid: OID, cosmos: c, log: (l) => logs.push(l) });
  assert.equal(r2.outcome, 'unchanged');
  assert.equal(c.writes.length, 1, 'a second run must not write');
  assert.match(logs.join('\n'), /^seeded /m);
  assert.match(logs.join('\n'), /^unchanged /m);
});

test('Reader grant is upgraded; an existing Admin grant is left alone; wrong-partition doc is not "converged"', async () => {
  const id = buildGrantDoc(OID).id;
  const c = memCosmos({ [id]: { ...buildGrantDoc(OID), role: 'Reader' } });
  assert.equal((await seed({ oid: OID, cosmos: c, log() {} })).outcome, 'seeded');
  const a = memCosmos({ [id]: { ...buildGrantDoc(OID), role: 'Admin' } });
  assert.equal((await seed({ oid: OID, cosmos: a, log() {} })).outcome, 'unchanged');
  assert.equal(isConverged({ ...buildGrantDoc(OID), tenantId: FIXED_TID }, buildGrantDoc(OID)), false);
});

test('read-back failure refuses to report seeded', async () => {
  const c = memCosmos();
  c.upsert = async () => {}; // write silently dropped
  await assert.rejects(seed({ oid: OID, cosmos: c, log() {} }), (e) => e instanceof SeedError && /did not read back/.test(e.message));
});

test('unresolvable oid -> exit 2 naming LOOM_AUTOMATION_OID_OVERRIDE, no Cosmos call', async () => {
  const c = memCosmos();
  const readers = { discoverResourceGroup: () => ({ status: 'app-not-found' }), readBinding: () => ({ status: 'absent' }) };
  assert.throws(() => resolveOid({}, readers), (e) => e.exit === 2 && /LOOM_AUTOMATION_OID_OVERRIDE/.test(e.message));
  const rc = await main({ LOOM_COSMOS_ENDPOINT: 'https://x.documents.azure.com:443/' }, {
    resolveOid: (env) => resolveOid(env, readers), cosmos: c,
  });
  assert.equal(rc, 2);
  assert.equal(c.writes.length, 0);
});

test('missing LOOM_COSMOS_ENDPOINT -> exit 2 naming the var', async () => {
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(m);
  try { assert.equal(await main({}, { resolveOid: () => OID, cosmos: memCosmos() }), 2); } finally { console.error = orig; }
  assert.match(errs.join(''), /LOOM_COSMOS_ENDPOINT/);
});

test('explicit override oid is used verbatim as the partition', () => {
  const readers = { discoverResourceGroup: () => ({ status: 'app-not-found' }), readBinding: () => ({ status: 'absent' }) };
  assert.equal(resolveOid({ LOOM_AUTOMATION_OID_OVERRIDE: OID }, readers), OID);
});
