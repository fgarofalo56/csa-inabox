/**
 * GUARD — a credentialed client may not send its token to an address a
 * RESPONSE BODY chose (advisory GHSA-4gvx-9p49-p43g).
 *
 * WHY THIS GUARD EXISTS RATHER THAN MORE PER-FILE TESTS. This class was found
 * and fixed twice already, each time keyed to ONE function name:
 * `networking-client.resolveArmUrl` (#2652) and `foundry-cs-client.armListAll`
 * (PR #4443 review). Both fixes were correct and both left every sibling
 * walker unguarded, because a fix keyed to a name cannot see the next client.
 * A hand-maintained list of known sites has the same defect one level up: it is
 * a narrower enumeration, and the file you forget to add is exactly the file
 * that ships the bug.
 *
 * So the POPULATION IS DERIVED FROM THE FILESYSTEM on every run. A newly added
 * client that attaches a bearer credential and follows a `nextLink` is in scope
 * the moment it lands, with no edit to this file.
 *
 * ── THE TWO SHAPES ────────────────────────────────────────────────────────
 *   S1  ABSOLUTE PASSTHROUGH — `x.startsWith('http') ? x : `${BASE}${x}``
 *       within reach of a `Bearer` attachment. This is the literal
 *       construction in the advisory. It is banned outright in a credentialed
 *       context: the shared resolver replaces it.
 *   S2  RESPONSE-BODY CONTINUATION — a file that both attaches a bearer
 *       credential and reads a `nextLink` / `@odata.nextLink`. Such a file must
 *       make its boundary decision through one of the shared helpers.
 *
 * ── WHAT S2 DOES *NOT* PROVE, stated because the claim above is the headline ─
 * S2 is a FILE-level assertion, not a per-site dataflow. It proves the file
 * makes a boundary decision through the shared helper; it does not prove that
 * decision covers every continuation in the file. A per-site taint analysis
 * would be stronger and is deliberately not attempted here — the cheap version
 * of it would be a regex over identifier names, which is a narrower enumeration
 * wearing a dataflow costume. S1 IS per-site. The behaviour tests in
 * `lib/azure/__tests__/credential-url-same-origin.test.ts` and
 * `lib/util/__tests__/same-origin-url.test.ts` carry the per-site burden.
 *
 * ── NOT-RUN IS NOT A PASS ─────────────────────────────────────────────────
 * A scanner that stops scanning reports zero violations, which reads exactly
 * like a clean tree. Both populations therefore carry a FLOOR, asserted before
 * any verdict: if the enumeration collapses the guard FAILS rather than
 * passing over nothing.
 *
 * ── CRLF ──────────────────────────────────────────────────────────────────
 * Every source file under apps/fiab-console is CRLF with zero bare LF. A line
 * regex anchored with `$`, and a `//.*$` comment stripper, both silently
 * misbehave on `\r`. `\r` is stripped FIRST, before anything else looks at the
 * text, and `stripsCarriageReturnsFirst` below proves it on a CRLF fixture.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const CONSOLE_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROOTS = ['lib', 'app'].map((d) => path.join(CONSOLE_ROOT, d));
const SKIP_DIRS = new Set(['node_modules', '.next', '__tests__', 'dist', 'out', 'coverage']);

/**
 * Floors. These are MEASURED counts at the time of the fix, not guesses. Lower
 * them only in the same change that genuinely removes the sites.
 */
const MIN_FILES_SCANNED = 2000;
/** Files that attach a bearer credential AND read a nextLink. Measured: 27. */
const MIN_CONTINUATION_FILES = 15;

/** The shared boundary primitives. A file satisfies S2 by calling one. */
const GUARD_MARKERS = [
  'resolveSameOriginUrl(',
  'sameOriginUrlOrNull(',
  'assertSameOrigin(',
  'isSameOrigin(',
  'isContinuationAllowed(',
  'sameOriginAs:',
  // host-match.ts — the sibling primitive, for suffix-scoped boundaries
  // (a Key Vault in THIS cloud) rather than a single fixed origin.
  'hostHasSuffix(',
  'urlHostHasSuffix(',
  'hostHasAnySuffix(',
];

/**
 * Blank COMMENTS ONLY, preserving offsets, newlines — and string bodies.
 *
 * Prose that QUOTES the banned construction to explain it — which several of
 * the fixed files now do, at length — must not be read as the construction, so
 * comments have to go. String bodies must STAY, because both markers this guard
 * looks for live inside literals: `.startsWith('http')` and
 * `` authorization: `Bearer ${tk}` ``. A mask that blanks string bodies (the
 * usual shape, e.g. `scripts/ci/check-external-origin-urls.mjs`) makes this
 * guard match ZERO and report a clean sweep — measured: the first draft of this
 * file did exactly that, and only the population floors below caught it.
 *
 * It is still a real lexer rather than `line.replace(/\/\/.*$/, '')`, because
 * that truncates any line carrying `//` inside a string — every `'https://…'`
 * in the tree — and would delete the code most worth scanning.
 */
export function stripComments(src: string): string {
  const s = src;
  const out = s.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < s.length; k++) out[k] = s[k] === '\n' ? '\n' : ' ';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end === -1 ? s.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    // Skip OVER a literal without touching it — this is what stops a `//`
    // inside `'https://x'` from being read as a comment.
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) break;
        if (c !== '`' && s[j] === '\n') break;
        j++;
      }
      i = j < s.length && s[j] === c ? j + 1 : j;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Every tracked-looking source file under the scanned roots. */
function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e)) continue;
      walk(p, acc);
    } else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) && !/\.d\.ts$/.test(e)) {
      acc.push(p);
    }
  }
  return acc;
}

/** The absolute-URL passthrough, on ONE logical line of masked code. */
const PASSTHROUGH = /\.startsWith\((['"])https?\1\)\s*\?/g;
/** A bearer credential being attached. */
const BEARER = /Bearer\s*\$\{|authorization:\s*`Bearer|['"]authorization['"]\s*:\s*`Bearer/;
const CONTINUATION = /nextLink/;

interface Scanned {
  rel: string;
  masked: string;
  raw: string;
}

function scanAll(): Scanned[] {
  const files: Scanned[] = [];
  for (const root of ROOTS) {
    for (const p of walk(root)) {
      // Strip \r FIRST: every file here is CRLF, and a `\r` left in place makes
      // `$`-anchored and line-oriented matching quietly wrong.
      const raw = readFileSync(p, 'utf8').replace(/\r/g, '');
      files.push({ rel: path.relative(CONSOLE_ROOT, p).replace(/\\/g, '/'), masked: stripComments(raw), raw });
    }
  }
  return files;
}

const SCANNED = scanAll();

describe('credentialed-URL origin guard — the population is real', () => {
  it('enumerates the console source tree (NOT-RUN must not read as a pass)', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
  });

  it('the mask leaves code intact — it must not blank the world', () => {
    // If stripComments ever ate real code, every downstream zero would be
    // meaningless. Anchor on a construction that is everywhere. Measured on
    // this tree: 200+ files attach a bearer credential.
    const withBearer = SCANNED.filter((f) => BEARER.test(f.masked));
    expect(withBearer.length).toBeGreaterThanOrEqual(100);
  });

  it('the mask blanks PROSE but keeps STRING BODIES (both markers live in literals)', () => {
    const m = stripComments(
      "// path.startsWith('http') ? path : BASE\nconst a = 1;\nconst b = c.startsWith('http') ? c : d;\n",
    );
    // the comment is gone…
    expect(m).not.toContain('path : BASE');
    expect(m).toContain('const a = 1;');
    // …and the real construction on the line below survived the mask.
    PASSTHROUGH.lastIndex = 0;
    expect(PASSTHROUGH.test(m)).toBe(true);
    PASSTHROUGH.lastIndex = 0;
  });

  it('a `//` inside a string literal is not treated as a comment', () => {
    const m = stripComments("const u = 'https://management.azure.com'; const t = `Bearer ${x}`;\n");
    expect(m).toContain('management.azure.com');
    expect(BEARER.test(m)).toBe(true);
  });

  it('stripsCarriageReturnsFirst — a CRLF fixture behaves like an LF one', () => {
    // Every file under apps/fiab-console is CRLF with ZERO bare LF, so a
    // line-oriented check written against LF fixtures is quietly wrong on the
    // real tree — the recorded failure mode is a guard that silently matches
    // nothing and reads as a clean sweep. Show the hazard concretely, then show
    // the strip removes it.
    const crlf = "const url = path.startsWith('http') ? path : `${ARM}${path}`;\r\nconst tk = `Bearer ${t}`;\r\n";
    expect(crlf.split('\n')[0].endsWith(';')).toBe(false); // the trailing \r
    expect(crlf.replace(/\r/g, '').split('\n')[0].endsWith(';')).toBe(true);

    // And the guard's own detection, run the way scanAll() runs it.
    const lines = stripComments(crlf.replace(/\r/g, '')).split('\n');
    PASSTHROUGH.lastIndex = 0;
    expect(PASSTHROUGH.test(lines[0])).toBe(true);
    PASSTHROUGH.lastIndex = 0;
    expect(BEARER.test(lines.join('\n'))).toBe(true);
  });
});

describe('S1 — no absolute-URL passthrough in a credentialed context', () => {
  it('every remaining passthrough is away from a bearer attachment', () => {
    const offenders: string[] = [];
    for (const f of SCANNED) {
      const lines = f.masked.split('\n');
      lines.forEach((line, idx) => {
        PASSTHROUGH.lastIndex = 0;
        if (!PASSTHROUGH.test(line)) return;
        // "In a credentialed context" = a Bearer attachment inside the same
        // ~25-line neighbourhood, which is the whole body of every one of
        // these fetch helpers. Scoping it this way is what keeps a UI `href`
        // builder (spark-monitor's Databricks deep-link, health-pane's <a>)
        // out of a security guard it has nothing to do with.
        const near = lines.slice(Math.max(0, idx - 12), idx + 25).join('\n');
        if (BEARER.test(near)) offenders.push(`${f.rel}:${idx + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the S1 detector is not blind — it flags the construction it exists for', () => {
    // A green guard is AMBIGUOUS between "nothing to find" and "the detector
    // stopped detecting". Feed it the pre-fix source of a real site.
    const preFix = [
      'async function armGet(path: string): Promise<any> {',
      '  const tk = await token();',
      "  const url = path.startsWith('http') ? path : `${ARM}${path}`;",
      '  const res = await fetchWithTimeout(url, {',
      '    headers: { authorization: `Bearer ${tk}`, accept: "application/json" },',
      '  });',
      '  return res;',
      '}',
    ].join('\n');
    const lines = stripComments(preFix).split('\n');
    let flagged = 0;
    lines.forEach((line, idx) => {
      PASSTHROUGH.lastIndex = 0;
      if (!PASSTHROUGH.test(line)) return;
      const near = lines.slice(Math.max(0, idx - 12), idx + 25).join('\n');
      if (BEARER.test(near)) flagged += 1;
    });
    expect(flagged).toBe(1);
  });

  it('...and does not flag the same construction with NO credential nearby', () => {
    const uiLink = [
      'export function links(env: NodeJS.ProcessEnv) {',
      "  const base = dbx.startsWith('http') ? dbx : `https://${dbx}`;",
      '  return [{ href: `${base}/#setting/clusters` }];',
      '}',
    ].join('\n');
    const lines = stripComments(uiLink).split('\n');
    let flagged = 0;
    lines.forEach((line, idx) => {
      PASSTHROUGH.lastIndex = 0;
      if (!PASSTHROUGH.test(line)) return;
      const near = lines.slice(Math.max(0, idx - 12), idx + 25).join('\n');
      if (BEARER.test(near)) flagged += 1;
    });
    expect(flagged).toBe(0);
  });
});

describe('S2 — a credentialed nextLink walker makes a boundary decision', () => {
  const population = SCANNED.filter((f) => BEARER.test(f.masked) && CONTINUATION.test(f.masked));

  it('the population is non-empty (a zero here is NOT-RUN, not clean)', () => {
    expect(population.length).toBeGreaterThanOrEqual(MIN_CONTINUATION_FILES);
  });

  it('every member calls one of the shared boundary helpers', () => {
    const unguarded = population
      .filter((f) => !GUARD_MARKERS.some((m) => f.masked.includes(m)))
      .map((f) => f.rel);
    expect(unguarded).toEqual([]);
  });

  it('the marker check is not vacuous — a file with no marker IS reported', () => {
    // Without this control, `GUARD_MARKERS.some(...)` could match everything
    // (e.g. a marker string that appears in every file) and the assertion above
    // would be green over a completely unguarded tree.
    const fake = {
      rel: 'lib/azure/fake-client.ts',
      raw: '',
      masked: [
        'async function walk() {',
        '  let next = j.nextLink;',
        '  await fetch(next, { headers: { authorization: `Bearer ${tk}` } });',
        '}',
      ].join('\n'),
    };
    expect(BEARER.test(fake.masked) && CONTINUATION.test(fake.masked)).toBe(true);
    expect(GUARD_MARKERS.some((m) => fake.masked.includes(m))).toBe(false);
  });
});
