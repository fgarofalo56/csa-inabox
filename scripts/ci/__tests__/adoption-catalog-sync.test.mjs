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
import { runChecks, loadFiles, parseCatalog, submittedTemplates } from '../check-adoption-catalog-sync.mjs';

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
// G0..G4 — the NON-COMMERCIAL templates.
//
// Every mutation below reproduces a state one of these files was actually in
// before #3577, and each must go RED. Before these checks existed the guard read
// ONE file while THREE templates created Purview accounts — its population
// excluded both consumers that were broken.
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
    problems.some((p) => p.includes('gov/main.bicep') && p.includes('provisionPurview')),
    `expected the Gov creator-gate check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: reverting the DMLZ purview module to `if (bool(deployModules.governance))` goes RED', () => {
  // The second creator, live on the same Gov tenant via params.USGov.dev.json.
  const { problems } = withMutation(
    'dmlzGovernance',
    "module deployPurview '../Purview/purview.bicep' = if (provisionPurview) {",
    "module deployPurview '../Purview/purview.bicep' = if (bool(deployModules.governance)) {",
  );
  assert.ok(
    problems.some((p) => p.includes('DMLZ') && p.includes('provisionPurview')),
    `expected the DMLZ creator-gate check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: dropping the adopt bag from either template goes RED', () => {
  for (const file of ['govBicep', 'dmlzGovernance']) {
    const { problems } = withMutation(file, 'param adopt object = {}', 'param adoptGone object = {}');
    assert.ok(
      problems.some((p) => p.includes('param adopt object')),
      `expected the transport check to fail for ${file}, got:\n${problems.join('\n')}`,
    );
  }
});

test('MUTATION: dropping a suppression var goes RED', () => {
  const { problems } = withMutation(
    'govBicep',
    "var provisionPurview = deployDMLZ && adoptMode(adopt, 'purview') == 'create'",
    'var provisionPurview = deployDMLZ',
  );
  assert.ok(
    problems.some((p) => p.includes('provisionPurview') && p.includes('adoptMode')),
    `expected the gate-expression check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: suppressing the new account but binding NOTHING goes RED', () => {
  // The subtle half. Gating the creator is only half of adopt-or-create: if the
  // adopted account is never referenced, "adopt" silently means "no catalog at
  // all" while every other gate still reads green.
  const { problems } = withMutation(
    'govBicep',
    "resource purviewAdopted 'Microsoft.Purview/accounts@2021-12-01' existing = {",
    "resource purviewAdopted 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {",
  );
  assert.ok(
    problems.some((p) => p.includes('existing') && p.includes('bind nothing')),
    `expected the binding check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: binding through a cross-scope MODULE goes RED (the #3333 RBAC trap)', () => {
  // A module scoped to the adopted resource group compiles to a nested
  // deployment THERE and needs Microsoft.Resources/deployments/write. Reader is
  // not enough, and the whole deployment fails with AuthorizationFailed. This
  // is the shape the first revision of this PR shipped.
  const { problems } = withMutation(
    'govBicep',
    "resource purviewAdopted 'Microsoft.Purview/accounts@2021-12-01' existing = {",
    "module purviewAdopted 'modules/purview-existing.bicep' = if (adoptPurview) {\n  x: 1\n}\nresource purviewAdoptedReal 'Microsoft.Purview/accounts@2021-12-01' existing = {",
  );
  assert.ok(
    problems.some((p) => p.includes('nested deployment') && p.includes('deployments/write')),
    `expected the nested-deployment check to fail, got:\n${problems.join('\n')}`,
  );
});

test('the checks are keyed to a REAL catalog entry, not a private list', () => {
  // If someone removes `purview` from the catalog, these checks must not go
  // quietly green by finding nothing to check.
  const { problems } = runChecks({
    ...BASE,
    catalog: BASE.catalog.replace("    key: 'purview',", "    key: 'purview-renamed',"),
  });
  assert.ok(
    problems.some((p) => p.includes('ADOPT_HONOURING_TEMPLATES') || p.includes("'purview' is not")),
    `expected a loud failure when the catalog entry disappears, got:\n${problems.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// G0 — the POPULATION itself. These are the checks that make this guard
// different from the one it replaces: they fail when the guard is not LOOKING at
// something, rather than only when what it looks at is wrong.
// ---------------------------------------------------------------------------

test('the population is DERIVED from the workflows, not hard-coded', () => {
  const found = submittedTemplates(BASE.workflows);
  assert.ok(found.size >= 4, `expected several submitted templates, parsed ${found.size}`);
  // The three that matter, all discovered rather than listed.
  for (const tpl of [
    'platform/fiab/bicep/main.bicep',
    'deploy/bicep/gov/main.bicep',
    'deploy/bicep/DMLZ/main.bicep',
  ]) {
    assert.ok(found.has(tpl), `${tpl} should be discovered from the workflows; got ${[...found.keys()].join(', ')}`);
  }
  // $GITHUB_WORKSPACE-rooted spellings must normalise to the same key, or the
  // Commercial orchestrator reads as an unknown template and the guard cries
  // wolf on every run.
  assert.ok(
    found.get('platform/fiab/bicep/main.bicep').some((w) => /gcch|gcc|il5/.test(w)),
    'the workspace-rooted sovereign spellings should collapse onto the repo-relative path',
  );
});

test('MUTATION: a NEW submitted template that creates Purview goes RED', () => {
  // The class this guard exists to close: someone adds a template that creates
  // a Purview account and never registers it here. Before the derived
  // population existed, that was silently green — which is exactly how
  // deploy/bicep/DMLZ went unnoticed.
  const { problems } = runChecks({
    ...BASE,
    workflows: {
      ...BASE.workflows,
      'brand-new-lane.yml': 'run: az deployment sub create --template-file deploy/bicep/unregistered/main.bicep\n',
    },
    templateBodies: {
      ...BASE.templateBodies,
      'deploy/bicep/unregistered/main.bicep': "resource p 'Microsoft.Purview/accounts@2021-12-01' = {\n  name: 'x'\n}\n",
    },
  });
  assert.ok(
    problems.some((p) => p.includes('unregistered/main.bicep') && p.includes('not in PATHS')),
    `expected the population check to fail, got:\n${problems.join('\n')}`,
  );
});

test('a submitted template that cannot be READ is UNKNOWN, never a pass', () => {
  const { problems } = runChecks({
    ...BASE,
    workflows: {
      ...BASE.workflows,
      'ghost-lane.yml': 'run: az deployment sub create --template-file deploy/bicep/ghost/main.bicep\n',
    },
    // Present as a key with value undefined — "I looked and could not read it".
    templateBodies: { ...BASE.templateBodies, 'deploy/bicep/ghost/main.bicep': undefined },
  });
  assert.ok(
    problems.some((p) => p.includes('ghost/main.bicep') && p.includes('UNKNOWN')),
    `expected an unreadable submitted template to fail, got:\n${problems.join('\n')}`,
  );
});
