#!/usr/bin/env node
/**
 * GUARDRAIL: known-client-routes  (merge-blocker, ABSOLUTE)   — R17
 * ------------------------------------------------------------------------
 * RULE: a browser→BFF call must name a route that EXISTS. A path that does not
 *   resolve to an `app/api/**\/route.ts` is a 404 in front of a user — the exact
 *   class of defect a "typed client map" is supposed to make impossible.
 *
 * WHY THIS EXISTS ALONGSIDE THE TYPE CHECK (R16).
 *   `lib/api-routes.generated.d.ts` makes an unknown route fail to COMPILE, but
 *   only when the argument is a string LITERAL. The dominant shape in this
 *   codebase is not a literal — it is a template with a static prefix and an
 *   interpolated id:
 *
 *       clientFetch(`/api/items/${type}/${id}/versions`)
 *
 *   TypeScript widens that to `string`, so R16 cannot see it, and narrowing it
 *   would break every computed URL in the tree. This guard reads those
 *   statically instead: it takes the LITERAL PREFIX up to the first `${`, and
 *   requires that prefix to be a real route or the prefix of one. That covers
 *   1,262 template call sites the type system is structurally blind to.
 *
 * WHAT IT CHECKS
 *   Every `/api/...` string that appears as the first argument of a fetch-like
 *   call (`clientFetch(`, `fetch(`) under lib/ and app/, in .ts/.tsx:
 *     - full literal (no interpolation) -> must match a route pattern exactly
 *       (after stripping ?query / #hash);
 *     - literal prefix of a template     -> must be a route, or a proper prefix
 *       of one (`/api/items/` is fine — `/api/items/[type]/...` exists).
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 *   A path with NO literal prefix beyond `/api/` (fully computed) is
 *   unknowable statically and is skipped — counted and reported so the blind
 *   spot is visible rather than silent. Non-first-party absolute URLs are out
 *   of scope.
 *
 * FAIL-CLOSED: if the generated map is missing, unparseable, or implausibly
 * small, this exits 1 rather than passing vacuously. A guard that silently
 * measures nothing is the failure mode this repo has been bitten by repeatedly.
 *
 * USAGE:
 *   node scripts/ci/check-known-client-routes.mjs
 *   node scripts/ci/check-known-client-routes.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const MAP_PATH = path.join(CONSOLE_ROOT, 'lib', 'api-routes.generated.json');
const SCAN_DIRS = ['lib', 'app'];

/** Load the generated map, failing closed on anything suspicious. */
export function loadRouteMap(mapPath = MAP_PATH) {
  if (!fs.existsSync(mapPath)) {
    throw new Error(
      `generated route map missing at ${path.relative(REPO_ROOT, mapPath)} — ` +
      'run: node scripts/ci/generate-client-route-map.mjs',
    );
  }
  const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const patterns = Array.isArray(raw?.patterns) ? raw.patterns : null;
  const regexSources = Array.isArray(raw?.regexSources) ? raw.regexSources : null;
  if (!patterns || !regexSources || patterns.length !== regexSources.length) {
    throw new Error('generated route map is malformed (patterns/regexSources mismatch)');
  }
  if (patterns.length < 100) {
    throw new Error(`generated route map has only ${patterns.length} routes — implausible; refusing to run vacuously`);
  }
  return { patterns, regexes: regexSources.map((s) => new RegExp(s)) };
}

/** Static path prefixes, so a template prefix like `/api/items/` can be validated. */
export function staticPrefixes(patterns) {
  const set = new Set();
  for (const p of patterns) {
    const segs = p.split('/').filter(Boolean); // ['api', 'items', '[type]', …]
    const acc = [];
    for (const s of segs) {
      if (s.startsWith('[')) break;
      acc.push(s);
      set.add('/' + acc.join('/'));
    }
  }
  return set;
}

const STRIP = (s) => s.split('?')[0].split('#')[0];

/**
 * Verdict for one extracted path.
 *   'ok'      — resolves to a real route (or a prefix of one)
 *   'unknown' — does not resolve → a violation
 *   'skip'    — not statically knowable (no literal prefix past /api/)
 */
export function classifyPath(rawPath, isTemplate, map, prefixes) {
  const p = STRIP(rawPath);
  if (!p.startsWith('/api')) return 'skip';
  if (!isTemplate) return map.regexes.some((re) => re.test(p)) ? 'ok' : 'unknown';

  // Template: `p` is the literal prefix up to the first `${`.
  // `/api/` or `/api` alone carries no information — record as a blind spot.
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '/api' || trimmed === '') return 'skip';
  // A complete route already (`/api/foo/bar` then `?x=${y}`) …
  if (map.regexes.some((re) => re.test(trimmed))) return 'ok';
  // … or a proper static prefix of one (`/api/items/` → `/api/items/[type]`).
  if (prefixes.has(trimmed)) return 'ok';
  // A prefix that ends mid-segment (`/api/items/foo-` + `${id}`) — accept when
  // some route's static prefix STARTS with it, since the interpolation
  // completes the segment.
  for (const pre of prefixes) if (pre.startsWith(trimmed)) return 'ok';
  return 'unknown';
}

/** All .ts/.tsx under the scan dirs, excluding tests/build output. */
function listSourceFiles(root = CONSOLE_ROOT) {
  const out = [];
  for (const d of SCAN_DIRS) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    const walk = (cur) => {
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          if (['node_modules', '.next', '__tests__', 'e2e', 'dist'].includes(ent.name)) continue;
          walk(full);
        } else if (/\.tsx?$/.test(ent.name) && !/\.d\.ts$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
          out.push(full);
        }
      }
    };
    walk(dir);
  }
  return out;
}

/**
 * Blank out `//` and `/* *\/` comments, preserving offsets (so reported line
 * numbers stay true) and leaving string literals alone.
 *
 * Needed because this guard's OWN header documents the failure it detects
 * (`clientFetch('/api/loom/workspacs')  // ERROR`), and so does client-fetch.ts.
 * Scanning comments made the guard flag its own documentation — the same
 * self-inflicted class as a prose-matching route guard: the finding looks real,
 * costs a reviewer time, and trains people to skim the output.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Extract the first-argument path of every fetch-like call.
 * Returns { path, isTemplate, line }.
 *
 * The quote character decides the shape: a backtick MAY interpolate, so we take
 * the literal run up to the first `${`; a plain quote cannot, so the whole
 * string is the path.
 *
 * A backticked template must NOT also be read as a plain literal. The naive
 * quote-agnostic regex does exactly that — `[^'"\`]` happily spans `${…}` — so
 * `` clientFetch(`/api/items/${id}/versions`) `` produced a bogus "route
 * /api/items/${id}/versions does not exist". On the guard's first run that
 * overlap accounted for 30 of 31 findings, and the 31st was this file's own
 * JSDoc (see stripComments). i.e. the first version of this guard was 31/31
 * false positives — which is worth recording, because a guard whose output is
 * all noise gets muted, and a muted guard measures nothing.
 */
export function extractCallPaths(rawSrc) {
  const src = stripComments(rawSrc);
  const out = [];
  const re = /\b(?:clientFetch|fetch)\(\s*(['"`])(\/api[^'"`]*?)\1/g;
  const reTemplate = /\b(?:clientFetch|fetch)\(\s*`(\/api[^`]*?)\$\{/g;
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  for (const m of src.matchAll(reTemplate)) {
    out.push({ path: m[1], isTemplate: true, line: lineOf(m.index) });
  }
  for (const m of src.matchAll(re)) {
    // Skip a backticked body that interpolates — reTemplate already produced the
    // correct (prefix-only) entry for it.
    if (m[1] === '`' && m[2].includes('${')) continue;
    out.push({ path: m[2], isTemplate: false, line: lineOf(m.index) });
  }
  return out;
}

export function scan(root = CONSOLE_ROOT, mapPath = MAP_PATH) {
  const map = loadRouteMap(mapPath);
  const prefixes = staticPrefixes(map.patterns);
  const violations = [];
  let checked = 0;
  let skipped = 0;

  for (const file of listSourceFiles(root)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('/api')) continue;
    for (const hit of extractCallPaths(src)) {
      const verdict = classifyPath(hit.path, hit.isTemplate, map, prefixes);
      if (verdict === 'skip') { skipped++; continue; }
      checked++;
      if (verdict === 'unknown') {
        violations.push({
          file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
          line: hit.line,
          path: hit.path,
          isTemplate: hit.isTemplate,
        });
      }
    }
  }
  return { violations, checked, skipped, routeCount: map.patterns.length };
}

function selftest() {
  const map = loadRouteMap();
  const prefixes = staticPrefixes(map.patterns);
  const cases = [
    // [path, isTemplate, expected]
    ['/api/loom/workspaces', false, 'ok'],
    ['/api/loom/workspacs', false, 'unknown'],
    ['/api/definitely/not/a/route/at/all', false, 'unknown'],
    ['/api/', true, 'skip'],
    ['https://example.com/x', false, 'skip'],
  ];
  let bad = 0;
  for (const [p, tpl, want] of cases) {
    const got = classifyPath(p, tpl, map, prefixes);
    if (got !== want) { console.error(`[known-client-routes] SELFTEST FAIL ${p} → ${got}, want ${want}`); bad++; }
  }
  if (bad) process.exit(1);
  console.log(`[known-client-routes] selftest OK (${cases.length} cases, ${map.patterns.length} routes loaded)`);
  process.exit(0);
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  let result;
  try {
    result = scan();
  } catch (e) {
    console.error(`[known-client-routes] FAIL — ${e.message}`);
    process.exit(1);
  }
  const { violations, checked, skipped, routeCount } = result;
  console.log(`[known-client-routes] ${routeCount} BFF routes; checked ${checked} client call paths (${skipped} fully-computed, not statically knowable)`);
  if (checked === 0) {
    console.error('[known-client-routes] FAIL — checked ZERO call paths. Discovery is broken; refusing to pass vacuously.');
    process.exit(1);
  }
  if (violations.length) {
    // R7 — DO NOT ASSERT ABSENCE FROM A DERIVED ARTIFACT (#3158).
    //
    // This guard resolves against the COMMITTED map, and on 2026-08-08 that made
    // it turn main red with "3 call(s) name a BFF route that does not exist:
    // /api/powerplatform/solutions". The route existed. It was real, complete and
    // withSession-wrapped, shipped in #3146 alongside the panel calling it. What
    // did not exist was a MAP ENTRY, because #3152 regenerated the map from a
    // base predating #3146 — each PR correct alone, the merge order not, and no
    // review of either could have caught it.
    //
    // The map going stale is a real defect and the drift gate exists to catch it.
    // But "the map does not mention X" and "X does not exist" are DIFFERENT
    // CLAIMS, and reporting the second while having established only the first
    // sent the #3157 repair hunting for a route that was sitting in the tree.
    //
    // So: before saying a route is absent, look on disk. The verdict does not
    // change — a stale map still fails the build, because shipping it breaks the
    // compile-time guarantee in api-routes.generated.d.ts — but the REASON is now
    // the true one, and the remediation matches it.
    const onDisk = new Set();
    try {
      const gen = await import(pathToFileURL(path.join(__dirname, 'generate-client-route-map.mjs')).href);
      for (const p of gen.buildRoutes()) onDisk.add(p);
    } catch {
      // Discovery unavailable: fall back to the original wording rather than
      // inventing a cause. UNKNOWN is not "the route is missing".
    }
    const staleOnly = onDisk.size > 0
      ? violations.filter((v) => [...onDisk].some((r) => r === STRIP(v.path) || r.startsWith(STRIP(v.path))))
      : [];

    if (staleOnly.length === violations.length && violations.length > 0) {
      console.error(
        `\n[known-client-routes] FAIL — the generated route map is STALE. ${violations.length} call(s) name a route ` +
        'that EXISTS on disk but is absent from lib/api-routes.generated.json. This is the merge-order race in #3158: ' +
        'one PR added the route, another regenerated the map from a base that predated it.',
      );
      for (const v of violations) {
        console.error(`  - ${v.file}:${v.line}  ${v.path}${v.isTemplate ? '${…}' : ''}   [route EXISTS on disk]`);
      }
      console.error('\nFix: regenerate and commit the map — the routes are fine.');
      console.error('  node scripts/ci/generate-client-route-map.mjs');
      process.exit(1);
    }

    console.error(`\n[known-client-routes] FAIL — ${violations.length} call(s) name a BFF route that does not exist:`);
    for (const v of violations) {
      const exists = onDisk.size > 0 && [...onDisk].some((r) => r === STRIP(v.path) || r.startsWith(STRIP(v.path)));
      console.error(`  - ${v.file}:${v.line}  ${v.path}${v.isTemplate ? '${…}' : ''}${exists ? '   [route EXISTS on disk — the MAP is stale]' : ''}`);
    }
    console.error('\nFix: correct the path, or add the missing app/api/…/route.ts.');
    console.error('If you just added a route, regenerate the map:');
    console.error('  node scripts/ci/generate-client-route-map.mjs');
    process.exit(1);
  }
  console.log('[known-client-routes] OK — every statically-resolvable client call names a real route.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
