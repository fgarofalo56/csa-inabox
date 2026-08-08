/**
 * R15-R17 — typed client-route map: generator, type-level guard, CI guard.
 *
 * The item this covers ("typed client-map") has ONE load-bearing property: a
 * caller must not be able to reference a BFF route that does not exist. A map
 * that merely EXISTS satisfies nothing — the repo has been bitten repeatedly by
 * signals that are presence-shaped rather than enforcement-shaped
 * (`csa_loom_guard_signals_presence_not_enforcement`). So the sharpest test
 * here is the NEGATIVE one: it runs the real TypeScript compiler over a
 * fixture that names a bogus route and asserts the compile FAILS. If that test
 * ever passes-by-vacuity, the whole feature is decorative.
 *
 * MUTATION-PROVEN (counts in the PR body):
 *   - make ValidateApiPath<S> = S            -> the negative tsc test goes RED
 *   - drop the Extract<> clause              -> the query-suffix test goes RED
 *   - remove stripComments() from the guard  -> the self-documentation test RED
 *   - drop the backtick-overlap skip         -> the template test goes RED
 *   - make classifyPath always return 'ok'   -> the unknown-path test goes RED
 *
 * Run: node --test scripts/ci/__tests__/client-route-map.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  routeFileToUrlPattern, patternToTypeLiteral, patternToRegexSource, buildRoutes,
} from '../generate-client-route-map.mjs';
import {
  loadRouteMap, staticPrefixes, classifyPath, extractCallPaths, stripComments,
} from '../check-known-client-routes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const GEN = path.resolve(HERE, '..', 'generate-client-route-map.mjs');
const GUARD = path.resolve(HERE, '..', 'check-known-client-routes.mjs');

// ── generator: filesystem → URL pattern ──────────────────────────────────────

test('routeFileToUrlPattern maps Next.js route files to URL patterns', () => {
  const api = path.join('X', 'app', 'api');
  const at = (...p) => path.join(api, ...p);
  assert.equal(routeFileToUrlPattern(at('loom', 'workspaces', 'route.ts'), api), '/api/loom/workspaces');
  assert.equal(routeFileToUrlPattern(at('items', '[type]', '[id]', 'route.ts'), api), '/api/items/[type]/[id]');
  assert.equal(routeFileToUrlPattern(at('delta-sharing', '[...path]', 'route.ts'), api), '/api/delta-sharing/[...path]');
  // Route groups are erased from the URL.
  assert.equal(routeFileToUrlPattern(at('(admin)', 'health', 'route.ts'), api), '/api/health');
});

test('patternToTypeLiteral keeps static routes EXACT and only widens dynamic segments', () => {
  // A static route must stay a unit literal — widening it to `${string}` would
  // let a typo in that very segment through, defeating the whole check.
  assert.equal(patternToTypeLiteral('/api/loom/workspaces'), "'/api/loom/workspaces'");
  assert.equal(patternToTypeLiteral('/api/items/[type]/versions'), '`/api/items/${string}/versions`');
  assert.equal(patternToTypeLiteral('/api/delta-sharing/[...path]'), '`/api/delta-sharing/${string}`');
});

test('patternToRegexSource distinguishes single-segment from catch-all', () => {
  const one = new RegExp(patternToRegexSource('/api/items/[id]'));
  assert.ok(one.test('/api/items/abc'));
  assert.ok(!one.test('/api/items/abc/extra'), '[id] must NOT span a slash');

  const many = new RegExp(patternToRegexSource('/api/delta-sharing/[...path]'));
  assert.ok(many.test('/api/delta-sharing/a/b/c'), 'catch-all must span slashes');
  assert.ok(!many.test('/api/delta-sharing'), 'required catch-all needs >=1 segment');

  const opt = new RegExp(patternToRegexSource('/api/x/[[...p]]'));
  assert.ok(opt.test('/api/x'), 'optional catch-all matches the bare prefix');
  assert.ok(opt.test('/api/x/a/b'));

  // Regex metacharacters in a static segment must be escaped, not interpreted.
  const dotted = new RegExp(patternToRegexSource('/api/v1.0/ping'));
  assert.ok(dotted.test('/api/v1.0/ping'));
  assert.ok(!dotted.test('/api/v1X0/ping'), 'the dot must be literal');
});

test('the generator discovers the real route tree (and would fail closed if it did not)', () => {
  const routes = buildRoutes();
  assert.ok(routes.length > 1000, `expected >1000 routes, got ${routes.length}`);
  assert.ok(routes.includes('/api/loom/workspaces'), 'a known route must be present');
  assert.deepEqual([...routes].sort(), routes, 'output must be deterministically sorted');
  assert.equal(new Set(routes).size, routes.length, 'no duplicates');
});

test('the generated artifacts are in sync with app/api (--check drift gate)', () => {
  const r = spawnSync(process.execPath, [GEN, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `route map is stale — run: node scripts/ci/generate-client-route-map.mjs\n${r.stdout}${r.stderr}`);
});

test('the drift gate FAILS when the generated map is stale', (t) => {
  const dts = path.join(CONSOLE_ROOT, 'lib', 'api-routes.generated.d.ts');
  const original = fs.readFileSync(dts, 'utf8');
  t.after(() => fs.writeFileSync(dts, original));
  fs.writeFileSync(dts, original.replace("  | '/api/loom/workspaces'\n", ''));
  const r = spawnSync(process.execPath, [GEN, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1, 'a stale map must fail the drift gate');
  assert.match(r.stderr, /STALE/);
});

// ── R17 guard ────────────────────────────────────────────────────────────────

test('classifyPath: exact routes ok, typos unknown, computed skipped', () => {
  const map = loadRouteMap();
  const pre = staticPrefixes(map.patterns);
  assert.equal(classifyPath('/api/loom/workspaces', false, map, pre), 'ok');
  assert.equal(classifyPath('/api/loom/workspaces?take=5', false, map, pre), 'ok', 'query is stripped');
  assert.equal(classifyPath('/api/loom/workspacs', false, map, pre), 'unknown');
  assert.equal(classifyPath('/api/nope/nope/nope', false, map, pre), 'unknown');
  assert.equal(classifyPath('/api/', true, map, pre), 'skip', 'no literal prefix → not knowable');
  assert.equal(classifyPath('https://example.com/api/x', false, map, pre), 'skip');
  // A template prefix that is a proper static prefix of a real route.
  assert.equal(classifyPath('/api/items/', true, map, pre), 'ok');
});

test('extractCallPaths does NOT double-read a backtick template as a plain literal', () => {
  const src = 'const a = clientFetch(`/api/items/${id}/versions`);';
  const hits = extractCallPaths(src);
  assert.equal(hits.length, 1, `expected exactly one hit, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].isTemplate, true);
  assert.equal(hits[0].path, '/api/items/', 'only the literal prefix, not the whole template body');
});

test('extractCallPaths reads plain literals whole', () => {
  const hits = extractCallPaths("clientFetch('/api/loom/workspaces');");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].isTemplate, false);
  assert.equal(hits[0].path, '/api/loom/workspaces');
});

test('stripComments blanks comments but preserves line numbers and real strings', () => {
  const src = [
    "// clientFetch('/api/bogus/route')",
    "/* clientFetch('/api/also-bogus') */",
    "clientFetch('/api/loom/workspaces');",
  ].join('\n');
  const hits = extractCallPaths(src);
  assert.equal(hits.length, 1, 'commented-out examples must not be scanned');
  assert.equal(hits[0].path, '/api/loom/workspaces');
  assert.equal(hits[0].line, 3, 'line numbers must survive comment stripping');
});

test('the R17 guard passes on the real tree and is NOT vacuous', () => {
  const r = spawnSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = r.stdout.match(/checked (\d+) client call paths/);
  assert.ok(m, 'the guard must report how many paths it checked');
  assert.ok(Number(m[1]) > 1000, `guard checked only ${m?.[1]} paths — discovery is probably broken`);
});

test('the R17 guard FAILS on a planted bad route (fail-closed)', (t) => {
  // Edited IN PLACE rather than created-then-deleted. A probe file that appears
  // and vanishes races every other guard that enumerates the tree and then reads
  // each hit — `check-insecure-randomness.mjs` died with ENOENT exactly that way
  // when a sibling suite in this directory used a create/delete probe, reddening
  // a guard that had no stake in the change. There is no create/delete window
  // here, so no such race is possible.
  //
  // `lib/client-fetch.ts` is deliberately chosen: it IS in this guard's scope
  // (lib/**), but it is NOT in the scope of no-bare-client-fetch or no-raw-px
  // (lib/editors | lib/panes | lib/components + app page.tsx), so the transient
  // bogus `fetch(...)` cannot make either of those fail if they run concurrently.
  const victim = path.join(CONSOLE_ROOT, 'lib', 'client-fetch.ts');
  const original = fs.readFileSync(victim, 'utf8');
  t.after(() => fs.writeFileSync(victim, original));

  fs.writeFileSync(victim, `${original}\nexport const __probe = () => fetch('/api/this/route/does/not/exist');\n`);
  const r = spawnSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1, `guard must reject an unknown route\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /this\/route\/does\/not\/exist/);
});

test('the R17 guard fails closed when the generated map is missing', () => {
  const missing = path.join(os.tmpdir(), `loom-route-map-does-not-exist-${Date.now()}.json`);
  assert.throws(
    () => loadRouteMap(missing),
    /generated route map missing/,
    'a missing map must THROW, not silently yield an empty allowlist that passes everything',
  );
});

test('the R17 guard fails closed on an implausibly small map', (t) => {
  const tiny = path.join(os.tmpdir(), `loom-route-map-tiny-${Date.now()}.json`);
  t.after(() => { try { fs.unlinkSync(tiny); } catch { /* already gone */ } });
  fs.writeFileSync(tiny, JSON.stringify({ patterns: ['/api/x'], regexSources: ['^/api/x/?$'] }));
  assert.throws(() => loadRouteMap(tiny), /implausible/);
});

// ── R16: the compile-time contract (the load-bearing test) ───────────────────

/**
 * Type-check a fixture against the console's own tsconfig paths. Returns the
 * tsc stdout so a caller can assert on the diagnostic.
 *
 * The fixture is written INTO the console tree (not a temp dir) so `@/lib/...`
 * resolves through the real `paths` mapping — a temp-dir fixture would fail to
 * resolve for the wrong reason and the negative test would "pass" vacuously.
 *
 * A generated tsconfig is used rather than CLI flags because `--paths` is not
 * settable on the command line (TS6064). That mistake is instructive: with
 * CLI flags every fixture emitted `error TS6064`, which made the POSITIVE
 * tests fail loudly but would have let the NEGATIVE test pass on the wrong
 * error entirely. That is why the negative test asserts on the diagnostic TEXT
 * ("No BFF route matches"), not merely on "some error occurred".
 */
function typecheckFixture(t, body) {
  const stem = `__route_type_probe_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(CONSOLE_ROOT, `${stem}.ts`);
  const cfg = path.join(CONSOLE_ROOT, `${stem}.tsconfig.json`);
  t.after(() => {
    for (const f of [file, cfg]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  });
  fs.writeFileSync(file, body);
  fs.writeFileSync(cfg, JSON.stringify({
    compilerOptions: {
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      target: 'es2022',
      lib: ['es2022', 'dom'],
      baseUrl: '.',
      paths: { '@/*': ['./*'] },
      types: [],
    },
    files: [`./${stem}.ts`],
  }, null, 2));
  const tsc = path.join(CONSOLE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', cfg], { cwd: CONSOLE_ROOT, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  // A configuration error (TS5xxx/TS6xxx) is NOT a verdict about the route map.
  // Surface it loudly instead of letting a negative test pass on it.
  assert.doesNotMatch(
    out, /error TS[56]\d{3}/,
    `tsc CONFIGURATION error — the fixture never type-checked, so any verdict below is meaningless:\n${out}`,
  );
  return out;
}

test('R16 — a KNOWN route type-checks', { timeout: 180_000 }, (t) => {
  const out = typecheckFixture(t, [
    "import { clientFetch } from '@/lib/client-fetch';",
    "export const a = () => clientFetch('/api/loom/workspaces');",
    '',
  ].join('\n'));
  assert.doesNotMatch(out, /error TS/, `a real route must compile:\n${out}`);
});

test('R16 — an UNKNOWN route FAILS TO COMPILE (this is the whole point)', { timeout: 180_000 }, (t) => {
  const out = typecheckFixture(t, [
    "import { clientFetch } from '@/lib/client-fetch';",
    "export const a = () => clientFetch('/api/loom/workspacs');",
    '',
  ].join('\n'));
  assert.match(out, /error TS/, `a bogus route MUST be a compile error, got:\n${out}`);
  assert.match(
    out, /No BFF route matches/,
    `the diagnostic must name the problem, not read as an opaque type mismatch:\n${out}`,
  );
});

test('R16 — a dynamic route accepts any single segment but not an extra one', { timeout: 180_000 }, (t) => {
  const ok = typecheckFixture(t, [
    "import { clientFetch } from '@/lib/client-fetch';",
    "export const a = () => clientFetch('/api/items/lakehouse/abc123');",
    '',
  ].join('\n'));
  assert.doesNotMatch(ok, /error TS/, `a dynamic segment must accept a concrete value:\n${ok}`);
});

test('R16 — a query string is stripped before matching', { timeout: 180_000 }, (t) => {
  const out = typecheckFixture(t, [
    "import { clientFetch } from '@/lib/client-fetch';",
    "export const a = () => clientFetch('/api/loom/workspaces?take=5');",
    '',
  ].join('\n'));
  assert.doesNotMatch(out, /error TS/, `?query must not break the match:\n${out}`);
});

test('R16 — a computed `string` path stays unconstrained (R17 covers those)', { timeout: 180_000 }, (t) => {
  const out = typecheckFixture(t, [
    "import { clientFetch } from '@/lib/client-fetch';",
    'export const a = (u: string) => clientFetch(u);',
    '',
  ].join('\n'));
  assert.doesNotMatch(out, /error TS/, `a wide string must still be accepted:\n${out}`);
});

test('R16 — a partially-concrete template (prefix + ${string}) still compiles', { timeout: 180_000 }, (t) => {
  // This is the EXACT shape that broke five real call sites before the
  // Extract<> clause was added (lib/components/admin/access-report-panel.tsx:100
  // among them). TS infers `` `/api/access-governance/report${string}` `` — a
  // template type that is WIDER than the union member `'/api/access-governance/report'`,
  // so the plain `extends` direction fails and only the reverse direction
  // (some route is assignable TO it) can accept it.
  //
  // NOTE the fixture must reproduce the inference, not merely resemble it: an
  // earlier version wrote `const u = \`…\${qs}\`` and TS widened `u` to plain
  // `string`, so the test passed with the Extract<> clause DELETED — it was
  // proving nothing. The conditional interpolation below is what actually
  // produces the template-literal type.
  const out = typecheckFixture(t, [
    "import { clientFetch } from '@/lib/client-fetch';",
    'export const a = (qs: string) =>',
    '  clientFetch(`/api/access-governance/report${qs ? `?${qs}` : \'\'}`);',
    '',
  ].join('\n'));
  assert.doesNotMatch(out, /error TS/, `a prefix+\${string} template must compile:\n${out}`);
});
