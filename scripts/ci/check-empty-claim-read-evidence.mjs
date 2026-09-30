#!/usr/bin/env node
/**
 * GUARDRAIL: empty-claim-read-evidence  (merge-blocker)  — issue #3281
 * ===========================================================================
 * RULE
 *
 *   AN EMPTY-STATE CLAIM MUST BE GATED ON EVIDENCE THAT THE READ SUCCEEDED.
 *
 * Not "the surface has an error bar somewhere". Not "the catch is non-empty".
 * The property is reachability: if the render path that emits "there is nothing
 * here" is still reachable when the read FAILED, the surface asserts as fact
 * something it never established (deploy-integrity.md R7), and the user cannot
 * tell an empty tenant from a broken one.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND GUARD, AND NOT A WIDER `check-editor-read-failure-honesty`
 * ---------------------------------------------------------------------------
 * #3281 measured the sibling guard's reach:
 *
 *     surfaces using useQuery                  :  34   <- the sibling judges these
 *     surfaces using useState+useEffect+fetch  : 506   <- INVISIBLE to it
 *
 * Its RULE 2 resolves `useQuery` fetchers, so the dominant shape in this console
 * — `useState` + `useEffect` + `clientFetch` — was never judged, and the gate
 * still printed OK over 4058 scanned files. The live example was
 * `app/catalog/domains`: an honest "could not reach the route" banner rendered
 * three DOM nodes above a grid asserting "No business domains defined for this
 * tenant yet."
 *
 * WIDENING BY REGEX WAS TRIED FIRST AND FAILED. The attempt is recorded in
 * `check-loaded-flag-honesty.mjs`: 161 candidates -> 35 -> 20 -> 2, and both
 * survivors were false positives (a variable name reused across two components
 * in one file; a proximity window linking a setter to an unrelated fetch chain).
 * Regex proximity cannot express *this failure feeds that claim*.
 *
 * Worse, a token rule keyed to the UNSAFE spelling goes quiet on exactly the
 * files that adopt the fix — this repo has already paid for that
 * (`csa_loom_guard_keyed_to_the_unsafe_pattern`). So this guard is built to make
 * that impossible by construction:
 *
 *   POPULATION MEMBERSHIP IS INDEPENDENT OF THE FIX.
 *
 *   A component is judged because it (a) performs a client read and (b) renders
 *   an EmptyState-family claim. Adopting the fix removes NEITHER. Adoption
 *   changes the VERDICT on a claim; it can never remove the claim from the set
 *   being judged. A new unguarded claim added to an already-fixed file is
 *   therefore still caught — proved mechanically on every run by the embedded
 *   ADOPTER control below.
 *
 * ---------------------------------------------------------------------------
 * HOW IT DECIDES (structural, not textual)
 * ---------------------------------------------------------------------------
 * No dependency is available: the guardrails job runs `node scripts/ci/*.mjs`
 * on a bare checkout with no `pnpm install`, so `typescript` cannot be
 * imported. The analysis is therefore a hand-written structural pass:
 *
 *   1. Blank comments and string/template TEXT while preserving every byte
 *      offset (so `${...}` code inside a template is still analysed and every
 *      reported line number is true). A rule a COMMENT can satisfy measures
 *      nothing.
 *   2. Bracket-match the whole file once -> the ( ) [ ] { } span tree.
 *   3. Split the file into COMPONENT SCOPES at top-level declarations, so a
 *      variable named `err` in one component cannot answer for a claim in its
 *      neighbour (the exact false positive that killed the regex attempt).
 *   4. Per scope, resolve:
 *        - every `useState` -> { var, setter, initial-value class }
 *        - every FAILURE REGION -> `catch` blocks, `.catch(...)` handlers, and
 *          the branch of an `if` on `res.ok` / HTTP status that runs when the
 *          response was NOT ok
 *        - every PROMOTION REGION -> `finally` blocks and `.finally(...)`
 *        - ERROR SIGNALS  = state vars whose setter runs in a failure region
 *          with a NON-TRIVIAL argument (`setErr(e.message)` counts;
 *          `setLoading(false)` does not — that is the promotion, not a signal)
 *        - LOAD SENTINELS = nullish-initialised state vars never written on a
 *          failure path (their truthiness IS the proof the read returned)
 *   5. For each `<EmptyState>` / `<GuidedEmptyState>` / `<GuidedEmptyStateLauncher>`,
 *      compute the conditions that must hold FOR IT TO RENDER, with polarity:
 *        `A && claim`            -> A required TRUE
 *        `A ? claim : _`         -> A required TRUE
 *        `A ? _ : claim`         -> A required FALSE
 *        `if (A) return _;` above it, same function body -> A required FALSE
 *      Conjunctions decompose under a true requirement, disjunctions under a
 *      false one; `!` flips polarity. POLARITY IS LOAD-BEARING: in the original
 *      /catalog/domains defect the empty grid sat in the ALTERNATE of
 *      `loading && !error ? <Spinner/> : …`, so `error` was mentioned in a
 *      dominating test and still could not stop the claim. A guard that merely
 *      looked for the identifier would have called that surface safe.
 *   6. VERDICT. The claim is SAFE if any required literal is evidence the read
 *      succeeded (see EVIDENCE below); UNGUARDED if none is; UNKNOWN if the
 *      scope could not be resolved. UNKNOWN IS NOT SAFE — it is ratcheted
 *      separately and reported separately.
 *
 * EVIDENCE (the only things that count)
 *   E1  required-TRUE  `X`            X is a nullish-init state var never written
 *                                     on a failure path  (`domains && …`)
 *   E2  required-FALSE `X`            X is an error signal              (`!err && …`)
 *   E4  required-TRUE  `X.a…`         a nested field of a state var that the
 *                                     failure path rewrites or that starts
 *                                     nullish (`state.data?.ok && …`)
 *   E5  `X !== null` / `X === null` etc. — resolved to E1/E2 with polarity
 *   E6  required-FALSE `Q.isError` or `W(Q).isError` — a react-query outcome.
 *       ALL of these must hold, or it is not evidence:
 *         a. Q is bound in the SAME component as `const Q = useQuery({…})` —
 *            `const` only (a `let` can be rebound after the call), and the
 *            options object is the whole argument list and uses ONLY
 *            E6_OPTION_KEYS: `select` can rewrite the folded status,
 *            `initialData` / `placeholderData` show data no read produced, and
 *            `enabled` can leave the query pending with nothing fetched.
 *         b. the literal is required FALSE — the claim is on the not-errored
 *            side (never inside `if (…isError) return <EmptyState/>`, which the
 *            early-return pass misreads, and never under a return that is
 *            itself CONDITIONAL inside `if (…isError) { … }`; E6 refuses both
 *            by flag).
 *         c. the isError is COMPLETE:
 *              `Q.isError`    — Q's queryFn fails LOUDLY: it calls nothing
 *                               imported (other than `clientFetch`), EVERY
 *                               same-file fetching helper it calls is itself
 *                               loud, it makes at most one direct fetch whose
 *                               every not-ok branch throws and never returns,
 *                               every `.ok` / `.status` read sits in such a test
 *                               (bar a plain `status: R.status` copy), and
 *                               every catch throws and never returns;
 *              `W(Q).isError` — W is a same-file function with ONE `return`,
 *                               whose returned `isError` is `<param>.isError`
 *                               OR'd with `status >= 400` (plus only null /
 *                               typeof guards, never `<` / `<=`), where status
 *                               is `<param>.data?.status` itself — AND Q's
 *                               queryFn is `() => H(…)` for a same-file H that
 *                               merges its one fetch's status LAST
 *                               (`return { ...json, status: res.status }`).
 *                               Otherwise Q must be loud as above.
 *            W is proved from its body, never trusted from its name.
 *         d. SETTLED: the claim also requires `!Q.isPending`, `Q.isSuccess` or
 *            `Q.data`. `isLoading` is NOT enough — in react-query v5 it is
 *            `isPending && isFetching`, so a paused (offline) query is neither
 *            loading nor errored and has no data.
 *         e. REACH: the claim is not inside a `useMemo` / `useCallback` body,
 *            nor inside an arrow whose parameters rebind Q.
 *         f. DATA LINK: every emptiness test on the claim's render path (a
 *            condition reading `.length` / `.size`) reads ONLY Q's data —
 *            `Q.data`, `W(Q).data`, or a const in the component derived PURELY
 *            from Q's data (every free identifier is Q or such a const) — and
 *            there is at least one such test. This is the rule implemented for
 *            "the claim's data comes from Q"; it is stricter than "Q is the
 *            only useQuery feeding the branch".
 *       (#4771. Before E6 a react-query surface could only be baselined, even
 *       when gated correctly. Six claims are now SAFE under E6: 5 that main
 *       baselined, across 4 files, plus 1 this PR adds — the cockpit's
 *       breakdown claim.)
 *
 * (E3 — "a loaded flag set only on success" — was measured, judged
 * indefensible, and REMOVED. See verdictFor().)
 *
 * `X.length === 0` is deliberately NOT evidence: emptiness is the CLAIM, never
 * the proof.
 *
 * ---------------------------------------------------------------------------
 * KNOWN IMPRECISION, STATED RATHER THAN HIDDEN
 * ---------------------------------------------------------------------------
 *   - An `<EmptyState>` used AS the error surface (rendered only WHEN the error
 *     state is truthy, e.g. `error.status === 404 ? <EmptyState title="App not
 *     found"/> : …`) is reported UNGUARDED. The guard cannot read the status
 *     comparison, and it refuses to key on the message text. These are
 *     baselined; they are also worth a human look, because the same branch
 *     after a 500 would be a false claim.
 *   - A claim whose data arrives by PROP from a fetching ancestor is NOT judged
 *     at all — the component holds no read of its own. That population is
 *     counted and reported separately on every run, never folded into "OK".
 *   - A read held in a CUSTOM HOOK's return value can never be classified SAFE,
 *     however honestly it is gated. `states` is collected by `stRe` (§5) which
 *     matches `= useState` only, so a root bound as `const [stores, reload] =
 *     useApi(url)` is not in `info.states` and `verdictFor()` skips every
 *     literal rooted at it. Measured on 2026-09-05 in
 *     `foundry-sub-editors.tsx#DatastoreBrowsePanel`: after adding the
 *     dominating `if (!stores.data) return <TableSkeleton/>` the required
 *     literals became `[!stores.loading, !stores.error, stores.data,
 *     rows.length]` — the evidence IS required and IS visible in the literal
 *     list — and the verdict stayed `unguarded`. That claim is baselined for
 *     this reason, not because the read is unproven. Admitting custom-hook
 *     roots would reclassify a large share of the existing `unguarded`
 *     population at once and strand the baseline as stale everywhere, so it is
 *     a deliberate deferral rather than an oversight. `useQuery` is the ONE
 *     hook admitted, and only under E6's conditions.
 *   - E6 is conservative in known ways. A destructured `const { data, isError }
 *     = useQuery(…)`, a shorthand or positional `queryFn`, any option outside
 *     E6_OPTION_KEYS, a fetcher in another file, and a derived const whose
 *     initialiser mentions anything but the gated query's data (even pure UI
 *     state such as a search box) all leave the claim UNGUARDED.
 *     It trusts react-query's own contract that `isError` is true after a
 *     rejected queryFn; it does not model a queryFn that resolves 200 with an
 *     error body the not-ok test does not read. A gated 200 (`{ items: [],
 *     gate }`) is not an error to E6 either — the component must refuse the
 *     claim under the gate itself (the cockpit does, #4771).
 *   - E2 does not yet carry E6's round-6 tightening: its useState analogs of
 *     the #4771 re-review shapes (a catch or not-ok branch that returns, two
 *     fetches, a conditional return under the error test, a claim in a
 *     useMemo, no settled gate) are tracked on #4800, not fixed here, because
 *     tightening E2 moves real claims and needs a baseline decision.
 *   - The early-return pass reads `if (COND) return <EmptyState/>` — where the
 *     claim IS the returned value — as if COND were required FALSE. It should
 *     be TRUE. Correcting it moves 3 claims from safe to unguarded
 *     (agent-quality-panel.tsx:431, :580; data-product-detail.tsx:783) and so
 *     needs a baseline RAISE; left for an operator decision (#4771 report).
 *
 * ---------------------------------------------------------------------------
 * EMBEDDED CONTROLS (run on EVERY invocation, not behind a flag)
 * ---------------------------------------------------------------------------
 * A ratchet whose population can drain to zero can end up protecting nothing,
 * and an analyser that silently stops parsing reports a clean tree. So a set of
 * fixtures is analysed in memory before the repo is — among them:
 *
 *   DEFECT  the real pre-fix /catalog/domains shape  -> must be UNGUARDED
 *   FIXED   the shipped /admin/domains shape         -> must be SAFE
 *   ADOPTER the FIXED shape PLUS one new unguarded claim in the SAME component
 *           -> must be SAFE for the old claim AND UNGUARDED for the new one
 *   QUERY / QUERY_SWAP  the finops cockpit's react-query shape -> SAFE (E6),
 *           and the same shape reading ANOTHER query's data -> UNGUARDED
 *   QUERY_BARE  the same RESOLVING fetcher gated on a bare `Q.isError`
 *           -> UNGUARDED (a resolved non-2xx never sets isError)
 *
 * The full list is CONTROLS (§8); the CLI prints its size on every run.
 *
 * The ADOPTER control is the anti-blindness proof: it fails the build if
 * adopting the fix ever makes the analyser stop judging the file.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = process.cwd();
const CONSOLE_DIR = join(REPO, 'apps', 'fiab-console');
const SCAN_ROOTS = [join(CONSOLE_DIR, 'lib'), join(CONSOLE_DIR, 'app')].filter(existsSync);
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'empty-claim-read-evidence-baseline.json');

/** The shared empty-state primitives. web3-ui.md forbids hand-rolled empties. */
const CLAIM_TAGS = ['EmptyState', 'GuidedEmptyState', 'GuidedEmptyStateLauncher'];

/** Files that DEFINE the primitives, not consumers of them. */
const CLAIM_DEFINITION_FILES = new Set([
  'apps/fiab-console/lib/components/empty-state.tsx',
  'apps/fiab-console/lib/components/shared/guided-empty-state.tsx',
  'apps/fiab-console/lib/components/pipeline/guided-empty-state.tsx',
]);

const rel = (p) => relative(REPO, p).split(sep).join('/');

// ===========================================================================
// 1. Offset-preserving blanking of comments and string/template TEXT.
// ===========================================================================

/**
 * Replace comment bodies and string contents with spaces, keeping every other
 * byte (and every newline) exactly where it was.
 *
 * Template literals keep their `${ … }` code — a guard condition can live
 * inside an interpolation, and blanking it would make the analyser hallucinate
 * a simpler expression than the one that ships.
 *
 * Regex literals are recognised by the standard "what can precede a regex"
 * heuristic, because an unrecognised `/…'…/` would otherwise open a phantom
 * string and desynchronise every offset after it.
 */
export function blankNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };

  /**
   * Could the `/` at `i` be starting a regex literal?
   *
   * `<` and `}` are DELIBERATELY absent from the predecessor set. Both are legal
   * regex predecessors in JS, and both are far more often JSX here:
   * `</Badge>)}</TableCell>` and `{c.correct}/{c.total})` each parsed as a regex,
   * swallowed brackets, and desynchronised the brace depth for the rest of the
   * file — which collapsed five sibling components into one scope on
   * dlp-panel.tsx. Nor can a regex start `/>`, `/{`, `/ `, `/=` or `//` here:
   * those are the self-closing tag, JSX interpolation, division, divide-assign
   * and a comment.
   *
   * This predicate is shared with the template-interpolation scanner. When it
   * was NOT — the interpolation used a looser "any `/` that is not a comment" —
   * `${(d.sessions / maxDaily) * 100}%` read as a regex and ate the rest of the
   * line, unbalancing eight more files.
   */
  // Deliberately SHORT. `in`, `of`, `case`, `do` and `else` are common English
  // words, and JSX prose puts them right before a slash: the header cell
  // `Tokens (in/out)` in foundry-sub-editors.tsx read as `in` + a regex and ate
  // the closing paren. Only keywords that never appear as prose immediately
  // before `/` stay in.
  const KEYWORD_BEFORE_REGEX = new Set(['return', 'typeof', 'throw', 'await', 'yield']);
  const looksLikeRegexStart = (i) => {
    if (src[i] !== '/') return false;
    if ('>{/= \t\n'.includes(src[i + 1] ?? '')) return false;
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    const prev = j >= 0 ? src[j] : '';
    if ('(,=:[!&|?;'.includes(prev)) return true;
    // `return /[",\n\r]/.test(s)` — a keyword may precede a regex, and missing
    // that one let the `[` and the `"` inside it corrupt share-explorer.tsx.
    if (/[A-Za-z0-9_$]/.test(prev)) {
      let s = j;
      while (s >= 0 && /[A-Za-z0-9_$]/.test(src[s])) s--;
      return KEYWORD_BEFORE_REGEX.has(src.slice(s + 1, j + 1));
    }
    return false;
  };


  let i = 0;
  const scanTemplate = (start) => {
    // start points at the opening backtick.
    let k = start + 1;
    while (k < n) {
      if (src[k] === '\\') { blank(k); if (k + 1 < n) blank(k + 1); k += 2; continue; }
      if (src[k] === '`') return k + 1;
      if (src[k] === '$' && src[k + 1] === '{') {
        // Keep the interpolation's code; recurse for nested strings, templates
        // and REGEX LITERALS. The regex case is not hypothetical: warehouse-editor
        // has `${ctasSchema.replace(/]/g, '')}` inside a template, and counting
        // that `]` as a bracket unbalanced the file.
        k += 2;
        let depth = 1;
        while (k < n && depth > 0) {
          const c = src[k];
          if (c === '{') { depth++; k++; continue; }
          if (c === '}') { depth--; k++; continue; }
          if (c === '`') { k = scanTemplate(k); continue; }
          if (c === '"' || c === "'") { k = scanQuoted(k); continue; }
          if (c === '/' && looksLikeRegexStart(k)) {
            const end = scanRegex(k);
            if (end > k) { k = end; continue; }
          }
          k++;
        }
        continue;
      }
      blank(k);
      k++;
    }
    return k;
  };

  const scanQuoted = (start) => {
    const q = src[start];
    let k = start + 1;
    while (k < n) {
      if (src[k] === '\\') { blank(k); if (k + 1 < n) blank(k + 1); k += 2; continue; }
      if (src[k] === q) return k + 1;
      blank(k);
      k++;
    }
    return k;
  };

  /**
   * Is the quote at `start` really opening a STRING LITERAL, or is it an
   * apostrophe in JSX text?
   *
   * This is not a nicety. `Author vector algorithms + profiles that vector
   * fields bind to (a field's <em>Vector profile</em> …)` in
   * foundry-sub-editors.tsx opened a phantom string that ran 900 lines to the
   * next apostrophe, swallowing four brackets and every component boundary in
   * between. Two independent tests, either of which is sufficient:
   *
   *   1. A string literal is never preceded by an identifier character or by
   *      `)` / `]` — but English possessives and contractions always are
   *      (`field's`, `don't`). JS keywords that legally precede a literal
   *      (`return 'x'`, `case 'y'`) are allowed back in explicitly.
   *   2. A single- or double-quoted literal cannot span a newline. If no
   *      closing quote appears before the line ends, it was never a string.
   */
  const KEYWORD_BEFORE_STRING = new Set([
    'return', 'case', 'typeof', 'in', 'of', 'do', 'else', 'new', 'await', 'yield',
    'delete', 'void', 'throw', 'instanceof', 'extends', 'from', 'import', 'export',
    'as', 'default', 'satisfies', 'key', 'startsWith', 'endsWith', 'includes',
  ]);
  const opensString = (start) => {
    let j = start - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    const prev = j >= 0 ? src[j] : '';
    if (/[A-Za-z0-9_$]/.test(prev)) {
      let s = j;
      while (s >= 0 && /[A-Za-z0-9_$]/.test(src[s])) s--;
      if (!KEYWORD_BEFORE_STRING.has(src.slice(s + 1, j + 1))) return false;
    } else if (prev === ')' || prev === ']') {
      return false;
    }
    const q = src[start];
    for (let k = start + 1; k < n; k++) {
      if (src[k] === '\\') { k++; continue; }
      if (src[k] === q) return true;
      if (src[k] === '\n') return false;
    }
    return false;
  };

  /**
   * Blank a regex literal starting at `start` (the `/`). Returns the index just
   * past the closing `/`, or `start` when this is not a regex after all.
   *
   * It probes for the closing delimiter BEFORE blanking anything: an earlier
   * draft blanked as it scanned and then gave up on a newline, leaving a half-
   * blanked line behind — which is a corruption the balance check would report
   * as UNKNOWN forever.
   */
  const scanRegex = (start) => {
    let k = start + 1; let inClass = false; let end = -1;
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '\n') break;
      if (src[k] === '[') inClass = true;
      else if (src[k] === ']') inClass = false;
      else if (src[k] === '/' && !inClass) { end = k; break; }
      k++;
    }
    if (end < 0) return start;
    for (let j = start + 1; j < end; j++) blank(j);
    return end + 1;
  };

  while (i < n) {
    const c = src[i];
    // `//` is a line comment UNLESS it is a URL scheme separator. JSX text
    // carries real URLs (`<code>https://airflow.contoso.com</code>)`), and
    // treating that as a comment blanked the rest of the line — including a
    // closing paren — which unbalanced airflow-job-editor.tsx.
    //
    // The `:` must be IMMEDIATELY adjacent. An earlier draft skipped whitespace
    // first, and since the look-back reads the ORIGINAL source (not the blanked
    // copy), a comment line ending in `:` made the NEXT comment line look like a
    // URL — so `// everyone lands on THEIR compute), then …` was parsed as code
    // and donated a stray `)`. A URL scheme never has a space before its `//`.
    if (c === '/' && src[i + 1] === '/' && src[i - 1] !== ':') {
      while (i < n && src[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i += 2; continue; }
    // `/*` opens a block comment only when it does NOT follow an identifier
    // character. JSX prose carries glob paths — `<code>platform/fiab/bicep/
    // modules/synapse/*.bicep</code>` — and treating that `/*` as a comment ran
    // to the NEXT `*/`, twenty lines away inside a real `{/* … */}`, swallowing
    // four brackets of live JSX in between.
    if (c === '/' && src[i + 1] === '*' && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? ' ')) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) blank(i);
      continue;
    }
    if ((c === '"' || c === "'") && opensString(i)) { i = scanQuoted(i); continue; }
    if (c === '"' || c === "'") { i++; continue; }
    if (c === '`') { i = scanTemplate(i); continue; }
    if (looksLikeRegexStart(i)) {
      const end = scanRegex(i);
      if (end > i) { i = end; continue; }
    }
    i++;
  }
  return out.join('');
}

// ===========================================================================
// 2. Bracket span tree.
// ===========================================================================

/**
 * Every matched ( ) [ ] { } pair in the file. Angle brackets are deliberately
 * NOT tracked: `<` is also a comparison and a generic, and a mis-paired angle
 * bracket would corrupt the whole tree. Every construct this guard reasons
 * about — JSX expression containers, call arguments, arrow bodies — is
 * brace/paren delimited.
 */
export function bracketPairs(text) {
  const pairs = [];
  const stack = [];
  const OPEN = { '(': ')', '[': ']', '{': '}' };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (OPEN[c]) { stack.push({ open: i, ch: c }); continue; }
    if (c === ')' || c === ']' || c === '}') {
      // Tolerate a stray closer (JSX text can contain one) rather than
      // desynchronising: pop only when it matches.
      for (let s = stack.length - 1; s >= 0; s--) {
        if (OPEN[stack[s].ch] === c) {
          const top = stack.splice(s, 1)[0];
          pairs.push({ open: top.open, close: i, ch: top.ch });
          break;
        }
      }
    }
  }
  pairs.sort((a, b) => a.open - b.open);
  return pairs;
}

/**
 * Is the blanked text bracket-balanced?
 *
 * A well-formed .tsx file always is: JSX text cannot contain a bare `{` or `}`
 * (they must be written `{'{'}`), and every other bracket is code. So an
 * imbalance means THE ANALYSER lost sync — a string, template, comment or
 * regex it mis-scanned — not that the file is odd.
 *
 * That distinction is the whole point. When the analyser cannot parse a file it
 * must say UNKNOWN, never "no violations here": an unparsed file reported as
 * clean is the "UNKNOWN reported as a negative" failure this repo keeps paying
 * for. This check is what makes the UNKNOWN bucket real rather than decorative.
 */
function balanced(text) {
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { d--; if (d < 0) return false; }
  }
  return d === 0;
}

/** Spans enclosing `idx`, outermost first, restricted to [lo, hi). */
function enclosing(pairs, idx, lo, hi) {
  return pairs
    .filter((p) => p.open >= lo && p.close <= hi && p.open < idx && p.close > idx)
    .sort((a, b) => a.open - b.open);
}

/** The innermost span enclosing `idx`, or null. */
function innermost(pairs, idx) {
  let best = null;
  for (const p of pairs) {
    if (p.open < idx && p.close > idx) {
      if (!best || p.open > best.open) best = p;
    }
  }
  return best;
}

/**
 * Positions of the operators this analyser cares about, at depth 0 of
 * [lo, hi). `?.` and `??` are excluded (optional chaining / nullish coalescing
 * are not ternaries), as is a `?` immediately followed by `:` (a TS optional).
 */
function depth0Ops(text, lo, hi) {
  const ops = [];
  let depth = 0;
  for (let i = lo; i < hi; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if (c === '&' && text[i + 1] === '&') { ops.push({ op: '&&', at: i }); i++; continue; }
    if (c === '|' && text[i + 1] === '|') { ops.push({ op: '||', at: i }); i++; continue; }
    if (c === '?') {
      if (text[i + 1] === '.' || text[i + 1] === '?') { i++; continue; }
      let j = i + 1; while (j < hi && /\s/.test(text[j])) j++;
      if (text[j] === ':') { i = j; continue; }
      ops.push({ op: '?', at: i });
      continue;
    }
    if (c === ':') { ops.push({ op: ':', at: i }); continue; }
    if (c === ',') { ops.push({ op: ',', at: i }); continue; }
    if (c === ';') { ops.push({ op: ';', at: i }); continue; }
  }
  return ops;
}

// ===========================================================================
// 3. Component scopes.
// ===========================================================================

/**
 * Split a file into top-level declaration scopes. A scope runs from its own
 * declaration to the start of the next one, which is exactly the text of one
 * component in this codebase's file layout (declarations do not interleave).
 *
 * Scoping is what stops `err` in one component answering for a claim in the
 * next — the false positive that ended the regex attempt recorded in
 * check-loaded-flag-honesty.mjs.
 */
export function componentScopes(text) {
  const starts = [];
  const depth = new Int32Array(text.length + 1);
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    depth[i] = d;
  }
  const declRe = /(?:^|\n)\s*(?:export\s+)?(?:export\s+default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = declRe.exec(text))) {
    const at = m.index + m[0].indexOf(m[1]);
    // Only genuine top-level declarations (nothing open around them).
    if (depth[m.index] !== 0) continue;
    starts.push({ name: m[1], start: m.index });
  }
  if (starts.length === 0) return [{ name: '<file>', start: 0, end: text.length }];
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    out.push({
      name: starts[i].name,
      start: starts[i].start,
      end: i + 1 < starts.length ? starts[i + 1].start : text.length,
    });
  }
  return out;
}

// ===========================================================================
// 4. Per-scope resolution: state, failure regions, evidence classes.
// ===========================================================================

const TRIVIAL_ARG = /^(?:true|false|null|undefined|0|-1|''|""|``|\[\]|\{\})$/;

/** Argument text of the call whose `(` is at `openIdx`. */
function callArgs(text, openIdx, pairs) {
  const p = pairs.find((x) => x.open === openIdx && x.ch === '(');
  return p ? text.slice(p.open + 1, p.close) : null;
}

/** Classify a `useState` initial value. */
function classifyInit(argText) {
  const t = (argText ?? '').trim();
  if (t === '' ) return 'unknown';
  if (/^(?:null|undefined)$/.test(t)) return 'nullish';
  if (/^\[\s*\]$/.test(t)) return 'empty-array';
  if (/^\{\s*\}$/.test(t)) return 'empty-object';
  if (/^(?:''|""|``)$/.test(t)) return 'empty-string';
  if (/^(?:0|false)$/.test(t)) return 'falsy-scalar';
  if (/^true$/.test(t)) return 'true';
  if (/^new\s+(?:Map|Set)\s*\(\s*\)$/.test(t)) return 'empty-collection';
  return 'other';
}

/**
 * Regions of `[lo,hi)` in which a read FAILURE is being handled, and regions
 * that run regardless of outcome.
 *
 * FAILURE
 *   - `catch (…) { … }` blocks
 *   - `.catch(…)` handler arguments
 *   - the branch of `if (…)` that runs when a response was NOT ok:
 *     the consequent when the test negates ok-ness, the `else` when it asserts it
 * PROMOTION (neither failure nor success)
 *   - `finally { … }` blocks and `.finally(…)` handler arguments
 */
function regionsOf(text, lo, hi, pairs) {
  const failure = [];
  const promotion = [];
  // The subset of `failure` that is an `if` branch on response ok-ness / HTTP
  // status (never a `catch`). E6 needs it: a `throw` there is what makes a
  // RESOLVED non-2xx reject the query; a rethrow in a catch proves nothing
  // about a response that never threw.
  const notOk = [];
  // The `( … )` test of every `if` that produced a notOk region — E6 allows a
  // response's `.ok` / `.status` to be read ONLY there or inside the branch.
  const notOkTests = [];

  const blockAfter = (from) => {
    let i = from;
    while (i < hi && /\s/.test(text[i])) i++;
    if (text[i] !== '{') return null;
    const p = pairs.find((x) => x.open === i);
    return p ? { lo: p.open, hi: p.close } : null;
  };

  // catch / finally blocks
  const kwRe = /\b(catch|finally)\b/g;
  kwRe.lastIndex = 0;
  let m;
  const region = text.slice(lo, hi);
  while ((m = kwRe.exec(region))) {
    const at = lo + m.index;
    let i = at + m[0].length;
    while (i < hi && /\s/.test(text[i])) i++;
    if (text[i] === '(') { const p = pairs.find((x) => x.open === i); if (p) i = p.close + 1; }
    const blk = blockAfter(i);
    if (!blk) continue;
    (m[1] === 'catch' ? failure : promotion).push(blk);
  }

  // .catch( … ) / .finally( … ) handlers
  const mrRe = /\.\s*(catch|finally)\s*\(/g;
  mrRe.lastIndex = 0;
  while ((m = mrRe.exec(region))) {
    const openIdx = lo + m.index + m[0].length - 1;
    const p = pairs.find((x) => x.open === openIdx);
    if (!p) continue;
    (m[1] === 'catch' ? failure : promotion).push({ lo: p.open, hi: p.close });
  }

  // if (…) on response ok-ness / HTTP status
  const ifRe = /\bif\s*\(/g;
  ifRe.lastIndex = 0;
  while ((m = ifRe.exec(region))) {
    const openIdx = lo + m.index + m[0].length - 1;
    const p = pairs.find((x) => x.open === openIdx);
    if (!p) continue;
    const test = text.slice(p.open + 1, p.close);
    const mentionsOk = /\.\s*ok\b/.test(test);
    const mentionsStatus = /\.\s*status\s*(?:>=|>|!==|!=|===|==)\s*\d{3}/.test(test);
    if (!mentionsOk && !mentionsStatus) continue;
    const negated = /!\s*[A-Za-z_$(]/.test(test)
      || /\.\s*ok\s*(?:!==|!=)\s*true\b/.test(test)
      || /\.\s*ok\s*(?:===|==)\s*false\b/.test(test)
      || /\.\s*status\s*(?:>=|>)\s*\d{3}/.test(test)
      || /\.\s*status\s*(?:!==|!=)\s*200\b/.test(test);
    // consequent
    let i = p.close + 1;
    while (i < hi && /\s/.test(text[i])) i++;
    let cons = null; let after = i;
    if (text[i] === '{') {
      const b = pairs.find((x) => x.open === i);
      if (b) { cons = { lo: b.open, hi: b.close }; after = b.close + 1; }
    } else {
      const semi = text.indexOf(';', i);
      const stop = semi < 0 || semi > hi ? Math.min(i + 200, hi) : semi;
      cons = { lo: i, hi: stop }; after = stop + 1;
    }
    if (negated) { if (cons) { failure.push(cons); notOk.push(cons); notOkTests.push({ lo: p.open, hi: p.close }); } continue; }
    // positive ok-test -> the ELSE branch handles the failure
    let j = after;
    while (j < hi && /\s/.test(text[j])) j++;
    if (text.slice(j, j + 4) === 'else') {
      let k = j + 4;
      while (k < hi && /\s/.test(text[k])) k++;
      if (text[k] === '{') {
        const b = pairs.find((x) => x.open === k);
        if (b) { failure.push({ lo: b.open, hi: b.close }); notOk.push({ lo: b.open, hi: b.close }); notOkTests.push({ lo: p.open, hi: p.close }); }
      } else {
        const semi = text.indexOf(';', k);
        const r = { lo: k, hi: semi < 0 || semi > hi ? Math.min(k + 200, hi) : semi };
        failure.push(r); notOk.push(r); notOkTests.push({ lo: p.open, hi: p.close });
      }
    }
  }
  return { failure, promotion, notOk, notOkTests };
}

const inAny = (regions, idx) => regions.some((r) => idx >= r.lo && idx < r.hi);

/** Everything this analyser knows about one component scope. */
export function analyseScope(text, scope, pairs, helpers = new Map()) {
  const { start, end } = scope;
  const slice = text.slice(start, end);

  // --- state declarations -------------------------------------------------
  const states = new Map();       // varName -> { setter, init }
  const setterToVar = new Map();
  const stRe = /(?:const|let)\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState\s*/g;
  let m;
  while ((m = stRe.exec(slice))) {
    const at = start + m.index + m[0].length;
    // Skip a generic argument, then read the call's own parentheses.
    let i = at;
    while (i < end && /\s/.test(text[i])) i++;
    if (text[i] === '<') {
      let d = 0;
      for (; i < end; i++) {
        if (text[i] === '<') d++;
        else if (text[i] === '>') { d--; if (d === 0) { i++; break; } }
      }
      while (i < end && /\s/.test(text[i])) i++;
    }
    if (text[i] !== '(') continue;
    const args = callArgs(text, i, pairs);
    states.set(m[1], { setter: m[2], init: classifyInit(args) });
    setterToVar.set(m[2], m[1]);
  }

  // --- reads --------------------------------------------------------------
  //
  // Either the component fetches directly, or it delegates to a helper defined
  // in the SAME FILE. The delegating shape is common here — dlp-panel's five
  // sections all do `setState(await fetchJson(url))` against a module-level
  // helper — and treating it as "no read" would drop five real surfaces out of
  // the judged population while the guard still printed OK.
  const callsHelper = (names) => [...names].some(
    (h) => new RegExp(`\\b${h}\\s*[(<]`).test(slice),
  );
  const readingHelpers = new Set([...helpers].filter(([n, f]) => f.hasFetch && n !== scope.name).map(([n]) => n));
  const failingHelpers = new Set([...helpers].filter(([n, f]) => f.hasFetch && f.hasFailure && n !== scope.name).map(([n]) => n));
  const hasRead = /\b(?:clientFetch|fetch)\s*\(/.test(slice) || callsHelper(readingHelpers);

  // --- failure / promotion regions ---------------------------------------
  //
  // No verdict currently reads `promotion`. The split still has to exist: a
  // `finally` runs on BOTH outcomes, so routing it into `failure` would make
  // `setLoading(false)` look like a recorded error, and every surface with a
  // `finally` would go quietly safe. It is returned for diagnostics.
  const { failure, promotion } = regionsOf(text, start, end, pairs);

  // --- setter call sites --------------------------------------------------
  const errorSignals = new Set();
  const writtenOnFailure = new Set();
  const setRe = /\b(set[A-Z][\w$]*)\s*\(/g;
  while ((m = setRe.exec(slice))) {
    const varName = setterToVar.get(m[1]);
    if (!varName) continue;
    const openIdx = start + m.index + m[0].length - 1;
    const args = (callArgs(text, openIdx, pairs) ?? '').trim();
    if (inAny(failure, openIdx)) {
      writtenOnFailure.add(varName);
      // `setLoading(false)` in a catch is the PROMOTION, not a signal — it
      // takes the spinner down without recording anything. Only a setter
      // carrying real content counts.
      if (!TRIVIAL_ARG.test(args)) errorSignals.add(varName);
    }
    // `setState(await fetchJson(url))` — the helper's failure branches return a
    // value, so this state variable CARRIES the failure outcome even though no
    // setter runs inside a catch here.
    if ([...failingHelpers].some((h) => new RegExp(`\\b${h}\\s*[(<]`).test(args))) {
      writtenOnFailure.add(varName);
    }
  }

  const loadSentinels = new Set();
  for (const [v, s] of states) {
    if (s.init === 'nullish' && !writtenOnFailure.has(v)) loadSentinels.add(v);
  }

  const queries = queryBindings(text, start, end, pairs);
  const derived = derivedFromQueries(text, start, end, queries);

  return {
    states, setterToVar, hasRead, failure, promotion,
    errorSignals, writtenOnFailure, loadSentinels, queries, derived,
  };
}

// ---------------------------------------------------------------------------
// E6 support — a react-query result as the read's outcome.
//
// Every rule below exists because a fixture in #4771's round-6 re-review
// (5898687296) got through the looser round-5 version. The fixture ids (1a …
// 11) are pinned in scripts/ci/__tests__/empty-claim-read-evidence.test.mjs.
// ---------------------------------------------------------------------------

/** Identifiers E6 treats as inert inside an emptiness test or a derived const. */
const E6_IGNORABLE = new Set(['Object', 'Array', 'Math', 'Number', 'String', 'Boolean', 'JSON',
  'undefined', 'null', 'true', 'false', 'typeof', 'void', 'new', 'in', 'instanceof']);

/**
 * react-query options that do NOT change what `data` / `isError` mean. Anything
 * else declines E6: `select` can strip or rewrite the folded status (7a, 7b),
 * `initialData` / `placeholderData` put data on screen that no read produced
 * (9b, 9a), and `enabled: false` leaves the query pending with no fetch (8a).
 */
const E6_OPTION_KEYS = new Set(['queryKey', 'queryFn', 'staleTime', 'gcTime', 'refetchInterval',
  'refetchIntervalInBackground', 'refetchOnWindowFocus', 'refetchOnMount', 'refetchOnReconnect',
  'retry', 'retryDelay']);

const FETCH_CALL_RE = /(?<![\w$.])(?:clientFetch|fetch)\s*\(/g;
const NOT_A_CALL = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'await', 'new', 'delete', 'void', 'super', 'import', 'async']);

/** Names bound by this file's `import` statements (default, named, namespace). */
export function importedNames(text) {
  const names = new Set();
  const re = /\bimport\s+(?:type\s+)?([^;]*?)\s+from\s*['"]/g;
  let m;
  while ((m = re.exec(text))) {
    let clause = m[1];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const t = part.trim().replace(/^type\s+/, '');
        if (!t) continue;
        const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t);
        names.add(alias ? alias[1] : t.split(/\s+/)[0]);
      }
      clause = clause.replace(braces[0], '');
    }
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) names.add(ns[1]);
    const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause.replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, ''));
    if (def) names.add(def[1]);
  }
  return names;
}

/**
 * `const Q = useQuery(…)` / `useQuery<T>(…)` bindings in [start, end), as
 * name -> the call's `( … )` span. `const` ONLY: a `let` binding can be
 * rebound after the call (`q = { ...q, isError: false }`, fixture 11).
 * Destructured bindings are NOT resolved: their isError has no name to tie to a
 * data read.
 */
function queryBindings(text, start, end, pairs) {
  const out = new Map();
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*useQuery\b/g;
  const slice = text.slice(start, end);
  let m;
  while ((m = re.exec(slice))) {
    let i = start + m.index + m[0].length;
    while (i < end && /\s/.test(text[i])) i++;
    if (text[i] === '<') {
      let d = 0;
      for (; i < end; i++) {
        if (text[i] === '<') d++;
        else if (text[i] === '>') { d--; if (d === 0) { i++; break; } }
      }
      while (i < end && /\s/.test(text[i])) i++;
    }
    if (text[i] !== '(') continue;
    const p = pairs.find((x) => x.open === i && x.ch === '(');
    if (p) out.set(m[1], { lo: p.open, hi: p.close });
  }
  return out;
}

/** Identifiers in `s` that are not a property access (`.x` / `?.x`). */
const freeIdents = (s) => {
  const ids = [];
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(s))) {
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(s[j])) j--;
    if (s[j] === '.' || /[0-9]/.test(s[m.index - 1] ?? '')) continue;
    ids.push({ id: m[0], at: m.index });
  }
  return ids;
};

/** Is the identifier at `at` in `s` read as `.data` / `?.data`? */
const readsDataAt = (s, at, id) => /^\s*!?\s*\??\.\s*data\b/.test(s.slice(at + id.length));

/**
 * Same-scope consts whose value is PURELY one query's data: name -> query.
 *
 * Every free identifier in the initialiser must be the query (read as
 * `.data`), a const already derived purely from that same query, or in
 * E6_IGNORABLE. Anything else — another query, destructured `useQuery` data,
 * a prop, a memo, a useState var, a call — and the const is derived from
 * nothing (fixture 4a). A name declared twice counts only if every
 * declaration agrees.
 */
function derivedFromQueries(text, start, end, queries) {
  const derived = new Map();
  if (queries.size === 0) return derived;
  const decls = [];
  const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+?)?=(?![=>])/g;
  const slice = text.slice(start, end);
  let m;
  while ((m = re.exec(slice))) {
    let i = start + m.index + m[0].length;
    const lo = i;
    let depth = 0;
    for (; i < end; i++) {
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if ((c === ';' || c === '\n') && depth === 0) break;
    }
    decls.push({ name: m[1], init: text.slice(lo, i), isLet: /^let\b/.test(m[0]) });
  }
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    const byName = new Map();
    for (const d of decls) {
      if (queries.has(d.name)) continue;
      let src = null; let bad = d.isLet;
      for (const { id, at } of freeIdents(d.init)) {
        if (E6_IGNORABLE.has(id)) continue;
        if (queries.has(id) && readsDataAt(d.init, at, id)) {
          if (src && src !== id) bad = true;
          src = src || id;
          continue;
        }
        if (derived.has(id)) {
          const q = derived.get(id);
          if (src && src !== q) bad = true;
          src = src || q;
          continue;
        }
        bad = true;
      }
      const verdict = !bad && src ? src : null;
      if (byName.has(d.name) && byName.get(d.name) !== verdict) byName.set(d.name, null);
      else if (!byName.has(d.name)) byName.set(d.name, verdict);
    }
    for (const [name, q] of byName) {
      if (q && derived.get(name) !== q) { derived.set(name, q); changed = true; }
      if (!q && derived.has(name)) { derived.delete(name); changed = true; }
    }
    if (!changed) break;
  }
  return derived;
}

/**
 * The `queryFn` span of a query whose options object uses ONLY E6_OPTION_KEYS,
 * or null. The object must be the call's whole argument list, every property
 * a plain `key: value` (no spread, no shorthand, no method).
 */
function queryFnOf(text, pairs, call) {
  let i = call.lo + 1;
  while (i < call.hi && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  const obj = pairs.find((x) => x.open === i && x.ch === '{');
  if (!obj) return null;
  let k = obj.close + 1;
  while (k < call.hi && /\s/.test(text[k])) k++;
  if (k !== call.hi) return null;
  const bounds = [...depth0Ops(text, obj.open + 1, obj.close).filter((o) => o.op === ',').map((o) => o.at), obj.close];
  let segLo = obj.open + 1;
  let queryFn = null;
  for (const b of bounds) {
    const seg = text.slice(segLo, b);
    if (seg.trim()) {
      const mm = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(seg);
      if (!mm || !E6_OPTION_KEYS.has(mm[1])) return null;
      if (mm[1] === 'queryFn') queryFn = { lo: segLo + mm[0].length, hi: b };
    }
    segLo = b + 1;
  }
  return queryFn;
}

/** Bare-identifier calls in [lo, hi): `name(` not preceded by `.` / `new`. */
function callsIn(text, lo, hi) {
  const out = [];
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
  const body = text.slice(lo, hi);
  let m;
  while ((m = re.exec(body))) {
    if (NOT_A_CALL.has(m[1])) continue;
    if (/\bnew\s+$/.test(body.slice(Math.max(0, m.index - 8), m.index))) continue;
    out.push(m[1]);
  }
  return out;
}

/**
 * Does the code in `span` REJECT whenever its read fails?
 *
 *   - no call to an identifier IMPORTED from another module, other than
 *     `clientFetch` itself — its failure handling cannot be read here (2b);
 *   - EVERY same-file helper it calls that fetches must itself fail loudly —
 *     one loud helper beside a quiet one proves nothing (2c);
 *   - at most ONE direct fetch; with one, every if-not-ok branch must throw and
 *     never return (1b), at least one must exist, and every `.ok` / `.status`
 *     read must sit in such an `if` test or branch — a ternary on `.ok` is a
 *     swallow the branch check cannot see (1c). The one exception is a plain
 *     `status: R.status` copied into an object literal, which decides nothing;
 *   - every catch must throw and never return (1a), except `.json().catch(…)`,
 *     whose fallback still meets the ok test below it.
 */
function unitFailsLoudly(ctx, span, self, depth) {
  const { text, pairs, helpers, imports } = ctx;
  const body = text.slice(span.lo, span.hi);
  const direct = (body.match(FETCH_CALL_RE) || []).length;
  if (direct > 1) return false;
  let reads = direct;
  const seen = new Set();
  for (const name of callsIn(text, span.lo, span.hi)) {
    if (name === self || name === 'clientFetch' || name === 'fetch') continue;
    if (imports.has(name)) return false;
    const h = helpers.get(name);
    if (!h || !h.hasFetch || h.start === undefined) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    if (depth >= 2 || !unitFailsLoudly(ctx, { lo: h.start, hi: h.end }, name, depth + 1)) return false;
    reads++;
  }
  if (reads === 0) return false;
  const { failure, notOk, notOkTests } = regionsOf(text, span.lo, span.hi, pairs);
  const isNotOk = (r) => notOk.some((n) => n.lo === r.lo && n.hi === r.hi);
  for (const r of failure) {
    const seg = text.slice(r.lo, r.hi);
    if (!isNotOk(r) && /\.\s*json\s*\(\s*\)\s*\.\s*catch\s*$/.test(text.slice(Math.max(span.lo, r.lo - 60), r.lo))) continue;
    if (!/\bthrow\b/.test(seg) || /\breturn\b/.test(seg)) return false;
  }
  if (direct === 1) {
    if (!notOk.some((r) => /\bthrow\b/.test(text.slice(r.lo, r.hi)))) return false;
    const tokRe = /\??\.\s*(?:ok|status)\b/g;
    let m;
    while ((m = tokRe.exec(body))) {
      const at = span.lo + m.index;
      if (inAny(notOk, at) || inAny(notOkTests, at)) continue;
      // The one plain VALUE read allowed: `status: R.status` copied into an
      // object literal (`,` or `}` follows). It decides nothing.
      const copied = /\bstatus\s*:\s*[A-Za-z_$][\w$]*\s*$/.test(body.slice(Math.max(0, m.index - 60), m.index))
        && /^\s*[,}]/.test(body.slice(m.index + m[0].length));
      if (!copied) return false;
    }
  }
  return true;
}

/**
 * Is `queryFn` exactly `() => H(args)` for a same-file H whose one fetch's
 * status is merged LAST into its single returned object
 * (`return { ...json, status: res.status }`)? That is what makes a wrapper's
 * `data.status` fold see a resolved non-2xx. A fetcher that never merges the
 * status would leave the fold reading nothing.
 */
function queryFnMergesStatus(ctx, fn) {
  const { text, pairs, helpers, imports } = ctx;
  const t = text.slice(fn.lo, fn.hi);
  const mm = /^\s*(?:async\s*)?\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/.exec(t);
  if (!mm) return false;
  const open = fn.lo + mm[0].length - 1;
  const p = pairs.find((x) => x.open === open && x.ch === '(');
  if (!p || text.slice(p.close + 1, fn.hi).trim() !== '') return false;
  if (callsIn(text, p.open + 1, p.close).length) return false;
  const name = mm[1];
  const h = helpers.get(name);
  if (!h || !h.hasFetch || h.start === undefined) return false;
  const body = text.slice(h.start, h.end);
  if ((body.match(FETCH_CALL_RE) || []).length !== 1) return false;
  const fr = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:clientFetch|fetch)\s*\(/.exec(body);
  if (!fr) return false;
  const rets = [...body.matchAll(/\breturn\b/g)];
  if (rets.length !== 1) return false;
  let i = h.start + rets[0].index + 6;
  while (i < h.end && /\s/.test(text[i])) i++;
  const obj = pairs.find((x) => x.open === i && x.ch === '{');
  if (!obj) return false;
  const objText = text.slice(obj.open + 1, obj.close).replace(/\s+/g, '');
  if (!new RegExp(`^(?:\\.\\.\\.[A-Za-z_$][\\w$]*,)?status:${fr[1]}\\.status,?$`).test(objText)) return false;
  for (const c of callsIn(text, h.start, h.end)) {
    if (c === name || c === 'clientFetch' || c === 'fetch') continue;
    if (imports.has(c)) return false;
    const other = helpers.get(c);
    if (other && other.hasFetch) return false;
  }
  const { failure } = regionsOf(text, h.start, h.end, pairs);
  for (const r of failure) {
    if (/\.\s*json\s*\(\s*\)\s*\.\s*catch\s*$/.test(text.slice(Math.max(h.start, r.lo - 60), r.lo))) continue;
    return false;
  }
  return true;
}

/**
 * Is same-file function `w` a wrapper whose single returned `isError` is
 * `<param>.isError` OR'd with an HTTP-failure fold of `<param>.data.status`?
 *
 * Proved from the ORIGINAL text of its body, never trusted from its name:
 *   - exactly ONE `return` — an early `return { isError: false }` (3b) is out;
 *   - exactly one `isError:` in that returned object, of the form
 *     `P.isError` or `P.isError || X`;
 *   - X (or the const it names, declared once, never reassigned) is `&&` of
 *     exactly one `status >= 400` / `> 399` and optional `status !== null` /
 *     `typeof status === 'number'` guards — no `<` / `<=` (3a), no `||`, no
 *     parentheses, nothing else;
 *   - `status` is `P.data?.status` itself, or
 *     `typeof P.data?.status === 'number' ? P.data.status : null` — never a
 *     deeper member or a default (3c).
 */
function wrapperFold(ctx, w) {
  const none = { foldsQuery: false, foldsHttp: false };
  const { text, pairs, helpers, src } = ctx;
  const h = helpers.get(w);
  if (!h || h.start === undefined) return none;
  const body = text.slice(h.start, h.end);
  const orig = src.slice(h.start, h.end);
  const pm = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+[\w$]+\s*(?:<[^>]*>)?\s*\(\s*|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?\(?\s*)([A-Za-z_$][\w$]*)/.exec(body);
  if (!pm) return none;
  const P = pm[1];
  const rets = [...body.matchAll(/\breturn\b/g)];
  if (rets.length !== 1) return none;
  let i = h.start + rets[0].index + 6;
  while (i < h.end && /\s/.test(text[i])) i++;
  const obj = pairs.find((x) => x.open === i && x.ch === '{');
  if (!obj) return none;
  const objText = text.slice(obj.open + 1, obj.close);
  if ((objText.match(/(?<![\w$.])isError\s*:/g) || []).length !== 1) return none;
  const im = new RegExp(`(?<![\\w$.])isError\\s*:\\s*${P}\\s*\\.\\s*isError\\s*(?:\\|\\|\\s*([A-Za-z_$][\\w$]*))?\\s*(?:,|$)`).exec(objText);
  if (!im) return none;
  if (!im[1]) return { foldsQuery: true, foldsHttp: false };

  /** The original initialiser of a const declared once and never reassigned. */
  const constInit = (name) => {
    const decls = [...body.matchAll(new RegExp(`\\bconst\\s+${name}\\s*(?::[^=;]+?)?=(?![=>])`, 'g'))];
    if (decls.length !== 1) return null;
    const assigns = (body.match(new RegExp(`(?<![\\w$.])${name}\\s*(?:=(?![=>])|\\+=|-=|\\+\\+|--)`, 'g')) || []).length;
    if (assigns !== 1) return null;
    const lo = decls[0].index + decls[0][0].length;
    const semi = body.indexOf(';', lo);
    const nl = body.indexOf('\n', lo);
    const hi = Math.min(semi < 0 ? body.length : semi, nl < 0 ? body.length : nl);
    return orig.slice(lo, hi).trim();
  };
  const http = constInit(im[1]);
  if (http === null || /[<|()]/.test(http)) return { foldsQuery: true, foldsHttp: false };
  const statusRef = `(?:status|${P}\\s*\\??\\.\\s*data\\s*\\??\\.\\s*status)`;
  const conj = http.split('&&').map((c) => c.trim());
  let compares = 0; let usesBareStatus = false;
  for (const c of conj) {
    if (new RegExp(`^${statusRef}\\s*(?:>=\\s*400|>\\s*399)$`).test(c)) {
      compares++;
      if (/^status\b/.test(c)) usesBareStatus = true;
      continue;
    }
    if (/^status\s*!==?\s*null$/.test(c)) continue;
    if (/^typeof\s+status\s*===?\s*(['"])number\1$/.test(c)) continue;
    return { foldsQuery: true, foldsHttp: false };
  }
  if (compares !== 1) return { foldsQuery: true, foldsHttp: false };
  if (usesBareStatus || conj.some((c) => /^(?:status\b|typeof\s+status\b)/.test(c))) {
    const s = constInit('status');
    const dataStatus = `${P}\\s*\\??\\.\\s*data\\s*\\??\\.\\s*status`;
    const ok = s !== null && (
      new RegExp(`^${dataStatus}$`).test(s)
      || new RegExp(`^typeof\\s+${dataStatus}\\s*===\\s*(['"])number\\1\\s*\\?\\s*${dataStatus}\\s*:\\s*null$`).test(s));
    if (!ok) return { foldsQuery: true, foldsHttp: false };
  }
  return { foldsQuery: true, foldsHttp: true };
}

/**
 * The claim's DATA LINK to query `q`: every emptiness test on its render path
 * (a condition reading `.length` / `.size`) must read ONLY `q.data` or consts
 * derived purely from it, and there must be at least one.
 */
function dataLinked(q, conds, info) {
  const tests = conds.filter((c) => /\.\s*(?:length|size)\b/.test(c));
  if (tests.length === 0) return false;
  for (const c of tests) {
    let linked = false;
    for (const { id, at } of freeIdents(c)) {
      if (E6_IGNORABLE.has(id)) continue;
      if (id === q && readsDataAt(c, at, id)) { linked = true; continue; }
      if (info.derived.get(id) === q) { linked = true; continue; }
      return false;
    }
    if (!linked) return false;
  }
  return true;
}

/**
 * Does the claim's path require that `q` has SETTLED — `!q.isPending`,
 * `q.isSuccess` or `q.data`? `isLoading` is deliberately NOT enough: in
 * react-query v5 it is `isPending && isFetching`, so a paused (offline) query
 * is not loading, not errored, and has no data. Without a settled gate the
 * claim renders before any read returned (fixture 10).
 */
function querySettled(q, literals) {
  return literals.some((l) => !l.consequentMisread && !l.conditionalReturn && (
    (!l.polarity && new RegExp(`^${q}\\??\\.isPending$`).test(l.expr))
    || (l.polarity && new RegExp(`^${q}\\??\\.(?:isSuccess|data)$`).test(l.expr))));
}

/**
 * Is the claim somewhere E6 cannot follow: inside a `useMemo` / `useCallback`
 * body (its deps can omit isError and serve a stale verdict, fixture 6a), or
 * inside an arrow whose parameters rebind `q` (fixture 6b)?
 */
function claimOutOfReach(ctx, scope, claimIdx, q) {
  const { text, pairs } = ctx;
  for (const p of enclosing(pairs, claimIdx, scope.start, scope.end)) {
    const before = text.slice(Math.max(scope.start, p.open - 80), p.open);
    if (p.ch === '(' && /\b(?:useMemo|useCallback)\s*(?:<[^<>]*>)?\s*$/.test(before)) return true;
  }
  const shadow = new RegExp(`(?<![\\w$.])${q}(?![\\w$])`);
  const arrowRe = /=>/g;
  const hay = text.slice(scope.start, claimIdx);
  let m;
  while ((m = arrowRe.exec(hay))) {
    const at = scope.start + m.index;
    const owner = innermost(pairs, at);
    if (!owner || !(owner.open < claimIdx && owner.close > claimIdx)) continue;
    let j = at - 1;
    while (j > owner.open && /\s/.test(text[j])) j--;
    let params = '';
    if (text[j] === ')') {
      const pp = pairs.find((x) => x.close === j && x.ch === '(');
      if (pp) params = text.slice(pp.open + 1, pp.close);
    } else {
      const im = /([A-Za-z_$][\w$]*)$/.exec(text.slice(owner.open + 1, j + 1));
      if (im) params = im[1];
    }
    if (shadow.test(params)) return true;
  }
  return false;
}

/**
 * E6 — a react-query read outcome required FALSE: `Q.isError` or `W(Q).isError`
 * on the not-errored side of the claim. Every condition is necessary; see the
 * header's EVIDENCE list.
 */
function queryErrorEvidence(info, literals, ctx) {
  for (const lit of literals) {
    if (lit.polarity || lit.consequentMisread || lit.conditionalReturn) continue;
    let q = null; let wrapper = null;
    if (lit.kind === 'query-error') { q = lit.root; wrapper = lit.wrapper; }
    else {
      const mm = /^([A-Za-z_$][\w$]*)\??\.isError$/.exec(lit.expr);
      if (!mm) continue;
      q = mm[1];
    }
    const call = info.queries.get(q);
    if (!call) continue;
    const fn = queryFnOf(ctx.text, ctx.pairs, call);
    if (!fn) continue;
    const loud = () => unitFailsLoudly(ctx, fn, null, 0);
    let complete;
    if (wrapper) {
      const w = wrapperFold(ctx, wrapper);
      complete = w.foldsQuery && ((w.foldsHttp && queryFnMergesStatus(ctx, fn)) || loud());
    } else {
      complete = loud();
    }
    if (!complete) continue;
    if (!querySettled(q, literals)) continue;
    if (claimOutOfReach(ctx, ctx.scope, ctx.claimIdx, q)) continue;
    if (!dataLinked(q, ctx.conds, info)) continue;
    return { safe: true, why: `E6 !${lit.expr}` };
  }
  return { safe: false, why: null };
}

// ===========================================================================
// 5. Required conditions for a claim to render, with polarity.
// ===========================================================================

/** Strip one layer of wrapping parentheses. */
function unwrap(t) {
  let s = t.trim();
  for (;;) {
    if (s.length < 2 || s[0] !== '(') return s;
    const inner = bracketPairs(s).find((p) => p.open === 0);
    if (!inner || inner.close !== s.length - 1) return s;
    s = s.slice(1, -1).trim();
  }
}

/** Split `t` on a depth-0 binary operator (`&&` / `||`). */
function splitTop(t, op) {
  const parts = [];
  let depth = 0; let last = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth === 0 && c === op[0] && t[i + 1] === op[1]) {
      parts.push(t.slice(last, i)); last = i + 2; i++;
    }
  }
  parts.push(t.slice(last));
  return parts;
}

/**
 * Decompose a condition into the literals it forces, given the polarity the
 * condition itself must hold at.
 *
 *   polarity true : `A && B` forces both A and B
 *   polarity false: `A || B` forces neither A nor B
 *   `!X`          : flips
 *
 * A conjunction under a FALSE requirement forces nothing (¬(A∧B) says only that
 * one of them is false), and that asymmetry is exactly what caught the
 * /catalog/domains defect: the empty grid lived in the alternate of
 * `loading && !error ? … : …`, so `!error` forced nothing at all.
 */
function literalsOf(cond, polarity, out = []) {
  const t = unwrap(cond);
  if (!t) return out;
  const parts = splitTop(t, polarity ? '&&' : '||');
  if (parts.length > 1) {
    for (const p of parts) literalsOf(p, polarity, out);
    return out;
  }
  // A mixed expression we cannot decompose at this polarity.
  if (splitTop(t, polarity ? '||' : '&&').length > 1) return out;
  if (t[0] === '!' && t[1] !== '=') return literalsOf(t.slice(1), !polarity, out);

  let mm = /^([A-Za-z_$][\w$.?[\]]*?)\s*(===|!==|==|!=)\s*(null|undefined)$/.exec(t);
  if (mm) {
    const truthy = mm[2] === '!==' || mm[2] === '!=' ? polarity : !polarity;
    out.push({ expr: mm[1], root: rootOf(mm[1]), polarity: truthy });
    return out;
  }
  mm = /^Array\.isArray\s*\(\s*([A-Za-z_$][\w$.?[\]]*)\s*\)$/.exec(t);
  if (mm) { out.push({ expr: mm[1], root: rootOf(mm[1]), polarity }); return out; }

  // `W(Q).isError` — a same-file wrapper over a useQuery result. Tagged so the
  // useState rules (E1/E2/E4) never read it: only E6 may, and only after it has
  // proved W, Q and the data link (see queryErrorEvidence()).
  mm = /^([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\??\.\s*isError$/.exec(t);
  if (mm) {
    out.push({ expr: t.replace(/\s+/g, ''), root: mm[2], wrapper: mm[1], kind: 'query-error', polarity });
    return out;
  }

  // A bare identifier or member chain used for its truthiness.
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/.test(t)) {
    out.push({ expr: t, root: rootOf(t), polarity });
  }
  return out;
}

const rootOf = (expr) => (/^([A-Za-z_$][\w$]*)/.exec(expr) ?? [])[1] ?? null;

/**
 * Every literal that must hold for the claim at `claimIdx` to render.
 * Returns null when the structure could not be resolved (-> UNKNOWN).
 *
 * `conds`, when given, receives the RAW text of every condition on the claim's
 * render path (ternary tests, `&&` operands, earlier `||` disjuncts, dominating
 * early returns). E6 reads it to find the claim's emptiness test, which
 * `literalsOf` cannot represent (`(q.data?.rows || []).length` is not a literal).
 */
export function requiredLiterals(text, pairs, scope, claimIdx, conds = null) {
  const spans = enclosing(pairs, claimIdx, scope.start, scope.end);
  const out = [];
  let resolved = false;

  const regions = [
    ...spans.map((s) => ({ lo: s.open + 1, hi: s.close })),
  ];
  // The scope body itself, so a claim returned directly is still considered.
  regions.unshift({ lo: scope.start, hi: scope.end });

  for (const r of regions) {
    if (claimIdx <= r.lo || claimIdx >= r.hi) continue;
    const ops = depth0Ops(text, r.lo, r.hi);
    // Restrict to the statement/element the claim lives in.
    let lo = r.lo; let hi = r.hi;
    for (const o of ops) {
      if (o.op !== ',' && o.op !== ';') continue;
      if (o.at < claimIdx) lo = Math.max(lo, o.at + 1);
      else hi = Math.min(hi, o.at);
    }
    resolved = true;
    collectFrom(text, lo, hi, claimIdx, out, conds);
  }

  // `if (COND) return …;` earlier in the SAME body dominates the claim.
  const ifRe = /\bif\s*\(/g;
  const hay = text.slice(scope.start, scope.end);
  let m;
  while ((m = ifRe.exec(hay))) {
    const at = scope.start + m.index;
    if (at >= claimIdx) break;
    const openIdx = scope.start + m.index + m[0].length - 1;
    const p = pairs.find((x) => x.open === openIdx);
    if (!p) continue;
    const owner = innermost(pairs, at);
    // The `if` must sit in a block that ALSO encloses the claim — i.e. the same
    // function body — so that returning from it really does skip the claim.
    // Comparing against the claim's own innermost span instead would demand the
    // `if` live inside the JSX expression container, which no early return does.
    if (!owner || !(owner.open < claimIdx && owner.close > claimIdx)) continue;
    const rest = text.slice(p.close + 1, Math.min(p.close + 400, scope.end));
    if (!/^\s*(?:\{[^{}]*)?return\b/.test(rest)) continue;
    // The claim may BE the returned value: `if (err) return <EmptyState …/>`.
    // Then COND is really required TRUE, and reading it as a dominating early
    // exit (required FALSE, below) is WRONG. That misreading is pre-existing
    // and is deliberately NOT corrected here: correcting it moves three claims
    // from safe to unguarded (agent-quality-panel.tsx:431 and :580,
    // data-product-detail.tsx:783), which needs a baseline RAISE and an operator
    // decision. What IS done: literals read that way are flagged, and E6 refuses
    // them, so the new rule can never inherit the misreading.
    const cond = text.slice(p.open + 1, p.close);
    const inConsequent = claimIdx > p.close && claimIdx < consequentEnd(text, pairs, p.close + 1, scope.end);
    if (inConsequent) {
      const misread = literalsOf(cond, false, []);
      for (const l of misread) out.push({ ...l, consequentMisread: true });
      continue;
    }
    // `if (COND) { if (x) return …; }` returns only SOMETIMES, so it does not
    // dominate the claim (fixture 5d). The existing E1/E2/E4 reading of it is
    // unchanged (pre-existing, #4800); E6 refuses literals flagged here.
    if (!/^\s*(?:\{\s*)?return\b/.test(rest)) {
      const partial = literalsOf(cond, false, []);
      for (const l of partial) out.push({ ...l, conditionalReturn: true });
      continue;
    }
    literalsOf(cond, false, out);
    if (conds) conds.push(cond);
  }

  return resolved ? out : null;
}

/** End offset of the statement / block that starts at or after `from`. */
function consequentEnd(text, pairs, from, hi) {
  let i = from;
  while (i < hi && /\s/.test(text[i])) i++;
  if (text[i] === '{') {
    const b = pairs.find((x) => x.open === i);
    return b ? b.close : hi;
  }
  let depth = 0;
  for (; i < hi; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
    else if (c === ';' && depth === 0) return i;
  }
  return hi;
}

/** Walk `&&` / `?:` structure inside [lo,hi) and record what the claim needs. */
function collectFrom(text, lo, hi, claimIdx, out, conds = null) {
  const need = (cond, polarity) => {
    literalsOf(cond, polarity, out);
    if (conds) conds.push(cond);
  };
  const ops = depth0Ops(text, lo, hi).filter((o) => o.op === '&&' || o.op === '||' || o.op === '?' || o.op === ':');
  if (ops.length === 0) return;

  // Ternary first (lowest precedence of the three).
  const q = ops.find((o) => o.op === '?');
  if (q) {
    let level = 0; let colon = -1;
    for (const o of ops) {
      if (o.at < q.at) continue;
      if (o.op === '?') level++;
      else if (o.op === ':') { level--; if (level === 0) { colon = o.at; break; } }
    }
    if (colon >= 0) {
      if (claimIdx < q.at) { collectFrom(text, lo, q.at, claimIdx, out, conds); return; }
      const cond = text.slice(lo, q.at);
      if (claimIdx > q.at && claimIdx < colon) {
        need(cond, true);
        collectFrom(text, q.at + 1, colon, claimIdx, out, conds);
      } else if (claimIdx > colon) {
        need(cond, false);
        collectFrom(text, colon + 1, hi, claimIdx, out, conds);
      }
      return;
    }
  }

  // `||` binds looser than `&&`: find the claim's disjunct.
  const ors = ops.filter((o) => o.op === '||');
  if (ors.length) {
    let dLo = lo; let dHi = hi;
    for (const o of ors) {
      if (o.at < claimIdx) dLo = Math.max(dLo, o.at + 2);
      else dHi = Math.min(dHi, o.at);
    }
    // Earlier disjuncts must have been falsy for this one to be evaluated.
    let prev = lo;
    for (const o of ors) {
      if (o.at >= claimIdx) break;
      need(text.slice(prev, o.at), false);
      prev = o.at + 2;
    }
    collectFrom(text, dLo, dHi, claimIdx, out, conds);
    return;
  }

  // `A && B && claim` — every operand before the claim must be truthy.
  let prev = lo;
  for (const o of ops) {
    if (o.op !== '&&') continue;
    if (o.at >= claimIdx) break;
    need(text.slice(prev, o.at), true);
    prev = o.at + 2;
  }
}

// ===========================================================================
// 6. Verdict.
// ===========================================================================

/**
 * Is any required literal EVIDENCE THAT THE READ SUCCEEDED?
 *
 * A "loaded" boolean is deliberately NOT evidence, and that is a measured
 * decision, not an oversight. `check-loaded-flag-honesty.mjs` exists precisely
 * because a `finally` can promote a FAILED read to loaded, and this analyser
 * cannot tell which of a component's several reads a given flag attests to —
 * `isAdmin` in skills-studio and `configured` in ml-experiment-editor both
 * qualified as "set true only on success" while saying nothing about the read
 * behind the empty claim. Admitting them made exactly 2 of 103 safe verdicts
 * safe for a reason that would not survive review, so the rule was removed and
 * both surfaces are baselined instead.
 */
function verdictFor(info, literals, ctx = null) {
  for (const lit of literals) {
    const root = lit.root;
    // A wrapped query outcome is E6's alone (below); the useState rules must
    // never read it, whatever its root happens to be named.
    if (lit.kind === 'query-error') continue;
    if (!root || !info.states.has(root)) continue;
    const isMemberChain = lit.expr !== root;
    // E1 / E5 — a nullish sentinel required truthy proves the read returned.
    if (lit.polarity && !isMemberChain && info.loadSentinels.has(root)) return { safe: true, why: `E1 ${lit.expr}` };
    // E2 — an error signal required falsy proves no failure was recorded.
    if (!lit.polarity && !isMemberChain && info.errorSignals.has(root)) return { safe: true, why: `E2 !${lit.expr}` };
    // E4 — a nested field of the read payload required truthy. A failed read
    // cannot populate `resp?.ok` / `state.data?.ok` / `qResult.ok`.
    if (lit.polarity && isMemberChain && !/\.length$/.test(lit.expr)
        && (info.writtenOnFailure.has(root) || info.states.get(root).init === 'nullish')) {
      return { safe: true, why: `E4 ${lit.expr}` };
    }
  }
  // E6 runs only after E1/E2/E4 have all declined, so no existing verdict or
  // reason can change because it exists.
  if (ctx && info.queries && info.queries.size) return queryErrorEvidence(info, literals, ctx);
  return { safe: false, why: null };
}

// ===========================================================================
// 7. The pass.
// ===========================================================================

const CLAIM_RE = new RegExp(`<(${CLAIM_TAGS.join('|')})\\b`, 'g');

/**
 * Judge one source text. Returns { claims: [...], scopesWithRead, skipped }.
 * `path` is informational only — nothing about the verdict depends on it.
 */
export function judgeSource(src, path = '<memory>') {
  const text = blankNonCode(src);
  const pairs = bracketPairs(text);
  const scopes = componentScopes(text);
  const claims = [];
  let noReadClaims = 0;

  // The analyser lost sync somewhere in this file. Every claim in it is
  // UNKNOWN — not "fine". See balanced().
  const parseOk = balanced(text);

  // Facts about every top-level declaration, so a component that delegates its
  // read to a same-file helper is still judged (and so the helper's own failure
  // branches count as writing the state the component sets from it).
  const helpers = new Map();
  for (const s of scopes) {
    const body = text.slice(s.start, s.end);
    helpers.set(s.name, {
      start: s.start,
      end: s.end,
      hasFetch: /\b(?:clientFetch|fetch)\s*\(/.test(body),
      hasFailure: /\bcatch\b/.test(body) || /\.\s*catch\s*\(/.test(body)
        || /\bif\s*\([^)]*!\s*[A-Za-z_$][\w$.?]*\.\s*ok\b/.test(body),
    });
  }
  const scopeCache = new Map();
  const imports = importedNames(text);
  const infoFor = (s) => {
    if (!scopeCache.has(s.name + s.start)) scopeCache.set(s.name + s.start, analyseScope(text, s, pairs, helpers));
    return scopeCache.get(s.name + s.start);
  };

  CLAIM_RE.lastIndex = 0;
  let m;
  while ((m = CLAIM_RE.exec(text))) {
    const at = m.index;
    const line = src.slice(0, at).split('\n').length;
    if (!parseOk) {
      claims.push({
        path, scope: '?', line, tag: m[1], verdict: 'unknown',
        why: 'file did not bracket-balance after blanking — the analyser could not parse it',
      });
      continue;
    }
    const scope = scopes.find((s) => at >= s.start && at < s.end) ?? scopes[scopes.length - 1];
    const info = infoFor(scope);
    if (!info.hasRead) { noReadClaims++; continue; }
    // A component that reads but holds NO useState of its own keeps the read's
    // outcome somewhere this analyser cannot see (a ref, a context, a custom
    // hook). That is unknown, and unknown is not safe.
    if (info.states.size === 0 || scope.name === '<file>') {
      claims.push({
        path, scope: scope.name, line, tag: m[1], verdict: 'unknown',
        why: info.states.size === 0
          ? 'component reads but declares no useState — the read outcome is held somewhere this analyser cannot follow'
          : 'no top-level declaration found, so the claim could not be scoped to a component',
      });
      continue;
    }
    const conds = [];
    const literals = requiredLiterals(text, pairs, scope, at, conds);
    if (literals === null) {
      claims.push({ path, scope: scope.name, line, tag: m[1], verdict: 'unknown', why: 'unresolvable render structure' });
      continue;
    }
    const v = verdictFor(info, literals, { text, src, pairs, helpers, imports, conds, scope, claimIdx: at });
    claims.push({
      path,
      scope: scope.name,
      line,
      tag: m[1],
      verdict: v.safe ? 'safe' : 'unguarded',
      why: v.why,
      literals: literals.map((l) => `${l.polarity ? '' : '!'}${l.expr}`),
    });
  }
  return { claims, noReadClaims, parseOk };
}

// ===========================================================================
// 8. Embedded controls — a known-true fixture set, run on EVERY invocation.
//
// Every fixture is a REAL shape measured in this repo, with its expected
// verdict AND the expected reason. Asserting the reason matters: a drifted
// analyser can land on the right verdict for the wrong cause, and that is a
// guard that has stopped watching without saying so.
//
// The set is deliberately two-sided. Fixtures that must be UNGUARDED stop the
// analyser going blind; fixtures that must be SAFE stop it going noisy (and a
// noisy rule gets weakened until it passes, which is how a gate ends up
// measuring nothing). The ADOPTER fixture is the anti-blindness proof for
// #3281 specifically: it fails the build if adopting the fix ever stops the
// analyser judging NEW defects in the same file.
// ===========================================================================

const CONTROL_DEFECT = `'use client';
import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/domains');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setDomains(j.domains || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {error && <MessageBar intent="error">{error}</MessageBar>}
      {loading && !error ? (
        <Spinner label="Loading domains…" />
      ) : domains.length === 0 ? (
        <GuidedEmptyState title="Organize the estate into domains" />
      ) : (
        <Table rows={domains} />
      )}
    </div>
  );
}
`;

const CONTROL_FIXED = CONTROL_DEFECT
  .replace('useState<Domain[]>([])', 'useState<Domain[] | null>(null)')
  .replace('domains.length === 0 ?', 'domains && domains.length === 0 ?')
  .replace('<Table rows={domains} />', '<Table rows={domains || []} />');

const CONTROL_ADOPTER = CONTROL_FIXED.replace(
  '      {error && <MessageBar intent="error">{error}</MessageBar>}',
  '      {error && <MessageBar intent="error">{error}</MessageBar>}\n'
  + '      {recent.length === 0 && <EmptyState title="No recent activity" />}',
).replace(
  '  const [loading, setLoading] = useState(true);',
  '  const [loading, setLoading] = useState(true);\n  const [recent, setRecent] = useState<Row[]>([]);',
);

/**
 * POLARITY. The empty claim sits in the ALTERNATE of a conjunction that
 * mentions the error state. `¬(error ∧ ready)` does NOT imply `¬error`, so this
 * claim still renders after a failure and must be UNGUARDED.
 *
 * This fixture exists because the first control set MISSED a real drift: making
 * `literalsOf` decompose a false-required condition on `&&` instead of `||`
 * turns `error && ready ? … : claim` into "error is false" and reports the
 * defect as safe. The old DEFECT fixture kept passing through that mutation.
 */
const CONTROL_POLARITY = `'use client';
import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';

export default function RunsPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    clientFetch('/api/runs').then((r) => r.json()).then((j) => { setRows(j.rows || []); setReady(true); })
      .catch((e) => setError(e?.message || String(e)));
  }, []);
  return (
    <div>
      {error && ready ? (
        <MessageBar intent="error">{error}</MessageBar>
      ) : rows.length === 0 ? (
        <EmptyState title="No runs" body="Nothing has run yet." />
      ) : (
        <Table rows={rows} />
      )}
    </div>
  );
}
`;

/**
 * COERCION. The nullish sentinel is present and required (`rows !== null &&`),
 * but the failure handler writes `[]` into it — so the sentinel proves nothing
 * and the claim is UNGUARDED. This is items-by-type-pane.tsx, verbatim in
 * shape: `.catch(() => setItems([]))` under `{items !== null && items.length
 * === 0 && <EmptyState title="No items yet" …>}`.
 *
 * It pins the failure-path write tracking. An analyser that only looked at the
 * `useState` initialiser would call this SAFE via E1 — which is exactly the
 * "looks correct, is not" case no textual rule can separate.
 */
const CONTROL_COERCION = `'use client';
import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';

export function ItemsByTypePane() {
  const [items, setItems] = useState<OwnedItem[] | null>(null);
  useEffect(() => {
    clientFetch('/api/items/by-type').then((r) => r.json())
      .then((d) => setItems(Array.isArray(d?.items) ? d.items : []))
      .catch(() => setItems([]));
  }, []);
  return (
    <div>
      {items === null && <Spinner label="Loading items…" />}
      {items !== null && items.length === 0 && (
        <EmptyState title="No items yet" body="Create your first one." />
      )}
    </div>
  );
}
`;

/**
 * PAYLOAD. The read is delegated to a same-file helper whose failure branches
 * return `{ data: null, error }`, and the claim requires `state.data?.ok`. A
 * failed read cannot populate that field, so this is SAFE via E4. This is
 * dlp-panel.tsx's shape, and it pins the same-file helper resolution — without
 * it these five sections drop out of the judged population entirely while the
 * guard still prints OK.
 */
const CONTROL_PAYLOAD = `'use client';
import { useCallback, useEffect, useState } from 'react';

async function fetchJson<T>(url: string): Promise<ApiState<T>> {
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) return { loading: false, data: null, error: j?.error || 'HTTP ' };
    return { loading: false, data: j as T };
  } catch (e: any) { return { loading: false, data: null, error: e?.message || String(e) }; }
}

export function PoliciesSection() {
  const [state, setState] = useState<ApiState<PoliciesPayload>>(emptyState());
  const load = useCallback(async () => {
    setState({ loading: true, data: null });
    setState(await fetchJson<PoliciesPayload>('/api/admin/security/dlp/policies'));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      {state.error && <MessageBar intent="error">{state.error}</MessageBar>}
      {state.data?.ok && (state.data.policies || []).length === 0 && (
        <EmptyState title="No DLP policies" body="None are configured for this tenant." />
      )}
    </div>
  );
}
`;

/**
 * QUERY. finops-cockpit-pane.tsx's shape: the read is a react-query whose
 * fetcher RESOLVES on a non-2xx (so `breakdownQ.isError` alone stays false
 * through a 504), and a same-file wrapper folds the HTTP status back into
 * `isError`. The claim sits on the not-errored side of `readState(breakdownQ)`
 * and its emptiness test reads breakdownQ's own data. SAFE via E6.
 */
const CONTROL_QUERY = `'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clientFetch } from '@/lib/client-fetch';

async function getJson(url: string): Promise<any> {
  const res = await clientFetch(url, { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  return { ...json, status: res.status };
}

function readState(q: { isError: boolean; data: any }) {
  const status = typeof q.data?.status === 'number' ? q.data.status : null;
  const httpFailed = status !== null && status >= 400;
  return { isError: q.isError || httpFailed };
}

export function BreakdownPane() {
  const [dimension, setDimension] = useState('service');
  const breakdownQ = useQuery({ queryKey: ['b', dimension], queryFn: () => getJson('/api/b') });
  const budgetsQ = useQuery({ queryKey: ['u'], queryFn: () => getJson('/api/u') });
  return (
    <div>
      {breakdownQ.isPending ? <Spinner /> :
        readState(breakdownQ).isError ? null :
        (breakdownQ.data?.rows || []).length ? <Chart rows={breakdownQ.data.rows} /> : (
          <EmptyState title="No breakdown data" />
        )}
    </div>
  );
}
`;

/**
 * QUERY_SWAP. The QUERY control with ONE change: the emptiness test reads a
 * DIFFERENT query's data. `readState(breakdownQ)` succeeding says nothing about
 * budgetsQ, so the claim is UNGUARDED. This is the data-link half of E6; without
 * it, any isError anywhere above a claim would launder it.
 */
const CONTROL_QUERY_SWAP = CONTROL_QUERY.replace(
  '(breakdownQ.data?.rows || []).length ?',
  '(budgetsQ.data?.rows || []).length ?',
);

/**
 * QUERY_BARE. The QUERY control gated on a BARE `breakdownQ.isError` instead of
 * the fold. `getJson` RESOLVES on a 504, so that isError stays false through a
 * failed read: UNGUARDED. This pins E6's completeness condition on every run —
 * without it, trusting a bare isError (or missing a swallowing catch) left the
 * guard exiting 0 and only the unit tests noticed (#4771 round 6, finding 8).
 */
const CONTROL_QUERY_BARE = CONTROL_QUERY.replace(
  'readState(breakdownQ).isError ? null :',
  'breakdownQ.isError ? null :',
);

/**
 * Each row: [name, source, expected verdicts in order, why-prefix per claim,
 * what a failure of this row means].
 */
const CONTROLS = [
  ['DEFECT', CONTROL_DEFECT, ['unguarded'], [null],
    'The analyser can no longer see the original /catalog/domains defect (#3281), so a clean report from it would mean nothing.'],
  ['FIXED', CONTROL_FIXED, ['safe'], ['E1'],
    'The analyser no longer recognises the shipped fix, so every corrected surface would be reported as a violation — and a rule that cries wolf gets weakened until it passes.'],
  ['ADOPTER', CONTROL_ADOPTER, ['unguarded', 'safe'], [null, 'E1'],
    'ANTI-BLINDNESS: adopting the fix has stopped the analyser judging NEW defects in the same file. That is exactly how the previous attempt at this rule went quiet (csa_loom_guard_keyed_to_the_unsafe_pattern).'],
  ['POLARITY', CONTROL_POLARITY, ['unguarded'], [null],
    'A condition mentioning the error state in a NEGATIVE position is being read as evidence. `¬(error ∧ ready)` does not imply `¬error`, and this is the shape the live /catalog/domains bug had.'],
  ['COERCION', CONTROL_COERCION, ['unguarded'], [null],
    'A failure handler that writes an EMPTY value into the data state is no longer tracked, so a nullish sentinel it destroys is being accepted as proof the read succeeded.'],
  ['PAYLOAD', CONTROL_PAYLOAD, ['safe'], ['E4'],
    'A read delegated to a same-file helper is no longer resolved. Those components silently leave the judged population while the guard keeps printing OK.'],
  ['QUERY', CONTROL_QUERY, ['safe'], ['E6'],
    'A react-query read gated on its folded outcome is no longer recognised, so every correctly-gated useQuery surface reads as a violation again.'],
  ['QUERY_SWAP', CONTROL_QUERY_SWAP, ['unguarded'], [null],
    'E6 has lost its data link: a claim whose emptiness comes from one query is being accepted on ANOTHER query\'s success.'],
  ['QUERY_BARE', CONTROL_QUERY_BARE, ['unguarded'], [null],
    'E6 has lost its completeness check: a bare isError over a fetcher that RESOLVES on a 504 is being accepted as proof the read succeeded.'],
];

function runControls() {
  const problems = [];
  for (const [name, src, wantVerdicts, wantWhy, meaning] of CONTROLS) {
    const got = judgeSource(src, `<control:${name.toLowerCase()}>`)
      .claims.sort((a, b) => a.line - b.line);
    const desc = got.map((c) => `${c.verdict}${c.why ? `(${c.why})` : ''}@${c.line}`).join(', ') || 'no claims judged at all';
    if (got.length !== wantVerdicts.length) {
      problems.push(`${name} control: expected ${wantVerdicts.length} judged claim(s), got ${got.length} — ${desc}. ${meaning}`);
      continue;
    }
    for (let i = 0; i < got.length; i++) {
      if (got[i].verdict !== wantVerdicts[i]) {
        problems.push(`${name} control: claim ${i + 1} expected ${wantVerdicts[i]}, got ${got[i].verdict} — ${desc}. ${meaning}`);
      } else if (wantWhy[i] && !String(got[i].why ?? '').startsWith(wantWhy[i])) {
        problems.push(
          `${name} control: claim ${i + 1} is ${got[i].verdict}, but for the WRONG reason — expected `
          + `${wantWhy[i]}, got ${got[i].why ?? 'none'} (${desc}). A verdict reached by a different `
          + `route is a verdict that will diverge on the next real file. ${meaning}`,
        );
      }
    }
  }
  return problems;
}


// ===========================================================================
// 9. CLI
// ===========================================================================

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '__tests__', 'e2e'].includes(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const REPORT = argv.includes('--report');
  const WRITE_BASELINE = argv.includes('--write-baseline');
  const SELF_TEST = argv.includes('--self-test');

  const controlProblems = runControls();
  if (controlProblems.length) {
    console.error('\ncheck-empty-claim-read-evidence: EMBEDDED CONTROL FAILED\n');
    for (const p of controlProblems) console.error(`  ${p}\n`);
    console.error(
      '  The controls run on every invocation precisely so that a drifted analyser\n'
      + '  cannot present itself as a clean codebase. Refusing to report on the repo.\n',
    );
    process.exit(2);
  }
  if (SELF_TEST) {
    console.log(`check-empty-claim-read-evidence: embedded controls PASS (${CONTROLS.length} fixtures: ${CONTROLS.map((c) => c[0]).join(', ')} — verdict AND reason)`);
    if (!REPORT) return;
  }

  const files = SCAN_ROOTS.flatMap((r) => walk(r));
  const claims = [];
  let noReadClaims = 0;
  let filesWithClaims = 0;

  for (const f of files) {
    const path = rel(f);
    if (CLAIM_DEFINITION_FILES.has(path)) continue;
    const src = readFileSync(f, 'utf8');
    if (!CLAIM_TAGS.some((t) => src.includes(`<${t}`))) continue;
    filesWithClaims++;
    const r = judgeSource(src, path);
    claims.push(...r.claims);
    noReadClaims += r.noReadClaims;
  }

  const unguarded = claims.filter((c) => c.verdict === 'unguarded');
  const unknown = claims.filter((c) => c.verdict === 'unknown');
  const safe = claims.filter((c) => c.verdict === 'safe');

  const observed = new Map();
  for (const c of [...unguarded, ...unknown]) {
    const k = `${c.path}#${c.verdict}`;
    observed.set(k, (observed.get(k) || 0) + 1);
  }

  if (WRITE_BASELINE) {
    const known = {};
    for (const k of [...observed.keys()].sort()) known[k] = observed.get(k);
    process.stdout.write(`${JSON.stringify({
      note: 'Per-file ratchet for check-empty-claim-read-evidence.mjs (#3281). '
        + 'Counts may only SHRINK; a file absent from this map must be at ZERO. '
        + 'Delete an entry when the last claim in that file is fixed.',
      generated: new Date().toISOString().slice(0, 10),
      known,
    }, null, 2)}\n`);
    return;
  }

  if (REPORT) {
    console.log('== check-empty-claim-read-evidence census ==');
    console.log(`files scanned (.tsx under lib/ + app/) : ${files.length}`);
    console.log(`files rendering an EmptyState family    : ${filesWithClaims}`);
    console.log(`claims JUDGED (component has a read)    : ${claims.length}`);
    console.log(`  safe                                  : ${safe.length}`);
    console.log(`  unguarded                             : ${unguarded.length}`);
    console.log(`  unknown (structure unresolvable)      : ${unknown.length}`);
    console.log(`claims UNJUDGED (no read in component)  : ${noReadClaims}`);
    const byFile = new Map();
    for (const c of unguarded) byFile.set(c.path, (byFile.get(c.path) || 0) + 1);
    console.log(`\ntop unguarded files:`);
    for (const [p, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`  ${n}  ${p}`);
    }
    if (argv.includes('--verbose')) {
      for (const c of claims) {
        console.log(`${c.verdict}\t${c.path}:${c.line}\t${c.scope}\t${c.why ?? ''}\t[${(c.literals || []).join(' ')}]`);
      }
    }
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    console.error(`check-empty-claim-read-evidence: baseline missing/unreadable at ${rel(BASELINE_PATH)}.`);
    process.exit(2);
  }

  const failures = [];
  for (const [key, count] of observed) {
    const allowed = baseline.known?.[key] ?? 0;
    if (count > allowed) {
      const [file, verdict] = key.split('#');
      failures.push({ key, count, allowed, sample: claims.find((c) => c.path === file && c.verdict === verdict) });
    }
  }
  const stale = Object.keys(baseline.known || {}).filter((k) => !observed.has(k));

  if (failures.length || stale.length) {
    console.error('\ncheck-empty-claim-read-evidence: FAILED\n');
    console.error('An empty-state claim must be gated on evidence that the READ SUCCEEDED.\n');
    for (const f of failures) {
      console.error(`  ${f.key}: ${f.count} claim(s), baseline allows ${f.allowed}`);
      if (f.sample) {
        console.error(`    first at ${f.sample.path}:${f.sample.line} (${f.sample.scope}, <${f.sample.tag}>)`);
        console.error(`    conditions that must hold for it to render: [${(f.sample.literals || []).join(', ') || 'none'}]`);
        console.error(
          f.sample.verdict === 'unknown'
            ? '    UNKNOWN — the analyser could not resolve this render structure. Unknown is not '
              + 'safe: it means nobody has checked whether this claim survives a failed read.'
            : '    None of those is evidence the read SUCCEEDED, so this claim still renders after '
              + 'a 500 / 401 / timeout and asserts emptiness the code never established '
              + '(deploy-integrity.md R7).',
        );
        console.error(
          '    Fix: gate the claim on the read having returned — keep the data state nullish '
          + 'until it loads and require it (`rows && rows.length === 0 && …`), or require the '
          + 'error state to be absent (`!err && …`). Do not gate on a `loading` flag a '
          + '`finally` clears regardless of outcome.\n',
        );
      }
    }
    if (stale.length) {
      console.error('  STALE baseline entries (fixed — delete them so the ratchet keeps its teeth):');
      for (const k of stale) console.error(`    ${k}`);
      console.error('');
    }
    process.exit(1);
  }

  console.log(
    `check-empty-claim-read-evidence: OK (${files.length} files scanned, `
    + `${claims.length} empty-state claims JUDGED in components that read — `
    + `${safe.length} gated on read-success evidence, ${unguarded.length} not, `
    + `${unknown.length} unresolvable; all within baseline. `
    + `${noReadClaims} further claim(s) sit in components with no read of their own and are NOT judged. `
    + `${CONTROLS.length} embedded controls intact.)`,
  );
}

// Run as a script, not as an import side effect (#3436). Without this,
// `import`ing this module to unit-test its helpers runs the WHOLE scan and can
// process.exit() inside the test runner — which surfaces as a runner that dies
// with no failed assertion, the same non-diagnostic shape as a `set -u` abort.
if (process.argv[1] && process.argv[1].endsWith('check-empty-claim-read-evidence.mjs')) {
  main();
}
