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
 * WHOLE REPOSITORY, and no file is out of scope because it is new.
 *
 * ── WHAT THAT CLAIM IS AND IS NOT (round 2) ───────────────────────────────
 * An earlier revision of this header said "a site is in scope the moment it
 * lands", flat. Independent review of #4454 planted three ordinary credentialed
 * clients under `lib/azure/` and the guard stayed green on all three — two were
 * not in the population at all. An overstated control is worse than a narrow
 * one, because the next author reads the claim and not the regex, so the claim
 * is now stated to the reach that can be demonstrated:
 *
 *   IN SCOPE, automatically, for any file anywhere in the repo: an absolute-URL
 *   test written in one of the SIX spellings in `ABS_TEST_SPELLINGS`, whose
 *   subject is yielded by ternary, by return (whole or through a transform that
 *   keeps it a URL), or by assign-then-return — and it is GUARDED only when a
 *   boundary primitive is applied to that subject, or to a value carrying it.
 *
 *   NOT IN SCOPE, and not claimed to be: a passthrough written in a SEVENTH
 *   spelling of "is this absolute?". The detector cannot see one, and neither
 *   could the reviewer's independent instrument, for the same reason. That is a
 *   known ceiling, not a solved problem. If you add a new way to ask the
 *   question, add it to `ABS_TEST_SPELLINGS` in the same commit.
 *
 * The three planted shapes are now permanent controls below, one row each, and
 * mutations N1/N2/N3 in `scripts/ci/ghsa-4gvx-mutation-receipts.mjs` revert each
 * widening and prove the row goes RED.
 *
 * ── THE TWO SHAPES, AND THE TWO CHANNELS ───────────────────────────────────
 *   S1  ABSOLUTE PASSTHROUGH — an absolute-URL TEST whose SUBJECT is what the
 *       expression then yields, inside a file that attaches a credential. Six
 *       spellings are recognised (`isAbsoluteHttpUrl(x)`, `startsWith`, a
 *       caret-anchored regex `.test` / `.exec`, `.match(/^http…/)`,
 *       `.indexOf(…) === 0`, `new RegExp('^http…')`) and the match runs over the
 *       WHOLE masked file, so a ternary split across lines is caught and the
 *       distance between the test and the credential is irrelevant. Per-site.
 *   S2  SERVER-CHOSEN CONTINUATION — the address came back in the response.
 *       Channel A is the BODY (`nextLink` / `@odata.nextLink`); channel B is a
 *       response HEADER (`Location`, `Operation-Location`,
 *       `Azure-AsyncOperation`, `Content-Location`). Channel A is asserted at
 *       file level; channel B is per-site, and its per-site count is REGEX
 *       MATCHES — a line with two header reads contributes two.
 *
 * ── HOW A SITE BECOMES COMPLIANT ───────────────────────────────────────────
 * Either (a) its enclosing top-level block applies one of the shared boundary
 * primitives TO THE SITE'S SUBJECT (presence of the primitive is not enough —
 * see `guardBindsSubject`), or (b) the line DECLARES its input channel with
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

/**
 * Floors. MEASURED at this head, not guessed. See "NOT-RUN IS NOT A PASS".
 *
 * THE FIRST TWO ARE APPROXIMATE BY CONSTRUCTION and the header count is a MATCH
 * count, both stated because a reviewer reproduced them and got different
 * numbers for good reasons:
 *   - the walk reads the FILESYSTEM, not the git index, so any untracked file
 *     counts. A clean worktree gives ~4574 / ~268 where this comment once said
 *     4570 / 270. Both pass; the delta is the instrument, not a disagreement.
 *   - `HEADER_CONTINUATION` is matched GLOBALLY, so a line with two header reads
 *     contributes two. 43 is regex matches, not distinct lines.
 */
const MIN_FILES_SCANNED = 4100; // measured ~4574 repo-wide
const MIN_BEARER_FILES = 240; // measured ~268
/** Files that attach a credential AND read a body continuation. Measured: 20. */
const MIN_BODY_CONTINUATION_FILES = 18;
/** Response-header continuation MATCHES in credentialed files. Measured: 43. */
const MIN_HEADER_CONTINUATION_SITES = 38;
/** Absolute-URL passthrough sites in credentialed files. Measured: 10. */
const MIN_S1_SITES = 9;

/**
 * The shared boundary primitives, as CALLS. A site satisfies the guard by
 * calling one — and, for an S1 site, by calling one on the value it passes
 * through (see {@link guardBindsSubject}).
 */
const GUARD_MARKERS = [
  'resolveSameOriginUrl(',
  'sameOriginUrlOrNull(',
  'assertSameOrigin(',
  'isSameOrigin(',
  'isContinuationAllowed(',
  'ppRequestUrl(', // power-platform-auth's wrapper around resolveSameOriginUrl
  // host-match.ts — the sibling primitive, for suffix-scoped boundaries (a Key
  // Vault in THIS cloud) rather than a single fixed origin.
  'hostHasSuffix(',
  'urlHostHasSuffix(',
  'hostHasAnySuffix(',
];

/**
 * `sameOriginAs` is an OPTION passed to the paging walker, not a call, so it
 * needs its own shape — and the shape has to exclude the TYPE that declares it.
 *
 * `paging-budget.ts` declares both `sameOriginAs?: string;` (the options
 * interface) and `sameOriginAs?: string,` (a parameter). The plain
 * `'sameOriginAs:'` substring this replaces therefore made a NON-optional
 * interface field — `interface Opts { sameOriginAs: string; }` — mark a file
 * compliant; the optional form escaped only by accident, because the `?` broke
 * the substring. Independent review of #4454 measured both and found them
 * latent (0 of the 20 S2 members were compliant by that route). Closed here
 * rather than left to become live: the VALUE must not be a bare TS type.
 */
// The lookahead sits IMMEDIATELY after the `:` on purpose. Written as
// `:\s*(?!…)` the `\s*` backtracks to zero width and the lookahead is then
// evaluated against the SPACE, which no type name matches — so the exclusion
// silently never fires. Measured while writing the control below.
const SAME_ORIGIN_OPTION =
  /\bsameOriginAs\s*:(?!\s*(?:string|number|boolean|any|unknown|null|undefined)\s*[;,}\n])\s*/g;

/**
 * Offsets of every real boundary-primitive USE in `structural`.
 *
 * GIVE THIS THE `structural` MASK, NOT `code`. `lexSource` deliberately
 * PRESERVES string bodies in `code` — both of the detector's own needles live
 * inside literals — which means a marker inside a LITERAL scored as a boundary
 * decision: `throw new Error('call resolveSameOriginUrl(x, base) first')` marked
 * a file compliant. `structural` blanks literal bodies, so only a marker in real
 * code counts. Also measured latent by the #4454 review, and closed here.
 *
 * A DEFINITION is not a use. `power-platform-auth.ts` exports `ppRequestUrl`,
 * which is itself a marker, so the very function that performs the boundary
 * check satisfied the check by NAMING ITSELF — and reverting its body to the
 * passthrough left the guard green. Measured: mutation M3 in
 * `scripts/ci/ghsa-4gvx-mutation-receipts.mjs` survived exactly this way on the
 * first run of the harness, which is why the harness exists.
 */
export function boundaryPrimitiveSites(structural: string): number[] {
  const out: number[] = [];
  for (const m of GUARD_MARKERS) {
    let i = structural.indexOf(m);
    while (i !== -1) {
      const before = structural.slice(Math.max(0, i - 30), i);
      if (!/\b(?:function|class|interface|type)\s+$/.test(before)) out.push(i);
      i = structural.indexOf(m, i + m.length);
    }
  }
  SAME_ORIGIN_OPTION.lastIndex = 0;
  let m2: RegExpExecArray | null;
  while ((m2 = SAME_ORIGIN_OPTION.exec(structural))) out.push(m2.index);
  return out.sort((a, b) => a - b);
}

/** True when `structural` CALLS a shared boundary primitive — anywhere in it. */
export function callsBoundaryPrimitive(structural: string): boolean {
  return boundaryPrimitiveSites(structural).length > 0;
}

/**
 * The at-the-line channel declaration. The `(channel)` group is required and the
 * reason must be non-empty — a bare marker is not a declaration.
 */
const EXEMPT_DECLARATION = /SAME-ORIGIN-EXEMPT\(([a-z-]+)\)\s*:\s*(\S[^\n]*)/;

/**
 * How many declared exemptions exist. A CEILING, not a target: raising it is an
 * edit to this file and therefore a reviewed act.
 *
 * 5 -> 6 in round 2. Independent review of #4454 walked all 18 absolute-URL
 * tests the detector DISCARDED and found one wrong discard:
 * `cloud-endpoints.aasServerBase` passes the tested value through as
 * `trimmed.replace(/\/+$/, '')`, which the old bare-identifier `return S` shape
 * could not see. It is the same `LOOM_AAS_SERVER` deploy-config class as
 * `aasXmlaUrl` 58 lines below — so benign, but undeclared because the DETECTOR
 * was blind, not because anyone decided it was exempt. The ceiling was therefore
 * a bound on the passthroughs the detector happened to spell-match, not on how
 * many exist. Widening `yieldsAfter` made the site visible; this is the reviewed
 * act of declaring it.
 */
const MAX_DECLARED_EXEMPTIONS = 6;

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
 * a per-client judgement, not a sweep.
 *
 * WHERE THIS DEBT IS TRACKED. In THIS LIST, and nowhere else yet. An earlier
 * revision of this comment said "tracked in the follow-up issue named in the PR
 * body"; the body named no such issue and no such issue existed — the same
 * defect class this branch already shipped once (a `TOUCH_EXEMPT` comment citing
 * a harness that did not cover the suite), and a comment asserting a fact it did
 * not establish is a `deploy-integrity.md` R7 violation. No issue is opened
 * while GHSA-4gvx-9p49-p43g is an unpublished draft advisory, because a public
 * issue is a disclosure channel. The list is a real tracking artifact rather
 * than a promise: the two rows below make it shrink-only — a file NOT in it
 * fails, and a file that CLOSES and is left in it also fails.
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

/** `name` appears in `text` as a whole identifier, not as a property of another. */
function mentionsIdentifier(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`).test(text);
}

/**
 * `[start, end)` of the STATEMENT containing `index`.
 *
 * Read off the `structural` mask, so a `;` or a brace inside a string, a
 * template or a regex cannot end a statement early.
 *
 * WHY THIS EXISTS AT ALL — IT REPLACES A CHARACTER BUDGET. The previous draft
 * reached for the ternary's `?` with `[\s\S]{0,40}` and for a `return` with
 * `{0,120}`. Independent review of #4454 planted a client that pushed the `?`
 * past forty characters with an inline comment; the site vanished from the
 * population entirely. A number in a detector is a hiding place, and "DISTANCE
 * is not a hiding place" was true at line scale and false at character scale. A
 * syntactic span has no budget to exceed.
 */
export function statementBounds(
  structural: string,
  index: number,
  lo = 0,
  hi = structural.length,
): [number, number] {
  let start = lo;
  let d = 0;
  for (let i = index; i >= lo; i--) {
    const c = structural[i];
    if (c === ')' || c === ']' || c === '}') d++;
    else if (c === '(' || c === '[' || c === '{') { if (d === 0) { start = i + 1; break; } d--; }
    else if (c === ';' && d === 0) { start = i + 1; break; }
  }
  let end = hi;
  d = 0;
  for (let i = index; i < hi; i++) {
    const c = structural[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { if (d === 0) { end = i; break; } d--; }
    else if (c === ';' && d === 0) { end = i; break; }
  }
  return [start, end];
}

/**
 * The CONSEQUENT of the `if` whose CONDITION contains `index`, as `[start, end)`
 * — or null when the site is not inside an `if (…)` at all.
 *
 * Walking to the opening paren rather than matching `if\s*\(\s*!?\s*$` right
 * before the site also means a compound condition (`if (ready && isAbs(x))`)
 * is recognised, which the fixed-prefix match was not.
 */
export function ifConsequent(structural: string, index: number, hi: number): [number, number] | null {
  let d = 0;
  let open = -1;
  for (let i = index - 1; i >= 0; i--) {
    const c = structural[i];
    if (c === ')') d++;
    else if (c === '(') { if (d === 0) { open = i; break; } d--; }
    else if (c === ';' || c === '{' || c === '}') break;
  }
  if (open < 0) return null;
  if (!/\bif\s*$/.test(structural.slice(Math.max(0, open - 8), open))) return null;
  d = 0;
  let close = -1;
  for (let i = open; i < hi; i++) {
    const c = structural[i];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) { close = i; break; } }
  }
  if (close < 0) return null;
  let s = close + 1;
  while (s < hi && /\s/.test(structural[s])) s++;
  if (structural[s] === '{') {
    d = 0;
    for (let i = s; i < hi; i++) {
      const c = structural[i];
      if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) return [s, i + 1]; }
    }
    return [s, hi];
  }
  for (let i = s; i < hi; i++) if (structural[i] === ';') return [s, i + 1];
  return [s, hi];
}

/**
 * Methods that take a URL APART rather than pass it along.
 * `return v.match(/^https:\/\/([^.]+)\./)` is a parser, not a passthrough, and
 * flagging it would put a URL parser in a security guard it has nothing to do
 * with — which is how a guard earns the ignore-it reflex.
 *
 * DELIBERATELY AN EXCLUSION, SO THE DEFAULT IS FLAGGED. `aasServerBase` yielded
 * `trimmed.replace(/\/+$/, '')` and was invisible to the previous draft for no
 * better reason than that spelling — the narrower-enumeration failure this whole
 * file exists to avoid, one level down. An enumeration that fails CLOSED makes
 * the next unrecognised spelling visible instead of silent.
 */
const URL_DESTRUCTURING_METHODS =
  /^(?:match|exec|test|split|indexOf|lastIndexOf|search|charAt|charCodeAt|codePointAt|startsWith|endsWith|includes|localeCompare|length)$/;

/**
 * True when `text` yields `name` — whole, or through a transform that keeps it a
 * URL — immediately after `lead` (`?` for a ternary, `return`/`=>` for a return).
 *
 * The transform arm is not decoration: `kv-secrets-client` yields
 * `ov.replace(/\/$/, '')` and `cloud-endpoints.aasXmlaUrl` yields
 * `s.endsWith('/xmla') ? s : …`. A bare-identifier-only match drops both.
 */
function yieldsAfter(text: string, name: string, lead: string): boolean {
  const re = new RegExp(
    `${lead}\\s*${escapeRe(name)}(?![\\w$])\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*))?`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[1] || !URL_DESTRUCTURING_METHODS.test(m[1])) return true;
  }
  return false;
}

/**
 * True when the tested value is what the expression YIELDS — i.e. the absolute
 * URL is passed through rather than taken apart.
 *
 * THREE SHAPES, EACH SCOPED SYNTACTICALLY, NEVER BY A CHARACTER BUDGET:
 *   1. TERNARY — `isAbs(p) ? p : …`, searched over the enclosing STATEMENT.
 *   2. EARLY RETURN — `if (isAbs(p)) return p;`, searched over that `if`'s
 *      CONSEQUENT, and allowing an identity-preserving transform on the way out.
 *   3. ASSIGN-THEN-RETURN — `if (isAbs(p)) u = p;` … `return u;`. The most
 *      natural refactor of the very construction being guarded, and the previous
 *      draft did not recognise it as a yield at all: review planted it as a real
 *      client and the site never entered the population.
 *
 * The NEGATION matters in all three: `if (!isAbs(ref)) return ref;` yields the
 * value in the branch where it is NOT absolute.
 *
 * `structural` defaults to `code` so a literal-free fixture can call this with
 * one argument; real scanning always passes the mask and the enclosing block.
 */
export function yieldsTestedValue(
  code: string,
  site: AbsTestSite,
  structural: string = code,
  block: [number, number] = [0, code.length],
): boolean {
  const S = escapeRe(site.subject);
  const be = block[1];
  const before = code.slice(Math.max(0, site.index - 60), site.index);
  const negated = /[!]\s*$/.test(before);

  const [, stmtEnd] = statementBounds(structural, site.end, 0, be);
  if (yieldsAfter(code.slice(site.end, stmtEnd), site.subject, '\\?')) return !negated;

  const cons = ifConsequent(structural, site.index, be);
  if (!cons) return false;
  const consText = code.slice(cons[0], cons[1]);
  // The ternary can live INSIDE the consequent too — `if (isAbs(s)) return
  // s.endsWith('/xmla') ? s : …` is `aasXmlaUrl`, a real declared site.
  if (yieldsAfter(consText, site.subject, '\\?')) return !negated;
  if (yieldsAfter(consText, site.subject, '(?:return|=>)')) return !negated;

  const assign = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=(?![=>])\\s*${S}\\s*[;\\n]`).exec(consText);
  if (assign && yieldsAfter(code.slice(cons[1], be), assign[1], '(?:return|=>)')) return !negated;
  return false;
}

/**
 * The names in `structural` that CARRY the site's subject — the subject itself
 * plus anything assigned from an expression mentioning it, transitively.
 *
 * This exists because the canonical fix introduces exactly one hop:
 *
 *     const rel = isAbsoluteHttpUrl(path) || path.startsWith('/') ? path : `/${path}`;
 *     return resolveSameOriginUrl(rel, armBase(), 'the ARM token');
 *
 * Demanding `path` itself as the primitive's argument would fail the very shape
 * this change adopts, so the alias closure is what makes the subject
 * requirement usable rather than merely strict.
 */
function subjectAliases(structural: string, subject: string): Set<string> {
  const aliases = new Set<string>([subject]);
  const head = /^[A-Za-z_$][\w$]*/.exec(subject)?.[0];
  if (head) aliases.add(head);
  const ASSIGN = /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=(?![=>])/g;
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    ASSIGN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASSIGN.exec(structural))) {
      const name = m[1];
      if (aliases.has(name)) continue;
      const from = m.index + m[0].length;
      const [, to] = statementBounds(structural, from);
      const rhs = structural.slice(from, to);
      for (const a of aliases) {
        if (mentionsIdentifier(rhs, a)) { aliases.add(name); grew = true; break; }
      }
    }
    if (!grew) break;
  }
  return aliases;
}

/**
 * True when a boundary primitive is applied TO THE SITE'S SUBJECT (or to a value
 * carrying it) somewhere in `structuralBlock`.
 *
 * WHY PRESENCE IS NOT ENOUGH — THIS IS M3, ONE LEVEL DEEPER. M3 taught the guard
 * that a DEFINITION is not a use. But `callsBoundaryPrimitive` was still only a
 * PRESENCE test over the enclosing block: it never asked whether the value that
 * is passed through is the value that went through the primitive. Independent
 * review of #4454 planted a client whose block called
 * `resolveSameOriginUrl(somethingElse, base)` and then returned the tested value
 * verbatim, and the guard scored it GUARDED. That is the same tautology M3 was —
 * the marker satisfies the check without the check being performed on the
 * subject — and it is the second time in one change that a fix turned out to be
 * a NARROWER ENUMERATION than the class it claimed to close.
 */
export function guardBindsSubject(structuralBlock: string, subject: string): boolean {
  const aliases = subjectAliases(structuralBlock, subject);
  for (const at of boundaryPrimitiveSites(structuralBlock)) {
    const [s, e] = statementBounds(structuralBlock, at);
    const stmt = structuralBlock.slice(s, e);
    for (const a of aliases) if (mentionsIdentifier(stmt, a)) return true;
  }
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
  /**
   * A boundary decision covering this site is made in its enclosing block.
   *
   * For an S1 site that means the primitive is applied to the site's SUBJECT
   * ({@link guardBindsSubject}). For a header site there is no extractable
   * subject — the value is whatever `headers.get(…)` returned, and the capture
   * and the decision are routinely in different functions by design — so it
   * stays a PRESENCE test. Channel B's assertion is `fileGuarded` anyway; this
   * flag is the dump's annotation, and the difference is stated rather than
   * left for a reader to assume.
   */
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
      const [bs, be] = enclosingTopLevelBlock(f.structural, site.index);
      if (!yieldsTestedValue(f.code, site, f.structural, [bs, be])) continue;
      const { no } = lineAt(f, site.index);
      out.push({
        rel: f.rel,
        line: no,
        text: site.text.trim(),
        guarded: guardBindsSubject(f.structural.slice(bs, be), site.subject),
        fileGuarded: callsBoundaryPrimitive(f.structural),
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
      const { no } = lineAt(f, m.index);
      out.push({
        rel: f.rel,
        line: no,
        text: m[0],
        guarded: callsBoundaryPrimitive(f.structural.slice(bs, be)),
        fileGuarded: callsBoundaryPrimitive(f.structural),
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
    // at this head: arm-client, mcp-client, postgres-flex-client,
    // power-platform-auth.
    expect(S1.filter((f) => f.guarded).length).toBeGreaterThanOrEqual(3);
  });

  it('THE PRIMITIVE MUST BE APPLIED TO THE SUBJECT — naming it in the block is not enough', () => {
    // N2 from the #4454 round-2 review, planted there as a real client under
    // lib/azure and scored GUARDED by the previous draft. It is M3's tautology
    // one level deeper: `callsBoundaryPrimitive` asked whether a primitive was
    // NAMED in the block, never whether the value passed through is the value
    // that went through it.
    const evasive = [
      'function n2Url(p: string) {',
      "  const probe = resolveSameOriginUrl('/ping', BASE, 'the ARM token');",
      '  void probe;',
      "  if (/^https?:\\/\\//i.test(p)) return p;",
      '  return `${BASE}${p}`;',
      '}',
    ].join('\n');
    const { code, structural } = lexSource(evasive);
    const site = absoluteUrlTests(code).filter((s) => yieldsTestedValue(code, s, structural))[0];
    expect(site).toBeDefined();
    // The marker IS present in the block — the old check passed on exactly this.
    expect(callsBoundaryPrimitive(structural)).toBe(true);
    // …but it is not applied to `p`, nor to anything carrying `p`.
    expect(guardBindsSubject(structural, site.subject)).toBe(false);

    // …and the one-hop alias the real fix uses still counts, or the requirement
    // would reject the canonical shape this change adopts everywhere.
    const real = [
      'function armUrl(path: string) {',
      "  const rel = isAbsoluteHttpUrl(path) || path.startsWith('/') ? path : `/${path}`;",
      "  return resolveSameOriginUrl(rel, armBase(), 'the ARM token');",
      '}',
    ].join('\n');
    const lx = lexSource(real);
    const realSite = absoluteUrlTests(lx.code).filter((s) => yieldsTestedValue(lx.code, s, lx.structural))[0];
    expect(realSite).toBeDefined();
    expect(guardBindsSubject(lx.structural, realSite.subject)).toBe(true);
  });

  it('ASSIGN-THEN-RETURN is a yield — the most natural refactor of the guarded construction', () => {
    // N1 from the #4454 round-2 review. `yieldsTestedValue` recognised only
    // `return`/`=>`, so a client that assigned the absolute value to a local and
    // returned the local never entered the population AT ALL — it was not
    // scored wrongly, it was invisible.
    const src = [
      'function n1Url(p: string) {',
      '  let u = `${BASE}${p}`;',
      "  if (/^https?:\\/\\//i.test(p)) u = p;",
      '  return u;',
      '}',
    ].join('\n');
    const { code, structural } = lexSource(src);
    expect(absoluteUrlTests(code).filter((s) => yieldsTestedValue(code, s, structural))).toHaveLength(1);

    // …and the local has to actually be YIELDED. An assignment that goes
    // nowhere is not a passthrough.
    const inert = [
      'function logOnly(p: string) {',
      '  let seen = "";',
      "  if (/^https?:\\/\\//i.test(p)) seen = p;",
      '  return `${BASE}${p}` + seen.length;',
      '}',
    ].join('\n');
    const lx = lexSource(inert);
    expect(absoluteUrlTests(lx.code).filter((s) => yieldsTestedValue(lx.code, s, lx.structural))).toHaveLength(0);
  });

  it('a CHARACTER BUDGET is a hiding place — the `?` may sit any distance from the test', () => {
    // N3 from the #4454 round-2 review: an inline comment pushed the ternary's
    // `?` past the old `[\s\S]{0,40}` window and the site vanished. Comments are
    // blanked to SPACES (offsets are preserved), so the distance survives the
    // mask — which is precisely why a character budget could be defeated with a
    // comment. The span is now the enclosing STATEMENT.
    const pad = ' '.repeat(300);
    const src = [
      'function n3Url(p: string) {',
      `  const u = /^https?:\\/\\//i.test(p) /*${pad}*/ ? p : \`\${BASE}\${p}\`;`,
      '  return u;',
      '}',
    ].join('\n');
    const { code, structural } = lexSource(src);
    expect(absoluteUrlTests(code).filter((s) => yieldsTestedValue(code, s, structural))).toHaveLength(1);

    // …and the statement really is the bound: a `? p` in the NEXT statement is
    // not this site's ternary.
    const next = [
      'function unrelated(p: string, q: boolean) {',
      "  const abs = /^https?:\\/\\//i.test(p);",
      '  const pick = q ? p : BASE;',
      '  return abs ? BASE : pick.length;',
      '}',
    ].join('\n');
    const lx = lexSource(next);
    expect(absoluteUrlTests(lx.code).filter((s) => yieldsTestedValue(lx.code, s, lx.structural))).toHaveLength(0);
  });

  it('a marker inside a STRING LITERAL is not a boundary decision', () => {
    // `lexSource` must PRESERVE string bodies in `code` (the detector's own
    // needles live in literals), so scoring compliance off `code` let an error
    // MESSAGE that merely names the primitive mark a file compliant. Review of
    // #4454 measured this latent — 0 of the 20 S2 members were compliant by a
    // literal-only marker — and latent is the moment to close it.
    const lie = "function f(u) {\n  throw new Error('call resolveSameOriginUrl(u, base) first');\n}";
    const lx = lexSource(lie);
    expect(lx.code).toContain('resolveSameOriginUrl(');   // still visible in `code`
    expect(callsBoundaryPrimitive(lx.structural)).toBe(false);

    // The TYPE that declares the paging option is not a use of it either —
    // optional or not. The old `'sameOriginAs:'` substring caught the
    // non-optional form; the optional form escaped only because of the `?`.
    expect(callsBoundaryPrimitive(lexSource('interface O { sameOriginAs: string; }').structural)).toBe(false);
    expect(callsBoundaryPrimitive(lexSource('interface O { sameOriginAs?: string; }').structural)).toBe(false);
    expect(callsBoundaryPrimitive(lexSource('walk(cb, { sameOriginAs: armBase() });').structural)).toBe(true);
    expect(callsBoundaryPrimitive(lexSource('walk(cb, { sameOriginAs: base });').structural)).toBe(true);
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

describe('the two resolver copies cannot silently diverge', () => {
  /**
   * `azure-functions/report-subscriptions` is a separate npm package with its
   * own build, so it cannot import the console module — it carries a faithful
   * SUBSET copy instead.
   *
   * WHOLE-REPO SCANNING DOES NOT ANSWER THE DRIFT RISK, and the PR body said it
   * did. Scanning detects a NEW passthrough in that package; it cannot detect
   * the two IMPLEMENTATIONS diverging, because the copy IS a definition of the
   * marker — weaken the copy's body and `insights-engine.ts` still calls
   * `resolveSameOriginUrl(` and still scores compliant. What actually guards
   * divergence is this row: the shared function bodies must agree, modulo
   * comments and whitespace.
   */
  const CONSOLE_RESOLVER = 'apps/fiab-console/lib/util/same-origin-url.ts';
  const COPY_RESOLVER = 'azure-functions/report-subscriptions/src/same-origin-url.ts';
  /** The four the copy defines. It omits `sameOriginUrlOrNull` / `assertSameOrigin`. */
  const SHARED = ['isAbsoluteHttpUrl', 'originOf', 'isSameOrigin', 'resolveSameOriginUrl'];

  /** A named top-level function's BODY, comments blanked and whitespace collapsed. */
  function bodyOf(source: string, name: string): string | null {
    const { code, structural } = lexSource(source.replace(/\r/g, ''));
    const at = structural.indexOf(`function ${name}(`);
    if (at === -1) return null;
    let d = 0;
    let open = -1;
    for (let i = at; i < structural.length; i++) {
      if (structural[i] === '(') d++;
      else if (structural[i] === ')') { d--; if (d === 0) { open = i + 1; break; } }
    }
    if (open === -1) return null;
    while (open < structural.length && structural[open] !== '{') open++;
    d = 0;
    for (let i = open; i < structural.length; i++) {
      if (structural[i] === '{') d++;
      else if (structural[i] === '}') { d--; if (d === 0) return code.slice(open, i + 1).replace(/\s+/g, ' ').trim(); }
    }
    return null;
  }

  it('every function the copy defines has the SAME body as the console module', () => {
    const consoleSrc = readFileSync(path.join(REPO_ROOT, CONSOLE_RESOLVER), 'utf8');
    const copySrc = readFileSync(path.join(REPO_ROOT, COPY_RESOLVER), 'utf8');
    const differing: string[] = [];
    for (const fn of SHARED) {
      const a = bodyOf(consoleSrc, fn);
      const b = bodyOf(copySrc, fn);
      // A function that cannot be FOUND is a divergence too, not a skip — that
      // is how an equivalence check quietly stops checking.
      if (a === null || b === null || a !== b) differing.push(`${fn} (console=${a === null ? 'ABSENT' : 'present'}, copy=${b === null ? 'ABSENT' : 'present'})`);
    }
    expect(differing).toEqual([]);
  });

  it('the check is not vacuous — a one-character weakening of the copy IS reported', () => {
    const consoleSrc = readFileSync(path.join(REPO_ROOT, CONSOLE_RESOLVER), 'utf8');
    const copySrc = readFileSync(path.join(REPO_ROOT, COPY_RESOLVER), 'utf8');
    // The exact weakening R1 applies to the console module: compare by PREFIX
    // instead of by ORIGIN. Applied to the COPY here, in memory only.
    const weakened = copySrc.replace(
      'if (target.origin !== baseOrigin) throw new OffOriginUrlError(\'off-origin\', credentialLabel);',
      'if (!raw.startsWith(base)) throw new OffOriginUrlError(\'off-origin\', credentialLabel);',
    );
    expect(weakened).not.toBe(copySrc); // the find string must still exist
    expect(bodyOf(weakened, 'resolveSameOriginUrl')).not.toBe(bodyOf(consoleSrc, 'resolveSameOriginUrl'));
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
    expect(real && callsBoundaryPrimitive(real.structural)).toBe(true);
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
