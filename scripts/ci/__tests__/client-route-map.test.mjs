/**
 * R15-R17 — typed client-route map: generator, type-level guard, CI guard.
 *
 * The item this covers ("typed client-map") has ONE load-bearing property: a
 * caller must not be able to reference a BFF route that does not exist. A map
 * that merely EXISTS satisfies nothing — the repo has been bitten repeatedly by
 * signals that are presence-shaped rather than enforcement-shaped
 * (`csa_loom_guard_signals_presence_not_enforcement`).
 *
 * This file holds the parts that need NO toolchain: the generator, the regex
 * derivation, and the R17 CI guard. The compile-time assertions (R16) live in
 * `apps/fiab-console/lib/__tests__/api-route-typing.test.ts` — see the note by
 * the last test here for why that split is load-bearing rather than tidy.
 *
 * MUTATION-PROVEN (counts in the PR body):
 *   - make ValidateApiPath<S> = S            -> the negative tsc test goes RED
 *   - drop the Extract<> clause              -> the query-suffix test goes RED
 *   - remove stripComments() from the guard  -> the self-documentation test RED
 *   - drop the backtick-overlap skip         -> the template test goes RED
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

  // `\r?\n`, never a bare `\n`. The generated file is committed with LF but
  // git checks it out CRLF on Windows (`core.autocrlf`), so an LF-only needle
  // matched NOTHING: `replace` returned the input unchanged, the file was
  // rewritten byte-identical, and this test then demanded the gate fail at a
  // staleness that had never been introduced. The gate was right; the proof
  // was broken — `--check` normalises line endings before comparing (`norm`),
  // which is exactly why the drift gate itself stayed green on the same tree.
  const mutated = original.replace(/ {2}\| '\/api\/loom\/workspaces'\r?\n/, '');

  // The mutation must be CONFIRMED, not assumed. A mutation-based proof whose
  // mutation silently no-ops is the "gate that measures nothing" shape: every
  // assertion below would still run, against an unmodified file. This line is
  // what makes the decay loud instead of platform-dependent.
  assert.notEqual(mutated, original, 'the staleness mutation did not land — this proof would assert nothing');
  fs.writeFileSync(dts, mutated);

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
  // mkdtempSync, not a constant name under os.tmpdir(): a shared temp root is
  // world-writable, so a fixed path can be pre-created or symlinked by another
  // local user. Enforced by scripts/ci/check-temp-artifact-safety.mjs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-route-map-'));
  const missing = path.join(dir, 'does-not-exist.json');
  assert.throws(
    () => loadRouteMap(missing),
    /generated route map missing/,
    'a missing map must THROW, not silently yield an empty allowlist that passes everything',
  );
});

test('the R17 guard fails closed on an implausibly small map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-route-map-'));
  const tiny = path.join(dir, 'tiny.json');
  fs.writeFileSync(tiny, JSON.stringify({ patterns: ['/api/x'], regexSources: ['^/api/x/?$'] }));
  assert.throws(() => loadRouteMap(tiny), /implausible/);
});


// ── R16 lives in the console's vitest lane — assert it did not silently vanish ─

/**
 * The COMPILE-TIME assertions (R16) are in
 * `apps/fiab-console/lib/__tests__/api-route-typing.test.ts`, not here, because
 * this suite runs in the `guardrails` job — which installs no console
 * dependencies and therefore has no `typescript/bin/tsc`.
 *
 * That is not a cosmetic split. When these tests DID live here, every fixture
 * died with `Cannot find module '…/typescript/bin/tsc'` — and only the NEGATIVE
 * test failed. All five POSITIVE ones PASSED, because they assert
 * `doesNotMatch(/error TS/)` and "Cannot find module" contains no `error TS`.
 * A missing compiler read as "type-checks cleanly". CI reported five green type
 * assertions over zero type-checking.
 *
 * So the coverage moved to a lane with a toolchain — and this test exists so it
 * cannot quietly disappear from there, which would restore the same blind spot
 * with no red anywhere.
 */
test('the R16 compile-time suite still exists and still asserts the negative case', () => {
  const spec = path.join(CONSOLE_ROOT, 'lib', '__tests__', 'api-route-typing.test.ts');
  assert.ok(fs.existsSync(spec), `${spec} is missing — the R16 compile-time coverage has been deleted`);
  const src = fs.readFileSync(spec, 'utf8');
  assert.match(src, /FAILS TO COMPILE/, 'the negative case must still be asserted');
  assert.match(src, /No BFF route matches/, 'it must still assert on the diagnostic text, not merely "some error"');
  assert.match(src, /assertCompilerPresent/, 'it must still fail closed when tsc is absent');
  assert.match(src, /clientFetch/, 'it must exercise clientFetch, not the type alias in isolation');
});
