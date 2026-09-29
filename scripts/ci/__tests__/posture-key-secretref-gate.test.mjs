/**
 * posture-key-secretref-gate — the Console's `loom-posture-function-key` Key
 * Vault secret, and the LOOM_POSTURE_FUNCTION_KEY env that references it, must
 * NOT be emitted merely because `loomPostureFunctionUrl` is set.
 *
 * ## The P0 this pins
 *
 * `platform/fiab/bicep/modules/admin-plane/main.bicep` used to gate BOTH the
 * `keyVaultUrl` secret and the env `secretRef` on `!empty(loomPostureFunctionUrl)`.
 * A Container App revision whose secret references a Key Vault secret that does
 * not exist FAILS TO PROVISION. Measured before this change: the posture Function
 * App exists with ZERO published functions, and the bootstrap never logged
 * storing the host key — so the KV secret very probably does not exist. Wiring
 * the URL from the deploy (#4161 / #4665) would therefore have taken the Console
 * down. The gate is now `postureFunctionKeyBound`: URL set AND
 * `observabilityConfig.postureFunctionKeyEnabled` true (the "secret is known to
 * exist" signal, default false).
 *
 * ## Why the compiled ARM, not the bicep source
 *
 * `apps/fiab-console/deploy-templates/main.json` is the artifact that deploys
 * (Dockerfile COPY + inline submit; see check-deploy-template-sync.mjs). A
 * source-text assertion would stay green over a stale artifact. So the gate is
 * FOUND in the compiled template — the innermost `if(` whose THEN branch builds
 * the posture-key object — and EVALUATED, never pattern-matched. The condition is
 * lifted from the artifact at runtime; nothing here transcribes it.
 *
 * ## What value breaks each assertion
 *
 *   - "URL set, key signal absent/false → NOT emitted": the pre-fix condition
 *     `not(empty(parameters('loomPostureFunctionUrl')))` evaluates TRUE for
 *     loomPostureFunctionUrl = 'https://func-loom-posture-refresh-test.azurewebsites.net'.
 *     Measured RED against the compiled template of origin/main a7eadda12.
 *   - "URL set, key signal true → emitted" (POSITIVE control): a gate hard-wired
 *     false, or the secret/env deleted (the site count assertion fails first).
 *   - "key signal true, URL empty → NOT emitted": a gate on the signal alone.
 *   - "env and secret agree": gating only one of the two — an env secretRef to an
 *     undeclared secret is itself a failed revision.
 *   - "exactly one site each": bicep emitting the object UNCONDITIONALLY (no
 *     enclosing `if(` → the finder throws), or a second copy of it appearing.
 *
 * Only the INNERMOST gate is evaluated. Outer conditions (the `appDeployments`
 * containerApps + deployAppsEnabled condition) can only further suppress the
 * object, so "innermost false ⇒ not emitted" holds; the positive control is
 * therefore "the posture gate itself admits it", not "the Console deploys".
 *
 * Run: node --test scripts/ci/__tests__/posture-key-secretref-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATE = resolve(REPO, 'apps/fiab-console/deploy-templates/main.json');

const ENV_MARKER = "createObject('name', 'LOOM_POSTURE_FUNCTION_KEY'";
const SECRET_MARKER = "createObject('name', 'loom-posture-function-key'";
const URL = 'https://func-loom-posture-refresh-test.azurewebsites.net';

const root = JSON.parse(readFileSync(TEMPLATE, 'utf8'));

/** The nested template that declares loomPostureFunctionKeySecretName (admin-plane). */
function findAdminPlane(t) {
  const res = t.resources ?? {};
  const list = Array.isArray(res) ? res : Object.values(res);
  for (const r of list) {
    const inner = r?.properties?.template;
    if (!inner) continue;
    if (inner.parameters?.loomPostureFunctionKeySecretName) return inner;
    const deeper = findAdminPlane(inner);
    if (deeper) return deeper;
  }
  return null;
}
const adminPlane = findAdminPlane(root);

// ─────────────────────────── a tiny ARM evaluator ───────────────────────────
// Only the operators these gates use. Anything else THROWS, so an expression the
// evaluator cannot read can never be silently scored as false (= "not emitted",
// which is the verdict the load-bearing assertions want — fail-open otherwise).

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
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { s += "'"; i += 2; continue; }
        if (src[i] === "'") break;
        s += src[i]; i += 1;
      }
      i += 1;
      out.push({ k: 'str', v: s });
      continue;
    }
    let id = '';
    while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { id += src[i]; i += 1; }
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
    if (tokens[p]?.k !== '(') throw new Error(`bare identifier ${name} (not a call)`);
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

function evaluateExpr(raw, scope) {
  const s = String(raw).trim();
  const body = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
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
    const raw = adminPlane.variables?.[k];
    if (raw === undefined) throw new Error(`unbound variable ${k}`);
    const val = evaluateExpr(raw, scope);
    scope.variables[k] = val;
    return val;
  }
  if (lower === 'true' && args.length === 0) return true;
  if (lower === 'false' && args.length === 0) return false;
  if (lower === 'and') return args.every((_, i) => a(i) === true);
  if (lower === 'or') return args.some((_, i) => a(i) === true);
  if (lower === 'not') return a(0) !== true;
  if (lower === 'equals') return a(0) === a(1);
  if (lower === 'empty') { const v = a(0); return v === '' || v === null || v === undefined; }
  if (lower === 'coalesce') { for (let i = 0; i < args.length; i += 1) { const v = a(i); if (v !== null && v !== undefined) return v; } return null; }
  if (lower === 'tryget') { const o = a(0); const k = a(1); return (o && typeof o === 'object') ? (o[k] ?? null) : null; }
  throw new Error(`unmodelled ARM function: ${name}`);
}

// ─────────────────────── find the gate around a marker ──────────────────────

/** Every string value anywhere under `node`, with its key path. */
function* strings(node, path = []) {
  if (typeof node === 'string') { yield [node, path]; return; }
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i += 1) yield* strings(node[i], [...path, String(i)]); return; }
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) yield* strings(v, [...path, k]);
}

/**
 * For each occurrence of `marker` in `expr`, return the condition text of the
 * INNERMOST enclosing `if(` call, requiring the marker to sit in its THEN
 * argument. Forward scan with a call stack; ARM string literals ('' escaped)
 * are skipped so a comma or paren inside a literal cannot move the frames.
 */
function gatesAround(expr, marker) {
  const out = [];
  const stack = [];
  let i = 0;
  let nextHit = expr.indexOf(marker);
  while (i < expr.length) {
    if (i === nextHit) {
      const frame = [...stack].reverse().find((f) => f.name.toLowerCase() === 'if');
      if (!frame) throw new Error(`${marker} is emitted UNCONDITIONALLY (no enclosing if)`);
      if (frame.argStarts.length !== 2) throw new Error(`${marker} is not in the THEN branch of its if (arg ${frame.argStarts.length - 1})`);
      out.push(expr.slice(frame.argStarts[0], frame.argStarts[1] - 1).trim());
      nextHit = expr.indexOf(marker, i + 1);
    }
    const c = expr[i];
    if (c === "'") {
      i += 1;
      while (i < expr.length) {
        if (expr[i] === "'" && expr[i + 1] === "'") { i += 2; continue; }
        if (expr[i] === "'") break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j += 1;
      if (expr[j] === '(') {
        stack.push({ name: expr.slice(i, j), argStarts: [j + 1] });
        i = j + 1;
        continue;
      }
      i = j;
      continue;
    }
    if (c === ',' && stack.length) stack[stack.length - 1].argStarts.push(i + 1);
    if (c === ')') stack.pop();
    i += 1;
  }
  return out;
}

/**
 * Scope pin. The sites compile into `appDeployments.properties.parameters.apps`
 * — a nested deployment with `expressionEvaluationOptions.scope: 'inner'`, whose
 * `properties.parameters` values ARM evaluates in the PARENT (admin-plane)
 * scope. That is why `variables(...)` above resolves against
 * `adminPlane.variables`. A site found under a nested `properties.template`
 * would resolve against a DIFFERENT variables block, so it throws rather than
 * being evaluated in the wrong scope.
 */
function sitesFor(marker) {
  const conds = [];
  for (const [s, path] of strings(adminPlane.resources ?? {})) {
    if (!s.includes(marker)) continue;
    if (path.includes('template')) throw new Error(`${marker} compiled inside a nested template (${path.join('.')}); its variables scope is not admin-plane's`);
    conds.push(...gatesAround(s, marker));
  }
  return conds;
}

const scopeOf = (url, obs) => ({
  parameters: { loomPostureFunctionUrl: url, observabilityConfig: obs },
  variables: {},
});

// ──────────────────────────── embedded controls ─────────────────────────────

test('CONTROL — the compiled admin-plane template was found', () => {
  assert.ok(adminPlane, `no nested template declaring loomPostureFunctionKeySecretName in ${TEMPLATE}`);
  assert.equal(adminPlane.parameters.loomPostureFunctionKeySecretName.defaultValue, 'loom-posture-function-key');
});

test('CONTROL — the evaluator discriminates, and refuses what it cannot read', () => {
  const s = scopeOf(URL, {});
  assert.equal(evaluateExpr("[not(empty(parameters('loomPostureFunctionUrl')))]", s), true);
  assert.equal(evaluateExpr("[not(empty(parameters('loomPostureFunctionUrl')))]", scopeOf('', {})), false);
  assert.equal(evaluateExpr("[coalesce(tryGet(parameters('observabilityConfig'), 'x'), false())]", s), false);
  assert.equal(evaluateExpr("[coalesce(tryGet(parameters('observabilityConfig'), 'x'), false())]", scopeOf(URL, { x: true })), true);
  assert.throws(() => evaluateExpr("[union(parameters('observabilityConfig'), createObject())]", s), /unmodelled ARM function/);
  assert.throws(() => evaluateExpr("[parameters('neverBound')]", s), /unbound parameter/);
  assert.throws(() => evaluateExpr("[reference('keyvault').outputs.keyVaultUri.value]", s), /trailing tokens|unexpected|bare identifier/);
});

test('CONTROL — the gate finder reads the THEN branch and fails closed on an unconditional emit', () => {
  const m = "createObject('name', 'X'";
  assert.deepEqual(gatesAround(`[concat(createArray(), if(foo(','), createArray(${m}, 'v', 'a''b')), createArray()))]`, m), ["foo(',')"]);
  assert.throws(() => gatesAround(`[concat(createArray(${m}, 'v')))]`, m), /UNCONDITIONALLY/);
  assert.throws(() => gatesAround(`[if(c(), createArray(), createArray(${m}, 'v')))]`, m), /not in the THEN branch/);
});

// ─────────────────────────────── the contract ───────────────────────────────

const ENV_GATES = adminPlane ? sitesFor(ENV_MARKER) : [];
const SECRET_GATES = adminPlane ? sitesFor(SECRET_MARKER) : [];

test('exactly one env secretRef site and one Key Vault secret site, each behind a gate', () => {
  assert.equal(ENV_GATES.length, 1, `LOOM_POSTURE_FUNCTION_KEY env sites: ${ENV_GATES.length}`);
  assert.equal(SECRET_GATES.length, 1, `loom-posture-function-key secret sites: ${SECRET_GATES.length}`);
});

/** [label, url, observabilityConfig, expected verdict] */
const CASES = [
  ['URL set, key signal ABSENT → not emitted (the P0)', URL, {}, false],
  ['URL set, key signal FALSE → not emitted', URL, { postureFunctionKeyEnabled: false }, false],
  ['URL set, key signal TRUE → emitted (positive control)', URL, { postureFunctionKeyEnabled: true }, true],
  ['URL empty, key signal TRUE → not emitted (URL still required)', '', { postureFunctionKeyEnabled: true }, false],
  ['URL empty, key signal absent → not emitted (legacy both-empty)', '', {}, false],
];

for (const [label, url, obs, expected] of CASES) {
  test(label, () => {
    const env = ENV_GATES.map((c) => evaluateExpr(c, scopeOf(url, obs)));
    const secret = SECRET_GATES.map((c) => evaluateExpr(c, scopeOf(url, obs)));
    assert.deepEqual(env, [expected], `env gate ${ENV_GATES[0]} → ${env} for url=${JSON.stringify(url)} obs=${JSON.stringify(obs)}`);
    assert.deepEqual(secret, [expected], `secret gate ${SECRET_GATES[0]} → ${secret} for url=${JSON.stringify(url)} obs=${JSON.stringify(obs)}`);
  });
}
