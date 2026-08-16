/**
 * Mutation proof for scripts/ci/check-adoption-catalog-sync.mjs.
 *
 * A guard nobody has broken is a guard nobody can trust. Every assertion below
 * BREAKS the thing the guard protects and requires the guard to go RED, then
 * confirms the unmutated tree is GREEN — so the test cannot be passing merely
 * because it always fails.
 *
 * The mutations are of the CONTROL (the gate expression, the sink, the param
 * declaration), not of a value some earlier early-return would mask.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, loadFiles, parseCatalog } from '../check-adoption-catalog-sync.mjs';

const BASE = loadFiles();

/**
 * Run the guard over a copy of the tree with one file mutated.
 *
 * Replaces EVERY occurrence, not the first. `String.replace` with a string
 * argument replaces only the first match, which silently produced a HALF
 * mutation — the legacy-env probe appears twice in the bicepparam shim (the
 * `empty()` guard and the value), so a first-only replace left the guard's
 * needle intact and the test read as "the guard did not fire" when the truth
 * was "the mutation did not happen".
 */
function withMutation(file, from, to) {
  const src = BASE[file];
  assert.ok(src.includes(from), `mutation setup: ${file} does not contain ${JSON.stringify(from.slice(0, 80))}`);
  const mutated = src.split(from).join(to);
  assert.notEqual(mutated, src, 'mutation setup: the file was not changed');
  assert.ok(!mutated.includes(from), 'mutation setup: an occurrence survived — the mutation is incomplete');
  return runChecks({ ...BASE, [file]: mutated });
}

test('baseline: the real tree is GREEN', () => {
  const { problems, catalog, adoptable } = runChecks(BASE);
  assert.deepEqual(problems, [], `unmutated tree must have no problems, got:\n${problems.join('\n')}`);
  assert.ok(catalog.length >= 20, `expected >= 20 catalog entries, parsed ${catalog.length}`);
  assert.ok(adoptable.length >= 13, `expected >= 13 adoptable, parsed ${adoptable.length}`);
});

test('the parser reads real field values, not just "some entries exist"', () => {
  const catalog = parseCatalog(BASE.catalog);
  const purview = catalog.find((d) => d.key === 'purview');
  assert.ok(purview, 'purview must be in the catalog');
  assert.equal(purview.enableFlag, 'purviewEnabled');
  assert.equal(purview.provisionVar, 'provisionPurview');
  assert.equal(purview.provisionSink, 'purviewEnabled');
  assert.equal(purview.cls, 'adopt-required');
  assert.ok(purview.consoleEnv.includes('LOOM_PURVIEW_ACCOUNT'));
});

test('MUTATION: renaming a provision var in bicep goes RED', () => {
  const { problems } = withMutation(
    'rootBicep',
    "var provisionPurview = purviewEnabled && adoptMode(adopt, 'purview') == 'create'",
    "var provisionPurviewRenamed = purviewEnabled && adoptMode(adopt, 'purview') == 'create'",
  );
  assert.ok(
    problems.some((p) => p.includes('purview') && p.includes('must contain exactly this line')),
    `expected the exact-line check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: reverting the gate to the raw enable flag goes RED', () => {
  // This is the exact regression the guard exists for: someone restores
  // `purviewEnabled: purviewEnabled` and Loom deploys a second Purview account,
  // which fails the whole deployment with EnterpriseTenantAlreadyExists.
  const { problems } = withMutation(
    'rootBicep',
    '    purviewEnabled: provisionPurview\n',
    '    purviewEnabled: purviewEnabled\n',
  );
  assert.ok(
    problems.some((p) => p.includes('purview') && p.includes('must carry')),
    `expected the sink check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: dropping the provision var entirely goes RED', () => {
  const { problems } = withMutation(
    'rootBicep',
    "var provisionMaps = azureMapsEnabled && adoptMode(adopt, 'maps') == 'create'",
    '// removed',
  );
  assert.ok(
    problems.some((p) => p.includes('maps')),
    `expected maps to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: removing `param adopt object = {}` goes RED', () => {
  const { problems } = withMutation('rootBicep', 'param adopt object = {}', 'param adoptRemoved object = {}');
  assert.ok(
    problems.some((p) => p.includes('param adopt object')),
    `expected the bag declaration check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: an invented Console env name goes RED', () => {
  const { problems } = withMutation(
    'catalog',
    "consoleEnv: ['LOOM_PURVIEW_ACCOUNT'],",
    "consoleEnv: ['LOOM_PURVIEW_ACCOUNT_THAT_DOES_NOT_EXIST'],",
  );
  assert.ok(
    problems.some((p) => p.includes('names a') && p.includes('binding that does not exist')),
    `expected the env-name check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: a locked row without its reason goes RED', () => {
  const { problems } = withMutation('catalog', '    createOnlyReason:\n      "Loom\'s Key Vault', '    unusedField:\n      "Loom\'s Key Vault');
  assert.ok(
    problems.some((p) => p.includes('keyvault') && p.includes('createOnlyReason')),
    `expected the locked-row reason check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: dropping the mutations array goes RED', () => {
  const { problems } = withMutation(
    'catalog',
    "    mutations: [\n      'registers Loom lake, Synapse and Databricks sources as Purview data sources',",
    "    notMutations: [\n      'registers Loom lake, Synapse and Databricks sources as Purview data sources',",
  );
  assert.ok(
    problems.some((p) => p.includes('purview') && p.includes('mutations')),
    `expected the mutations check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: a legacy EXISTING_* the bicepparam no longer reads goes RED', () => {
  const { problems } = withMutation(
    'commercialParams',
    "readEnvironmentVariable('EXISTING_PURVIEW', '')",
    "readEnvironmentVariable('EXISTING_PURVIEW_GONE', '')",
  );
  assert.ok(
    problems.some((p) => p.includes('EXISTING_PURVIEW') && p.includes('would do nothing')),
    `expected the legacy-env check to fail, got:\n${problems.join('\n')}`,
  );
});

test('a catalog the guard cannot parse THROWS rather than reporting ok', () => {
  assert.throws(
    () => runChecks({ ...BASE, catalog: '// the literal was refactored away\n' }),
    /ADOPTION_CATALOG not found/,
  );
  assert.throws(
    () => runChecks({ ...BASE, catalog: 'export const ADOPTION_CATALOG = [];\n' }),
    /no catalog entries parsed/,
  );
});

// ---------------------------------------------------------------------------
// G1..G4 — the SOVEREIGN orchestrator.
//
// Every mutation below reproduces the state `deploy/bicep/gov/main.bicep` was
// actually in before #3577, and each must go RED. Before these checks existed
// the guard read one file and reported OK while the Gov orchestrator created a
// Purview account unconditionally — a guard whose population excluded the
// consumer that broke.
// ---------------------------------------------------------------------------

test('MUTATION: reverting the Gov purview module to `if (deployDMLZ)` goes RED', () => {
  // Byte-for-byte the pre-#3577 line. This is the revert that reopens the
  // per-tenant cap failure, and it is the single most important thing here.
  const { problems } = withMutation(
    'govBicep',
    "module purview 'modules/purview.bicep' = if (provisionPurview) {",
    "module purview 'modules/purview.bicep' = if (deployDMLZ) {",
  );
  assert.ok(
    problems.some((p) => p.includes('modules/purview.bicep') && p.includes('provisionPurview')),
    `expected the Gov creator-gate check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: dropping the Gov adopt bag goes RED', () => {
  const { problems } = withMutation('govBicep', 'param adopt object = {}', 'param adoptGone object = {}');
  assert.ok(
    problems.some((p) => p.includes('deploy/bicep/gov/main.bicep') && p.includes('param adopt object')),
    `expected the Gov transport check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: dropping the Gov suppression var goes RED', () => {
  const { problems } = withMutation(
    'govBicep',
    "var provisionPurview = deployDMLZ && adoptMode(adopt, 'purview') == 'create'",
    'var provisionPurview = deployDMLZ',
  );
  assert.ok(
    problems.some((p) => p.includes('provisionPurview') && p.includes('adoptMode')),
    `expected the Gov gate-expression check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: suppressing the new account but binding NOTHING goes RED', () => {
  // The subtle half. Gating the creator is only half of adopt-or-create: if the
  // adopted account is never referenced, "adopt" silently means "no catalog at
  // all" while every gate still reads green.
  const { problems } = withMutation(
    'govBicep',
    "module purviewAdopted 'modules/purview-existing.bicep' = if (adoptPurview) {",
    "module purviewAdopted 'modules/purview-disabled.bicep' = if (adoptPurview) {",
  );
  assert.ok(
    problems.some((p) => p.includes('purview-existing.bicep') && p.includes('bind nothing')),
    `expected the Gov binding check to fail, got:\n${problems.join('\n')}`,
  );
});

test('the Gov checks are keyed to a REAL catalog entry, not a private list', () => {
  // If someone removes `purview` from the catalog, the Gov checks must not go
  // quietly green by finding nothing to check.
  const { problems } = runChecks({
    ...BASE,
    catalog: BASE.catalog.replace("    key: 'purview',", "    key: 'purview-renamed',"),
  });
  assert.ok(
    problems.some((p) => p.includes('GOV_SERVICE_KEYS') || p.includes("'purview' is not")),
    `expected a loud failure when the catalog entry disappears, got:\n${problems.join('\n')}`,
  );
});
