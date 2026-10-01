/**
 * Front Door: the security policy must cover EVERY domain a route serves.
 *
 * `platform/fiab/bicep/modules/admin-plane/front-door.bicep` declares one route
 * (`fdRoute`) and one WAF security policy (`fdSecurityPolicy`). The route serves
 * the endpoint's generated *.azurefd.net host (`linkToDefaultDomain: 'Enabled'`)
 * and, when `vanityDomain` is set, the custom domain `fdCustomDomain`. The policy
 * applies the WAF only to the domains listed in its `associations[].domains`, so
 * any domain the route serves that is missing from that list is served without
 * the policy evaluating its traffic. Until this test landed the association
 * listed the endpoint alone.
 *
 * WHAT THIS COMPARES. The module is compiled with `az bicep build`, and the
 * compiled ARM expressions are EVALUATED, not string-matched, for three
 * parameter scenarios:
 *
 *   S0  vanityDomain = ''                         (no custom domain)
 *   S1  vanityDomain = 'csa-loom.example.com'     (derived customDomains name)
 *   S2  same, vanityCustomDomainName = 'adopted-custom-domain'  (adopt-first, #3287)
 *
 * For each: served = every route's endpoint (when linkToDefaultDomain is
 * Enabled) + every route's customDomains[].id; protected = every security
 * policy's associations[].domains[].id; deployed = the id of every resource
 * whose `condition` holds. Asserted: served is a subset of protected, and
 * protected is a subset of deployed.
 *
 * WHAT WOULD MAKE EACH ASSERTION FAIL (assertion-design.md):
 *   - served ⊆ protected  — RED when the association lists only
 *     `{ id: fdEndpoint.id }` (the pre-fix template) in S1/S2. Mutation-run on a
 *     sandbox copy: see the PR body.
 *   - protected ⊆ deployed — RED when the association lists the custom domain
 *     UNCONDITIONALLY: in S0 it names a customDomains resource whose condition
 *     is false, which Front Door cannot associate. Mutation-run likewise.
 *   - the served-count pins (1 in S0, 2 in S1/S2) — RED if the evaluator stops
 *     seeing the route's customDomains, which would otherwise make the subset
 *     check vacuously true over an empty served set.
 *   - the S2 adopted-name pin — RED if the policy and the route stop naming the
 *     SAME customDomains resource when an existing name is adopted.
 *
 * The synthetic-template tests at the top are the comparator's own positive and
 * negative controls; they need no Azure CLI.
 *
 * The evaluator is deliberately small and FAILS CLOSED: an ARM function it does
 * not implement throws, naming the function, rather than evaluating to something
 * that might happen to compare equal.
 *
 * Run: node --test scripts/ci/__tests__/front-door-security-policy-domains.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertInterpreterSafeArgs, resolveWindowsInterpreter } from '../check-deploy-template-sync.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const FRONT_DOOR_BICEP = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'front-door.bicep');

const ROUTE_TYPE = 'microsoft.cdn/profiles/afdendpoints/routes';
const POLICY_TYPE = 'microsoft.cdn/profiles/securitypolicies';
const ENDPOINT_TYPE = 'Microsoft.Cdn/profiles/afdEndpoints';

// ── ARM expression evaluator (the subset bicep emits for this module) ────────

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "'") {
      let s = '';
      i += 1;
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated string literal in ARM expression: ${src}`);
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i += 1;
          break;
        }
        s += src[i];
        i += 1;
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const m = /^-?[0-9]+/.exec(src.slice(i));
      if (!m) throw new Error(`unexpected '${c}' in ARM expression: ${src}`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('(),.[]'.includes(c)) { out.push({ t: c }); i += 1; continue; }
    throw new Error(`unexpected '${c}' in ARM expression: ${src}`);
  }
  return out;
}

export function parseArmExpression(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => {
    const tok = toks[p];
    if (!tok || tok.t !== t) throw new Error(`expected '${t}' at token ${p} in ARM expression: ${src}`);
    p += 1;
    return tok;
  };
  function primary() {
    const tok = toks[p];
    if (!tok) throw new Error(`unexpected end of ARM expression: ${src}`);
    if (tok.t === 'str' || tok.t === 'num') { p += 1; return { k: 'lit', v: tok.v }; }
    if (tok.t === 'id') {
      p += 1;
      take('(');
      const args = [];
      if (peek() && peek().t !== ')') {
        args.push(expr());
        while (peek() && peek().t === ',') { p += 1; args.push(expr()); }
      }
      take(')');
      return { k: 'call', name: tok.v.toLowerCase(), args };
    }
    throw new Error(`unexpected token '${tok.t}' in ARM expression: ${src}`);
  }
  function expr() {
    let node = primary();
    for (;;) {
      const tok = peek();
      if (tok && tok.t === '.') { p += 1; node = { k: 'prop', obj: node, name: take('id').v }; continue; }
      if (tok && tok.t === '[') { p += 1; const index = expr(); take(']'); node = { k: 'idx', obj: node, index }; continue; }
      return node;
    }
  }
  const node = expr();
  if (p !== toks.length) throw new Error(`trailing tokens in ARM expression: ${src}`);
  return node;
}

/** Deterministic stand-in for uniqueString(): only EQUALITY between ids matters here. */
function fakeUniqueString(args) {
  let h = 0;
  for (const ch of args.join('|')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `u${h.toString(36)}`;
}

const RG = {
  id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fd-test',
  name: 'rg-fd-test',
  location: 'centralus',
};

function resourceIdOf(args) {
  const typeAt = args.findIndex((a) => typeof a === 'string' && a.includes('/'));
  if (typeAt < 0) throw new Error(`resourceId() without a resource type: ${JSON.stringify(args)}`);
  const [ns, ...segments] = args[typeAt].split('/');
  const names = args.slice(typeAt + 1);
  if (names.length !== segments.length) {
    throw new Error(`resourceId(${args[typeAt]}) needs ${segments.length} names, got ${names.length}`);
  }
  if (typeAt !== 0) throw new Error(`resourceId() with an explicit subscription/RG is outside this evaluator: ${JSON.stringify(args)}`);
  return `${RG.id}/providers/${ns}/${segments.map((s, i) => `${s}/${names[i]}`).join('/')}`;
}

/**
 * @param {any} template compiled ARM template
 * @param {Record<string, any>} paramValues scenario parameter values
 */
export function makeContext(template, paramValues) {
  const paramCache = new Map();
  const varCache = new Map();
  const ctx = {
    param(name) {
      if (Object.prototype.hasOwnProperty.call(paramValues, name)) return paramValues[name];
      if (paramCache.has(name)) return paramCache.get(name);
      const decl = (template.parameters || {})[name];
      if (!decl) throw new Error(`parameters('${name}') is not declared in the template`);
      if (!('defaultValue' in decl)) throw new Error(`parameters('${name}') has no default and the scenario does not set it`);
      const v = evaluate(decl.defaultValue, ctx);
      paramCache.set(name, v);
      return v;
    },
    variable(name) {
      if (varCache.has(name)) return varCache.get(name);
      const vars = template.variables || {};
      if (!(name in vars)) throw new Error(`variables('${name}') is not declared in the template`);
      const v = evaluate(vars[name], ctx);
      varCache.set(name, v);
      return v;
    },
  };
  return ctx;
}

function evalNode(node, ctx) {
  if (node.k === 'lit') return node.v;
  if (node.k === 'prop') {
    const o = evalNode(node.obj, ctx);
    if (o === null || typeof o !== 'object' || !(node.name in o)) {
      throw new Error(`property '${node.name}' is not available on ${JSON.stringify(o)}`);
    }
    return o[node.name];
  }
  if (node.k === 'idx') {
    const o = evalNode(node.obj, ctx);
    return o[evalNode(node.index, ctx)];
  }
  const a = (i) => evalNode(node.args[i], ctx);
  const all = () => node.args.map((n) => evalNode(n, ctx));
  switch (node.name) {
    case 'if': return a(0) ? a(1) : a(2); // lazy, like ARM: only the chosen branch is evaluated
    case 'not': return !a(0);
    case 'equals': return JSON.stringify(a(0)) === JSON.stringify(a(1));
    case 'empty': {
      const v = a(0);
      if (v === null || v === undefined) return true;
      if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
      if (typeof v === 'object') return Object.keys(v).length === 0;
      throw new Error(`empty() of ${typeof v}`);
    }
    case 'parameters': return ctx.param(a(0));
    case 'variables': return ctx.variable(a(0));
    case 'createarray': return all();
    case 'createobject': {
      const v = all();
      const o = {};
      for (let i = 0; i < v.length; i += 2) o[v[i]] = v[i + 1];
      return o;
    }
    case 'concat': {
      const v = all();
      return v.every(Array.isArray) ? v.flat() : v.map(String).join('');
    }
    case 'format': {
      const [fmt, ...rest] = all();
      return fmt.replace(/\{(\d+)\}/g, (_, n) => String(rest[Number(n)]));
    }
    case 'replace': { const [s, from, to] = all(); return s.split(from).join(to); }
    case 'uniquestring': return fakeUniqueString(all());
    case 'resourcegroup': return RG;
    case 'resourceid': return resourceIdOf(all());
    default:
      throw new Error(`ARM function '${node.name}()' is not implemented by this test's evaluator — extend it rather than letting the comparison guess`);
  }
}

/** Evaluate a compiled-template JSON value: expression strings, arrays and objects recursively. */
export function evaluate(value, ctx) {
  if (typeof value === 'string') {
    if (value.startsWith('[[')) return value.slice(1);
    if (value.startsWith('[') && value.endsWith(']')) return evalNode(parseArmExpression(value.slice(1, -1)), ctx);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => evaluate(v, ctx));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = evaluate(v, ctx);
    return o;
  }
  return value;
}

// ── the comparison ───────────────────────────────────────────────────────────

function resourcesOf(template) {
  const r = template.resources;
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') return Object.values(r); // languageVersion 2.0 symbolic names
  return [];
}

const norm = (id) => String(id).toLowerCase();

function idsOf(domains, where) {
  if (!Array.isArray(domains)) throw new Error(`${where} did not evaluate to an array: ${JSON.stringify(domains)}`);
  return domains.map((d) => {
    if (!d || typeof d.id !== 'string') throw new Error(`${where} entry has no string id: ${JSON.stringify(d)}`);
    return d.id;
  });
}

/**
 * @returns {{ served: string[], protectedIds: string[], deployed: string[],
 *             uncovered: string[], dangling: string[], routes: number, policies: number }}
 */
export function compareDomains(template, paramValues) {
  const ctx = makeContext(template, paramValues);
  const live = resourcesOf(template).filter((r) => !('condition' in r) || evaluate(r.condition, ctx));
  const deployed = live.map((r) => resourceIdOf([r.type, ...String(evaluate(r.name, ctx)).split('/')]));

  const served = [];
  const routes = live.filter((r) => norm(r.type) === ROUTE_TYPE);
  for (const r of routes) {
    const [profile, endpoint] = String(evaluate(r.name, ctx)).split('/');
    const props = r.properties || {};
    if (evaluate(props.linkToDefaultDomain, ctx) === 'Enabled') served.push(resourceIdOf([ENDPOINT_TYPE, profile, endpoint]));
    served.push(...idsOf(evaluate(props.customDomains ?? [], ctx), `route ${profile}/${endpoint} customDomains`));
  }

  const protectedIds = [];
  const policies = live.filter((r) => norm(r.type) === POLICY_TYPE);
  for (const p of policies) {
    const params = evaluate((p.properties || {}).parameters, ctx) || {};
    for (const [i, assoc] of (params.associations || []).entries()) {
      protectedIds.push(...idsOf(assoc.domains, `security policy association[${i}] domains`));
    }
  }

  const prot = new Set(protectedIds.map(norm));
  const dep = new Set(deployed.map(norm));
  return {
    served,
    protectedIds,
    deployed,
    uncovered: served.filter((id) => !prot.has(norm(id))),
    dangling: protectedIds.filter((id) => !dep.has(norm(id))),
    routes: routes.length,
    policies: policies.length,
  };
}

// ── controls: the comparator on hand-built templates (no Azure CLI) ─────────

/** A minimal compiled-shape template: one profile, endpoint, optional custom domain, route, policy. */
function syntheticTemplate(policyDomainsExpr) {
  const cd = "resourceId('Microsoft.Cdn/profiles/customDomains', 'p', 'cd')";
  const ep = "resourceId('Microsoft.Cdn/profiles/afdEndpoints', 'p', 'e')";
  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    parameters: { vanityDomain: { type: 'string', defaultValue: '' } },
    resources: [
      { type: 'Microsoft.Cdn/profiles', name: 'p' },
      { type: 'Microsoft.Cdn/profiles/afdEndpoints', name: 'p/e' },
      { type: 'Microsoft.Cdn/profiles/customDomains', name: 'p/cd', condition: "[not(empty(parameters('vanityDomain')))]" },
      {
        type: 'Microsoft.Cdn/profiles/afdEndpoints/routes',
        name: 'p/e/r',
        properties: {
          linkToDefaultDomain: 'Enabled',
          customDomains: `[if(empty(parameters('vanityDomain')), createArray(), createArray(createObject('id', ${cd})))]`,
        },
      },
      {
        type: 'Microsoft.Cdn/profiles/securityPolicies',
        name: 'p/pol',
        properties: { parameters: { type: 'WebApplicationFirewall', associations: [{ domains: policyDomainsExpr(ep, cd), patternsToMatch: ['/*'] }] } },
      },
    ],
  };
}

const VANITY = { vanityDomain: 'csa-loom.example.com' };

test('control: an endpoint-only association LEAVES the served custom domain uncovered', () => {
  const t = syntheticTemplate((ep) => [{ id: `[${ep}]` }]);
  const r = compareDomains(t, VANITY);
  assert.equal(r.served.length, 2, 'the route serves the endpoint AND the custom domain');
  assert.deepEqual(r.uncovered.map((id) => id.split('/').slice(-2).join('/')), ['customDomains/cd']);
});

test('control: the same template with no vanity domain serves only the endpoint, which is covered', () => {
  const t = syntheticTemplate((ep) => [{ id: `[${ep}]` }]);
  const r = compareDomains(t, { vanityDomain: '' });
  assert.equal(r.served.length, 1);
  assert.deepEqual(r.uncovered, []);
});

test('control: a conditional association covering both domains passes in both scenarios', () => {
  const t = syntheticTemplate((ep, cd) => `[if(empty(parameters('vanityDomain')), createArray(createObject('id', ${ep})), createArray(createObject('id', ${ep}), createObject('id', ${cd})))]`);
  for (const scenario of [{ vanityDomain: '' }, VANITY]) {
    const r = compareDomains(t, scenario);
    assert.deepEqual(r.uncovered, [], JSON.stringify(scenario));
    assert.deepEqual(r.dangling, [], JSON.stringify(scenario));
  }
});

test('control: an UNCONDITIONAL custom-domain association dangles when no custom domain is deployed', () => {
  const t = syntheticTemplate((ep, cd) => [{ id: `[${ep}]` }, { id: `[${cd}]` }]);
  const r = compareDomains(t, { vanityDomain: '' });
  assert.deepEqual(r.dangling.map((id) => id.split('/').slice(-2).join('/')), ['customDomains/cd']);
});

test('control: an ARM function the evaluator does not implement throws instead of guessing', () => {
  const t = syntheticTemplate(() => "[createArray(createObject('id', reference('x').id))]");
  assert.throws(() => compareDomains(t, VANITY), /'reference\(\)' is not implemented/);
});

// ── the real module ──────────────────────────────────────────────────────────

/** Run `az`; on Windows through cmd.exe with the same argument guard the deploy-template guards use. */
function runAz(args) {
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (process.platform === 'win32') {
    const interpreter = resolveWindowsInterpreter();
    assertInterpreterSafeArgs(['az', ...args]);
    return spawnSync(interpreter, ['/d', '/c', 'az', ...args], opts);
  }
  return spawnSync('az', args, opts);
}

let compiled;
function compileFrontDoor() {
  if (compiled) return compiled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fdpolicy-'));
  const out = path.join(dir, 'front-door.json');
  try {
    const res = runAz(['bicep', 'build', '-f', FRONT_DOOR_BICEP, '--outfile', out]);
    // FAILS, never skips: a compile check that cannot compile has verified nothing.
    if (res.error) throw new Error(`could not run \`az bicep build\`: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`\`az bicep build\` failed (exit ${res.status}):\n${String(res.stderr).slice(-4000)}`);
    if (!fs.existsSync(out)) throw new Error('`az bicep build` exited 0 but wrote no output file');
    compiled = JSON.parse(fs.readFileSync(out, 'utf8'));
    return compiled;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Placeholders for the module's required parameters; none of them feeds a domain id.
const BASE = {
  caeId: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fd-test/providers/Microsoft.App/managedEnvironments/cae',
  caeDefaultDomain: 'example.centralus.azurecontainerapps.io',
  consoleFqdn: 'loom-console.example.centralus.azurecontainerapps.io',
  complianceTags: {},
};

const SCENARIOS = [
  { name: 'S0 no vanity domain', params: { ...BASE, vanityDomain: '', vanityCustomDomainName: '' }, served: 1 },
  { name: 'S1 vanity domain, derived customDomains name', params: { ...BASE, vanityDomain: 'csa-loom.example.com', vanityCustomDomainName: '' }, served: 2 },
  { name: 'S2 vanity domain, adopted customDomains name', params: { ...BASE, vanityDomain: 'csa-loom.example.com', vanityCustomDomainName: 'adopted-custom-domain' }, served: 2 },
];

test('front-door.bicep compiles to a template with exactly one route and at least one security policy', () => {
  const t = compileFrontDoor();
  const r = compareDomains(t, SCENARIOS[1].params);
  // Population pins: a template with no route or no policy would make every
  // subset check below vacuously true.
  assert.equal(r.routes, 1, 'expected exactly one Front Door route in front-door.bicep');
  assert.ok(r.policies >= 1, 'expected at least one Front Door security policy in front-door.bicep');
});

for (const s of SCENARIOS) {
  test(`front-door.bicep ${s.name}: every domain the route serves is in the security-policy association`, () => {
    const r = compareDomains(compileFrontDoor(), s.params);
    assert.equal(r.served.length, s.served, `served domains in ${s.name}: ${JSON.stringify(r.served)}`);
    assert.deepEqual(
      r.uncovered,
      [],
      `domains served by the route but absent from the security-policy association in ${s.name}: ${JSON.stringify(r.uncovered)}`,
    );
  });

  test(`front-door.bicep ${s.name}: every associated domain is a resource this scenario deploys`, () => {
    const r = compareDomains(compileFrontDoor(), s.params);
    assert.ok(r.protectedIds.length >= 1, 'the security policy associates no domains at all');
    assert.deepEqual(
      r.dangling,
      [],
      `security-policy association names domains this scenario does not deploy in ${s.name}: ${JSON.stringify(r.dangling)}`,
    );
  });
}

test('front-door.bicep S2: the route and the policy name the SAME adopted customDomains resource', () => {
  const r = compareDomains(compileFrontDoor(), SCENARIOS[2].params);
  const tail = '/providers/microsoft.cdn/profiles/';
  const adopted = (ids) => ids.map(norm).filter((id) => id.includes(tail) && id.endsWith('/customdomains/adopted-custom-domain'));
  assert.equal(adopted(r.served).length, 1, `route customDomains: ${JSON.stringify(r.served)}`);
  assert.equal(adopted(r.protectedIds).length, 1, `policy domains: ${JSON.stringify(r.protectedIds)}`);
});
