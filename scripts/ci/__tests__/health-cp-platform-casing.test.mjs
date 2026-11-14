/**
 * Guard for the LHDS control-plane platform validity check in platform/fiab/bicep/health.bicep.
 *
 * Defect (deploy-health run 43317155221): cpValidPlatform compared a LOWERCASED value against the
 * mixed-case literal 'containerApps', so the containerApps control plane could never deploy:
 * "controlPlaneConfig.controlPlane must be containerApps or aks, got containerapps".
 *
 * Method: compile health.bicep with `az bicep build`, then EVALUATE the compiled ARM expressions
 * for cpPlatformRaw / cpValidPlatform / cpPlatform / cpSkipReason with a small evaluator (only
 * the functions those expressions use; an unknown function throws, so it cannot silently pass).
 * This is not a grep for a string. Requires `az` with bicep; if absent the suite FAILS, it does
 * not skip, because a skipped guard watches nothing.
 *
 * Inputs that break each assertion are named inline (assertion-design.md). LHDS_REPO_ROOT points
 * the suite at a sandbox copy for mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/health-cp-platform-casing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const bicep = resolve(root, 'platform/fiab/bicep/health.bicep');

const tmp = mkdtempSync(join(tmpdir(), 'health-casing-'));
const out = join(tmp, 'health.json');
const build = spawnSync('az', ['bicep', 'build', '--file', bicep, '--outfile', out], { encoding: 'utf8', shell: process.platform === 'win32' });
assert.equal(build.status, 0, `az bicep build failed (guard cannot run): ${build.stderr}`);
const arm = JSON.parse(readFileSync(out, 'utf8'));
rmSync(tmp, { recursive: true, force: true });

// ---- minimal ARM expression evaluator ----
function tokenize(s) {
  const t = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") { let j = i + 1, v = ''; while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { v += "'"; j += 2; continue; } break; } v += s[j++]; } t.push({ k: 's', v }); i = j + 1; continue; }
    if ('(),'.includes(c)) { t.push({ k: c }); i++; continue; }
    const m = /^[A-Za-z0-9_.]+/.exec(s.slice(i));
    assert.ok(m, `unparseable ARM expression at: ${s.slice(i, i + 20)}`);
    t.push({ k: 'id', v: m[0] }); i += m[0].length;
  }
  return t;
}
function evalExpr(expr, ctx) {
  const toks = tokenize(expr.replace(/^\[/, '').replace(/\]$/, ''));
  let p = 0;
  // skip=true walks the tokens without evaluating (if() is lazy, as in ARM, so untaken branches
  // never touch unstubbed parameters).
  const parse = (skip = false) => {
    const tk = toks[p++];
    if (tk.k === 's') return tk.v;
    assert.equal(tk.k, 'id');
    if (toks[p]?.k !== '(') { if (tk.v === 'true') return true; if (tk.v === 'false') return false; throw new Error(`bare identifier ${tk.v}`); }
    p++;
    const args = [];
    let i = 0, cond;
    while (toks[p].k !== ')') {
      const lazyIf = tk.v === 'if' && i > 0;
      const argSkip = skip || (lazyIf && (i === 1 ? !cond : !!cond));
      args.push(parse(argSkip));
      if (tk.v === 'if' && i === 0) cond = args[0];
      i++;
      if (toks[p].k === ',') p++;
    }
    p++;
    return skip ? undefined : call(tk.v, args);
  };
  const call = (fn, a) => {
    switch (fn) {
      case 'toLower': return String(a[0]).toLowerCase();
      case 'string': return String(a[0]);
      case 'coalesce': return a.find((x) => x !== null && x !== undefined);
      case 'tryGet': return a[0]?.[a[1]];
      case 'if': return a[0] ? a[1] : a[2];
      case 'equals': return a[0] === a[1];
      case 'not': return !a[0];
      case 'and': return a.every(Boolean);
      case 'or': return a.some(Boolean);
      case 'empty': return a[0] === undefined || a[0] === null || a[0].length === 0;
      case 'createArray': return a;
      case 'contains': return Array.isArray(a[0]) ? a[0].includes(a[1]) : String(a[0]).includes(a[1]);
      case 'format': return a[0].replace(/\{(\d+)\}/g, (_, n) => a[Number(n) + 1]);
      case 'variables': return ctx.variable(a[0]);
      case 'parameters': return ctx.parameter(a[0]);
      default: throw new Error(`evaluator does not support ${fn}()`);
    }
  };
  const v = parse();
  assert.equal(p, toks.length, `trailing tokens in ${expr}`);
  return v;
}

// Evaluate the real compiled variable graph; inputs the platform check does not depend on are
// stubbed so that cpSkipReason reaches the platform branch (audiences non-empty, PG allowed, enabled).
function evaluate(controlPlane, boundary = 'Commercial') {
  const overrides = { effectiveBoundary: boundary, healthPgAllowed: true, cpAudiences: ['api://x'] };
  const memo = {};
  const ctx = {
    variable: (n) => (n in overrides ? overrides[n] : (memo[n] ??= evalExpr(typeof arm.variables[n] === 'string' ? arm.variables[n] : (() => { throw new Error(`variable ${n} is not an expression`); })(), ctx))),
    parameter: (n) => (n === 'controlPlaneConfig' ? (controlPlane === undefined ? {} : { controlPlane }) : n === 'healthEnabled' ? true : (() => { throw new Error(`parameter ${n} not stubbed`); })()),
  };
  return {
    valid: ctx.variable('cpValidPlatform'),
    platform: ctx.variable('cpPlatform'),
    reason: ctx.variable('cpSkipReason'),
  };
}

test('containerApps (the exact value deploy-health.yml sends) is a valid platform and maps to containerApps', () => {
  // Breaks if cpValidPlatform compares the lowercased value to the mixed-case literal 'containerApps'
  // (the defect: valid === false for this input, reason "got containerapps").
  const r = evaluate('containerApps');
  assert.equal(r.valid, true, 'containerApps rejected as an invalid platform');
  assert.equal(r.platform, 'containerApps');
  assert.ok(!r.reason.includes('must be containerApps or aks'), `platform rejection leaked into the skip reason: ${r.reason}`);
});

test('case variants containerapps and ContainerApps are accepted and canonicalised', () => {
  // Breaks if the check becomes case-sensitive again (either direction of the lowercase mismatch).
  for (const v of ['containerapps', 'ContainerApps', 'CONTAINERAPPS']) {
    const r = evaluate(v);
    assert.equal(r.valid, true, `${v} rejected`);
    assert.equal(r.platform, 'containerApps', `${v} mapped to ${r.platform}`);
  }
});

test('aks in any case stays valid and maps to aks', () => {
  // Breaks if the fix over-corrects and drops the aks path or its canonical mapping.
  for (const v of ['aks', 'AKS', 'Aks']) {
    const r = evaluate(v);
    assert.equal(r.valid, true, `${v} rejected`);
    assert.equal(r.platform, 'aks');
  }
});

test('an unknown platform is rejected and the skip reason prints the ORIGINAL value', () => {
  // Breaks if k8s is accepted (validity check that cannot fail), or if the reason prints the
  // lowercased form: 'K8s' must appear verbatim, not 'k8s'.
  const r = evaluate('K8s');
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'controlPlaneConfig.controlPlane must be containerApps or aks, got K8s');
});

test('unset controlPlane defaults to containerApps off IL5 and aks at IL5, both valid', () => {
  // Breaks if the default literal in the coalesce fails the validity check (the default path
  // hits the same comparison as an explicit value).
  assert.deepEqual([evaluate(undefined).valid, evaluate(undefined).platform], [true, 'containerApps']);
  assert.deepEqual([evaluate(undefined, 'IL5').valid, evaluate(undefined, 'IL5').platform], [true, 'aks']);
});
