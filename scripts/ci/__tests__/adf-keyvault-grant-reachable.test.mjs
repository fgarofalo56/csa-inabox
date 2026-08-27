/**
 * adf-keyvault-grant-reachable — the Snowflake mirroring credential grant must
 * exist in the SHIPPED compiled ARM, and its condition must be one the shipped
 * param files can actually take.
 *
 * ## What broke, measured
 *
 * `modules/admin-plane/adf-keyvault-rbac.bicep` grants the Data Factory managed
 * identity **Key Vault Secrets User** on the Loom Key Vault. Without it every
 * Snowflake mirror fails at run time on the credential read, because the
 * auto-bound linked service references the secret through a `loom_key_vault`
 * linked service authenticated with the factory's own MI.
 *
 * The module shipped with exactly two call sites, gated on `useSingleDlz` and
 * `useMultiDlz`. Both are FALSE on every `.bicepparam` that targets
 * `main.bicep`, because they all pin `topology='tenant'`:
 *
 *     deployLandingZones = effectiveTopology != 'tenant'          → false
 *     useSingleDlz       = deployLandingZones && … == 'single-sub' → false
 *     useMultiDlz        = deployLandingZones && … != 'single-sub' → false
 *
 * So the grant had NO reachable call site on any shipped boundary, and on the
 * live Commercial estate the factory MI held zero assignments on the vault. A
 * module that is wired but never reached is the exact failure this suite exists
 * to make loud.
 *
 * ## Why the compiled ARM and not the bicep source
 *
 * `apps/fiab-console/deploy-templates/main.json` is the artifact that deploys —
 * the Dockerfile COPYs it into the console image and `lib/setup/user-arm-deploy.ts`
 * submits it INLINE. Asserting the .bicep source would leave a stale artifact
 * green, which this repo has shipped twice (#2945, #2960). So the conditions are
 * PARSED OUT of the committed ARM and EVALUATED, with the topology each shipped
 * `.bicepparam` actually pins as the input.
 *
 * ## Embedded controls
 *
 * A guard whose failure path has never executed is not a guard, and an evaluator
 * that returns `false` for everything would pass half of these assertions. Two
 * controls run every time: a mutated condition must flip the verdict, and the
 * evaluator must reject an expression it does not understand rather than
 * defaulting it.
 *
 * Run: node --test scripts/ci/__tests__/adf-keyvault-grant-reachable.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATE = resolve(REPO, 'apps/fiab-console/deploy-templates/main.json');
const PARAMS_DIR = resolve(REPO, 'platform/fiab/bicep/params');
const DISCOVERY = resolve(REPO, 'scripts/csa-loom/discover-dlz-adopt-plan.sh');

/** Key Vault Secrets User — built-in, identical GUID in every Azure cloud. */
const KEY_VAULT_SECRETS_USER = '4633458b-17de-408a-b874-0445c86b69e6';

const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));

// ─────────────────────────── a tiny ARM evaluator ───────────────────────────
// Covers only the operators these conditions use. Anything else THROWS, so an
// expression this evaluator cannot read can never be silently scored as false.

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\t') { i += 1; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ k: c }); i += 1; continue; }
    if (c === "'") {
      let s = '';
      i += 1;
      while (i < src.length && src[i] !== "'") { s += src[i]; i += 1; }
      i += 1;
      out.push({ k: 'str', v: s });
      continue;
    }
    let id = '';
    while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) { id += src[i]; i += 1; }
    if (!id) throw new Error(`unexpected character ${JSON.stringify(c)} in ${src}`);
    out.push({ k: 'id', v: id });
  }
  return out;
}

function parse(tokens) {
  let p = 0;
  function expr() {
    const t = tokens[p];
    if (!t) throw new Error('unexpected end of expression');
    if (t.k === 'str') { p += 1; return { type: 'str', value: t.v }; }
    if (t.k !== 'id') throw new Error(`unexpected token ${t.k}`);
    const name = t.v;
    p += 1;
    if (tokens[p]?.k !== '(') return { type: 'str', value: name };
    p += 1;
    const args = [];
    if (tokens[p]?.k !== ')') {
      args.push(expr());
      while (tokens[p]?.k === ',') { p += 1; args.push(expr()); }
    }
    if (tokens[p]?.k !== ')') throw new Error(`expected ) in call to ${name}`);
    p += 1;
    return { type: 'call', name, args };
  }
  const e = expr();
  if (p !== tokens.length) throw new Error('trailing tokens in expression');
  return e;
}

/**
 * Evaluate an ARM expression string (with or without its `[...]` wrapper).
 *
 * @param {string} raw
 * @param {{parameters: Record<string, unknown>, variables: Record<string, unknown>}} scope
 *   `variables` may pre-seed a value (used to inject the adopt-plan-derived
 *   `existingAdfFactory`, whose ARM user-function this evaluator does not model);
 *   anything not pre-seeded is resolved from the template's own `variables`.
 */
function evaluateExpr(raw, scope) {
  const body = String(raw).startsWith('[') ? String(raw).slice(1, -1) : String(raw);
  return evaluate(parse(tokenize(body)), scope);
}

function evaluate(node, scope) {
  if (node.type === 'str') return node.value;
  const { name, args } = node;
  const lower = name.toLowerCase();
  const a = (i) => evaluate(args[i], scope);

  if (lower === 'parameters') {
    const k = a(0);
    if (!(k in scope.parameters)) throw new Error(`unbound parameter ${k}`);
    return scope.parameters[k];
  }
  if (lower === 'variables') {
    const k = a(0);
    if (k in scope.variables) return scope.variables[k];
    const raw = tpl.variables?.[k];
    if (raw === undefined) throw new Error(`unbound variable ${k}`);
    const val = evaluateExpr(raw, scope);
    scope.variables[k] = val;
    return val;
  }
  if (lower === 'and') return args.every((_, i) => a(i) === true);
  if (lower === 'or') return args.some((_, i) => a(i) === true);
  if (lower === 'not') return a(0) !== true;
  if (lower === 'equals') return a(0) === a(1);
  if (lower === 'empty') { const v = a(0); return v === '' || v === null || v === undefined; }
  if (lower === 'if') return a(0) === true ? a(1) : a(2);
  if (lower === 'string') return String(a(0) ?? '');
  if (lower === 'coalesce') { for (let i = 0; i < args.length; i += 1) { const v = a(i); if (v !== null && v !== undefined) return v; } return null; }
  if (lower === 'tryget') { const o = a(0); const k = a(1); return (o && typeof o === 'object') ? (o[k] ?? null) : null; }
  // Deliberately NOT a default branch: an unmodelled function is an unknown,
  // and an unknown scored as `false` would make this whole suite fail open.
  throw new Error(`unmodelled ARM function: ${name}`);
}

// ───────────────────── the shipped param files' topology ────────────────────

/** Every `.bicepparam` whose `using` targets platform/fiab/bicep/main.bicep. */
function shippedMainParamFiles() {
  const out = [];
  for (const f of readdirSync(PARAMS_DIR).filter((n) => n.endsWith('.bicepparam'))) {
    const src = readFileSync(join(PARAMS_DIR, f), 'utf8');
    const using = /^\s*using\s+'([^']+)'/m.exec(src)?.[1] ?? '';
    if (!/(^|\/)main\.bicep$/.test(using) || using.includes('modules/')) continue;
    const topology = /^\s*param\s+topology\s*=\s*'([^']*)'/m.exec(src)?.[1] ?? '';
    const deploymentMode = /^\s*param\s+deploymentMode\s*=\s*'([^']*)'/m.exec(src)?.[1] ?? '';
    out.push({ file: f, topology, deploymentMode });
  }
  return out;
}

const SHIPPED = shippedMainParamFiles();

function topologyScope({ topology, deploymentMode }, extra = {}) {
  return {
    parameters: { topology, deploymentMode, skipRoleGrants: false, hubKeyVaultId: '', hubCoordinates: {}, ...extra },
    variables: {},
  };
}

// ──────────────────────────── embedded controls ─────────────────────────────

test('CONTROL — the evaluator discriminates, and refuses what it cannot read', () => {
  const scope = { parameters: { topology: 'tenant', deploymentMode: 'single-sub' }, variables: {} };
  assert.equal(evaluateExpr("[equals(parameters('topology'), 'tenant')]", scope), true);
  assert.equal(evaluateExpr("[equals(parameters('topology'), 'dlz-attach')]", scope), false);
  // An unmodelled function must THROW, never evaluate to a falsy verdict.
  assert.throws(
    () => evaluateExpr("[union(parameters('topology'), parameters('deploymentMode'))]", scope),
    /unmodelled ARM function/,
  );
  // So must an expression this parser cannot even read.
  assert.throws(
    () => evaluateExpr("[reference('adminPlane').outputs.x.value]", scope),
    /trailing tokens|unexpected/,
  );
  assert.throws(() => evaluateExpr("[parameters('neverBound')]", scope), /unbound parameter/);
});

test('CONTROL — a mutated grant condition flips the verdict', () => {
  const scope = topologyScope({ topology: 'tenant', deploymentMode: 'single-sub' }, {});
  scope.variables.existingAdfFactory = 'adf-loom-somewhere';
  const real = tpl.resources.adoptedAdfKeyVaultRbac.condition;
  assert.equal(evaluateExpr(real, scope), true, 'the shipped condition must be reachable on topology=tenant');
  // Re-gate it the way it used to be gated. If this does NOT go false, the
  // assertion above proves nothing about the fix.
  const mutated = real.replace(
    "variables('deployAdminPlane')",
    "variables('useSingleDlz')",
  );
  assert.notEqual(mutated, real, 'the mutation must actually change the expression');
  const scope2 = topologyScope({ topology: 'tenant', deploymentMode: 'single-sub' }, {});
  scope2.variables.existingAdfFactory = 'adf-loom-somewhere';
  assert.equal(evaluateExpr(mutated, scope2), false, 'the OLD gating must be unreachable on topology=tenant');
});

// ───────────────────────────── the assertions ───────────────────────────────

test('the shipped param files pin a topology that makes BOTH DLZ gates false', () => {
  assert.ok(SHIPPED.length >= 5, `expected the shipped main.bicep param files, found ${SHIPPED.length}`);
  const bothFalse = [];
  for (const p of SHIPPED) {
    const scope = topologyScope(p);
    const single = evaluateExpr(tpl.variables.useSingleDlz, scope);
    const multi = evaluateExpr(tpl.variables.useMultiDlz, scope);
    assert.equal(single, false, `${p.file}: useSingleDlz must be false (topology=${p.topology || '(unset)'})`);
    if (multi === false) bothFalse.push(p.file);
  }
  // The five boundary files are the population this fix exists for. If a future
  // change makes one of them take a DLZ branch, this list moves and the reason
  // for the adopt-keyed call site has to be re-examined rather than assumed.
  assert.deepEqual(
    bothFalse.sort(),
    ['commercial-full.bicepparam', 'commercial.bicepparam', 'gcc-high.bicepparam', 'gcc.bicepparam', 'il5.bicepparam'],
    'the boundaries where NEITHER DLZ grant call site is reachable',
  );
  for (const f of bothFalse) {
    const p = SHIPPED.find((x) => x.file === f);
    assert.equal(evaluateExpr(tpl.variables.deployAdminPlane, topologyScope(p)), true,
      `${f}: the admin plane (and therefore the vault) IS deployed here`);
  }
});

test('the adopt-keyed grant is reachable on every boundary that owns a factory', () => {
  for (const p of SHIPPED) {
    if (p.topology !== 'tenant') continue;
    const withFactory = topologyScope(p);
    withFactory.variables.existingAdfFactory = 'adf-loom-example';
    assert.equal(evaluateExpr(tpl.resources.adoptedAdfKeyVaultRbac.condition, withFactory), true,
      `${p.file}: the grant must be made when the estate owns a factory`);
    const noFactory = topologyScope(p);
    noFactory.variables.existingAdfFactory = '';
    assert.equal(evaluateExpr(tpl.resources.adoptedAdfKeyVaultRbac.condition, noFactory), false,
      `${p.file}: a greenfield sub with no factory must NOT attempt the grant`);
  }
});

test('the adopt-keyed grant passes the factory COORDINATES, not a principal', () => {
  const params = tpl.resources.adoptedAdfKeyVaultRbac.properties.parameters;
  // The factory lives in the landing-zone RG of a DIFFERENT subscription from
  // the vault, so name alone is not addressable — all three must be threaded.
  assert.match(params.dataFactoryName.value, /existingAdfFactory/);
  assert.match(params.dataFactoryRg.value, /existingAdfRg/);
  assert.match(params.dataFactorySub.value, /existingAdfSub/);
  assert.equal(params.dataFactoryPrincipalId, undefined,
    'an adopted factory has no principal output to pass — it must be RESOLVED from the coordinates');
});

test('the dlz-attach grant lands on the HUB, cross-subscription', () => {
  const r = tpl.resources.dlzAttachAdfKeyVaultRbac;
  assert.match(r.resourceGroup, /adminPlaneRgName/, 'the vault is in the admin-plane RG');
  assert.match(r.subscriptionId, /effHubSubscriptionId/,
    'a dlz-attach deployment is submitted at the DLZ sub, so the hub sub must be named explicitly');
  const attach = topologyScope({ topology: 'dlz-attach', deploymentMode: 'multi-sub' }, { hubKeyVaultId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.KeyVault/vaults/z' });
  assert.equal(evaluateExpr(r.condition, attach), true);
  const noVault = topologyScope({ topology: 'dlz-attach', deploymentMode: 'multi-sub' });
  assert.equal(evaluateExpr(r.condition, noVault), false,
    'with no hub Key Vault coordinate there is nothing to grant on — skip, do not guess');
});

test('every call site actually PUTs a Key Vault Secrets User assignment', () => {
  // The GUID lives in the nested template's VARIABLES, not inline in the
  // resource — searching only `resources` would find nothing and pass vacuously,
  // which it did on the first cut of this test.
  const callSites = Object.entries(tpl.resources).filter(
    ([, r]) => r?.type === 'Microsoft.Resources/deployments'
      && JSON.stringify(r?.properties?.template ?? {}).includes(KEY_VAULT_SECRETS_USER),
  );
  const names = callSites.map(([k]) => k).sort();
  assert.deepEqual(
    names.filter((n) => /AdfKeyVaultRbac$/.test(n)).sort(),
    ['adoptedAdfKeyVaultRbac', 'dlzAdfKeyVaultRbac', 'dlzAttachAdfKeyVaultRbac', 'singleDlzAdfKeyVaultRbac'],
    'all four factory shapes — single-sub, multi-sub, adopted, dlz-attach — must carry the grant',
  );
  for (const n of names.filter((x) => /AdfKeyVaultRbac$/.test(x))) {
    const nested = tpl.resources[n].properties.template;
    const list = Array.isArray(nested.resources) ? nested.resources : Object.values(nested.resources);
    const ra = list.find((x) => x.type === 'Microsoft.Authorization/roleAssignments');
    assert.ok(ra, `${n}: no role assignment in the nested template`);
    assert.equal(ra.properties.principalType, 'ServicePrincipal');
    // The role is carried in a nested VARIABLE, so resolve it rather than
    // pattern-matching the property text — a `roleDefinitionId` that merely
    // mentions the right function proves nothing about the role.
    assert.equal(nested.variables.keyVaultSecretsUser, KEY_VAULT_SECRETS_USER,
      `${n}: must grant Key Vault Secrets User, not some other role`);
    assert.match(ra.properties.roleDefinitionId, /keyVaultSecretsUser/,
      `${n}: the assignment must USE that role variable`);
    // Idempotent by NAME: a deterministic guid means a re-deploy re-PUTs the
    // same assignment rather than minting a second one.
    assert.match(ra.name, /^\[guid\(/, `${n}: the assignment name must be a deterministic guid()`);
    assert.ok(ra.condition, `${n}: the assignment must stay conditional (grantActive)`);
  }
});

test('the discovery script adopts the Data Factory — the other half of reachability', () => {
  // `adoptedAdfKeyVaultRbac` can only fire when `adopt.adf` is populated, and the
  // ONLY producer on the shipped deploy lanes is this script. Dropping the entry
  // would leave the grant permanently skipped while every gate stayed green.
  const src = readFileSync(DISCOVERY, 'utf8');
  assert.match(src, /^add "adf"\s+"\$ADF"$/m, 'the plan must carry an `adf` entry');
  assert.match(src, /Microsoft\.DataFactory\/factories/,
    'the factory must be READ from the DLZ resource group, never derived from a naming convention');
  // `az datafactory` is an EXTENSION; a runner without it would report a present
  // factory as absent. Match an INVOCATION (the shared `q` helper), not the word
  // — the file's own comment explains why the extension is avoided.
  assert.ok(!/\bq\s+datafactory\b/.test(src),
    'the lookup must not depend on the az datafactory extension being installed');
});

test('the ADLS sink override is still wired, and ARM owns no competing sink', () => {
  // The sink linked service itself is a data-plane object created at run time by
  // apps/fiab-console/lib/azure/mirror-adf-shared.ts (ADF linked services are not
  // ARM resources this template owns). What ARM owns is the OVERRIDE, and it must
  // survive: an estate with a hand-tuned AzureBlobFS linked service pins it here.
  const json = JSON.stringify(tpl);
  assert.ok(json.includes('LOOM_MIRROR_ADLS_LINKED_SERVICE'),
    'the brownfield override env var must still reach the console');
  // The auto-bound name may be NAMED in a description (that is documentation);
  // what must never appear is a linked-service RESOURCE claiming to own it, which
  // would fight the runtime upsert for the same object.
  const linkedServiceResources = json.match(/Microsoft\.DataFactory\/factories\/linkedservices/gi) ?? [];
  assert.deepEqual(linkedServiceResources, [],
    'ADF linked services are created by the runtime; a second ARM-side owner would fight the upsert');
});
