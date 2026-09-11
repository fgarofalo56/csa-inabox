/**
 * GUARD — a credentialed client may not send its token to an address a SERVER
 * chose (advisory GHSA-4gvx-9p49-p43g).
 *
 * ── WHY THIS FILE WAS REWRITTEN, AND WHAT THE PREVIOUS DRAFT GOT WRONG ─────
 * The first draft derived its population from the filesystem — the right idea —
 * but keyed DETECTION to two literal spellings (`.startsWith('http') ?` and the
 * token `nextLink`) inside two directories of one app. Independent review of
 * #4454 measured what that missed, and it was not marginal:
 *
 *   - `lib/azure/arm-client.ts:40` — THE shared ARM fetcher, the module whose
 *     own header tells new ARM code to use it — carried the construction spelled
 *     as `/^https?:\/\//i.test(path)` plus an early return. Invisible.
 *   - `lib/azure/fabric-client.ts` and `lib/azure/powerplatform-client.ts` took
 *     an absolute `Location` / `Operation-Location` value — a RESPONSE HEADER,
 *     a channel the old population did not model at all.
 *   - `azure-functions/report-subscriptions/src/insights-engine.ts:79` carried
 *     the EXACT spelling the old S1 detects, and was outside its roots.
 *
 * A fourth mechanism, found while re-keying and worse than any of them: the
 * comment mask ITSELF was blind. `stripComments` had no regex-literal lexer, so
 * in `/^https?:\/\//i.test(x)` the regex's closing `\/` followed by the literal
 * `/` reads as `//` — a line comment — and the mask blanked the REST OF THE
 * LINE. Any needle keyed to that spelling would have matched zero no matter how
 * it was written, and a `Bearer` attach on the same line disappeared too. That
 * is proved by `preserves a REGEX LITERAL that ends in \//` below, and it is why
 * "add the regex spelling to the needle list" would not have worked.
 *
 * ── THE PRINCIPLE ─────────────────────────────────────────────────────────
 * Key to the SHAPE, never to the spelling, and never to a list of known sites.
 * This class has now been closed five times — `networking-client.resolveArmUrl`
 * (#2652), `foundry-cs-client.armListAll` (#4443 review), the walker adoption in
 * #4454, and the four sites above — and every earlier fix was a NARROWER
 * ENUMERATION than the class. A hand-maintained list of offenders has the same
 * defect one level up: the file you forget to add is the file that ships the
 * bug. So the population is derived from the filesystem on every run, over the
 * WHOLE REPOSITORY, and a site is in scope the moment it lands.
 *
 * ── THE TWO SHAPES, AND THE TWO CHANNELS ───────────────────────────────────
 *   S1  ABSOLUTE PASSTHROUGH — an absolute-URL TEST whose SUBJECT is what the
 *       expression then yields, inside a file that attaches a credential. Seven
 *       spellings are recognised (`isAbsoluteHttpUrl(x)`, `startsWith`, a
 *       caret-anchored regex `.test` / `.exec`, `.match(/^http…/)`,
 *       `.indexOf(…) === 0`, `new RegExp('^http…')`) and the match runs over the
 *       WHOLE masked file, so a ternary split across lines is caught and the
 *       distance between the test and the credential is irrelevant. Per-site.
 *   S2  SERVER-CHOSEN CONTINUATION — the address came back in the response.
 *       Channel A is the BODY (`nextLink` / `@odata.nextLink`); channel B is a
 *       response HEADER (`Location`, `Operation-Location`,
 *       `Azure-AsyncOperation`, `Content-Location`). Channel A is asserted at
 *       file level; channel B is per-site.
 *
 * ── HOW A SITE BECOMES COMPLIANT ───────────────────────────────────────────
 * Either (a) its enclosing top-level block calls one of the shared boundary
 * primitives, or (b) the line DECLARES its input channel with
 * `SAME-ORIGIN-EXEMPT(<channel>): <reason>`. (b) exists because some of these
 * sites resolve the DEPLOY'S OWN endpoint — `LOOM_TRINO_URL`, `LOOM_AAS_SERVER`
 * — and an origin check of the boundary against itself is a tautology, not a
 * control. It is deliberately NOT a filename allowlist: the declaration lives at
 * the site, appears in every diff that touches it, and a new site with no
 * declaration FAILS. The number of declarations is also ceilinged below, so the
 * escape cannot grow quietly.
 *
 * A heuristic was tried first and rejected: "exempt the site if its enclosing
 * block reads `process.env`". It is itself an evasion — one unrelated
 * `process.env` mention anywhere in a long function silences the site — which is
 * the precise failure mode this file exists to stop.
 *
 * ── NOT-RUN IS NOT A PASS ──────────────────────────────────────────────────
 * A scanner that stops scanning reports zero violations, which reads exactly
 * like a clean tree. Every population carries a FLOOR asserted before any
 * verdict. The floors are measured, not guessed, and they are set close to the
 * measurement (the previous draft's 2000 against an actual 4273 would have
 * tolerated losing half the tree).
 *
 * ── SEEING THE POPULATION ──────────────────────────────────────────────────
 * A guard whose population you cannot inspect is a guard you have to take on
 * trust, and every review of this class has had to rebuild the scan by hand to
 * check it. Run it with `GHSA_4GVX_GUARD_DUMP=1` and it prints every site it found,
 * flagged `G` (a boundary decision in its enclosing block) and `D` (a declared
 * channel), so the numbers in the PR body can be reproduced in one command:
 *
 *   GHSA_4GVX_GUARD_DUMP=1 npx vitest run lib/util/__tests__/credential-url-origin-guard.test.ts
 *
 * NOT `LOOM_*`. Every `process.env.LOOM_…` read in the console is a member of
 * the bicep env-sync population (`scripts/ci/__tests__/env-sync-population.test.mjs`),
 * so a `LOOM_GUARD_DUMP` here would turn a test-only debug switch into a
 * deployment variable nothing emits — which that gate correctly failed on.
 *
 * ── CRLF ───────────────────────────────────────────────────────────────────
 * Source under apps/fiab-console is CRLF. A `$`-anchored line regex and a
 * `//.*$` comment stripper both misbehave on `\r`, so `\r` is stripped FIRST and
 * `stripsCarriageReturnsFirst` proves it on a CRLF fixture.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const CONSOLE_ROOT = path.resolve(__dirname, '..', '..', '..');
/** The WHOLE repository — see "outside its roots" in the header. */
const REPO_ROOT = path.resolve(CONSOLE_ROOT, '..', '..');

/**
 * Directories the walk does not enter, each with the reason it is excluded.
 * Stated here because "the guard's scope limit is unwritten" was itself a
 * finding: an unstated exclusion is indistinguishable from an oversight.
 */
const SKIP_DIRS = new Set([
  'node_modules', // dependencies — not code this repo ships
  '.next', 'dist', 'out', 'build', '.turbo', 'coverage', // build output
  '.git', // object store
  '.claude', // agent worktrees hold FULL COPIES of the repo; entering them would
  //           double-count every file and make FILES_SCANNED depend on how many
  //           agents happen to be running. No product source lives here.
  'temp', // scratch, gitignored
  '.venv', 'venv', '.pytest_cache', // python tooling
  '__tests__', // tests QUOTE the banned construction on purpose (this file does)
]);

/** Floors. MEASURED at this head, not guessed. See "NOT-RUN IS NOT A PASS". */
const MIN_FILES_SCANNED = 4100; // measured 4570 repo-wide
const MIN_BEARER_FILES = 240; // measured 270
/** Files that attach a credential AND read a body continuation. Measured: 20. */
const MIN_BODY_CONTINUATION_FILES = 18;
/** Per-site response-header continuations in credentialed files. Measured: 43. */
const MIN_HEADER_CONTINUATION_SITES = 38;
/** Absolute-URL passthrough sites in credentialed files. Measured: 8. */
const MIN_S1_SITES = 7;

/** The shared boundary primitives. A site satisfies the guard by calling one. */
const GUARD_MARKERS = [
  'resolveSameOriginUrl(',
  'sameOriginUrlOrNull(',
  'assertSameOrigin(',
  'isSameOrigin(',
  'isContinuationAllowed(',
  'sameOriginAs:',
  'ppRequestUrl(', // power-platform-auth's wrapper around resolveSameOriginUrl
  // host-match.ts — the sibling primitive, for suffix-scoped boundaries (a Key
  // Vault in THIS cloud) rather than a single fixed origin.
  'hostHasSuffix(',
  'urlHostHasSuffix(',
  'hostHasAnySuffix(',
];

/**
 * True when `text` CALLS a shared boundary primitive.
 *
 * A DEFINITION is not a use. `power-platform-auth.ts` exports `ppRequestUrl`,
 * which is itself a marker, so the very function that performs the boundary
 * check satisfied the check by NAMING ITSELF — and reverting its body to the
 * passthrough left the guard green. Measured: mutation M3 in
 * `scripts/ci/ghsa-4gvx-mutation-receipts.mjs` survived exactly this way on the
 * first run of the harness, which is why the harness exists.
 */
export function callsBoundaryPrimitive(text: string): boolean {
  for (const m of GUARD_MARKERS) {
    let i = text.indexOf(m);
    while (i !== -1) {
      const before = text.slice(Math.max(0, i - 30), i);
      if (!/\b(?:function|class|interface|type)\s+$/.test(before)) return true;
      i = text.indexOf(m, i + m.length);
    }
  }
  return false;
}

/**
 * The at-the-line channel declaration. The `(channel)` group is required and the
 * reason must be non-empty — a bare marker is not a declaration.
 */
const EXEMPT_DECLARATION = /SAME-ORIGIN-EXEMPT\(([a-z-]+)\)\s*:\s*(\S[^\n]*)/;

/**
 * How many declared exemptions exist. A CEILING, not a target: raising it is an
 * edit to this file and therefore a reviewed act.
 */
const MAX_DECLARED_EXEMPTIONS = 5;

/**
 * S2 channel B DEBT — files that read a server-chosen continuation HEADER and
 * make no boundary decision anywhere. Measured at this head.
 *
 * WHY THE ASSERTION IS PER-FILE AND NOT PER-SITE. The header READ and the
 * boundary DECISION are routinely in different functions and that is correct
 * design, not a defect: `fabric-client.call()` captures `Location` from a 202
 * and hands it back, and `operationUrl()` — a different top-level block — is
 * where it becomes a request target and where the origin is now pinned.
 * Demanding the decision at the capture site would have flagged the FIXED file.
 * So channel B carries exactly the same caveat channel A does: it proves the
 * file makes a boundary decision, not that the decision covers every site in it.
 * The per-site count below is what proves the DETECTOR still sees them all.
 *
 * WHY A RESIDUAL LIST IS NOT THE "NARROWER ENUMERATION" THIS FILE ARGUES
 * AGAINST. The rejected pattern enumerates the sites that ARE fixed and treats
 * everything unlisted as fine. This is the inverse: detection is shape-keyed and
 * exhaustive, every file is found, and the list records which found files are
 * still open. A file NOT in this list fails. A file that CLOSES and is left in
 * the list also fails, so the list cannot rot into a rubber stamp — it can only
 * shrink without editing this file.
 *
 * These are LRO pollers (`Location` / `Azure-AsyncOperation`), the same class as
 * the two fixed in #4454, and each needs its own service base chosen correctly —
 * a per-client judgement, not a sweep. Tracked in the follow-up issue named in
 * the PR body; this guard is what stops the debt growing meanwhile.
 */
const HEADER_CHANNEL_RESIDUAL = [
  'apps/fiab-console/lib/azure/aas-client.ts',
  'apps/fiab-console/lib/azure/aas-incremental-refresh.ts',
  'apps/fiab-console/lib/azure/aas-server-client.ts',
  'apps/fiab-console/lib/azure/adf-client.ts',
  'apps/fiab-console/lib/azure/app-service-slots-client.ts',
  'apps/fiab-console/lib/azure/azure-sql-client.ts',
  'apps/fiab-console/lib/azure/devcenter-client.ts',
  'apps/fiab-console/lib/azure/doc-intelligence-client.ts',
  'apps/fiab-console/lib/azure/powerbi-client.ts',
  'apps/fiab-console/lib/azure/servicebus-data-client.ts',
  'apps/fiab-console/lib/azure/stream-analytics-client.ts',
  'apps/fiab-console/lib/azure/synapse-dev-client.ts',
  'apps/fiab-console/lib/install/provisioners/kql-dashboard.ts',
  'apps/fiab-console/lib/install/provisioners/lakehouse.ts',
];

// ---------------------------------------------------------------------------
// The lexer
// ---------------------------------------------------------------------------

/** A `/` here starts a REGEX literal, not a division. */
const REGEX_PREV_KEYWORD =
  /\b(return|typeof|instanceof|in|of|case|do|else|yield|await|new|delete|void|throw)$/;

export interface Lexed {
  /** Comments blanked. Strings and regex literals PRESERVED. */
  code: string;
  /** Comments blanked AND string / regex BODIES blanked. For brace depth only. */
  structural: string;
}

/**
 * Blank comments, preserving offsets and newlines — and preserving string AND
 * REGEX LITERAL bodies.
 *
 * STRING BODIES MUST STAY: both of the markers this guard looks for live inside
 * literals — `.startsWith('http')` and `` authorization: `Bearer ${tk}` ``. A
 * mask that blanks string bodies (the usual shape, e.g.
 * `scripts/ci/check-external-origin-urls.mjs`) makes this guard match ZERO and
 * report a clean sweep. Measured: the first draft of this file did exactly that,
 * and only the population floors caught it.
 *
 * REGEX BODIES MUST STAY, AND THE LEXER MUST KNOW WHAT A REGEX IS: see the
 * header. Without the regex arm below, `/^https?:\/\//i.test(x)` is misread as a
 * line comment at its own closing delimiter and the rest of the line vanishes.
 *
 * `structural` is the SAME text with literal bodies blanked, so brace-depth
 * counting cannot be skewed by a `{` inside a string. Two masks, each for its
 * own job — offsets are identical, so a site found in `code` can be located in
 * `structural`.
 */
export function lexSource(s: string): Lexed {
  const code = s.split('');
  const structural = s.split('');
  const blankBoth = (from: number, to: number) => {
    for (let k = from; k < to && k < s.length; k++) {
      const ch = s[k] === '\n' ? '\n' : ' ';
      code[k] = ch;
      structural[k] = ch;
    }
  };
  const blankStructural = (from: number, to: number) => {
    for (let k = from; k < to && k < s.length; k++) structural[k] = s[k] === '\n' ? '\n' : ' ';
  };
  let i = 0;
  let lastSig = '';
  let lastSigIdx = -1;
  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      blankBoth(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end === -1 ? s.length : end + 2;
      blankBoth(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) break;
        if (c !== '`' && s[j] === '\n') break;
        j++;
      }
      const end = j < s.length && s[j] === c ? j + 1 : j;
      blankStructural(i + 1, Math.max(i + 1, end - 1));
      lastSig = c; lastSigIdx = i;
      i = end;
      continue;
    }
    if (c === '/') {
      // Regex literal or division? Decided by the previous significant token:
      // after an identifier, `)` or `]` it is division UNLESS that word is a
      // keyword that can be followed by an expression.
      let regexOk: boolean;
      if (lastSigIdx < 0) regexOk = true;
      else if (/[A-Za-z0-9_$)\]]/.test(lastSig)) regexOk = REGEX_PREV_KEYWORD.test(s.slice(0, lastSigIdx + 1));
      else regexOk = true;
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < s.length) {
          const d = s[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '\n') break;
          if (inClass) { if (d === ']') inClass = false; j++; continue; }
          if (d === '[') { inClass = true; j++; continue; }
          if (d === '/') { closed = true; break; }
          j++;
        }
        if (closed) {
          let k = j + 1;
          while (k < s.length && /[a-z]/.test(s[k])) k++;
          blankStructural(i + 1, j);
          lastSig = '/'; lastSigIdx = i;
          i = k;
          continue;
        }
      }
    }
    if (!/\s/.test(c)) { lastSig = c; lastSigIdx = i; }
    i++;
  }
  return { code: code.join(''), structural: structural.join('') };
}

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

/**
 * Every recognised spelling of "is this an absolute http(s) URL?". The capture
 * group that is not a quote delimiter is the SUBJECT — the value being tested,
 * which is what makes it possible to ask whether the passthrough yields it.
 */
const ABS_TEST_SPELLINGS: RegExp[] = [
  // The SHARED primitive counts too. It is the honest spelling of this test, so
  // the fixed sites stay IN the population as guarded members — which is a
  // positive control on the real tree, not a fixture — and a future
  // `isAbsoluteHttpUrl(x) ? x : …` with no resolver beside it is still caught.
  // Leaving it out would have made adopting the primitive a way to disappear.
  /\bisAbsoluteHttpUrl\(\s*([A-Za-z_$][\w$.?![\]']*)\s*\)/g,
  /([A-Za-z_$][\w$.?![\]']*)\s*\.startsWith\(\s*(['"`])https?(?::\/\/)?\2\s*\)/g,
  /\/\^(?:\\.|\[[^\]\n]*\]|[^\\/\n[])*\/[a-z]*\s*\.(?:test|exec)\s*\(\s*([A-Za-z_$][\w$.?![\]']*)\s*\)/g,
  /([A-Za-z_$][\w$.?![\]']*)\s*\.match\(\s*\/\^(?:\\.|\[[^\]\n]*\]|[^\\/\n[])*\/[a-z]*\s*\)/g,
  /([A-Za-z_$][\w$.?![\]']*)\s*\.indexOf\(\s*(['"`])https?(?::\/\/)?\2\s*\)\s*===?\s*0/g,
  /new RegExp\(\s*(['"`])\^[^'"`\n]*https?[^'"`\n]*\1[^)]*\)\s*\.test\(\s*([A-Za-z_$][\w$.?![\]']*)\s*\)/g,
];

interface AbsTestSite {
  index: number;
  end: number;
  subject: string;
  text: string;
}

/** Every absolute-URL test in `code`, in source order. */
export function absoluteUrlTests(code: string): AbsTestSite[] {
  const out: AbsTestSite[] = [];
  for (const re of ABS_TEST_SPELLINGS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const body = m[0];
      // A regex literal that never mentions http is some other test entirely.
      if (!/https?/i.test(body) && !body.startsWith('isAbsoluteHttpUrl')) continue;
      const subject = m.slice(1).filter((g) => g && !/^['"`]$/.test(g)).pop();
      if (!subject) continue;
      out.push({ index: m.index, end: m.index + body.length, subject, text: body });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the tested value is what the expression YIELDS — i.e. the absolute
 * URL is passed through rather than taken apart.
 *
 * Two shapes, and the NEGATION matters in both. `x.match(/^https:\/\/([^.]+)\./)`
 * extracts a capture group and never yields `x`, and
 * `if (!isAbs(ref)) return ref;` yields the value in the branch where it is NOT
 * absolute. Treating either as a passthrough would put a URL PARSER in a
 * security guard it has nothing to do with, which is how a guard earns the
 * ignore-it reflex.
 */
export function yieldsTestedValue(code: string, site: AbsTestSite): boolean {
  const S = escapeRe(site.subject);
  const after = code.slice(site.end, site.end + 400);
  const before = code.slice(Math.max(0, site.index - 60), site.index);
  const negated = /[!]\s*$/.test(before);
  if (new RegExp(`^[\\s\\S]{0,40}?\\?\\s*${S}\\b`).test(after)) return !negated;
  const guardedIf = /\bif\s*\(\s*!?\s*$/.test(before);
  const yieldsIt = new RegExp(`^[\\s\\S]{0,120}?(?:return|=>)\\s*${S}\\s*[;,)\\n]`).test(after);
  if (guardedIf && yieldsIt) return !negated;
  return false;
}

/**
 * The enclosing TOP-LEVEL block of `index`, as `[start, end)` offsets.
 *
 * The previous draft scoped by LINE DISTANCE (12 above / 25 below). Review
 * measured the ceiling: a helper with 31 lines between the passthrough and the
 * credential attach walked straight through. A brace-depth region has no such
 * number in it — `armUrl()` and `armFetch()` are separate top-level functions,
 * and file-level credential detection (below) is what connects them.
 */
export function enclosingTopLevelBlock(structural: string, index: number): [number, number] {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < index && i < structural.length; i++) {
    const c = structural[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  if (depth === 0) return [0, structural.length];
  let d = depth;
  let j = index;
  for (; j < structural.length; j++) {
    const c = structural[j];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) { j++; break; } }
  }
  let s = start;
  while (s > 0 && structural[s - 1] !== '\n') s--;
  return [s, j];
}

/**
 * A file that can attach a credential to a request.
 *
 * Widened past "a Bearer template literal" because `powerplatform-client.ts`
 * has none: it hands a URL and a SCOPE to a shared transport that mints the
 * token one module away. Keying on the visible `Bearer` made the credential's
 * distance from the URL a hiding place — the same defect as the line window.
 */
const CREDENTIALED =
  /Bearer\s*\$\{|authorization:\s*`Bearer|['"]authorization['"]\s*:\s*`Bearer|\.getToken\s*\(|\bacquireToken\s*\(|[Ss]cope\s*\(\s*\)/;

/** Channel A — the continuation came back in the response BODY. */
const BODY_CONTINUATION = /nextLink/;
/** Channel B — the continuation came back in a response HEADER. */
const HEADER_CONTINUATION =
  /\.headers\.get\(\s*(['"`])(?:operation-location|location|azure-asyncoperation|content-location)\1\s*\)/gi;

// ---------------------------------------------------------------------------
// The population
// ---------------------------------------------------------------------------

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

interface Scanned extends Lexed {
  rel: string;
  lines: string[];
}

function scanAll(): Scanned[] {
  const files: Scanned[] = [];
  for (const p of walk(REPO_ROOT)) {
    // Strip \r FIRST: the tree is CRLF, and a `\r` left in place makes
    // `$`-anchored and line-oriented matching quietly wrong.
    const raw = readFileSync(p, 'utf8').replace(/\r/g, '');
    const lexed = lexSource(raw);
    files.push({
      rel: path.relative(REPO_ROOT, p).replace(/\\/g, '/'),
      ...lexed,
      lines: lexed.code.split('\n'),
    });
  }
  return files;
}

const SCANNED = scanAll();
const CREDENTIALED_FILES = SCANNED.filter((f) => CREDENTIALED.test(f.code));

/** The line `index` falls on (1-based), and that line's text. */
function lineAt(f: Scanned, index: number): { no: number; text: string } {
  const no = f.code.slice(0, index).split('\n').length;
  return { no, text: f.lines[no - 1] ?? '' };
}

/**
 * A site is declared when its own line, or the comment block IMMEDIATELY above
 * it, states the channel.
 *
 * "Immediately above" is walked line by line and stops at the first line that is
 * not a comment, so a declaration cannot be parked at the top of a 400-line file
 * and silently cover every site in it. Attached-to-the-site is the whole point:
 * it is what makes the escape visible in the diff that introduces it.
 */
export function declaredExemption(rawLines: string[], lineNo: number): RegExpMatchArray | null {
  const own = rawLines[lineNo - 1];
  if (own) {
    const m = own.match(EXEMPT_DECLARATION);
    if (m) return m;
  }
  for (let n = lineNo - 1; n >= 1; n--) {
    const t = (rawLines[n - 1] ?? '').trim();
    if (!(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))) break;
    const m = t.match(EXEMPT_DECLARATION);
    if (m) return m;
  }
  return null;
}

const RAW_LINES_BY_REL = new Map<string, string[]>();
for (const f of SCANNED) {
  // The declaration lives in a COMMENT, which the mask blanks, so it is read
  // from the unmasked text. Read once, here, rather than per site.
  RAW_LINES_BY_REL.set(
    f.rel,
    readFileSync(path.join(REPO_ROOT, f.rel), 'utf8').replace(/\r/g, '').split('\n'),
  );
}

interface Finding {
  rel: string;
  line: number;
  text: string;
  /** A shared boundary primitive is called in the site's enclosing block. */
  guarded: boolean;
  /** A shared boundary primitive is called ANYWHERE in the file. */
  fileGuarded: boolean;
  declared: RegExpMatchArray | null;
}

function s1Findings(): Finding[] {
  const out: Finding[] = [];
  for (const f of CREDENTIALED_FILES) {
    const rawLines = RAW_LINES_BY_REL.get(f.rel) as string[];
    for (const site of absoluteUrlTests(f.code)) {
      if (!yieldsTestedValue(f.code, site)) continue;
      const [bs, be] = enclosingTopLevelBlock(f.structural, site.index);
      const block = f.code.slice(bs, be);
      const { no } = lineAt(f, site.index);
      out.push({
        rel: f.rel,
        line: no,
        text: site.text.trim(),
        guarded: callsBoundaryPrimitive(block),
        fileGuarded: callsBoundaryPrimitive(f.code),
        declared: declaredExemption(rawLines, no),
      });
    }
  }
  return out;
}

function headerFindings(): Finding[] {
  const out: Finding[] = [];
  for (const f of CREDENTIALED_FILES) {
    const rawLines = RAW_LINES_BY_REL.get(f.rel) as string[];
    HEADER_CONTINUATION.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEADER_CONTINUATION.exec(f.code))) {
      const [bs, be] = enclosingTopLevelBlock(f.structural, m.index);
      const block = f.code.slice(bs, be);
      const { no } = lineAt(f, m.index);
      out.push({
        rel: f.rel,
        line: no,
        text: m[0],
        guarded: callsBoundaryPrimitive(block),
        fileGuarded: callsBoundaryPrimitive(f.code),
        declared: declaredExemption(rawLines, no),
      });
    }
  }
  return out;
}

const S1 = s1Findings();
const HEADER_SITES = headerFindings();
if (process.env.GHSA_4GVX_GUARD_DUMP) {
  // eslint-disable-next-line no-console
  console.log('DUMP_S1\n' + S1.map((f) => `${f.guarded ? 'G' : '-'}${f.declared ? 'D' : '-'} ${f.rel}:${f.line} ${f.text}`).join('\n'));
  // eslint-disable-next-line no-console
  console.log('DUMP_HDR\n' + HEADER_SITES.map((f) => `${f.guarded ? 'G' : '-'}${f.declared ? 'D' : '-'} ${f.rel}:${f.line}`).join('\n'));
}

// ---------------------------------------------------------------------------

describe('credentialed-URL origin guard — the population is real', () => {
  it('enumerates the whole repository (NOT-RUN must not read as a pass)', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
  });

  it('the scan reaches BEYOND apps/fiab-console/{lib,app}', () => {
    // The old roots were two directories in one app, which is how the literal
    // advisory construction survived in an azure-functions runtime.
    expect(SCANNED.some((f) => f.rel.startsWith('azure-functions/'))).toBe(true);
    expect(SCANNED.some((f) => f.rel.startsWith('apps/fiab-console/lib/'))).toBe(true);
    expect(SCANNED.some((f) => f.rel.startsWith('apps/fiab-console/app/'))).toBe(true);
  });

  it('the mask leaves code intact — it must not blank the world', () => {
    expect(CREDENTIALED_FILES.length).toBeGreaterThanOrEqual(MIN_BEARER_FILES);
  });

  it('the mask blanks PROSE but keeps STRING BODIES (the markers live in literals)', () => {
    const { code } = lexSource(
      "// path.startsWith('http') ? path : BASE\nconst a = 1;\nconst b = c.startsWith('http') ? c : d;\n",
    );
    expect(code).not.toContain('path : BASE');
    expect(code).toContain('const a = 1;');
    expect(absoluteUrlTests(code)).toHaveLength(1);
  });

  it('preserves a REGEX LITERAL that ends in \\// — the mechanism that hid arm-client', () => {
    // A comment stripper with no regex arm sees the regex's closing `\/` plus
    // its delimiter `/` as `//` and blanks the rest of the line. Both the
    // construction AND a Bearer attach on that line disappear. This is the
    // measured reason `ARM_CLIENT_S1_MATCH` was false; a needle for the regex
    // spelling could never have matched.
    const src = "  const u = /^https?:\\/\\//i.test(p) ? p : B; const h = { authorization: `Bearer ${t}` };";
    const { code } = lexSource(src);
    expect(code).toContain('.test(p) ? p : B');
    expect(CREDENTIALED.test(code)).toBe(true);
    expect(absoluteUrlTests(code)).toHaveLength(1);

    // …and the pre-fix mask, reproduced inline, ate it. Without this the claim
    // above is an assertion about a bug nobody can see any more.
    const naive = (s: string) => s.replace(/\/\/[^\n]*/g, '');
    expect(naive(src)).not.toContain('.test(p)');
    expect(CREDENTIALED.test(naive(src))).toBe(false);
  });

  it('a `//` inside a string literal is not treated as a comment', () => {
    const { code } = lexSource("const u = 'https://management.azure.com'; const t = `Bearer ${x}`;\n");
    expect(code).toContain('management.azure.com');
    expect(CREDENTIALED.test(code)).toBe(true);
  });

  it('a division is not mistaken for a regex literal', () => {
    // If it were, everything to the next `/` would be swallowed and the file
    // after it would go unscanned — a silent population collapse.
    const { code } = lexSource("const half = total / 2; const u = p.startsWith('http') ? p : B;\n");
    expect(code).toContain('total / 2');
    expect(absoluteUrlTests(code)).toHaveLength(1);
  });

  it('a regex CHARACTER CLASS containing `/` does not end the literal early', () => {
    // Invented evasion, not one the review listed. `/^https?:\/\/[^/]+\//i` has
    // a `/` INSIDE a character class. A scanner that does not track `[…]` takes
    // that `/` as the closing delimiter, resumes lexing mid-literal, and then
    // meets the real `\//` — which it reads as a line comment and blanks the
    // rest of the line, taking the construction with it. Same mechanism as the
    // arm-client blindness, one level deeper.
    const src = "function f() {\n  const u = /^https?:\\/\\/[^/]+\\//i.test(p) ? p : B;\n  const h = { authorization: `Bearer ${tk}` };\n}\n";
    const { code } = lexSource(src);
    expect(code).toContain('.test(p) ? p : B');
    expect(CREDENTIALED.test(code)).toBe(true);
    expect(absoluteUrlTests(code).filter((s) => yieldsTestedValue(code, s))).toHaveLength(1);
  });

  it('an UNBALANCED brace inside a string cannot borrow a sibling block\'s guard', () => {
    // Invented evasion, not one the review listed. Brace depth decides the
    // enclosing block, and the enclosing block decides whether a boundary
    // decision is present. A lone `{` inside a STRING in an earlier function
    // means depth never returns to 0, so the next function's site is scored
    // against a block that starts back at the guarded one — and inherits its
    // marker. `structural` blanks literal bodies precisely to stop this.
    const src = [
      'function guarded(x: string, b: string) {',
      '  const brace = "{";',
      '  return resolveSameOriginUrl(x, b);',
      '}',
      'function leaky(p: string) {',
      "  const u = p.startsWith('http') ? p : B;",
      '  const h = { authorization: `Bearer ${tk}` };',
      '  return u;',
      '}',
    ].join('\n');
    const { code, structural } = lexSource(src);
    const site = absoluteUrlTests(code).filter((s) => yieldsTestedValue(code, s))[0];
    expect(site).toBeDefined();
    const [bs, be] = enclosingTopLevelBlock(structural, site.index);
    const block = code.slice(bs, be);
    expect(block).toContain('function leaky');
    expect(block).not.toContain('function guarded');
    expect(callsBoundaryPrimitive(block)).toBe(false);
  });

  it('stripsCarriageReturnsFirst — a CRLF fixture behaves like an LF one', () => {
    const crlf = "const url = path.startsWith('http') ? path : `${ARM}${path}`;\r\nconst tk = `Bearer ${t}`;\r\n";
    expect(crlf.split('\n')[0].endsWith(';')).toBe(false); // the trailing \r
    expect(crlf.replace(/\r/g, '').split('\n')[0].endsWith(';')).toBe(true);
    const { code } = lexSource(crlf.replace(/\r/g, ''));
    expect(absoluteUrlTests(code)).toHaveLength(1);
    expect(CREDENTIALED.test(code)).toBe(true);
  });
});

describe('S1 — no absolute-URL passthrough in a credentialed context', () => {
  it('every passthrough either makes a boundary decision or DECLARES its channel', () => {
    const offenders = S1.filter((f) => !f.guarded && !f.declared).map(
      (f) => `${f.rel}:${f.line}  [${f.text}]`,
    );
    expect(offenders).toEqual([]);
  });

  it('the S1 population is non-empty (a zero here is NOT-RUN, not clean)', () => {
    expect(S1.length).toBeGreaterThanOrEqual(MIN_S1_SITES);
  });

  it('at least one REAL site is compliant by GUARD, not by declaration', () => {
    // Without this, a tree where every site had talked its way out with a
    // declaration would look identical to a tree where the fix landed. Measured
    // at this head: arm-client, mcp-client, power-platform-auth.
    expect(S1.filter((f) => f.guarded).length).toBeGreaterThanOrEqual(3);
  });

  it('every declaration names a channel AND gives a reason', () => {
    const bad = S1.filter((f) => f.declared && !(f.declared[1] && f.declared[2]?.trim().length > 8))
      .map((f) => `${f.rel}:${f.line}`);
    expect(bad).toEqual([]);
  });

  it('declared exemptions stay under their ceiling', () => {
    const declared = S1.filter((f) => f.declared);
    expect(declared.length).toBeLessThanOrEqual(MAX_DECLARED_EXEMPTIONS);
  });

  it('the detector flags EVERY spelling it claims to — seven positive controls', () => {
    const bearer = '  const h = { authorization: `Bearer ${tk}` };';
    const cases: Array<[string, string]> = [
      ['shared primitive', '  const url = isAbsoluteHttpUrl(path) ? path : `${ARM}${path}`;'],
      ['startsWith', "  const url = path.startsWith('http') ? path : `${ARM}${path}`;"],
      ['regex .test + early return', '  if (/^https?:\\/\\//i.test(v)) return v;'],
      ['regex .test + ternary', '  const u = /^https?:\\/\\//i.test(t) ? t : `${B}/${t}`;'],
      ['indexOf === 0', "  const u = t.indexOf('http') === 0 ? t : `${B}${t}`;"],
      ['new RegExp', "  const u = new RegExp('^https?://').test(t) ? t : `${B}${t}`;"],
      [
        'MULTILINE ternary (the line-at-a-time detector could not see this)',
        "  const url = path.startsWith('http')\n    ? path\n    : `${ARM}${path}`;",
      ],
    ];
    const flagged: Record<string, number> = {};
    for (const [label, body] of cases) {
      const { code } = lexSource(`function f() {\n${body}\n${bearer}\n}\n`);
      expect(CREDENTIALED.test(code)).toBe(true);
      flagged[label] = absoluteUrlTests(code).filter((s) => yieldsTestedValue(code, s)).length;
    }
    expect(flagged).toEqual({
      'shared primitive': 1,
      'startsWith': 1,
      'regex .test + early return': 1,
      'regex .test + ternary': 1,
      'indexOf === 0': 1,
      'new RegExp': 1,
      'MULTILINE ternary (the line-at-a-time detector could not see this)': 1,
    });
  });

  it('DISTANCE is not a hiding place — a credential 40 lines below is still in scope', () => {
    // The previous draft's window was `idx + 25`. Measured by review: a helper
    // with 31 lines of separation walked through.
    const filler = Array.from({ length: 40 }, (_, i) => `  const pad${i} = ${i};`).join('\n');
    const src = [
      'function armUrl(p: string) {',
      "  if (/^https?:\\/\\//i.test(p)) return p;",
      '  return `${ARM}${p}`;',
      '}',
      filler,
      'async function armFetch(p: string) {',
      '  const tk = await token();',
      '  return fetch(armUrl(p), { headers: { authorization: `Bearer ${tk}` } });',
      '}',
    ].join('\n');
    const { code, structural } = lexSource(src);
    expect(CREDENTIALED.test(code)).toBe(true);
    const sites = absoluteUrlTests(code).filter((s) => yieldsTestedValue(code, s));
    expect(sites).toHaveLength(1);
    // …and the enclosing block is `armUrl`, NOT the whole file: the boundary
    // decision has to be made where the URL is built.
    const [bs, be] = enclosingTopLevelBlock(structural, sites[0].index);
    expect(code.slice(bs, be)).toContain('function armUrl');
    expect(code.slice(bs, be)).not.toContain('armFetch');
  });

  it('...and does NOT flag a URL parser, a negated test, or an uncredentialed href', () => {
    const bearer = '  const h = { authorization: `Bearer ${tk}` };';
    const notPassthrough: Array<[string, string]> = [
      ['capture-group extraction', '  const m = url.match(/^https:\\/\\/([^.]+)\\./i);'],
      ['exec + index', '  return /^https:\\/\\/([^.]+)\\./i.exec(url)?.[1];'],
      ['NEGATED early return (yields the RELATIVE value)', "  if (!/^https?:\\/\\//i.test(ref)) return ref;"],
      ['NEGATED scheme repair', "  if (!/^https?:\\/\\//i.test(v)) v = `https://${v}`;"],
    ];
    const flagged: Record<string, number> = {};
    for (const [label, body] of notPassthrough) {
      const { code } = lexSource(`function f() {\n${body}\n${bearer}\n}\n`);
      flagged[label] = absoluteUrlTests(code).filter((s) => yieldsTestedValue(code, s)).length;
    }
    expect(Object.values(flagged)).toEqual([0, 0, 0, 0]);

    // A UI deep-link builder in a file with NO credential is out of scope
    // entirely — this is what keeps the guard from becoming noise to ignore.
    const uiOnly = lexSource("export function links(dbx: string) {\n  const base = dbx.startsWith('http') ? dbx : `https://${dbx}`;\n  return [{ href: `${base}/#setting/clusters` }];\n}\n");
    expect(CREDENTIALED.test(uiOnly.code)).toBe(false);
  });

  it('the exemption is a DECLARATION, not a marker — a bare token does not satisfy it', () => {
    expect(EXEMPT_DECLARATION.test('// SAME-ORIGIN-EXEMPT')).toBe(false);
    expect(EXEMPT_DECLARATION.test('// SAME-ORIGIN-EXEMPT(deploy-config):')).toBe(false);
    const m = '// SAME-ORIGIN-EXEMPT(deploy-config): LOOM_TRINO_URL is the boundary'.match(EXEMPT_DECLARATION);
    expect(m?.[1]).toBe('deploy-config');
    expect((m?.[2] || '').length).toBeGreaterThan(8);
  });

  it('a declaration cannot be parked away from the site it claims to cover', () => {
    const decl = '// SAME-ORIGIN-EXEMPT(deploy-config): this is the deploy endpoint';
    // Attached: in the comment block directly above the site.
    const attached = [decl, '// (a second comment line does not break the block)', 'const u = x;'];
    expect(declaredExemption(attached, 3)).not.toBeNull();
    // On the site's own line.
    expect(declaredExemption([`const u = x; ${decl}`], 1)).not.toBeNull();
    // Detached by ONE non-comment line — the walk stops there.
    const detached = [decl, 'const unrelated = 1;', 'const u = x;'];
    expect(declaredExemption(detached, 3)).toBeNull();
    // Parked at the top of the file, far from the site.
    const parked = [decl, ...Array.from({ length: 40 }, (_, i) => `const p${i} = ${i};`), 'const u = x;'];
    expect(declaredExemption(parked, parked.length)).toBeNull();
  });
});

describe('S2 channel A — a credentialed nextLink walker makes a boundary decision', () => {
  const population = SCANNED.filter((f) => CREDENTIALED.test(f.code) && BODY_CONTINUATION.test(f.code));

  it('the population is non-empty (a zero here is NOT-RUN, not clean)', () => {
    expect(population.length).toBeGreaterThanOrEqual(MIN_BODY_CONTINUATION_FILES);
  });

  it('every member calls one of the shared boundary helpers', () => {
    const unguarded = population
      .filter((f) => !callsBoundaryPrimitive(f.code))
      .map((f) => f.rel);
    expect(unguarded).toEqual([]);
  });

  it('DEFINING a primitive does not count as CALLING one', () => {
    // `ppRequestUrl` IS a marker and lives in a credentialed file, so the
    // function that performs the boundary check was satisfying the check by
    // naming itself — reverting its body to the passthrough left the guard
    // green (harness mutation M3, first run). Found by the harness, not by
    // reading.
    const decl = "export function ppRequestUrl(target: string, base: string): string {\n  return `${base}${target}`;\n}";
    expect(callsBoundaryPrimitive(decl)).toBe(false);
    const call = "function f(t: string) {\n  return ppRequestUrl(t, base);\n}";
    expect(callsBoundaryPrimitive(call)).toBe(true);
    // …and the real module still counts, because it CALLS resolveSameOriginUrl.
    const real = SCANNED.find((f) => f.rel === 'apps/fiab-console/lib/azure/power-platform-auth.ts');
    expect(real && callsBoundaryPrimitive(real.code)).toBe(true);
  });

  it('the marker check is not vacuous — a file with no marker IS reported', () => {
    const fake = [
      'async function walk() {',
      '  let next = j.nextLink;',
      '  await fetch(next, { headers: { authorization: `Bearer ${tk}` } });',
      '}',
    ].join('\n');
    expect(CREDENTIALED.test(fake) && BODY_CONTINUATION.test(fake)).toBe(true);
    expect(callsBoundaryPrimitive(fake)).toBe(false);
  });
});

describe('S2 channel B — a response HEADER continuation is the same class', () => {
  it('the channel is actually detected (a zero here is NOT-RUN, not clean)', () => {
    expect(HEADER_SITES.length).toBeGreaterThanOrEqual(MIN_HEADER_CONTINUATION_SITES);
  });

  it('the detector is not blind — it flags the construction it exists for', () => {
    const fake = lexSource([
      'async function poll(res: Response) {',
      "  const loc = res.headers.get('operation-location');",
      '  return fetch(loc!, { headers: { authorization: `Bearer ${tk}` } });',
      '}',
    ].join('\n'));
    HEADER_CONTINUATION.lastIndex = 0;
    expect(HEADER_CONTINUATION.test(fake.code)).toBe(true);
    HEADER_CONTINUATION.lastIndex = 0;
  });

  it('every file that reads one makes a boundary decision, or is a KNOWN residual', () => {
    const open = [...new Set(HEADER_SITES.filter((f) => !f.fileGuarded && !f.declared).map((f) => f.rel))].sort();
    const appeared = open.filter((k) => !HEADER_CHANNEL_RESIDUAL.includes(k));
    expect(appeared).toEqual([]);
  });

  it('the residual list is not a rubber stamp — a file that CLOSES must be removed', () => {
    // A list that can only be satisfied from below is a baseline that never
    // tightens. Every entry must still correspond to a real open file, so
    // fixing one forces this file to change.
    const open = new Set(HEADER_SITES.filter((f) => !f.fileGuarded && !f.declared).map((f) => f.rel));
    const stale = HEADER_CHANNEL_RESIDUAL.filter((k) => !open.has(k));
    expect(stale).toEqual([]);
  });

  it('the two files fixed by this change are NOT in the residual', () => {
    // fabric-client and powerplatform-client both read a continuation header and
    // both now pin it; if either regressed it would reappear above rather than
    // here, so this row is the direction check on the two named fixes.
    expect(HEADER_CHANNEL_RESIDUAL).not.toContain('apps/fiab-console/lib/azure/fabric-client.ts');
    expect(HEADER_CHANNEL_RESIDUAL).not.toContain('apps/fiab-console/lib/azure/powerplatform-client.ts');
    const fixed = HEADER_SITES.filter(
      (f) => f.rel === 'apps/fiab-console/lib/azure/fabric-client.ts'
        || f.rel === 'apps/fiab-console/lib/azure/powerplatform-client.ts',
    );
    expect(fixed.length).toBeGreaterThan(0);
    expect(fixed.every((f) => f.fileGuarded)).toBe(true);
  });
});
