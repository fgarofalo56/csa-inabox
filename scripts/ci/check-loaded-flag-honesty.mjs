#!/usr/bin/env node
/**
 * check-loaded-flag-honesty.mjs
 *
 * RULE. A `finally` block must not promote a read to "loaded" when the matching
 * `catch` recorded nothing — not when a definitive empty claim is gated on that
 * flag.
 *
 * THE SHAPE (measured 2026-08-12 in lib/components/admin-security/dlp-panel.tsx):
 *
 *     const [history, setHistory] = useState<RestrictionRow[]>([]);
 *     const [historyLoaded, setHistoryLoaded] = useState(false);
 *
 *     try {
 *       const j = await clientFetch('/api/governance/dlp/meta').then((r) => r.json());
 *       setHistory(Array.isArray(j?.restrictions) ? j.restrictions : []);
 *     } catch { /* best-effort *\/ } finally { setHistoryLoaded(true); }
 *     ...
 *     {historyLoaded && history.length === 0 && (
 *       <EmptyState title="No restrict-access actions"
 *                   body="No restrict-access actions have been recorded yet. …" />
 *     )}
 *
 * When that fetch fails: the catch swallows it, `history` stays `[]`, and the
 * `finally` ACTIVELY PROMOTES the failed read to loaded — so the panel asserts
 * "no restrict-access actions have been recorded yet" as fact. The user cannot
 * tell a governance surface that is empty from one that is broken.
 *
 * The `finally` is what makes this lethal rather than merely sloppy. A swallowed
 * catch on its own usually leaves a spinner up; this one takes the spinner down
 * and replaces it with a confident lie. Same family as deploy-integrity R7 (an
 * error must not assert what the code never established), applied to the UI.
 *
 * ── WHY THIS RULE IS SHAPED SO NARROWLY ────────────────────────────────────
 *
 * #3281 reports that check-editor-read-failure-honesty resolves useQuery
 * fetchers only — 34 surfaces judged, 506 blind. Widening it by regex was tried
 * here first and FAILED, in a way worth recording so it is not retried blind:
 *
 *     file-level "empty claim + swallowed catch"      -> 161 candidates
 *     + require the catch be on a fetch chain          ->  35
 *     + exclude `.json().catch(...)` body-parse catches ->  20
 *     + require the swallowed setter feed the claim    ->   2
 *     hand-verified survivors                          ->   0 true positives
 *
 * Both survivors were false positives, by two different mechanisms: a variable
 * name reused across two components in one file, and a proximity window linking
 * a setter to an unrelated fetch chain nearby. Regex proximity cannot express
 * "this failure feeds that claim" — that needs component-scoped dataflow.
 *
 * The one REAL defect was found by reading the code, and its shape (a `catch`
 * BLOCK plus a promoting `finally`) is not what any of those matchers targeted.
 * So this rule encodes the shape that actually produced a defect, and nothing
 * wider. A rule that cries wolf gets muted, which is worse than no rule.
 *
 * ── SELF-DEFENCE ───────────────────────────────────────────────────────────
 *
 * The current population is ZERO, so "fail if no violations" is meaningless as
 * a drift check. Instead the guard runs its matcher against an EMBEDDED CONTROL
 * — the real pre-fix dlp-panel code — and fails if it cannot find it. A matcher
 * that has drifted off the language therefore fails LOUDLY rather than passing
 * on an empty population. This repo has been bitten five times by rules that
 * went quiet on exactly the change they watched.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = process.cwd();
const SCAN_ROOTS = [
  join(REPO, 'apps', 'fiab-console', 'lib'),
  join(REPO, 'apps', 'fiab-console', 'app'),
].filter(existsSync);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (['node_modules', '__tests__', '.next'].includes(entry)) continue;
      walk(p, out);
    } else if (/\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

/** Blank comments while PRESERVING offsets, so reported line numbers stay true. */
const blank = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
   .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

/** A catch that records NOTHING, immediately followed by a finally. */
const BARE_CATCH_FINALLY = /catch\s*(?:\([^)]*\)\s*)?\{\s*\}\s*finally\s*\{([^}]*)\}/g;

/** Find every violation in one source text. */
function findIn(src) {
  const found = [];
  BARE_CATCH_FINALLY.lastIndex = 0;
  let m;
  while ((m = BARE_CATCH_FINALLY.exec(src))) {
    const promoted = /set[\w$]*(?:Loaded|Ready|Done|Fetched)\s*\(\s*true\s*\)/.exec(m[1]);
    if (!promoted) continue; // finally does something else — not this defect
    const setterName = promoted[0].match(/set([\w$]*)\s*\(/)[1];
    const flagVar = setterName.charAt(0).toLowerCase() + setterName.slice(1);
    // That flag must gate a definitive empty claim.
    const claim = new RegExp(flagVar + '[\\s\\S]{0,80}?\\.length\\s*===?\\s*0[\\s\\S]{0,200}?<EmptyState');
    if (!claim.test(src)) continue;
    found.push({ line: src.slice(0, m.index).split('\n').length, flag: flagVar });
  }
  return found;
}

// ── Embedded control: the REAL pre-fix dlp-panel shape ──────────────────────
// If the matcher stops finding THIS, it has drifted and must not report a pass.
const CONTROL = `
  const [history, setHistory] = useState<RestrictionRow[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const loadHistory = useCallback(async () => {
    try {
      const j = await clientFetch('/api/governance/dlp/meta').then((r) => r.json());
      setHistory(Array.isArray(j?.restrictions) ? j.restrictions : []);
    } catch {   } finally { setHistoryLoaded(true); }
  }, []);
  return (<>{historyLoaded && history.length === 0 && (
    <EmptyState title="No restrict-access actions" body="No restrict-access actions have been recorded yet." />
  )}</>);
`;

if (findIn(CONTROL).length !== 1) {
  console.error(
    '::error::loaded-flag-honesty: the embedded CONTROL no longer matches. The matcher has drifted off the ' +
      'language it is meant to judge (JSX/TS changed, or the pattern was edited), so a pass here would mean ' +
      'nothing. Refusing to report a pass on a matcher that cannot find a known-true defect. ' +
      'The control is the real pre-fix lib/components/admin-security/dlp-panel.tsx.',
  );
  process.exit(1);
}

const files = SCAN_ROOTS.flatMap((r) => walk(r));
if (files.length === 0) {
  console.error(
    '::error::loaded-flag-honesty: scanned ZERO .tsx files. This console ships ~1,000, so the scan roots have ' +
      'drifted. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

const violations = [];
for (const f of files) {
  const src = blank(readFileSync(f, 'utf8'));
  if (!/\b(?:clientFetch|fetch)\s*\(/.test(src)) continue;
  for (const v of findIn(src)) violations.push({ file: relative(REPO, f).split(sep).join('/'), ...v });
}

if (violations.length > 0) {
  console.error(
    `::error::loaded-flag-honesty: ${violations.length} surface(s) promote a FAILED read to "loaded" in a ` +
      'finally, while the catch recorded nothing — and then gate a definitive empty claim on that flag. The ' +
      'spinner comes down and an <EmptyState> asserts "there is none" as fact, when the truth is "the read ' +
      'failed". Record the error in the catch and gate the claim on it (see dlp-panel.tsx, #3281).',
  );
  for (const v of violations) {
    console.error(`::error file=${v.file},line=${v.line}::finally promotes ${v.flag} on a swallowed failure`);
  }
  process.exit(1);
}

console.log(
  `loaded-flag-honesty OK — control matched, ${files.length} .tsx surface(s) scanned, 0 surfaces promote a ` +
    'failed read to loaded behind an empty claim.',
);
