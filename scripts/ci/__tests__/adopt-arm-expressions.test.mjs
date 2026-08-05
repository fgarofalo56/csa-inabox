/**
 * Evaluates the ADOPT expressions out of the SHIPPED compiled ARM template.
 *
 * WHY THIS AND NOT A UNIT TEST OF THE BICEP SOURCE
 * -----------------------------------------------
 * `apps/fiab-console/deploy-templates/main.json` is the artifact that actually
 * deploys — the Dockerfile COPYs it into the console image and
 * `lib/setup/user-arm-deploy.ts` submits it INLINE in the deployment PUT body.
 * It has shipped stale twice (#2945, #2960), each time carrying merged fixes
 * that were therefore inert.
 *
 * So this test does not re-implement the adopt logic and check its own copy —
 * that is the fixture-modelling-the-code failure. It PARSES the committed ARM
 * expressions and EVALUATES them, so what is asserted is what will run.
 *
 * The case that matters most is the third one. Bicep's `union()` deep-merges, so
 * a plan saying `{purview:{mode:'create'}}` layered over a legacy
 * EXISTING_PURVIEW environment KEEPS the legacy `target`. If the coordinate
 * accessors did not gate on mode, the deployment would bind the Console to the
 * customer's Purview account AND create a second one — which then fails the
 * whole deploy with EnterpriseTenantAlreadyExists. That behaviour was found by
 * running the real `az bicep build-params`, not by reading the code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATE = resolve(REPO, 'apps/fiab-console/deploy-templates/main.json');
const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const userFns = tpl.functions?.[0]?.members ?? {};

// --- a minimal ARM expression evaluator, covering only the ops these use ----
function tokenize(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n') { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { t.push({ k: c }); i++; continue; }
    if (c === "'") {
      let s = '';
      i++;
      while (i < src.length && src[i] !== "'") { s += src[i]; i++; }
      i++;
      t.push({ k: 'str', v: s });
      continue;
    }
    let id = '';
    while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) { id += src[i]; i++; }
    if (!id) throw new Error(`unexpected character ${JSON.stringify(c)} in ${src}`);
    t.push({ k: 'id', v: id });
  }
  return t;
}

function parse(tokens) {
  let p = 0;
  function expr() {
    const t = tokens[p];
    if (!t) throw new Error('unexpected end of expression');
    if (t.k === 'str') { p++; return { type: 'str', value: t.value ?? t.v }; }
    if (t.k !== 'id') throw new Error(`unexpected token ${t.k}`);
    const name = t.v;
    p++;
    if (tokens[p]?.k !== '(') return { type: 'str', value: name };
    p++; // (
    const args = [];
    if (tokens[p]?.k !== ')') {
      args.push(expr());
      while (tokens[p]?.k === ',') { p++; args.push(expr()); }
    }
    if (tokens[p]?.k !== ')') throw new Error(`expected ) in call to ${name}`);
    p++;
    return { type: 'call', name, args };
  }
  const e = expr();
  if (p !== tokens.length) throw new Error('trailing tokens in expression');
  return e;
}

function evaluate(node, scope) {
  if (node.type === 'str') return node.value;
  const { name, args } = node;
  const lower = name.toLowerCase();

  if (lower === 'parameters') return scope[evaluate(args[0], scope)];
  if (lower === 'coalesce') {
    for (const a of args) {
      const v = evaluate(a, scope);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  if (lower === 'tryget') {
    const obj = evaluate(args[0], scope);
    const key = evaluate(args[1], scope);
    if (obj === null || obj === undefined || typeof obj !== 'object') return null;
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
  }
  if (lower === 'equals') return evaluate(args[0], scope) === evaluate(args[1], scope);
  if (lower === 'empty') {
    const v = evaluate(args[0], scope);
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }
  if (lower === 'string') {
    const v = evaluate(args[0], scope);
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  if (lower === 'variables') {
    const key = evaluate(args[0], scope);
    const vars = scope.__variables ?? {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(vars, key),
      `variable ${key} is not in the template under evaluation`,
    );
    return evalArm(vars[key], scope);
  }
  if (lower === 'and') return args.every((a) => evaluate(a, scope) === true);
  if (lower === 'or') return args.some((a) => evaluate(a, scope) === true);
  if (lower === 'not') return evaluate(args[0], scope) !== true;
  if (lower === 'if') return evaluate(args[0], scope) ? evaluate(args[1], scope) : evaluate(args[2], scope);

  // A user-defined function, e.g. __bicep.adoptMode
  if (name.startsWith('__bicep.')) {
    const fn = userFns[name.slice('__bicep.'.length)];
    if (!fn) throw new Error(`user function ${name} not found in the compiled template`);
    const inner = {};
    fn.parameters.forEach((p, idx) => { inner[p.name] = evaluate(args[idx], scope); });
    return evalArm(fn.output.value, inner);
  }
  throw new Error(`unsupported ARM function in this evaluator: ${name}`);
}

function evalArm(expression, scope) {
  if (typeof expression !== 'string') return expression;
  if (!expression.startsWith('[') || !expression.endsWith(']')) return expression;
  return evaluate(parse(tokenize(expression.slice(1, -1))), scope);
}

/** Evaluate a template VARIABLE against a given `adopt` object + flag values. */
function variable(name, adopt, flags = {}) {
  const expr = tpl.variables?.[name];
  assert.ok(expr !== undefined, `variable ${name} is not in the compiled template`);
  return evalArm(expr, { adopt, ...flags });
}

// ---------------------------------------------------------------------------

test('the evaluator is exercising the SHIPPED artifact, not a copy', () => {
  assert.ok(tpl.parameters.adopt, 'the compiled template must declare the `adopt` parameter');
  assert.equal(tpl.parameters.adopt.type, 'object');
  assert.deepEqual(tpl.parameters.adopt.defaultValue, {});
  for (const fn of ['adoptMode', 'adoptName', 'adoptRg', 'adoptSub', 'adoptExtra']) {
    assert.ok(userFns[fn], `compiled template must export __bicep.${fn}`);
  }
});

test('greenfield: an EMPTY adopt object means create, for every service', () => {
  const flags = {
    purviewEnabled: true, aiSearchEnabled: true, adxEnabled: true, aiFoundryEnabled: true,
    agentFoundryEnabled: true, apimEnabled: true, loomSynapseEnabled: true,
    loomDatabricksEnabled: true, loomDataFactoryEnabled: true, loomConsoleCosmosEnabled: true,
    loomEventHubEnabled: true, loomStreamAnalyticsEnabled: true, azureMapsEnabled: true,
    mlWorkspaceEnabled: true,
  };
  for (const [v, flag] of Object.entries({
    provisionPurview: 'purviewEnabled', provisionAiSearch: 'aiSearchEnabled',
    provisionAdx: 'adxEnabled', provisionFoundry: 'aiFoundryEnabled',
    provisionApim: 'apimEnabled', provisionSynapse: 'loomSynapseEnabled',
    provisionDatabricks: 'loomDatabricksEnabled', provisionAdf: 'loomDataFactoryEnabled',
    provisionConsoleCosmos: 'loomConsoleCosmosEnabled', provisionEventHubs: 'loomEventHubEnabled',
    provisionStreamAnalytics: 'loomStreamAnalyticsEnabled', provisionMaps: 'azureMapsEnabled',
    provisionAml: 'mlWorkspaceEnabled',
  })) {
    assert.equal(variable(v, {}, flags), true, `${v} must be true on greenfield (flag ${flag})`);
  }
  assert.equal(variable('existingPurviewAccount', {}, flags), '');
});

test('adopt: the new resource is SUPPRESSED and the coordinates are bound', () => {
  const adopt = {
    purview: { mode: 'adopt', target: { name: 'pv-corp', rg: 'rg-gov', sub: 'sub-9' } },
  };
  assert.equal(variable('provisionPurview', adopt, { purviewEnabled: true }), false,
    'adopting an existing Purview must suppress the new account — a second one fails the whole deploy with EnterpriseTenantAlreadyExists');
  assert.equal(variable('existingPurviewAccount', adopt), 'pv-corp');
  assert.equal(variable('existingPurviewRg', adopt), 'rg-gov');
  assert.equal(variable('existingPurviewSub', adopt), 'sub-9');
});

test('the union DEEP-MERGE leak is closed: a create decision surfaces NO coordinates', () => {
  // Exactly what `union(legacyEnvShim, planJson)` produces when the operator has
  // EXISTING_PURVIEW exported AND the plan says create.
  const merged = {
    purview: { mode: 'create', target: { name: 'pv-corp', rg: 'rg-gov', sub: 'sub-9' } },
  };
  assert.equal(variable('provisionPurview', merged, { purviewEnabled: true }), true,
    'a create decision must still deploy a new Purview');
  assert.equal(variable('existingPurviewAccount', merged), '',
    'a create decision must NOT leak the leftover legacy name — binding it would point the Console at the customer resource while ALSO deploying a duplicate');
  assert.equal(variable('existingPurviewRg', merged), '');
  assert.equal(variable('existingPurviewSub', merged), '');
});

test('skip: nothing is deployed and nothing is bound', () => {
  const adopt = { aisearch: { mode: 'skip' } };
  assert.equal(variable('provisionAiSearch', adopt, { aiSearchEnabled: true }), false);
  assert.equal(variable('existingAiSearchService', adopt), '');
});

test('the enable flag still wins — opt-out is not overridden by the plan', () => {
  assert.equal(variable('provisionPurview', {}, { purviewEnabled: false }), false);
  assert.equal(
    variable('provisionPurview', { purview: { mode: 'create' } }, { purviewEnabled: false }),
    false,
  );
});

test('extras ride the adopt entry and are also mode-gated', () => {
  const adopt = {
    foundry: {
      mode: 'adopt',
      target: { name: 'aoai-corp', rg: 'rg-ai', sub: 'sub-2' },
      extra: { chatDeployment: 'gpt-4o', embedDeployment: 'text-embedding-3-large' },
    },
  };
  assert.equal(variable('existingFoundryChatDeployment', adopt), 'gpt-4o');
  assert.equal(variable('existingFoundryEmbedDeployment', adopt), 'text-embedding-3-large');
  assert.equal(variable('provisionFoundry', adopt, { aiFoundryEnabled: true }), false);
  assert.equal(variable('provisionAgentFoundry', adopt, { agentFoundryEnabled: true }), false,
    'the Agent Foundry account must be suppressed too — it defaults ON and the Console env prefers it, so leaving it would deploy a duplicate and bind the NEW one');

  const created = { foundry: { mode: 'create', extra: { chatDeployment: 'leftover' } } };
  assert.equal(variable('existingFoundryChatDeployment', created), '');
});

test('a partial entry is still a valid entry', () => {
  // A plan that names a resource but omits the rg/sub must not throw; the
  // missing coordinates come back empty and the honest gate downstream reports
  // what is missing rather than the deploy failing on an undefined index.
  const adopt = { adx: { mode: 'adopt', target: { name: 'kusto1' } } };
  assert.equal(variable('existingAdxClusterName', adopt), 'kusto1');
  assert.equal(variable('existingAdxClusterRg', adopt), '');
  assert.equal(variable('existingAdxClusterSub', adopt), '');
  assert.equal(variable('provisionAdx', adopt, { adxEnabled: true }), false);
});

// ---------------------------------------------------------------------------
// The agentFoundry CREATE decision vs the agentFoundry BIND decision.
//
// These are different questions, and for one release they shared one flag:
// main.bicep passed the CREATE decision down as `agentFoundryEnabled`, which is
// what admin-plane keys ~20 Console env expressions off. The result was that
// choosing "reuse my Azure OpenAI account" made admin-plane indistinguishable
// from "AOAI is switched off", and LOOM_AOAI_MINI_DEPLOYMENT /
// LOOM_AOAI_STRONG_DEPLOYMENT shipped EMPTY on exactly the brownfield path
// adoption exists to serve.
//
// Asserted against the SHIPPED artifact's nested admin-plane template, same as
// every other case here — not against a copy of the logic.
// ---------------------------------------------------------------------------

/** The admin-plane nested template inside the shipped artifact. */
function adminPlaneModule() {
  const resources = Array.isArray(tpl.resources) ? tpl.resources : Object.values(tpl.resources);
  const m = resources.find(
    (r) =>
      r && typeof r === 'object' &&
      r.type === 'Microsoft.Resources/deployments' &&
      JSON.stringify(r.name ?? '').includes('admin-plane'),
  );
  assert.ok(m, 'the compiled template must contain the admin-plane module deployment');
  return m;
}

/** Evaluate a variable of the admin-plane NESTED template. */
function adminVar(name, scope) {
  const vars = adminPlaneModule().properties.template.variables ?? {};
  assert.ok(vars[name] !== undefined, `admin-plane variable ${name} is not in the compiled template`);
  return evalArm(vars[name], { ...scope, __variables: vars });
}

test('main.bicep hands admin-plane the BIND flag and the CREATE flag SEPARATELY', () => {
  const passed = adminPlaneModule().properties.parameters;
  assert.equal(
    passed.agentFoundryEnabled?.value,
    "[parameters('agentFoundryEnabled')]",
    'agentFoundryEnabled is the BIND mirror — passing the provision var here makes an adopted AOAI account look identical to no AOAI at all',
  );
  assert.equal(
    passed.provisionAgentFoundry?.value,
    "[variables('provisionAgentFoundry')]",
    'the create decision must still reach admin-plane, or an adopt pick would deploy a duplicate Foundry account',
  );
  const byo = adminPlaneModule().properties.parameters.byoExisting.value;
  assert.equal(byo.foundryMiniDeployment, "[variables('existingFoundryMiniDeployment')]");
  assert.equal(byo.foundryStrongDeployment, "[variables('existingFoundryStrongDeployment')]");
  assert.equal(byo.foundryChatDeployment, "[variables('existingFoundryChatDeployment')]");
});

test('greenfield: agentFoundryCreate is TRUE, so the account deploys and its outputs are read', () => {
  const provision = variable('provisionAgentFoundry', {}, { agentFoundryEnabled: true });
  assert.equal(provision, true);
  assert.equal(
    adminVar('agentFoundryCreate', { agentFoundryEnabled: true, provisionAgentFoundry: provision }),
    true,
  );
});

test('adopt: the account is NOT created but the model-tier env vars are still bound', () => {
  const adopt = {
    foundry: {
      mode: 'adopt',
      target: { name: 'aoai-corp', rg: 'rg-ai', sub: 'sub-2' },
      extra: {
        chatDeployment: 'gpt-5.4-mini',
        embedDeployment: '',
        miniDeployment: 'gpt-5.4-mini',
        strongDeployment: 'o3-deep-research',
      },
    },
  };
  const provision = variable('provisionAgentFoundry', adopt, { agentFoundryEnabled: true });
  assert.equal(provision, false, 'an adopt pick must not stand up a second Foundry account');

  const scope = { agentFoundryEnabled: true, provisionAgentFoundry: provision };
  assert.equal(adminVar('agentFoundryCreate', scope), false);

  // The values main.bicep hands down, evaluated from the same plan.
  const byoExisting = {
    foundryChatDeployment: variable('existingFoundryChatDeployment', adopt),
    foundryMiniDeployment: variable('existingFoundryMiniDeployment', adopt),
    foundryStrongDeployment: variable('existingFoundryStrongDeployment', adopt),
  };
  assert.equal(byoExisting.foundryMiniDeployment, 'gpt-5.4-mini');
  assert.equal(byoExisting.foundryStrongDeployment, 'o3-deep-research');

  assert.equal(adminVar('effByoMiniDeployment', { ...scope, byoExisting }), 'gpt-5.4-mini');
  assert.equal(adminVar('effByoStrongDeployment', { ...scope, byoExisting }), 'o3-deep-research');
});

test('adopt with no distinct tier slots falls back to the chat deployment, never to empty', () => {
  const adopt = {
    foundry: {
      mode: 'adopt',
      target: { name: 'aoai-corp' },
      extra: { chatDeployment: 'gpt-4o', embedDeployment: 'text-embedding-3-large' },
    },
  };
  const byoExisting = {
    foundryChatDeployment: variable('existingFoundryChatDeployment', adopt),
    foundryMiniDeployment: variable('existingFoundryMiniDeployment', adopt),
    foundryStrongDeployment: variable('existingFoundryStrongDeployment', adopt),
  };
  assert.equal(byoExisting.foundryMiniDeployment, '');
  assert.equal(
    adminVar('effByoMiniDeployment', { byoExisting }), 'gpt-4o',
    'an empty tier var is a day-one gate the platform could have filled — mini==chat reproduces the documented single-default routing while staying inspectable',
  );
  assert.equal(adminVar('effByoStrongDeployment', { byoExisting }), 'gpt-4o');
});

test('the model-tier env entries consume the BYO fallback, not a literal empty string', () => {
  // The apps[] env array compiles to one big concat(createArray(...)) expression;
  // this pins the two entries the defect emptied, in the SHIPPED artifact.
  const env = JSON.stringify(adminPlaneModule().properties.template);
  for (const [name, fallback] of [
    ['LOOM_AOAI_MINI_DEPLOYMENT', 'effByoMiniDeployment'],
    ['LOOM_AOAI_STRONG_DEPLOYMENT', 'effByoStrongDeployment'],
  ]) {
    const needle =
      `createObject('name', '${name}', 'value', if(variables('agentFoundryCreate'), ` +
      `reference('agentFoundry').outputs.${fallback === 'effByoMiniDeployment' ? 'mini' : 'strong'}Deployment.value, ` +
      `variables('${fallback}')))`;
    assert.ok(
      env.includes(needle),
      `${name} must fall back to variables('${fallback}') on an adopt. Expected to find:\n  ${needle}`,
    );
  }
  assert.ok(
    !env.includes("createObject('name', 'LOOM_AOAI_MINI_DEPLOYMENT', 'value', if(parameters('agentFoundryEnabled')"),
    'the pre-fix expression (gated on the bind flag, falling back to an empty string) must be gone',
  );
});
