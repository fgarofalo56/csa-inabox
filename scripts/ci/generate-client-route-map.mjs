#!/usr/bin/env node
/**
 * R15 — typed API client-map generator (FINISHLINE C4 / loom-apex B-R15-17).
 * ------------------------------------------------------------------------
 * Scans apps/fiab-console/app/api/ ** /route.ts and emits TWO artifacts that
 * together close the "caller references a route that does not exist" gap:
 *
 *   1. `lib/api-routes.generated.d.ts` — TYPE-ONLY. The union `ApiRoutePattern`
 *      of every route as a TS template-literal type, plus `ValidateApiPath<S>`,
 *      which `clientFetch` consumes so that a STRING LITERAL naming a route
 *      that does not exist FAILS TO COMPILE (R16).
 *   2. `lib/api-routes.generated.json` — RUNTIME data. The same routes as
 *      pattern strings, consumed by `lib/api-routes.ts` (`isKnownApiRoute`) and
 *      by the R17 CI guard `check-known-client-routes.mjs`.
 *
 * WHY THE SPLIT IS TWO FILES AND NOT ONE .ts
 *   1,672 routes is ~1,700 lines of union members. Emitting that as a `.ts`
 *   trips `check-file-size` (1,500 LOC warn), and the sanctioned response to
 *   that guard is to COMPACT, never to raise the ceiling or to jam members onto
 *   shared lines (the cosmos-client ratchet note records that concatenation
 *   being undone rather than accepted). A declaration file is the honest home
 *   for a generated type-only artifact — `check-file-size` skips `.d.ts` for
 *   exactly this reason — and the runtime half is data, so it is data (JSON),
 *   not source. Neither file is hand-edited.
 *
 * WHY BOTH HALVES ARE NEEDED
 *   The type check is the sharper tool but fires only on a LITERAL.
 *   `clientFetch(url)` where `url: string` is unconstrained by construction and
 *   must stay that way. The dominant shape in this codebase is neither — it is
 *   a template literal with a static prefix (`` `/api/items/${id}/versions` ``),
 *   which TS narrows to `string`. The R17 guard reads those statically. Neither
 *   half alone closes the gap; the guard is the broader net, the type is the
 *   in-editor one.
 *
 * NEXT.JS PATH RULES honored here:
 *   - `[id]`      → exactly one segment  → `${string}` (type) / `[^/]+` (regex)
 *   - `[...path]` → one or more segments → `${string}` (type) / `.+`   (regex)
 *   - `[[...p]]`  → zero or more         → also matches the bare prefix
 *   - route groups `(name)` contribute nothing to the URL (none exist today;
 *     handled anyway so adding one does not silently produce a wrong pattern).
 *
 * USAGE:
 *   node scripts/ci/generate-client-route-map.mjs           # (re)write both artifacts
 *   node scripts/ci/generate-client-route-map.mjs --check   # CI drift gate (exit 1 if stale)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const API_ROOT = path.join(CONSOLE_ROOT, 'app', 'api');
const DTS_PATH = path.join(CONSOLE_ROOT, 'lib', 'api-routes.generated.d.ts');
const JSON_PATH = path.join(CONSOLE_ROOT, 'lib', 'api-routes.generated.json');

/** Every `app/api/**\/route.ts(x)`, absolute, deterministically ordered. */
export function listRouteFiles(apiRoot = API_ROOT) {
  const out = [];
  if (!fs.existsSync(apiRoot)) return out;
  const walk = (dir) => {
    const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '__tests__') continue;
        walk(full);
      } else if (ent.name === 'route.ts' || ent.name === 'route.tsx') {
        out.push(full);
      }
    }
  };
  walk(apiRoot);
  return out;
}

/** `<apiRoot>/items/[id]/versions/route.ts` → `/api/items/[id]/versions`. */
export function routeFileToUrlPattern(file, apiRoot = API_ROOT) {
  const rel = path.relative(apiRoot, file).split(path.sep).join('/');
  const dir = rel.replace(/\/route\.tsx?$/, '');
  const segments = dir === '' ? [] : dir.split('/');
  const urlSegments = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  return `/api${urlSegments.length ? '/' + urlSegments.join('/') : ''}`;
}

const CATCH_ALL = /^\[\[?\.\.\..+?\]?\]$/;
const DYNAMIC = /^\[.+\]$/;

function classify(pattern) {
  return pattern.replace(/^\/api\/?/, '').split('/').filter(Boolean).map((raw) => {
    if (CATCH_ALL.test(raw)) return { kind: 'catchAll', raw };
    if (DYNAMIC.test(raw)) return { kind: 'dynamic', raw };
    return { kind: 'static', raw };
  });
}

/**
 * TS template-literal type source for one pattern. A fully-static route emits a
 * plain string literal so it stays EXACT (no `${string}` wildcard to hide a
 * typo behind).
 */
export function patternToTypeLiteral(pattern) {
  const segs = classify(pattern);
  if (!segs.some((s) => s.kind !== 'static')) return `'${pattern}'`;
  const body = segs.map((s) => (s.kind === 'static' ? s.raw : '${string}')).join('/');
  return '`/api/' + body + '`';
}

/** Anchored regex SOURCE for one pattern (the runtime/CI half). */
export function patternToRegexSource(pattern) {
  const segs = classify(pattern);
  if (!segs.length) return '^/api/?$';
  let src = '^/api';
  for (const s of segs) {
    if (s.kind === 'static') src += '/' + s.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (s.kind === 'dynamic') src += '/[^/]+';
    else if (s.raw.startsWith('[[')) src += '(?:/.+)?'; // optional catch-all
    else src += '/.+';
  }
  return src + '/?$';
}

export function buildRoutes(apiRoot = API_ROOT) {
  const patterns = listRouteFiles(apiRoot).map((f) => routeFileToUrlPattern(f, apiRoot));
  return [...new Set(patterns)].sort();
}

function renderDts(patterns) {
  // Split STATIC routes (plain string-literal members) from DYNAMIC ones
  // (template literals). This is a TYPE-CHECKER PERFORMANCE split, not a
  // cosmetic one: TypeScript resolves assignability against a large union of
  // UNIT types with a hashed lookup, while every template-literal member costs a
  // pattern match. Checking the ~800 static routes first means the common exact
  // path is answered by the cheap branch and only a miss pays for the ~850
  // template members. Measured on this tree (1,672 routes, ~2,000 call sites):
  // one combined union 10.6s -> 62s; split 10.6s -> see PR body.
  const statics = patterns.filter((p) => !/\[/.test(p));
  const dynamics = patterns.filter((p) => /\[/.test(p));
  const staticMembers = statics.map((p) => `  | ${patternToTypeLiteral(p)}`).join('\n');
  const dynamicMembers = dynamics.map((p) => `  | ${patternToTypeLiteral(p)}`).join('\n');
  return `/**
 * GENERATED — do not edit by hand. TYPE-ONLY (no runtime import is emitted).
 * Source: apps/fiab-console/app/api/**\\/route.ts   (${patterns.length} routes)
 * Regenerate: node scripts/ci/generate-client-route-map.mjs
 * Drift gate:  node scripts/ci/generate-client-route-map.mjs --check
 *
 * R15/R16 — the typed client-route map. \`clientFetch\` applies
 * \`ValidateApiPath\` to its \`input\`, so a string LITERAL naming a BFF route
 * that does not exist fails to COMPILE instead of 404ing in front of a user.
 * Paths built from variables are unconstrained here by design and are covered
 * by the R17 guard (scripts/ci/check-known-client-routes.mjs).
 */

/** Routes with no dynamic segment — a union of UNIT types (cheap to check). */
export type StaticApiRoute =
${staticMembers};

/** Routes with a \`[param]\` / \`[...catchAll]\` segment, as template literals. */
export type DynamicApiRoute =
${dynamicMembers};

/** Every BFF route. Dynamic segments are \`\${string}\`. */
export type ApiRoutePattern = StaticApiRoute | DynamicApiRoute;

/**
 * The compile-time error surface, kept as a NAMED alias for documentation and
 * for tests to reference. Note that \`ValidateApiPath\` inlines the same shape
 * rather than referencing this alias — see the note there.
 */
export type UnknownApiRoute<S extends string> = {
  __loomUnknownApiRoute: \`No BFF route matches "\${S}". Add the app/api/…/route.ts, or fix the path.\`;
};

/** Strip \`?query\` / \`#hash\` at the type level so callers may pass either. */
type StripSuffix<S extends string> =
  S extends \`\${infer H}?\${string}\` ? StripSuffix<H>
  : S extends \`\${infer H}#\${string}\` ? H
  : S;

/**
 * R16 — the \`clientFetch\` path guard.
 *
 *   - a NON-LITERAL \`string\` passes through unconstrained (\`string extends S\`
 *     holds only for the wide type). Those are R17's remit, not the type
 *     system's — narrowing them would break every computed URL in the tree.
 *   - a literal that is not an /api path passes through (absolute URLs, blob:).
 *   - a CONCRETE literal /api path must match a static route, else a dynamic one.
 *   - a PARTIALLY-concrete path — the shape TS infers for
 *     \`const u = \\\`/api/foo/report\${qs}\\\`\` — is neither \`string\` nor a member of
 *     the union, so it needs the OTHER assignability direction: it is accepted
 *     when at least one real route is assignable TO it (i.e. some route could
 *     be what it resolves to). Without this clause five legitimate call sites
 *     that append a query string to a variable failed to compile — the union
 *     carries \`'/api/foo/report'\`, and \`\\\`/api/foo/report\${string}\\\`\` is wider
 *     than that member, not narrower. \`[X] extends [never]\` is bracketed to
 *     suppress distribution, so an empty Extract reads as "no route matches"
 *     rather than silently distributing to \`never\` and passing.
 *
 * The failure branch INLINES the error object rather than referencing the
 * \`UnknownApiRoute\` alias. TypeScript prints an alias by NAME and will not
 * expand it, so the alias form produced
 *   \`… not assignable to 'URL | UnknownApiRoute<"/api/loom/workspacs">'\`
 * — the path was there, but the remedy was not. Inlining makes tsc print the
 * structural type, so the message itself lands in the diagnostic.
 */
export type ValidateApiPath<S extends string> =
  string extends S ? S
  : S extends \`/api/\${string}\`
    ? (StripSuffix<S> extends StaticApiRoute
        ? S
        : StripSuffix<S> extends DynamicApiRoute
          ? S
          : [Extract<ApiRoutePattern, StripSuffix<S>>] extends [never]
            ? { __loomUnknownApiRoute: \`No BFF route matches "\${S}" — add the app/api/…/route.ts, or fix the path\` }
            : S)
    : S;
`;
}

function renderJson(patterns) {
  return JSON.stringify({
    __generated: 'node scripts/ci/generate-client-route-map.mjs — do not edit by hand',
    count: patterns.length,
    // Route patterns in Next.js form (`[id]` / `[...path]`). Consumers compile
    // these with patternToRegexSource()'s rules; the sources are emitted too so
    // a consumer never has to re-derive them.
    patterns,
    regexSources: patterns.map(patternToRegexSource),
  }, null, 2) + '\n';
}

function main() {
  const patterns = buildRoutes();
  // FAIL CLOSED. A discovery bug that finds nothing must not silently emit an
  // empty map — that would turn both halves of the contract into no-ops while
  // every gate stayed green.
  if (patterns.length < 100) {
    console.error(`[client-route-map] FAIL — discovered only ${patterns.length} routes under app/api.`);
    console.error('  That is implausible for this console; refusing to write a map that would disable both guards.');
    process.exit(1);
  }

  const nextDts = renderDts(patterns);
  const nextJson = renderJson(patterns);
  const norm = (s) => (s === null ? null : s.replace(/\r\n/g, '\n'));
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

  if (process.argv.includes('--check')) {
    const stale = [];
    if (norm(read(DTS_PATH)) !== norm(nextDts)) stale.push(path.relative(REPO_ROOT, DTS_PATH));
    if (norm(read(JSON_PATH)) !== norm(nextJson)) stale.push(path.relative(REPO_ROOT, JSON_PATH));
    if (stale.length) {
      console.error('[client-route-map] FAIL — the generated route map is STALE:');
      for (const f of stale) console.error(`  - ${f}`);
      console.error(`  discovered ${patterns.length} routes under app/api/`);
      console.error('  Regenerate: node scripts/ci/generate-client-route-map.mjs');
      process.exit(1);
    }
    console.log(`[client-route-map] OK — ${patterns.length} routes, generated map in sync.`);
    process.exit(0);
  }

  fs.writeFileSync(DTS_PATH, nextDts);
  fs.writeFileSync(JSON_PATH, nextJson);
  console.log(`[client-route-map] wrote ${path.relative(REPO_ROOT, DTS_PATH)} + .json (${patterns.length} routes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
