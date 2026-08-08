#!/usr/bin/env node
/**
 * Tests for scripts/ci/check-roll-atomicity.mjs.
 *
 * Every branch is driven in BOTH directions, with fixtures rather than the real
 * bicep. A guard suite that only proves "the current tree passes" is the shape
 * this program keeps finding: it would stay green after a refactor blinded the
 * parser, because a parser that resolves nothing has nothing to complain about.
 *
 * The load-bearing assertions:
 *   - check B FAILS when a third app appears on a targeted repository (the
 *     anti-split ratchet — a partial roll marks the reconcile's key UNKNOWN and
 *     freezes estate-wide config);
 *   - check D FAILS below the measured floor (a blind parser must not pass
 *     vacuously);
 *   - `escalate` fires on an UNRESOLVED app whose IMAGE mentions a targeted
 *     repository, and stays quiet when only prose does;
 *   - `expandExpr` keeps `${…}` when a symbol resolves only to another unknown,
 *     because turning a marked unknown into text that reads resolved is the
 *     exact R7 shape the guard exists to prevent.
 *
 * Run: node --test scripts/ci/__tests__/check-roll-atomicity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  MIN_RESOLVED,
  declaresContainerApp,
  parseModuleCalls,
  paramsBlock,
  literalParams,
  moduleSymbols,
  containerAppBlocks,
  expandExpr,
  classifyImage,
  resolveCall,
  parseInlineApps,
  decide,
} from '../check-roll-atomicity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const GUARD = join(HERE, '..', 'check-roll-atomicity.mjs');

/* ── fixtures ────────────────────────────────────────────────────────────── */

/** The real shape that broke an earlier revision: the image arrives NESTED. */
const ICEBERG_CALL = `module icebergCatalog '../data-plane/iceberg-catalog-aca.bicep' = {
  name: 'iceberg-catalog-deploy'
  params: {
    location: location
    catalogConfig: {
      name: 'iceberg-catalog'
      image: '\${registry.outputs.acrLoginServer}/loom-unity:\${appImageTags.unity}'
    }
  }
}`;

const ICEBERG_MODULE = `param location string
param catalogConfig object

var image = catalogConfig.image
var appName = catalogConfig.name

resource catalogApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    template: {
      containers: [
        {
          name: 'catalog'
          image: image
        }
      ]
    }
  }
}
`;

/** app-deployments.bicep's shape: everything comes from a loop variable. */
const LOOP_MODULE = `// mirrors the loom-unity and loom-trino apps elsewhere in the estate
param apps array
param acrLoginServer string

resource caeApps 'Microsoft.App/containerApps@2024-03-01' = [for app in apps: {
  name: app.name
  properties: {
    template: {
      containers: [
        {
          image: '\${acrLoginServer}/\${app.image}'
        }
      ]
    }
  }
}]
`;

const call = (overrides = {}) => ({ symbol: 'm', path: './m.bicep', line: 1, body: '', ...overrides });

const TARGETS = [
  { app: 'a1', repo: 'r1', tagKey: 'k1', envVar: 'LOOM_K1_TAG', bicep: 'x.bicep', why: 'fixture' },
];
const TAGS = [{ key: 'k1', repo: 'r1', envVar: 'LOOM_K1_TAG' }];
const base = (over = {}) => ({
  calls: [], moduleTexts: {}, inlineApps: [], targets: TARGETS, imageTags: TAGS, minResolved: 0, ...over,
});

/* ── the floor ───────────────────────────────────────────────────────────── */

test('MIN_RESOLVED is a positive integer', () => {
  assert.ok(Number.isInteger(MIN_RESOLVED) && MIN_RESOLVED > 0, String(MIN_RESOLVED));
});

/* ── declaresContainerApp ────────────────────────────────────────────────── */

test('declaresContainerApp sees a container APP and not a container app JOB', () => {
  assert.equal(declaresContainerApp("resource x 'Microsoft.App/containerApps@2024-03-01' = {"), true);
  assert.equal(declaresContainerApp("resource x 'Microsoft.App/jobs@2024-03-01' = {"), false);
  assert.equal(declaresContainerApp('param foo string'), false);
});

/* ── parseModuleCalls ────────────────────────────────────────────────────── */

test('parseModuleCalls returns symbol, path, 1-based line and body', () => {
  const text = ['var x = 1', "module alpha './a.bicep' = {", '  params: {', '    k: 1', '  }', '}', '', "module beta './b.bicep' = {", '}'].join('\n');
  const calls = parseModuleCalls(text);
  assert.deepEqual(calls.map((c) => c.symbol), ['alpha', 'beta']);
  assert.deepEqual(calls.map((c) => c.path), ['./a.bicep', './b.bicep']);
  assert.equal(calls[0].line, 2);
  assert.match(calls[0].body, /k: 1/);
  assert.ok(!calls[0].body.includes('beta'), 'a call body must stop at its own closing brace');
});

test('parseModuleCalls closes on a COLUMN-0 brace, not an indented one', () => {
  const text = ["module alpha './a.bicep' = {", '  params: {', '    obj: {', '    }', '  }', '}'].join('\n');
  assert.equal(parseModuleCalls(text)[0].body.split('\n').length, 6);
});

test('parseModuleCalls stops at the next declaration when a brace is missing', () => {
  const text = ["module alpha './a.bicep' = {", '  params: {}', "module beta './b.bicep' = {", '}'].join('\n');
  const calls = parseModuleCalls(text);
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].body.includes('beta'));
});

test('parseModuleCalls finds nothing in a file with no module calls', () => {
  assert.deepEqual(parseModuleCalls('param a string\nvar b = 1\n'), []);
});

/* ── paramsBlock ─────────────────────────────────────────────────────────── */

test('paramsBlock extracts the params sub-block and drops its braces', () => {
  const b = paramsBlock(ICEBERG_CALL);
  assert.match(b, /catalogConfig: \{/);
  assert.ok(!b.includes('params:'), 'the params: line itself is not part of the block');
  assert.ok(!b.includes("name: 'iceberg-catalog-deploy'"), 'the module deployment name is outside params');
});

test('paramsBlock returns empty string when the call takes no params', () => {
  assert.equal(paramsBlock("module m './m.bicep' = {\n  name: 'x'\n}"), '');
});

/* ── literalParams ───────────────────────────────────────────────────────── */

test('literalParams keys nested literals by DOTTED path', () => {
  const p = literalParams(paramsBlock(ICEBERG_CALL));
  assert.equal(p.get('catalogConfig.name'), 'iceberg-catalog');
  assert.match(p.get('catalogConfig.image'), /^\$\{registry\.outputs\.acrLoginServer\}\/loom-unity:/);
});

test('a NESTED name cannot masquerade as the module argument `name`', () => {
  // The anti-masquerade property. If nested keys were flattened, every module
  // with a `someConfig: { name: … }` would resolve its app to the wrong string.
  const p = literalParams(paramsBlock(ICEBERG_CALL));
  assert.equal(p.has('name'), false);
});

test('literalParams keeps ${…} interpolation — that IS the repository fact', () => {
  const p = literalParams("  image: '${acr}/loom-unity:${t}'");
  assert.equal(p.get('image'), '${acr}/loom-unity:${t}');
});

test('literalParams takes the FIRST value and ignores comments and blanks', () => {
  const p = literalParams(["  // name: 'commented'", '', "  name: 'first'", "  name: 'second'"].join('\n'));
  assert.equal(p.get('name'), 'first');
  assert.equal(p.size, 1);
});

test('literalParams does not descend past maxDepth', () => {
  const t = ['  outer: {', "    inner: 'v'", '  }'].join('\n');
  assert.equal(literalParams(t, 1).get('outer.inner'), 'v');
  assert.equal(literalParams(t, 0).has('outer.inner'), false);
});

test('literalParams of an empty block is empty, not a throw', () => {
  assert.equal(literalParams('').size, 0);
  assert.equal(literalParams('\n\n').size, 0);
});

/* ── moduleSymbols ───────────────────────────────────────────────────────── */

test('moduleSymbols records param defaults and RAW var right-hand sides', () => {
  const s = moduleSymbols(ICEBERG_MODULE);
  assert.equal(s.get('image'), 'catalogConfig.image');
  assert.equal(s.get('appName'), 'catalogConfig.name');
});

test('moduleSymbols keeps a var that is an expression, not only a quoted literal', () => {
  // The indirection is the norm: `var ref = '${server}/${img}'` is a step on the
  // way to the repository. Recording only quoted literals read it as a dead end.
  const s = moduleSymbols("param tag string = 'v0.1'\nvar ref = '${server}/loom-trino:${tag}'\n");
  assert.equal(s.get('tag'), 'v0.1');
  assert.equal(s.get('ref'), "'${server}/loom-trino:${tag}'");
});

test('moduleSymbols ignores comments and keeps the first binding', () => {
  const s = moduleSymbols(["// var image = 'commented'", "var image = 'first'", "var image = 'second'"].join('\n'));
  assert.equal(s.get('image'), "'first'");
});

/* ── containerAppBlocks ──────────────────────────────────────────────────── */

test('containerAppBlocks reads the resource name at its own indent and every image', () => {
  const b = containerAppBlocks(ICEBERG_MODULE);
  assert.equal(b.length, 1);
  assert.equal(b[0].symbol, 'catalogApp');
  assert.equal(b[0].nameExpr, 'appName');
  assert.deepEqual(b[0].imageExprs, ['image']);
});

test('a container-level `name:` does not steal the resource name', () => {
  // `name: 'catalog'` sits inside containers[]; only the 2-space `name:` is the app.
  assert.notEqual(containerAppBlocks(ICEBERG_MODULE)[0].nameExpr, "'catalog'");
});

test('containerAppBlocks parses a `= [for … ]` loop resource too', () => {
  const b = containerAppBlocks(LOOP_MODULE);
  assert.equal(b.length, 1);
  assert.equal(b[0].nameExpr, 'app.name');
  assert.deepEqual(b[0].imageExprs, ['\'${acrLoginServer}/${app.image}\'']);
});

test('containerAppBlocks finds nothing in a module that declares no container app', () => {
  assert.deepEqual(containerAppBlocks("resource s 'Microsoft.Storage/storageAccounts@2023-01-01' = {\n  name: 'x'\n}"), []);
});

/* ── expandExpr ──────────────────────────────────────────────────────────── */

test('expandExpr returns null for null/undefined rather than the string "null"', () => {
  assert.equal(expandExpr(null, new Map()), null);
  assert.equal(expandExpr(undefined, new Map()), null);
});

test('expandExpr follows a dotted chain to the literal', () => {
  const t = new Map([['appName', 'catalogConfig.name'], ['catalogConfig.name', 'iceberg-catalog']]);
  assert.equal(expandExpr('appName', t), 'iceberg-catalog');
});

test('expandExpr strips quotes', () => {
  assert.equal(expandExpr("'loom-trino'", new Map()), 'loom-trino');
});

test('expandExpr uses the module coalesce default only when the caller omitted the key', () => {
  const expr = "string(cfg.?s3ProxyImage ?? 's3proxy:3.3.0')";
  assert.equal(expandExpr(expr, new Map()), 's3proxy:3.3.0');
  assert.equal(expandExpr(expr, new Map([['cfg.s3ProxyImage', 'mine:1.0']])), 'mine:1.0');
});

test('expandExpr substitutes ${ident} recursively, because one symbol chains into the next', () => {
  const t = new Map([
    ['ref', "'${server}/${img}'"],
    ['server', "'acr.azurecr.io'"],
    ['img', "'loom-trino:v9'"],
  ]);
  assert.equal(expandExpr('ref', t), 'acr.azurecr.io/loom-trino:v9');
});

test('expandExpr KEEPS ${…} when the symbol resolves only to another unknown (R7)', () => {
  // s3-gateway's exact shape. Substituting would turn a marked unknown into text
  // that reads like a resolved value, and classifyImage would then mis-read it.
  const t = new Map([
    ['acrLoginServer', 's3GatewayConfig.acrLoginServer'],
    ['s3ProxyImage', "string(s3GatewayConfig.?s3ProxyImage ?? 's3proxy:3.3.0')"],
  ]);
  const got = expandExpr("'${acrLoginServer}/${s3ProxyImage}'", t);
  assert.equal(got, '${acrLoginServer}/s3proxy:3.3.0');
  assert.ok(!got.includes('s3GatewayConfig.acrLoginServer'), 'an unknown must not be rendered as resolved text');
  assert.equal(classifyImage(got).repo, 's3proxy', 'and the ${…}/repo: shape still classifies');
});

test('expandExpr leaves an identifier it has never heard of exactly as it found it', () => {
  assert.equal(expandExpr('${app.image}', new Map()), '${app.image}');
  assert.equal(expandExpr('app.name', new Map()), 'app.name');
});

test('expandExpr terminates on a self-referential symbol instead of hanging CI', () => {
  const t = new Map([['a', 'b'], ['b', 'a']]);
  assert.ok(['a', 'b'].includes(expandExpr('a', t)));
});

/* ── classifyImage ───────────────────────────────────────────────────────── */

test('classifyImage reads the repository out of an ACR reference', () => {
  assert.deepEqual(classifyImage('${acr}/loom-unity:36b765e4'), { kind: 'acr', repo: 'loom-unity' });
});

test('classifyImage calls an upstream registry EXTERNAL, which is an answer not a failure', () => {
  const c = classifyImage('mcr.microsoft.com/cbl-mariner/busybox:2.0@sha256:abc');
  assert.equal(c.kind, 'external');
  assert.match(c.repo, /^mcr\.microsoft\.com\//);
});

test('classifyImage refuses to guess a repository that is still interpolated', () => {
  assert.deepEqual(classifyImage('${acr}/${app.image}'), { kind: 'unresolved', repo: null });
});

test('classifyImage treats empty and null as unresolved, never as absent', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(classifyImage(v).kind, 'unresolved', String(v));
});

/* ── resolveCall ─────────────────────────────────────────────────────────── */

test('resolveCall resolves the iceberg shape: nested caller param → app name AND repo', () => {
  const r = resolveCall(parseModuleCalls(ICEBERG_CALL)[0], ICEBERG_MODULE);
  assert.equal(r.length, 1);
  assert.equal(r[0].app, 'iceberg-catalog');
  assert.deepEqual(r[0].repos, ['loom-unity']);
  assert.equal(r[0].unresolvedImages, 0);
  assert.equal(r[0].why, null);
});

test("resolveCall lets the CALLER's param beat the module default", () => {
  const mod = "param appName string = 'module-default'\n"
    + "resource a 'Microsoft.App/containerApps@2024-03-01' = {\n"
    + '  name: appName\n'
    + "  image: '${acr}/loom-trino:v1'\n"
    + '}\n';
  const c = parseModuleCalls("module m './m.bicep' = {\n  params: {\n    appName: 'caller-wins'\n  }\n}")[0];
  assert.equal(resolveCall(c, mod)[0].app, 'caller-wins');
});

test('resolveCall reports the loop module as unresolved and says WHY, both parts', () => {
  const c = parseModuleCalls("module m './m.bicep' = {\n  params: {\n    apps: apps\n  }\n}")[0];
  const r = resolveCall(c, LOOP_MODULE)[0];
  assert.equal(r.app, null);
  assert.equal(r.unresolvedImages, 1);
  assert.match(r.why, /neither the app name nor every image repository/);
});

test('resolveCall counts an external image as external, not as an unresolved one', () => {
  const mod = "resource a 'Microsoft.App/containerApps@2024-03-01' = {\n"
    + "  name: 'dab-runtime'\n"
    + "  image: 'mcr.microsoft.com/azure-databases/data-api-builder:1.0'\n"
    + '}\n';
  const r = resolveCall(call(), mod)[0];
  assert.equal(r.app, 'dab-runtime');
  assert.equal(r.unresolvedImages, 0);
  assert.deepEqual(r.repos, []);
  assert.equal(r.external.length, 1);
});

/* ── parseInlineApps ─────────────────────────────────────────────────────── */

test('parseInlineApps pairs an image with the literal name above it', () => {
  const text = ['  apps: [', '    {', "      name: 'loom-console'", "      image: 'loom-console:${appImageTags.console}'", '    }', '  ]'].join('\n');
  assert.deepEqual(parseInlineApps(text), [{ app: 'loom-console', repo: 'loom-console', line: 4 }]);
});

test('parseInlineApps returns app:null rather than pairing by guesswork', () => {
  const text = ['    {', '      name: someVariable', "      image: 'loom-unity:${t}'", '    }'].join('\n');
  const got = parseInlineApps(text);
  assert.equal(got[0].app, null);
  assert.equal(got[0].repo, 'loom-unity');
});

test('parseInlineApps skips blank lines and comments when looking upward', () => {
  const text = ["      name: 'loom-trino'", '', '      // the federated SQL engine', "      image: 'loom-trino:v1'"].join('\n');
  assert.equal(parseInlineApps(text)[0].app, 'loom-trino');
});

/* ── decide: A — the registry matches bicep ──────────────────────────────── */

test('A — a registry target bicep does not deploy FAILS', () => {
  const { problems } = decide(base());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /targets container app 'a1', which this scan did not find/);
});

test('A — a registry target deployed from a DIFFERENT repository FAILS', () => {
  const { problems } = decide(base({ inlineApps: [{ app: 'a1', repo: 'somewhere-else', line: 7 }] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /runs repository 'r1', but .*deploys it from 'somewhere-else'/);
});

test('A — the matching case produces no problem at all', () => {
  const { problems, resolved } = decide(base({ inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }] }));
  assert.deepEqual(problems, []);
  assert.equal(resolved[0].source, 'inline');
});

/* ── decide: B — the anti-split ratchet ──────────────────────────────────── */

test('B — a THIRD app on a targeted repository FAILS and names the fix', () => {
  const { problems } = decide(base({
    inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }, { app: 'a2', repo: 'r1', line: 9 }],
  }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'a2' is NOT in the registry/);
  assert.match(problems[0], /freezes the estate-wide config reconcile/);
  assert.match(problems[0], /ROLL_TARGETS/);
});

test('B — an app on an UNTARGETED repository is none of the ratchet\'s business', () => {
  const { problems } = decide(base({
    inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }, { app: 'a2', repo: 'unrelated', line: 9 }],
  }));
  assert.deepEqual(problems, []);
});

test('B — the ratchet covers MODULE-deployed apps, not only inline ones', () => {
  const c = parseModuleCalls(ICEBERG_CALL)[0];
  const targets = [{ app: 'loom-unity', repo: 'loom-unity', tagKey: 'unity', envVar: 'LOOM_UNITY_TAG' }];
  const { problems } = decide(base({
    calls: [c],
    moduleTexts: { '../data-plane/iceberg-catalog-aca.bicep': ICEBERG_MODULE },
    inlineApps: [{ app: 'loom-unity', repo: 'loom-unity', line: 3 }],
    targets,
    imageTags: [{ key: 'unity', repo: 'loom-unity', envVar: 'LOOM_UNITY_TAG' }],
  }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'iceberg-catalog' is NOT in the registry/);
});

/* ── decide: C — the registry agrees with the reconcile ──────────────────── */

test('C — a targeted repository with no APP_IMAGE_TAGS entry FAILS', () => {
  const { problems } = decide(base({ inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }], imageTags: [] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no entry in APP_IMAGE_TAGS/);
});

test('C — a disagreeing key or env var FAILS, one problem each', () => {
  const { problems } = decide(base({
    inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }],
    imageTags: [{ key: 'other', repo: 'r1', envVar: 'LOOM_OTHER_TAG' }],
  }));
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /claims appImageTags key 'k1'/);
  assert.match(problems.join('\n'), /claims env var 'LOOM_K1_TAG'/);
});

/* ── decide: D — the parser must be working ──────────────────────────────── */

test('D — resolving fewer apps than the floor FAILS, so a blind parser cannot pass vacuously', () => {
  const { problems } = decide(base({ inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }], minResolved: 5 }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /below the measured floor of 5/);
});

test('D — meeting the floor exactly is not a failure', () => {
  const { problems } = decide(base({ inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }], minResolved: 1 }));
  assert.deepEqual(problems, []);
});

/* ── decide: escalate — UNKNOWN is never reported as absent ──────────────── */

test('escalate — an unresolved app whose IMAGE mentions a targeted repo FAILS', () => {
  const mod = '// this module also sits beside r1 in the estate\n'
    + "resource loopApp 'Microsoft.App/containerApps@2024-03-01' = [for app in apps: {\n"
    + '  name: app.name\n'
    + "  image: '${acrLoginServer}/r1:${app.tag}'\n"
    + '}]\n';
  const { problems, unresolved } = decide(base({
    calls: [call()], moduleTexts: { './m.bicep': mod }, inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }],
  }));
  assert.equal(unresolved.length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /an unparsed app is UNKNOWN, not absent/);
});

test('escalate — PROSE mentioning the repo is not an image expression, so it stays quiet', () => {
  // The narrowing that fixed a false positive on loom-maps-app.bicep, whose
  // comment merely lists sibling image names.
  const mod = '// sibling images: r1, r2 — listed here for the reader only\n'
    + "resource loopApp 'Microsoft.App/containerApps@2024-03-01' = [for app in apps: {\n"
    + '  name: app.name\n'
    + "  image: '${acrLoginServer}/${app.image}'\n"
    + '}]\n';
  const { problems, unresolved } = decide(base({
    calls: [call()], moduleTexts: { './m.bicep': mod }, inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }],
  }));
  assert.equal(unresolved.length, 1, 'still REPORTED as unresolved');
  assert.deepEqual(problems, [], 'but not escalated on prose alone');
});

test('escalate — an inline app on a targeted repo with no literal name FAILS', () => {
  const { problems } = decide(base({
    inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }, { app: null, repo: 'r1', line: 9 }],
  }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /UNKNOWN, not absent/);
});

/* ── decide: module bookkeeping ──────────────────────────────────────────── */

test('a module call whose file cannot be read FAILS — it is not something to skip', () => {
  const { problems } = decide(base({ calls: [call({ path: './gone.bicep' })], moduleTexts: {} }));
  assert.match(problems.join('\n'), /calls '\.\/gone\.bicep', which does not exist/);
});

test('a module that deploys no container app is SKIPPED and counted, not treated as a problem', () => {
  const { problems, skipped } = decide(base({
    calls: [call()],
    moduleTexts: { './m.bicep': "resource s 'Microsoft.Storage/storageAccounts@2023-01-01' = {\n  name: 'x'\n}" },
    inlineApps: [{ app: 'a1', repo: 'r1', line: 7 }],
  }));
  assert.equal(skipped, 1);
  assert.deepEqual(problems, []);
});

/* ── the guard against the REAL tree ─────────────────────────────────────── */

test('the guard passes on the real bicep and resolves at least the floor', () => {
  // A unit suite over fixtures proves the logic; this proves the logic still
  // matches the repository. Both are needed — fixtures alone would stay green
  // through a bicep restructure that blinded the scan.
  const r = spawnSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `guard failed:\n${r.stdout}\n${r.stderr}`);
  const m = r.stdout.match(/(\d+) container app\(s\) resolved/);
  assert.ok(m, `expected a resolved count in:\n${r.stdout}`);
  assert.ok(
    Number(m[1]) >= MIN_RESOLVED,
    `resolved ${m[1]} but MIN_RESOLVED is ${MIN_RESOLVED}`,
  );
});
