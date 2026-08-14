#!/usr/bin/env node
/**
 * A URL handed to a CLIENT must be built on the FORWARDED origin, never on the
 * request's own. (refs #3443, #3442)
 *
 * PHYSICAL-LINES-OK: judges TypeScript expressions, not shell. A `\` at end of
 * line in TS only continues a string literal, never a statement, so folding
 * logical lines would join nothing and would break the per-line reporting this
 * guard emits.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * This console runs `output: 'standalone'` with `ENV HOSTNAME="0.0.0.0"` and
 * `ENV PORT=3000`. Traced through the installed next@15.5.21:
 *
 *   build/utils.js:1316   standalone template -> startServer({hostname, port})
 *   base-server.js:329    this.fetchHostname = formatHostname(this.hostname)
 *   next-server.js:1312   initURL = `${protocol}://${fetchHostname}:${port}${req.url}`
 *   web/next-url.js       NextURL has NO x-forwarded-* handling
 *
 * So `req.url` and `req.nextUrl.origin` carry the CONTAINER's authority. Any
 * value derived from them and handed to a client points at `0.0.0.0:3000`.
 *
 * It has bitten twice. #3442: the auth circuit breaker's terminal redirect —
 * the breaker fired correctly and then sent the browser somewhere unreachable,
 * so the diagnosis page that was the whole point never rendered. #3443:
 * `flightsql/connect` put that address in a **copy-paste snippet**, in a file
 * whose own docstring declares "No internal hosts … it would not resolve for
 * the reader".
 *
 * Both were one-line mistakes under a comment stating the correct rule. Neither
 * was visible to any existing fixture, because the harnesses set `host` and
 * `x-forwarded-host` to the same value as the request URL — making the broken
 * and correct constructions byte-identical.
 *
 * ── WHY IT STRIPS COMMENTS FIRST ───────────────────────────────────────────
 * The scan that found #3443 returned 7 hits, of which SIX were prose: doc
 * comments quoting the bad pattern to explain it, plus one deliberate control
 * in a test that evaluates the old construction to assert it yields
 * `0.0.0.0:3000`. A guard that cannot tell code from a comment about code would
 * force those explanations to be deleted — punishing exactly the documentation
 * that makes the class understandable.
 *
 * Run: node scripts/ci/check-external-origin-urls.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCOPE = 'apps/fiab-console';

/** A URL built on the request's OWN origin. */
export const BAD_ORIGIN =
  /new URL\(\s*[^)]*?,\s*(?:req|request)\.(?:url|nextUrl\.origin)\s*\)/;

/**
 * Strip `//` and block comments so prose ABOUT the pattern is not a violation.
 * Deliberately conservative: it does not try to parse strings, so a `//` inside
 * a string literal truncates the line. That can only cause a FALSE NEGATIVE on
 * a line that both contains a URL-looking string and the bad construction —
 * which the embedded controls below would catch if it ever mattered.
 */
export function stripComments(src) {
  const noBlocks = String(src).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * Files allowed to contain the construction in EXECUTABLE form, each with a
 * reason. A stale entry fails the guard, so this list cannot rot into cover.
 */
export const EXEMPT = new Map([
  [
    'apps/fiab-console/app/auth/__tests__/sign-in-redirect-origin.test.ts',
    'evaluates the pre-#3442 construction inline as a CONTROL, asserting it yields 0.0.0.0:3000 — the mutation proof lives here, so forbidding it would delete the evidence',
  ],
]);

const CONTROLS = [
  { name: 'bad: req.url', src: "const u = new URL('/x', req.url);", expect: true },
  { name: 'bad: req.nextUrl.origin', src: "const u = new URL('/x', req.nextUrl.origin);", expect: true },
  { name: 'good: externalOrigin', src: "const u = new URL('/x', externalOrigin(req.headers));", expect: false },
  { name: 'prose in a // comment', src: "// never build new URL('/x', req.url) here", expect: false },
  { name: 'prose in a block comment', src: "/**\n * see new URL(path, req.url)\n */\nconst a = 1;", expect: false },
];

export function findViolations(src) {
  const out = [];
  const lines = stripComments(src).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (BAD_ORIGIN.test(lines[i])) out.push({ line: i + 1, text: lines[i].trim().slice(0, 150) });
  }
  return out;
}

function selfTest() {
  for (const c of CONTROLS) {
    const got = findViolations(c.src).length > 0;
    if (got !== c.expect) {
      console.error(`::error::external-origin-urls: EMBEDDED CONTROL FAILED — "${c.name}" expected violation=${c.expect}, got ${got}. The detector has drifted; a clean scan from it would mean nothing.`);
      process.exit(1);
    }
  }
}

function main() {
  selfTest();

  const files = execFileSync('git', ['ls-files', SCOPE], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f));

  // Refuse to pass vacuously. NOTE: `git ls-files` sees only TRACKED files — a
  // scan of an untracked fixture proves nothing, which cost a false negative
  // elsewhere today.
  if (files.length < 500) {
    console.error(`::error::external-origin-urls: enumerated only ${files.length} tracked .ts/.tsx under ${SCOPE} (expected >= 500). The scan is broken — FAILING rather than reporting a clean sweep of nothing.`);
    process.exit(1);
  }

  const bad = [];
  const usedExemptions = new Set();
  for (const f of files) {
    const hits = findViolations(readFileSync(path.join(REPO_ROOT, f), 'utf8'));
    if (!hits.length) continue;
    if (EXEMPT.has(f)) {
      usedExemptions.add(f);
      continue;
    }
    for (const h of hits) bad.push({ f, ...h });
  }

  // A stale exemption is cover for a defect that no longer exists — and the next
  // real one would inherit it silently.
  const stale = [...EXEMPT.keys()].filter((f) => !usedExemptions.has(f));
  if (stale.length) {
    console.error(`::error::external-origin-urls: ${stale.length} EXEMPT entr(ies) no longer contain the construction: ${stale.join(', ')}. Remove them — a stale exemption silently covers the next real violation.`);
    process.exit(1);
  }

  for (const b of bad) {
    console.error(`::error file=${b.f},line=${b.line}::external-origin-urls: builds a client-facing URL on the request's OWN origin, which under \`output: 'standalone'\` is the container's listen address — clients get https://0.0.0.0:3000/… Use externalOrigin(req.headers) from @/lib/auth/auth-breaker, which reads the forwarded host this app already trusts for the OAuth redirect_uri. See #3442, #3443.\n  ${b.text}`);
  }

  console.log(`external-origin-urls: ${files.length} tracked file(s) scanned, ${bad.length} violation(s), ${EXEMPT.size} reasoned exemption(s), ${CONTROLS.length} embedded control(s) passed.`);
  if (bad.length) {
    console.error(`::error::external-origin-urls: ${bad.length} client-facing URL(s) built on an internal origin.`);
    process.exit(1);
  }
}

// Run as a script, not as an import side effect (#3436).
if (process.argv[1] && process.argv[1].endsWith('check-external-origin-urls.mjs')) {
  main();
}
