/**
 * CONTROLS ON THE ROUTE BACKEND CLASSIFIER (#3592)
 * ===========================================================================
 * `scripts/ci/_route-backends.mjs` decides the **Backends** column of
 * `docs/fiab/route-inventory.md`. The construct it replaced was `BACKEND_LABEL`,
 * a hand-maintained map from a Loom MODULE NAME to a backend tag, read through
 * `.filter(Boolean)` — so an unmapped module was dropped in silence and its
 * route published `—`, "touches no backend". Measured on `main` at b9ca620b:
 * **26 entries against 378 distinct `@/lib/azure/*` modules that routes import,
 * one of them (`keyvault-client`) imported by ZERO routes** while the module 19
 * routes use to reach Key Vault was absent. Four false documents, every one
 * caught by a human reading a regenerated diff and none by the gate.
 *
 * This suite has three jobs, in order of how much they matter:
 *
 * 1. **The classifier's own controls run** (`selfTest()`), including the
 *    NEGATIVE ones — a host in a comment, a doc link, prose inside a string, a
 *    credential SDK, a module-scope literal the function never references. A
 *    control set that only models the working case passes on the tree that
 *    produced the defect (#3468, one guard over).
 *
 * 2. **FALSIFICATION.** The analyzer is broken eight ways and each break must
 *    turn a control red. A control set is only evidence if it fails when the
 *    thing it watches is broken.
 *
 * 3. **The real tree is asserted, in both directions**: the four clients #3592
 *    names resolve to the backend they actually reach, the derivation's inputs
 *    are alive, and `—` is an assertion — no unnamed client, no unknown
 *    identifier, no signal with zero population.
 *
 * Run: node --test scripts/ci/__tests__/route-backends.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildGraph,
  deriveBackendReach,
  classifyRouteBackends,
  unnamedClientModules,
  unpopulatedSeeds,
  staleModuleReferences,
  detectIdentifiers,
  canonicalHost,
  labelFor,
  keyOf,
  selfTest,
  CONTROLS,
  ARM_PROVIDER_BACKEND,
  HOST_SUFFIX_BACKEND,
  PACKAGE_BACKEND,
  NOT_A_BACKEND,
  PROPAGATION_CUTS,
  CLIENT_WITHOUT_AZURE_IDENTIFIER,
  CONSOLE_ROOT,
} from '../_route-backends.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** CRLF-normalising reader — see the FALSIFICATION test for why this matters. */
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// One graph + derivation for the whole suite — building it walks 4,000+ files.
let cached = null;
function tree() {
  if (!cached) {
    const graph = buildGraph({ repoRoot: REPO_ROOT });
    const derivation = deriveBackendReach(graph);
    const routes = graph.files.filter(
      (f) => f.startsWith(`${CONSOLE_ROOT}/app/api/`) && f.endsWith('/route.ts'),
    );
    cached = { graph, derivation, routes };
  }
  return cached;
}
const classify = (rel) => {
  const { graph, derivation } = tree();
  return classifyRouteBackends(graph, derivation, `${CONSOLE_ROOT}/app/api/${rel}`);
};

// ───────────────────────────────────────────────────────────────────────────
// 1. THE CLASSIFIER'S OWN CONTROLS
// ───────────────────────────────────────────────────────────────────────────

test('every embedded control passes', () => {
  assert.deepEqual(selfTest(), []);
});

test('the control set contains BOTH directions, and the negative half is not token', () => {
  const positive = CONTROLS.filter((c) => (c.expect.has ?? []).length).length;
  const negative = CONTROLS.filter((c) => !(c.expect.has ?? []).length && !c.expect.unknown).length;
  assert.ok(positive >= 5, `only ${positive} must-publish controls`);
  assert.ok(negative >= 5, `only ${negative} must-NOT-publish controls`);
  // The two shapes this issue is ABOUT must be in the set, or it cannot claim to
  // have caught them: the transitive delegation (#3545) and the unknown service.
  assert.ok(CONTROLS.some((c) => /TRANSITIVE \(#3545\)/.test(c.name)));
  assert.ok(CONTROLS.some((c) => c.expect.unknown === true));
});

/**
 * FALSIFICATION — break the ANALYZER, eight ways, and require each break to turn
 * a control red.
 *
 * THREE of these were GREEN on the first draft, and each was fixed by
 * strengthening the CONTROL, never by weakening the mutation — the same outcome
 * #3643 recorded for the auth column:
 *
 *   - `namespace-alias edges removed` survived because no control used
 *     `import * as`. Added one, modelled on lib/copilot/pipeline-tools.ts.
 *   - `the prose filter removed` survived because no control put a hostname in
 *     PROSE inside a string. Added one, quoting lib/mcp/catalog.ts verbatim.
 *   - `B2 disabled` survived because the B2 control asserted only `backends`,
 *     which is empty either way. Strengthened `selfTest()` to compare the
 *     `unnamed` list as well.
 *
 * Runs against a patched COPY in a temp dir — the real file is never touched, so
 * a SIGKILL mid-test cannot leave the checkout mutated.
 *
 * NORMALISED TO LF BEFORE PATCHING. The repo is checked out CRLF, and a
 * multi-line needle carrying a literal `\n` silently matches nothing on Windows
 * — which reads as "the mutation proves the analyzer is watching" while proving
 * the opposite. That is #3644, and the `assert.notEqual(patched, original)`
 * below is what makes an unapplied mutation fail LOUDLY instead of vacuously.
 */
test('FALSIFICATION — eight breaks of the analyzer, each must turn a control red', async () => {
  const original = readNorm(path.join(REPO_ROOT, 'scripts/ci/_route-backends.mjs'));

  const MUTANTS = [
    {
      id: 'the SILENT DROP is restored — an unknown identifier is discarded instead of failing (`.filter(Boolean)`)',
      patch: (s) => s.replace('    if (label === undefined) {', '    if (false) {'),
    },
    {
      id: 'TRANSITIVITY is removed — a client reached through a sibling stops counting (#3545)',
      patch: (s) => s.replace('  for (let pass = 0; pass < 40; pass++) {', '  for (let pass = 0; pass < 0; pass++) {'),
    },
    {
      id: 'COMMENTS are no longer stripped — a host in a comment reaches a backend again',
      patch: (s) => s.replace('const ids = detectIdentifiers(mod.dataCode.slice(span.start, span.end));',
        'const ids = detectIdentifiers(mod.raw.slice(span.start, span.end));'),
    },
    {
      id: 'MODULE-SCOPE BINDINGS stop being nodes — every module-scope literal leaks to every function again',
      patch: (s) => s.replace('    for (const m of scopeCode.matchAll(MODULE_CONST_RE)) {',
        '    for (const m of [].matchAll(MODULE_CONST_RE)) {'),
    },
    {
      id: 'REFERENCE edges are removed — `const BASE = getGraphHost()` at module scope becomes invisible',
      patch: (s) => s.replace('      for (const cand of candidates) {', '      for (const cand of []) {'),
    },
    {
      id: 'NAMESPACE-ALIAS edges are removed — `import * as adf` + `adf.listLinkedServices()` becomes invisible',
      patch: (s) => s.replace('      for (const [alias, target] of namespaces) {', '      for (const [alias, target] of []) {'),
    },
    {
      id: 'the PROSE filter is removed — a hostname in UI help text counts as an endpoint',
      patch: (s) => s.replace('    if (m.index > 0 && /\\s/.test(dataCode[m.index - 1])) continue;', '    if (false) continue;'),
    },
    {
      id: 'B2 is disabled — a client that fetches and names nothing stops being reported',
      patch: (s) => s.replace('  const bad = [];\n  for (const file of reached) {', '  const bad = [];\n  for (const file of []) {'),
    },
  ];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-backends-falsify-'));
  try {
    // The siblings travel with it so the relative imports resolve.
    for (const f of ['_route-auth-scope.mjs', '_gate-consumption.mjs']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts/ci', f), path.join(dir, f));
    }
    for (const [i, m] of MUTANTS.entries()) {
      const patched = m.patch(original);
      assert.notEqual(patched, original, `mutation "${m.id}" did not apply — it proves nothing`);
      const file = path.join(dir, `mutant-${i}.mjs`);
      fs.writeFileSync(file, patched);
      const mod = await import(pathToFileURL(file).href);
      let failures;
      try {
        failures = mod.selfTest();
      } catch (e) {
        failures = [`threw ${e.message}`]; // a break that crashes is also detected
      }
      assert.ok(
        failures.length > 0,
        `MUTATION SURVIVED: "${m.id}" — every control still passed, so the control set cannot see this break`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE DERIVATION'S INPUTS ARE ALIVE
// ───────────────────────────────────────────────────────────────────────────

test('the graph and the route population are a plausible size', () => {
  const { graph, routes } = tree();
  assert.ok(graph.files.length > 3000, `graph collapsed to ${graph.files.length} files`);
  assert.ok(routes.length > 1400, `only ${routes.length} routes enumerated`);
});

test('the detector finds each of its three identifier shapes — a KNOWN-TRUE case per shape', () => {
  // A detector keyed to a string that does not occur returns a reassuring zero.
  // Every shape is proved against a case known to be true before any count from
  // it is trusted.
  const ids = detectIdentifiers(
    "const u = `${armBase()}/providers/Microsoft.Kusto/clusters`;\n" +
      "const h = 'https://x.kusto.windows.net/v2/rest/query';\n" +
      "import sql from 'mssql';",
  );
  assert.ok(ids.has('arm:Microsoft.Kusto'), 'ARM provider shape not detected');
  assert.ok(ids.has('host:kusto.windows.net'), 'host shape not detected');
  assert.ok(ids.has('pkg:mssql'), 'package shape not detected');
  // …and the interpolated-subdomain form, which a `+`-quantified prefix missed.
  assert.ok(detectIdentifiers('`https://${env.DBX}.azuredatabricks.net/x`').has('host:azuredatabricks.net'));
});

test('longest-suffix matching keeps neighbouring services apart', () => {
  assert.equal(canonicalHost('ossrdbms-aad.database.windows.net'), 'ossrdbms-aad.database.windows.net');
  assert.equal(labelFor(`host:${canonicalHost('ossrdbms-aad.database.windows.net')}`), 'PostgreSQL');
  assert.equal(labelFor(`host:${canonicalHost('myserver.database.windows.net')}`), 'Azure SQL');
  assert.equal(labelFor(`host:${canonicalHost('adb-1234.7.azuredatabricks.net')}`), 'Databricks');
  // the ARM control plane vs the ARM TEMPLATE SCHEMA host
  assert.equal(labelFor(`host:${canonicalHost('management.azure.com')}`), 'ARM');
  assert.equal(labelFor(`host:${canonicalHost('schema.management.azure.com')}`), null);
  // the Fabric API host vs the Fabric portal host
  assert.equal(labelFor(`host:${canonicalHost('api.fabric.microsoft.com')}`), 'Fabric');
  assert.equal(labelFor(`host:${canonicalHost('app.fabric.microsoft.com')}`), null);
});

test('every seeded signal has a POPULATION — the `keyvault-client` shape cannot recur', () => {
  const { derivation } = tree();
  assert.deepEqual(
    unpopulatedSeeds(derivation.origins),
    [],
    'a seeded identifier occurs NOWHERE in the tree. That is exactly what `keyvault-client` was: an entry that ' +
      'looked like coverage while covering nothing, which is how 19 Key Vault routes stayed invisible.',
  );
});

test('every module NAMED in the analyzer still exists', () => {
  assert.deepEqual(staleModuleReferences(tree().graph), []);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. `—` IS AN ASSERTION, ON THE REAL TREE
// ───────────────────────────────────────────────────────────────────────────

test('no route reaches an Azure identifier this vocabulary cannot translate (B1)', () => {
  const { graph, derivation, routes } = tree();
  const unknown = new Map();
  for (const f of routes) {
    for (const u of classifyRouteBackends(graph, derivation, f).unknowns) {
      if (!unknown.has(u.identifier)) unknown.set(u.identifier, u.module);
    }
  }
  assert.deepEqual([...unknown], [], 'unrecognised Azure identifiers — label each, or record why it is not a backend');
});

test('no route reaches a network client the derivation cannot name (B2)', () => {
  const { graph, derivation, routes } = tree();
  assert.deepEqual(
    unnamedClientModules(graph, derivation, routes),
    [],
    'a lib/azure module makes a network call, a route reaches it, and no backend can be named for it. Publishing ' +
      '`—` for those routes would be the #3592 defect.',
  );
});

test('the B1/B2 paths are ALIVE, not dead code', () => {
  // A guard with zero population verifies nothing. Both triggers are fired here
  // against synthetic trees so the assertions above mean something.
  const unknownFired = analyze({
    'apps/fiab-console/lib/azure/new-svc-client.ts':
      "export async function ping() { return fetch('https://x.brandnew.azure.com/v1'); }",
    'apps/fiab-console/app/api/items/probe/route.ts': [
      "import { ping } from '@/lib/azure/new-svc-client';",
      'export async function GET() { return json(await ping()); }',
    ].join('\n'),
  });
  assert.equal(unknownFired.result.unknowns.length, 1);
  assert.match(unknownFired.result.unknowns[0].identifier, /brandnew\.azure\.com/);
  assert.ok(unknownFired.result.unknowns[0].module.includes('new-svc-client'), 'the failure must NAME the module');

  const b2Fired = analyze({
    'apps/fiab-console/lib/azure/opaque-client.ts':
      'export async function callIt(p) { return fetch(`https://${process.env.H}/${p}`); }',
    'apps/fiab-console/app/api/items/probe/route.ts': [
      "import { callIt } from '@/lib/azure/opaque-client';",
      'export async function GET(req, ctx) { return json(await callIt(ctx.params.id)); }',
    ].join('\n'),
  });
  assert.deepEqual(b2Fired.unnamed, ['apps/fiab-console/lib/azure/opaque-client.ts']);
});

function analyze(files, route = 'apps/fiab-console/app/api/items/probe/route.ts') {
  const graph = buildGraph({ repoRoot: '/synthetic', files: Object.keys(files), readFile: (f) => files[f] });
  const derivation = deriveBackendReach(graph);
  return {
    result: classifyRouteBackends(graph, derivation, route),
    unnamed: unnamedClientModules(graph, derivation, [route]),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. THE FOUR CLIENTS #3592 NAMES — on the real tree
// ───────────────────────────────────────────────────────────────────────────

/**
 * Each instance in the issue, asserted where it actually lands. These are the
 * rows a human had to catch in a diff four times; if the derivation stops
 * finding one, this says so out loud instead of the row moving quietly.
 */
test('the four false-document instances resolve to the backend they actually reach', () => {
  const { graph, derivation } = tree();
  const reachOf = (mod, fn) => [...(derivation.fnReach.get(keyOf(mod, fn)) ?? new Map()).keys()]
    .map(labelFor)
    .filter(Boolean);

  // #3499 — data-quality-client runs live KQL aggregates against ADX.
  assert.ok(reachOf(`${CONSOLE_ROOT}/lib/azure/data-quality-client.ts`, 'scoreRule').includes('ADX')
    || reachOf(`${CONSOLE_ROOT}/lib/azure/data-quality-client.ts`, 'runRule').includes('ADX')
    || [...derivation.spansOf.get(`${CONSOLE_ROOT}/lib/azure/data-quality-client.ts`).keys()]
      .some((n) => reachOf(`${CONSOLE_ROOT}/lib/azure/data-quality-client.ts`, n).includes('ADX')),
    'data-quality-client no longer reaches ADX');
  // #3529 — azure-sql-client is real TDS.
  const sqlSpans = [...derivation.spansOf.get(`${CONSOLE_ROOT}/lib/azure/azure-sql-client.ts`).keys()];
  assert.ok(sqlSpans.some((n) => reachOf(`${CONSOLE_ROOT}/lib/azure/azure-sql-client.ts`, n).includes('Azure SQL')));
  // Wave 0 — kv-secrets-client is the Key Vault data plane.
  const kvSpans = [...derivation.spansOf.get(`${CONSOLE_ROOT}/lib/azure/kv-secrets-client.ts`).keys()];
  assert.ok(kvSpans.some((n) => reachOf(`${CONSOLE_ROOT}/lib/azure/kv-secrets-client.ts`, n).includes('Key Vault')));
  // #3545 — the TRANSITIVE case: sql-objects-client reaches Azure SQL only
  // through azure-sql-client, and 24 routes published `—` because of it.
  const objSpans = [...derivation.spansOf.get(`${CONSOLE_ROOT}/lib/azure/sql-objects-client.ts`).keys()];
  assert.ok(
    objSpans.some((n) => reachOf(`${CONSOLE_ROOT}/lib/azure/sql-objects-client.ts`, n).includes('Azure SQL')),
    'sql-objects-client no longer reaches Azure SQL — the transitive hop is broken',
  );
  void graph;
});

test('a route reaching Key Vault ONLY through kv-secrets-client publishes Key Vault', () => {
  // The Wave-0 instance, end to end. `keyvault/secret-names` does nothing but
  // list Key Vault secret names and it generated as `—`.
  const c = classify('keyvault/secret-names/route.ts');
  assert.ok(c.backends.includes('Key Vault'), `got [${c.backends.join(', ')}]`);
});

test('MUTATION — a route stops publishing a backend when its Key Vault reach is REMOVED', () => {
  // A classifier whose answer does not change when the dependency is deleted is
  // not watching it (csa_loom_route_guards_blind_three_ways). `\r?` throughout,
  // because the working tree is CRLF.
  //
  // BOTH import lines go. Deleting only the `kv-secrets-client` one left the
  // verdict standing and the first draft of this test read that as the analyzer
  // being blind — it is not: the route ALSO calls `kvSuffix()` / `kvUrlFromName()`
  // from cloud-endpoints, which is a second, independent path to the same
  // backend. The mutation has to remove the reach, not one import of it.
  const rel = 'keyvault/secret-names/route.ts';
  const abs = path.join(REPO_ROOT, CONSOLE_ROOT, 'app/api', rel);
  const src = fs.readFileSync(abs, 'utf8');
  assert.ok(classify(rel).backends.includes('Key Vault'));

  let stripped = src.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*kv-secrets-client['"];\r?\n/, '');
  assert.notEqual(stripped, src, 'the kv-secrets-client mutation did not apply — it proves nothing');
  const afterOne = analyzeOnTree(rel, stripped);

  const beforeTwo = stripped;
  stripped = stripped.replace(/import\s*\{\s*kvScope[^}]*\}\s*from\s*['"][^'"]*cloud-endpoints['"];\r?\n/, '');
  assert.notEqual(stripped, beforeTwo, 'the cloud-endpoints mutation did not apply — it proves nothing');
  assert.ok(
    !analyzeOnTree(rel, stripped).backends.includes('Key Vault'),
    'the route still reads Key Vault with BOTH of its Key Vault imports deleted — the verdict is not code-backed',
  );
  // …and the intermediate state is recorded, because it is the interesting one:
  // one path removed, the other still reaching, so the label correctly HOLDS.
  assert.ok(afterOne.backends.includes('Key Vault'));
});

/** Re-classify one route with a MUTATED source, against the real tree. */
function analyzeOnTree(rel, mutatedSource) {
  const target = `${CONSOLE_ROOT}/app/api/${rel}`;
  const { graph: base } = tree();
  const graph = buildGraph({
    repoRoot: REPO_ROOT,
    files: base.files,
    readFile: (f) => (f === target ? mutatedSource : fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')),
  });
  return classifyRouteBackends(graph, deriveBackendReach(graph), target);
}

// ───────────────────────────────────────────────────────────────────────────
// 5. THE VOCABULARY IS A VOCABULARY, NOT A POPULATION
// ───────────────────────────────────────────────────────────────────────────

test('nothing in the seeded tables names a Loom module, a route or a symbol', () => {
  // The property that makes this a derivation rather than the map it replaced:
  // adding a client requires NO edit here. If a Loom path appears in the label
  // tables, the hand list has come back through the side door.
  for (const k of [...ARM_PROVIDER_BACKEND.keys(), ...HOST_SUFFIX_BACKEND.keys(), ...PACKAGE_BACKEND.keys()]) {
    assert.doesNotMatch(k, /(^|\/)(lib|app|apps)\//, `${k} names a Loom path`);
    assert.doesNotMatch(k, /-client$|-store$|\.ts$/, `${k} looks like a Loom module name`);
  }
});

test('the judgement lists stay small and every entry carries a real reason', () => {
  assert.ok(NOT_A_BACKEND.size <= 30, `NOT_A_BACKEND has grown to ${NOT_A_BACKEND.size}`);
  for (const [k, why] of NOT_A_BACKEND) {
    assert.ok(typeof why === 'string' && why.length > 30, `${k} has no substantive reason recorded`);
  }
  assert.ok(
    CLIENT_WITHOUT_AZURE_IDENTIFIER.size <= 20,
    `CLIENT_WITHOUT_AZURE_IDENTIFIER has grown to ${CLIENT_WITHOUT_AZURE_IDENTIFIER.size} — it is becoming the ` +
      'module-name map this replaced',
  );
  for (const [k, v] of CLIENT_WITHOUT_AZURE_IDENTIFIER) {
    assert.ok(typeof v.why === 'string' && v.why.length > 60, `${k} has no substantive reason recorded`);
    assert.ok(v.backend === null || typeof v.backend === 'string');
  }
  // A cut can only ever REMOVE a label — the direction that produced this issue.
  assert.ok(PROPAGATION_CUTS.size <= 3, `${PROPAGATION_CUTS.size} propagation cuts — each one can hide a backend`);
  for (const [k, why] of PROPAGATION_CUTS) assert.ok(why.length > 60, `${k} has no substantive reason recorded`);
});

test('the published document carries the derived sets, not just the rows', () => {
  // #3643's rule, one column over: a set that lived only in memory would move
  // rows with no reviewable artifact.
  const doc = readNorm(path.join(REPO_ROOT, 'docs/fiab/route-inventory.md'));
  assert.match(doc, /## Backend signals \(derived\)/);
  assert.match(doc, /### The seeded vocabulary/);
  assert.match(doc, /### Detected identifiers that are NOT a backend dependency/);
  assert.match(doc, /### Clients whose backend the code does not name/);
  assert.match(doc, /### Modules that originate a backend label \(derived\)/);
  // The tombstone prose NAMES the replaced construct on purpose (the history is
  // the point), so this asserts the DERIVED sets are present rather than that a
  // string is absent — the absence assertion belongs on the generator's code,
  // which the next test makes.
  assert.match(doc, /\| `Microsoft\.Kusto` \(ARM provider\) \| ADX \|/);
});

test('BACKEND_LABEL is gone from the generator, and the drop mechanism with it', () => {
  const gen = readNorm(path.join(REPO_ROOT, 'scripts/ci/generate-route-inventory.mjs'));
  // The tombstone comment names it; the CODE must not use it.
  const code = gen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /BACKEND_LABEL\s*\[/, 'the module-name map is still being read');
  assert.doesNotMatch(code, /\.filter\(Boolean\)/, 'the silent-drop idiom is back in the generator');
});
