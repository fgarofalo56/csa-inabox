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
 *   - `--check` never reports STALE          -> the drift-gate test goes RED
 *   - `--check` stops watching only the .d.ts -> the drift-gate test goes RED
 *   - a SINGLE violation stops failing       -> the planted-route test RED
 *   - classifyPath fails open on EITHER of its two `unknown` returns -> RED
 *     (the template-branch one at :115 was NOT covered before; mutating it
 *      alone left this suite at RC=0, pass=15, fail=0)
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
const CI_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const GEN = path.resolve(HERE, '..', 'generate-client-route-map.mjs');
const GUARD = path.resolve(HERE, '..', 'check-known-client-routes.mjs');

// ── fail-closed proofs run against a FIXTURE, never against the tracked tree ─

/**
 * Is `target` inside the repo tree?
 *
 * `path.relative()`, not `startsWith(REPO_ROOT + path.sep)`: a prefix test is
 * case-SENSITIVE and NTFS is not, so a lower-cased in-tree path slips straight
 * through one. Duplicated (small, pure) in the two sibling suites that write
 * mutant copies rather than shared through a new module, because a non-suite
 * `.mjs` in this directory has its own conventions to satisfy.
 */
function insideRepo(target) {
  const canon = (p) => {
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
  };
  const abs = path.resolve(target);
  const canonAbs = path.join(canon(path.dirname(abs)), path.basename(abs));
  const rel = path.relative(canon(REPO_ROOT), canonAbs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * mkdtemp under the system temp root, having first proved it is out of tree.
 *
 * The join stays INSIDE the mkdtempSync call: check-temp-artifact-safety.mjs
 * reads line by line, so a hoisted `path.join(os.tmpdir(), …)` reads to it as a
 * constant shared-temp path with no mkdtemp.
 */
function scratch(prefixName) {
  const outOfTree = (prefix) => {
    assert.ok(!insideRepo(`${prefix}probe`), `the scratch root ${prefix} is inside the repo tree`);
    return prefix;
  };
  return fs.mkdtempSync(outOfTree(path.join(os.tmpdir(), prefixName)));
}

/**
 * Copy a `scripts/ci` script to a temp directory with its repo-anchored
 * constants REDIRECTED at a fixture console root.
 *
 * ── WHY THIS EXISTS (the #3459 / #3892 class, quiet variant) ───────────────
 * The two fail-closed proofs below used to EDIT A TRACKED FILE IN PLACE for
 * the duration of a spawn and restore it in `t.after()` —
 * `apps/fiab-console/lib/api-routes.generated.d.ts` and
 * `apps/fiab-console/lib/client-fetch.ts`. Both sit under a SCAN_ROOT of
 * `scripts/ci/check-role-guid-consistency.mjs`; `lib` is not in its SKIP_DIR
 * and neither filename matches its SKIP_FILE; and the two suites are
 * co-scheduled in the same `node --test` invocation. Measured with a
 * concurrent reader while this suite ran, three runs of the pre-rewrite
 * version:
 *
 *     api-routes.generated.d.ts   145-247 of 5565-6233 raced reads NOT the
 *                                 committed content (2.6-4.0%), 0 errors
 *     client-fetch.ts             2559-2601 of the same (41.1-46.7%), 0 errors
 *
 * ZERO errors is the whole point. The sibling suite's ENOENT/EPERM tolerance
 * never fires, nothing is recorded as vanished, and the scanner silently
 * harvests mutated content. That is the QUIET form of the defect #3912 fixed
 * loudly for the two transient `.__control__.mjs` writers — and quiet is
 * worse, because nothing goes red. After this rewrite, over 3326 raced reads:
 * 0 deviations on both files.
 *
 * The comment that used to sit on the second test said: "There is no
 * create/delete window here, so no such race is possible." The first clause is
 * true and the second does not follow — no ENOENT window is not no race. R7.
 *
 * ── WHY A REDIRECTED COPY RATHER THAN AN IN-PROCESS CALL ───────────────────
 * `check-known-client-routes.mjs` exports `scan(root, mapPath)` and would take
 * a fixture root directly, but calling it drops what these proofs are actually
 * about: the process EXIT CODE and the stderr wording, both of which live in
 * `main()`. So the script is copied and only its root constants move.
 *
 * Every rewrite asserts it matched EXACTLY ONCE, so a constant that is renamed
 * or moved fails loudly here instead of yielding a copy that silently still
 * points at the real tree — which would put these proofs straight back on the
 * tracked files they were moved off, with no red anywhere.
 *
 * `__dirname` is redirected at the REAL `scripts/ci` on purpose:
 * check-known-client-routes.mjs imports its sibling generator through it to
 * decide between "the map is stale" and "the route does not exist", and a copy
 * that could not resolve that import would take a different reporting branch
 * than the shipped script takes.
 */
function redirectedScript(scriptName, consoleRoot) {
  let out = fs.readFileSync(path.join(CI_DIR, scriptName), 'utf8');
  const rewrites = [
    ['const __dirname = path.dirname(fileURLToPath(import.meta.url));',
      `const __dirname = ${JSON.stringify(CI_DIR)};`],
    ["const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');",
      `const CONSOLE_ROOT = ${JSON.stringify(consoleRoot)};`],
  ];
  for (const [find, repl] of rewrites) {
    const n = out.split(find).length - 1;
    assert.equal(
      n, 1,
      `redirecting ${scriptName}: expected exactly ONE occurrence of \`${find}\`, found ${n}. The constant `
        + 'moved or was renamed, and a copy that still points at the real tree would put this proof back on '
        + 'the tracked files it was moved off.',
    );
    out = out.split(find).join(repl);
  }
  // Same discipline as the two sibling suites: a relative specifier left in the
  // copy would resolve against the TEMP directory and die with
  // ERR_MODULE_NOT_FOUND instead of measuring anything.
  assert.doesNotMatch(
    out, /\b(?:from|import)\s*\(?\s*['"]\.{1,2}\//,
    `${scriptName} now has a relative import; rewrite it to an absolute file: URL before copying, or the `
      + 'copy will fail to load rather than fail closed.',
  );
  const dir = scratch('loom-route-script-');
  const file = path.join(dir, scriptName);
  fs.writeFileSync(file, out);
  return { dir, file };
}

/**
 * A minimal console tree: `app/api/**\/route.ts` + an empty `lib/`.
 *
 * `count` static routes plus two dynamic ones — main() refuses to write a map
 * of fewer than 100 routes (fail-closed on a broken discovery), so a fixture
 * below that floor would prove the wrong thing, and renderDts() emits separate
 * static and dynamic unions, so a fixture with no dynamic route would exercise
 * only half of it.
 */
function consoleFixture(count = 120) {
  const root = scratch('loom-route-fixture-');
  const api = path.join(root, 'app', 'api');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const dir = path.join(api, 'loom', `probe${String(i).padStart(3, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'route.ts'), 'export const GET = () => new Response();\n');
  }
  for (const dyn of [['items', '[type]'], ['delta-sharing', '[...path]']]) {
    const dir = path.join(api, ...dyn);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'route.ts'), 'export const GET = () => new Response();\n');
  }
  return root;
}

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

test('the drift gate FAILS when the generated map is stale', () => {
  // Against a FIXTURE console tree, not the tracked one. See redirectedScript()
  // for the measured reason: this test used to rewrite
  // apps/fiab-console/lib/api-routes.generated.d.ts in place while a sibling
  // suite was reading that same tree, and 2.6-4.0% of a concurrent reader's
  // raced reads saw content that is not what is committed — with ZERO errors,
  // so nothing went red anywhere.
  const fixture = consoleFixture();
  const gen = redirectedScript('generate-client-route-map.mjs', fixture);
  try {
    const run = (...args) => spawnSync(process.execPath, [gen.file, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });

    // 1. Generate the fixture's artifacts.
    let r = run();
    assert.equal(r.status, 0, `the generator failed on the fixture:\n${r.stdout}${r.stderr}`);
    const dts = path.join(fixture, 'lib', 'api-routes.generated.d.ts');
    assert.ok(fs.existsSync(dts), 'the generator wrote nothing into the fixture — it is still pointed at the real tree');

    // 2. POSITIVE CONTROL, which the in-place version of this test never had:
    //    --check must be GREEN on what it just wrote. Without it, step 3's red
    //    could equally mean "the fixture never matched in the first place".
    r = run('--check');
    assert.equal(r.status, 0, `--check must pass on a freshly generated map:\n${r.stdout}${r.stderr}`);

    // 3. Now make it stale.
    //
    //    `\r?\n`, never a bare `\n`. The generated file is committed with LF but
    //    git checks it out CRLF on Windows (`core.autocrlf`), so an LF-only
    //    needle matched NOTHING: `replace` returned the input unchanged, the
    //    file was rewritten byte-identical, and this test then demanded the gate
    //    fail at a staleness that had never been introduced. The gate was right;
    //    the proof was broken — `--check` normalises line endings before
    //    comparing (`norm`), which is exactly why the drift gate itself stayed
    //    green on the same tree.
    const original = fs.readFileSync(dts, 'utf8');
    const mutated = original.replace(/ {2}\| '\/api\/loom\/probe050'\r?\n/, '');

    //    The mutation must be CONFIRMED, not assumed. A mutation-based proof
    //    whose mutation silently no-ops is the "gate that measures nothing"
    //    shape: every assertion below would still run, against an unmodified
    //    file. This line is what makes the decay loud instead of
    //    platform-dependent.
    assert.notEqual(mutated, original, 'the staleness mutation did not land — this proof would assert nothing');
    fs.writeFileSync(dts, mutated);

    r = run('--check');
    assert.equal(r.status, 1, `a stale map must fail the drift gate\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /STALE/);
  } finally {
    fs.rmSync(gen.dir, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
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
  // …and one that is NOT. Added because the TEMPLATE branch's `unknown` return
  // is a separate line from the non-template one (`check-known-client-routes
  // .mjs:115` vs `:101`), and nothing here covered it: mutating ONLY line 115
  // to `return 'ok'` left this suite at RC=0, pass=15, fail=0. A template call
  // naming a route prefix that exists nowhere was silently accepted.
  assert.equal(classifyPath('/api/nope/nope/', true, map, pre), 'unknown', 'a template prefix matching no route is unknown');
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

test('the R17 guard FAILS on a planted bad route (fail-closed)', () => {
  // Against a FIXTURE console tree, not the tracked one.
  //
  // This test used to append a probe to `apps/fiab-console/lib/client-fetch.ts`
  // in place for the duration of the spawn. Its comment argued that was safe
  // because "there is no create/delete window here, so no such race is
  // possible" — the first clause is true, the second does not follow, and
  // measured, 41.1-46.7% of a concurrent reader's raced reads across three runs
  // saw content that is not what is committed, with ZERO errors. No ENOENT
  // window is not no race; it is a race that cannot be detected. See
  // redirectedScript().
  //
  // The fixture's map is the REAL generated map, copied in: the guard must
  // resolve against the same route universe the shipped one does, or "this
  // route does not exist" would be true of the fixture rather than of the repo.
  const fixture = consoleFixture(0);
  const guard = redirectedScript('check-known-client-routes.mjs', fixture);
  const probe = path.join(fixture, 'lib', 'probe.ts');
  const good = "export const __ok = () => fetch('/api/loom/workspaces');\n";
  const bad = "export const __probe = () => fetch('/api/this/route/does/not/exist');\n";
  try {
    fs.copyFileSync(
      path.join(CONSOLE_ROOT, 'lib', 'api-routes.generated.json'),
      path.join(fixture, 'lib', 'api-routes.generated.json'),
    );
    const run = () => spawnSync(process.execPath, [guard.file], { cwd: REPO_ROOT, encoding: 'utf8' });

    // POSITIVE CONTROL first. The guard also exits 1 when it checked ZERO call
    // paths, so a red on the planted route alone would not distinguish "it
    // caught the bad route" from "the fixture was unreadable".
    fs.writeFileSync(probe, good);
    let r = run();
    assert.equal(r.status, 0, `a clean fixture must PASS, or the red below proves nothing:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /checked 1 client call paths/, r.stdout);

    fs.writeFileSync(probe, good + bad);
    r = run();
    assert.equal(r.status, 1, `guard must reject an unknown route\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /this\/route\/does\/not\/exist/);
    // The #3158 wording split: this route is absent from BOTH the map and the
    // tree, so it must be reported as a route that does not exist — not as a
    // stale map. Pinning the branch, not merely the substring.
    assert.match(r.stderr, /name a BFF route that does not exist/, r.stderr);
  } finally {
    fs.rmSync(guard.dir, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
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
