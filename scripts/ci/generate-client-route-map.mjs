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
 * THE DRIFT GATE PRINTS THE EXPECTED DIFF (#3158)
 *   Both artifacts are COMMITTED, so they race the merge order: PR A adds a
 *   route and regenerates; PR B, branched before A, regenerates without it; B
 *   merges last and `main` carries a map missing A's route. `main` goes red
 *   here, which is the correct and honest outcome — the map IS stale — but the
 *   failure used to name only the two files and the regenerate command, so
 *   every occurrence cost a fresh ~20-minute diagnosis.
 *
 *   The two structural fixes are both unavailable and measured to be so at
 *   origin/main 5a5572aa: branch protection's `required_status_checks.strict`
 *   reads FALSE (it was true when this was last triaged), so up-to-date-before-
 *   merge is not in force; and `gh api repos/… --jq .owner.type` reads `User`,
 *   so the `merge_group` triggers in the tree cannot be backed by a real merge
 *   queue. Regenerating in CI was rejected outright: it would make this gate
 *   unable to fail, which is the exact class this repo keeps digging out of.
 *
 *   So the gate is unchanged and the MESSAGE carries the remedy — see
 *   {@link describeExpectedDiff}.
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

/**
 * How many diff rows the stale report prints before it summarises the rest.
 *
 * A regeneration after a large merge can move hundreds of routes; dumping all of
 * them buries the two that matter. Bounded, and the count of what was elided is
 * always printed — a truncated list that does not say it was truncated is its
 * own small false statement.
 */
export const MAX_DIFF_ROWS = 25;

/** The committed JSON's route list, or an honest reason it could not be read. */
function readCommittedPatterns(text) {
  if (text === null) return { patterns: null, why: 'the file does not exist yet' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { patterns: null, why: `it is not valid JSON (${String(e.message).slice(0, 80)})` };
  }
  if (!Array.isArray(parsed?.patterns)) {
    return { patterns: null, why: 'it has no `patterns` array — it is not this generator\'s shape' };
  }
  return { patterns: parsed.patterns.map(String), why: null };
}

/** `[a, b, c]` → bounded lines with a truthful "and N more" when elided. */
function boundedRows(items, render, max = MAX_DIFF_ROWS) {
  const out = items.slice(0, max).map(render);
  if (items.length > max) out.push(`      … and ${items.length - max} more`);
  return out;
}

/** The first lines at which two renderings disagree, with their line numbers. */
function firstDifferingLines(committed, expected, max = 3) {
  const a = String(committed ?? '').replace(/\r\n/g, '\n').split('\n');
  const b = String(expected ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < max; i += 1) {
    if (a[i] === b[i]) continue;
    const clip = (s) => (s === undefined ? '(no such line)' : `"${s.length > 110 ? `${s.slice(0, 110)}…` : s}"`);
    out.push(`      line ${i + 1}  committed: ${clip(a[i])}`);
    out.push(`      ${' '.repeat(String(i + 1).length)}       expected: ${clip(b[i])}`);
  }
  return out;
}

/**
 * THE EXPECTED DIFF, in the terms the reader actually needs (#3158).
 *
 * WHY THIS EXISTS. The committed route map races the merge order: PR A adds a
 * route and regenerates; PR B, branched before A, regenerates without it; B
 * merges last and `main` now carries a map missing A's route. `main` goes red on
 * this gate, which is correct — the map IS stale — but the failure said only
 * "the generated route map is STALE", listed the two filenames, and printed the
 * regenerate command. It never said WHAT was stale, so every occurrence cost a
 * fresh ~20-minute diagnosis of a condition that is one line to state.
 *
 * The operator's own resolution (issue #3158, 2026-08-16): print the expected
 * diff, not just the command. The two structural resolutions that were on the
 * table are both off it — `strict` branch protection now reads false, and the
 * repo is user-owned so a merge queue cannot back the `merge_group` triggers.
 *
 * THE DIFF IS SEMANTIC FIRST, TEXTUAL ONLY AS A FALLBACK. What a reader needs is
 * "your map is missing /api/foo, which PR A added" — not 1,700 lines of union
 * members. So the route SETS are diffed, and each row says which side has the
 * file on disk, because that is the fact that tells you whether you are behind
 * main or have deleted a route. Only when the sets are IDENTICAL and the bytes
 * still differ (a rendering change, a regexSources change, a formatting change)
 * does it fall back to naming the first differing lines.
 *
 * PURE — no IO, no process.exit — so the self-test drives every branch.
 *
 * @param {{committedJson:string|null, committedDts:string|null,
 *          nextJson:string, nextDts:string, patterns:string[]}} a
 * @returns {string[]} operator-readable lines, already indented
 */
export function describeExpectedDiff({ committedJson, committedDts, nextJson, nextDts, patterns }) {
  const lines = [];
  const { patterns: committed, why } = readCommittedPatterns(committedJson);

  if (committed === null) {
    // NAME THE REASON. "No diff available" would be true and useless; the reason
    // is what distinguishes "run the generator" from "someone hand-edited this".
    lines.push(`  expected diff: the committed route list could not be read — ${why}.`);
    lines.push(`  Regenerating writes all ${patterns.length} discovered route(s) fresh.`);
    return lines;
  }

  const have = new Set(committed);
  const want = new Set(patterns);
  const added = patterns.filter((p) => !have.has(p));
  const removed = committed.filter((p) => !want.has(p));

  if (added.length || removed.length) {
    lines.push(`  expected diff — ${added.length} route(s) to ADD, ${removed.length} to REMOVE:`);
    lines.push(...boundedRows(added, (p) => `      + ${p}    (app/api has this route; the committed map does not list it)`));
    lines.push(...boundedRows(removed, (p) => `      - ${p}    (the committed map lists it; app/api no longer has it)`));
    if (added.length && !removed.length) {
      // The merge-order race, named. This is the shape #3158 is about, and
      // saying so converts the diagnosis into a read.
      lines.push('  Routes present on disk but absent from the map is the #3158 merge-order race:');
      lines.push('  another PR added them and this branch\'s map predates it. Regenerating is the whole fix.');
    }
    return lines;
  }

  // Same routes, different bytes. Say that plainly rather than printing an empty
  // diff, which would read as "nothing is wrong" over a red gate.
  lines.push('  expected diff: the ROUTE SET is identical — the difference is in how the artifacts');
  lines.push('  are rendered (member order, regexSources, the header, or line endings), not in which');
  lines.push('  routes exist. First differing line(s):');
  const jsonDiff = firstDifferingLines(committedJson, nextJson);
  if (jsonDiff.length) {
    lines.push(`    ${path.relative(REPO_ROOT, JSON_PATH)}`);
    lines.push(...jsonDiff);
  }
  const dtsDiff = firstDifferingLines(committedDts, nextDts);
  if (dtsDiff.length) {
    lines.push(`    ${path.relative(REPO_ROOT, DTS_PATH)}`);
    lines.push(...dtsDiff);
  }
  return lines;
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
    const committedDts = read(DTS_PATH);
    const committedJson = read(JSON_PATH);
    const stale = [];
    if (norm(committedDts) !== norm(nextDts)) stale.push(path.relative(REPO_ROOT, DTS_PATH));
    if (norm(committedJson) !== norm(nextJson)) stale.push(path.relative(REPO_ROOT, JSON_PATH));
    if (stale.length) {
      console.error('[client-route-map] FAIL — the generated route map is STALE:');
      for (const f of stale) console.error(`  - ${f}`);
      console.error(`  discovered ${patterns.length} routes under app/api/`);
      // #3158 — WHAT is stale, not merely THAT it is. The stale-map failure used
      // to print the file list, the route count and the regenerate command and
      // stop, so each occurrence cost a fresh diagnosis of a one-line condition.
      for (const line of describeExpectedDiff({
        committedJson, committedDts, nextJson, nextDts, patterns,
      })) console.error(line);
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
