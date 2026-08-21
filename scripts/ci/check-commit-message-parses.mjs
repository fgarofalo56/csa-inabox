#!/usr/bin/env node
/**
 * check-commit-message-parses.mjs — a commit whose body the changelog parser cannot
 * read is DROPPED ENTIRELY, silently, while the release run concludes `success`.
 *
 * WHY THIS EXISTS
 * ---------------
 * release-please builds its changelog with `@conventional-commits/parser`. That parser
 * reads the WHOLE commit message, subject and body together. When the body contains a
 * fragment it cannot tokenise, it throws — and release-please catches the throw, skips
 * that commit, and carries on. The run is green. The release is cut. The work is simply
 * absent from the changelog and from the GitHub release notes, with nothing anywhere
 * saying so.
 *
 * Measured on this repo's history (3010 non-merge commits on main):
 *   - 15 commits with a VALID conventional subject were silently dropped this way
 *   - the oldest is 2026-06-11; 5 of them are `fix(security):`
 * Every one is real, released work that appears in no changelog.
 *
 * WHAT THIS GUARD JUDGES
 * ----------------------
 * The PR branch's non-merge commit messages — because that is the text that actually
 * becomes the changelog input. This is not an assumption; the repo's own setting says so:
 *
 *     gh api repos/:owner/:repo --jq '.squash_merge_commit_message'  ->  COMMIT_MESSAGES
 *
 * So the landed squash body is composed from the branch commits, NOT from the PR body.
 * A guard reading the PR description would judge text that never lands.
 *
 * Merge commits are excluded (`--no-merges`) because GitHub excludes them from that
 * composition — measured on #3830: 6 bullets for 7 branch commits, merge subject absent.
 * Judging them would be judging text that never reaches the changelog.
 *
 * That flag LOOKS like dead code and is not. Measured: main carries 2 merge commits in its
 * entire history and neither subject parses as conventional, so the scoping below already
 * excludes every ordinary merge shape (`Merge branch ...`, `Merge pull request ...`).
 * Delete `--no-merges` and every real-history test still passes. The case it actually
 * covers is a merge made with `git merge -m "feat(x): ..."`: that subject IS conventional,
 * so scoping does NOT exclude it, and the guard would fail a PR over a body GitHub was
 * never going to put in the changelog. Keep the flag.
 *
 * Judging each commit on its own is SUFFICIENT: GitHub's composition glue (`* subject`
 * bullets, the `---------` separator, `Co-authored-by:` trailers) was measured to be
 * inert — it parses. So there is no need to model GitHub's squash composition, which is
 * the fragile part of any such design.
 *
 * SCOPING — the parser is the oracle for BOTH questions
 * -----------------------------------------------------
 * Not every unparseable commit is a defect. `Revert "..."`, `Merge branch ...` and
 * malformed subjects were never going to reach the changelog whatever the parser did;
 * failing a PR for those is noise. A commit whose SUBJECT is a valid conventional header
 * but whose BODY throws is the real loss.
 *
 * The split could be done with a regex for the header — but a regex is an approximation
 * of the very grammar that caused this bug. So instead: parse the SUBJECT ALONE to ask
 * "was this changelog-bound?", then parse the FULL message to ask "does it survive?".
 * No grammar is restated anywhere in this file.
 *
 * Replayed over all 3010 non-merge commits on main, that rule flags exactly the 15 known
 * losses and nothing else — a measured false-positive rate of zero.
 *
 * Like `check-release-please-integrity.mjs`, this guard asserts a SAFE property survives
 * rather than hunting for known-bad strings, and it refuses to report a repo verdict at
 * all when its own embedded controls disagree — a silent drift is exactly the failure
 * mode it was written to prevent.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * The real parser release-please uses. A missing dependency is a hard failure, never a
 * skip: a guard that quietly no-ops when its dependency is absent is worse than none.
 *
 * Loaded LAZILY and SYNCHRONOUSLY rather than with a module-level `await import`. That is
 * not a style preference — it is what makes this file testable without breaking a required
 * CI context. `loom-guardrails.yml` runs `node --test scripts/ci/__tests__/*.test.mjs` over
 * a GLOB, so any sibling test file is automatically picked up by that lane, and
 * `guardrails` IS a required context. The parser is installed only by
 * commit-message-parses.yml — there is no root package.json, so it is absent everywhere
 * else. With a module-level failure, merely importing this file would kill the importing
 * test file and turn a required context permanently red for every PR in the repo.
 *
 * Measured, not assumed: `node --test` on a file importing this module with the parser
 * unresolvable reported `pass 0 / fail 1`.
 *
 * The fail-closed behaviour is UNCHANGED — the same annotation, the same exit 1. It just
 * happens at first parse instead of at import. The package is CJS (`main: index.js`, no
 * `exports` map, no `type: module`), so createRequire resolves it synchronously and
 * nothing downstream has to become async.
 */
let parserFn = null;
function getParser() {
  if (parserFn) return parserFn;
  try {
    parserFn = createRequire(import.meta.url)('@conventional-commits/parser').parser;
  } catch (err) {
    console.error(
      '::error::check-commit-message-parses: @conventional-commits/parser is not installed, ' +
        'so this guard cannot judge anything. It is reporting NOTHING about this PR rather ' +
        'than a clean scan it did not perform. Install it before running: ' +
        `npm install --no-save @conventional-commits/parser@0.4.1  (${err?.message ?? err})`,
    );
    process.exit(1);
  }
  return parserFn;
}

/** Is the parser resolvable at all? Lets a caller distinguish "absent" from "rejects this
 * text" without triggering the hard failure above. Used by the test suite so it can assert
 * the fail-closed path deliberately rather than tripping over it. */
export function parserIsAvailable() {
  try {
    createRequire(import.meta.url)('@conventional-commits/parser');
    return true;
  } catch {
    return false;
  }
}

/** Does the parser accept this text? The single primitive both questions are asked with. */
function parses(text) {
  const parser = getParser();
  try {
    parser(text);
    return true;
  } catch {
    return false;
  }
}

/** Where did it throw? Returns null when the text parses. */
function locate(text) {
  const parser = getParser();
  try {
    parser(text);
    return null;
  } catch (e) {
    const raw = String(e?.message ?? e);
    const m = raw.match(/unexpected token '(.*?)' at (\d+):(\d+)/s);
    // If the message shape ever changes, say so rather than inventing coordinates.
    if (!m) return { token: null, line: null, col: null, raw };
    return { token: m[1], line: Number(m[2]), col: Number(m[3]), raw };
  }
}

/**
 * Judge one commit message exactly as release-please will read it.
 *
 * @param {string} text full commit message — subject, blank line, body
 * @returns {{changelogBound: boolean, ok: boolean, failure: null | {
 *   line: number|null, col: number|null, token: string|null,
 *   offendingLine: string, raw: string }}}
 */
export function judgeMessage(text) {
  const subject = String(text ?? '').split('\n')[0] ?? '';

  // Q1: would release-please have put this in the changelog at all?
  if (!parses(subject)) return { changelogBound: false, ok: true, failure: null };

  // Q2: does the whole message survive the parse that decides whether it lands?
  const where = locate(text);
  if (!where) return { changelogBound: true, ok: true, failure: null };

  const offendingLine =
    where.line != null ? (String(text).split('\n')[where.line - 1] ?? '') : '';
  return { changelogBound: true, ok: false, failure: { ...where, offendingLine } };
}

// ---------------------------------------------------------------------------
// Embedded controls.
//
// These assert EXACT coordinates, not merely "still throws". That makes them a version
// tripwire: if the parser's behaviour shifts, the controls disagree and the guard refuses
// to report, instead of silently drifting into judging a different grammar than the one
// release-please runs.
//
// Every coordinate below was measured against @conventional-commits/parser@0.4.1, which
// was independently confirmed to reproduce two hosted-run failures to the exact column.
// Fixtures are ASCII-only on purpose: a non-ASCII character silently shifts a column, and
// CRLF can no-op a needle outright.
// ---------------------------------------------------------------------------
const H = 'fix(scope): a normal subject line';

/** @type {{name: string, text: string, expect: null | {line: number, col: number}}[]} */
export const SELF_TEST_CASES = [
  // --- must PARSE: ordinary prose, and the near-misses that look dangerous but are not.
  { name: 'a plain body parses', text: `${H}\n\nAn ordinary body paragraph with no punctuation traps.\n`, expect: null },
  { name: 'parens mid-line parse', text: `${H}\n\nWe call the helper foo(bar) here and it is fine.\n`, expect: null },
  { name: 'balanced parens at line start parse', text: `${H}\n\nfoo(bar) is called at the start of this line.\n`, expect: null },
  { name: 'a backtick before a call parses', text: `${H}\n\n\`take('func-loom', 60)\` truncates the name.\n`, expect: null },
  { name: 'a bare open paren at line start parses', text: `${H}\n\n(this parenthetical opens a line and never closes on it\n`, expect: null },
  { name: 'a bullet list body parses', text: `${H}\n\n* one item\n* two item\n`, expect: null },
  { name: 'a co-author trailer parses', text: `${H}\n\nbody\n\nCo-Authored-By: A B <a@b.c>\n`, expect: null },
  // The measured remedy. If this ever stops parsing, the advice this guard prints is
  // wrong and it must stop printing it.
  { name: 'THE FIX: indenting the offending line by two spaces parses', text: `${H}\n\n  withAudit(async (req) => handler(req)) wraps the route.\n`, expect: null },

  // --- must THROW, at exactly these coordinates.
  { name: 'nested parens in a line-start call throw', text: `${H}\n\nwithAudit(async (req) => handler(req)) wraps the route.\n`, expect: { line: 3, col: 17 } },
  { name: 'a call left open at end of line throws', text: `${H}\n\ngetSession(\nand continues on the next line.\n`, expect: { line: 3, col: 12 } },
  // Counter-intuitive and worth pinning: a fenced code block does NOT protect the body.
  // "wrap it in a code block" is the advice most authors would reach for, and it is wrong.
  { name: 'a fenced code block does NOT protect the body', text: `${H}\n\n\`\`\`\nwithAudit(async (req) => handler(req))\n\`\`\`\n`, expect: { line: 4, col: 17 } },

  // --- scoping: a non-conventional subject is out of scope even when the body throws.
  { name: 'a non-conventional subject is out of scope', text: `Revert "fix(x): something"\n\nwithAudit(async (req) => handler(req))\n`, expect: null },
  { name: 'a merge subject is out of scope', text: `Merge branch 'main' into feature\n\nwithAudit(async (req) => handler(req))\n`, expect: null },
  // The case that keeps `--no-merges` alive. A merge made with `git merge -m "feat(x): ..."`
  // has a CONVENTIONAL subject, so scoping does not exclude it and this control throws. The
  // collection layer must filter it out, because GitHub drops merge commits from the squash
  // composition and the guard would otherwise fail a PR over text that never lands. If this
  // control is ever changed to `expect: null`, `--no-merges` has become genuinely redundant.
  { name: 'a merge with a CONVENTIONAL subject is IN scope (why --no-merges exists)', text: `feat(x): merge main into the feature branch\n\nwithAudit(async (req) => handler(req))\n`, expect: { line: 3, col: 17 } },
];

/** @returns {{name: string, expected: string, got: string}[]} controls that DISAGREED */
export function runSelfTest() {
  const bad = [];
  for (const c of SELF_TEST_CASES) {
    const v = judgeMessage(c.text);
    const got = v.ok ? 'parses' : `${v.failure.line}:${v.failure.col}`;
    const expected = c.expect === null ? 'parses' : `${c.expect.line}:${c.expect.col}`;
    if (got !== expected) bad.push({ name: c.name, expected, got });
  }
  return bad;
}

/**
 * The control POPULATION is itself load-bearing, and nothing above measures it.
 *
 * The success line used to print `${SELF_TEST_CASES.length}/${SELF_TEST_CASES.length}` --
 * numerator and denominator the same expression, so it reads N/N however many controls
 * exist. Delete four of them and it prints a tidy `10/10 embedded controls agree` and
 * still exits 0. The ratio was never a witness; RC=0 (runSelfTest returning empty) is.
 * These floors are what stop the suite being hollowed out underneath that.
 *
 * THROW_FLOOR is separate on purpose. The must-throw controls are the load-bearing half --
 * they are what pin the parser's exact coordinates -- and a total-only floor could be
 * satisfied by padding the suite with trivial must-parse cases after gutting them.
 *
 * Both floors are the counts measured against @conventional-commits/parser@0.4.1. Lowering
 * one is a deliberate act that belongs in a diff, which is the entire point.
 */
export const CONTROL_FLOOR = 14;
export const THROW_FLOOR = 4;

/**
 * @param {typeof SELF_TEST_CASES} [cases]
 * @returns {string[]} reasons the control population is inadequate; empty when it is fine
 */
export function checkControlPopulation(cases = SELF_TEST_CASES) {
  const problems = [];
  const mustThrow = cases.filter((c) => c.expect !== null).length;
  if (cases.length < CONTROL_FLOOR) {
    problems.push(`only ${cases.length} embedded control(s) remain, below the floor of ${CONTROL_FLOOR}`);
  }
  if (mustThrow < THROW_FLOOR) {
    problems.push(
      `only ${mustThrow} control(s) assert exact throw coordinates, below the floor of ${THROW_FLOOR}`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Repo scan
// ---------------------------------------------------------------------------
// Commit bodies contain blank lines, bullets and code, so no printable delimiter is
// safe. Separate records with U+0001 and the sha from the message with NUL. Written as
// escapes, never as literal control bytes -- a literal one is invisible in review and an
// editor or line-ending pass can silently eat it, which would make this guard scan one
// giant malformed record.
//
// Only ONE of these is genuinely impossible in the data. NUL cannot survive git's commit
// path, so the sha/message split is safe. U+0001 CAN legally appear in a commit body --
// nothing in git filters it -- and a body carrying one splits a single commit into two
// records, shifting every message after it so the guard judges each body against the
// wrong sha. That is not a worry papered over with a comment: it is exactly why the
// record count is cross-checked against git's own count below rather than trusted.
const RS = '\u0001';
const FS = '\u0000';

/** A full git object name. `.filter((c) => c.sha)` would be a TRUTHINESS test, which a
 * garbage fragment passes; this is a sha test, which it does not. */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * git's own count for the range -- the CONTROL the parse below is measured against.
 *
 * Deliberately a SECOND git invocation, with a different subcommand and a different
 * output format. A cross-check derived from the same command's output would agree with
 * whatever that output produced and would confirm only the method, never the answer.
 *
 * @param {string} base
 * @param {string} head
 * @param {{withMerges?: boolean}} [opts]
 * @returns {number}
 */
export function expectedCount(base, head, { withMerges = false } = {}) {
  const args = ['rev-list', '--count'];
  if (!withMerges) args.push('--no-merges');
  args.push(`${base}..${head}`);
  const raw = execFileSync('git', args, { encoding: 'utf8' }).trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `git rev-list --count returned ${JSON.stringify(raw)} for ${base}..${head}, which is not a ` +
        'count. Refusing to cross-check against a number this guard cannot read.',
    );
  }
  return n;
}

/**
 * Split a `git log --format=%H%x00%B<RS>` payload into records. A PURE function of the
 * text, so a test can hand it a payload carrying a stray U+0001 without having to build a
 * repository that produces one.
 *
 * A record with no NUL is KEPT, with a null sha, rather than dropped. It is the
 * fingerprint of a U+0001 inside a body, and discarding it here would hide the very
 * discrepancy the count cross-check exists to catch.
 *
 * @param {string} out
 * @returns {{sha: string|null, message: string}[]}
 */
export function parseLog(out) {
  return String(out)
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rec) => {
      const i = rec.indexOf(FS);
      return i === -1
        ? { sha: null, message: rec }
        : { sha: rec.slice(0, i), message: rec.slice(i + 1) };
    });
}

/**
 * The branch's non-merge commits -- or a throw. Never a partial answer.
 *
 * THROWS rather than calling process.exit, so the function can be asserted in-process by
 * a test. main() catches and emits the same ::error:: annotation and the same exit 1, so
 * CI behaviour is unchanged; only testability moves.
 *
 * @param {string} base
 * @param {string} head
 * @returns {{sha: string, message: string}[]}
 */
export function commitsIn(base, head) {
  const out = execFileSync(
    'git',
    ['log', '--no-merges', `--format=%H%x00%B${RS}`, `${base}..${head}`],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const records = parseLog(out);
  const nonMerge = expectedCount(base, head);

  if (records.length !== nonMerge) {
    throw new Error(
      `parsed ${records.length} record(s) out of git log, but git rev-list counts ${nonMerge} ` +
        `non-merge commit(s) in ${base}..${head}. The likeliest cause is a U+0001 inside a commit ` +
        'body splitting one record in two, which shifts every message after it and makes this ' +
        'guard judge each body against the wrong sha. Reporting NOTHING rather than a verdict on ' +
        'a payload it cannot account for.',
    );
  }

  // A zero range cannot be judged by that agreement alone. When BASE_SHA/HEAD_SHA are
  // wrong -- an unfetched base, a typo, a force-push that orphaned the ref -- git's count
  // is ALSO 0, so the check above agrees with itself and the guard reports a clean scan of
  // nothing. Counting WITH merges separates the two cases, because a real branch whose
  // commits happen to all be merges still has commits in it.
  if (nonMerge === 0) {
    const total = expectedCount(base, head, { withMerges: true });
    if (total === 0) {
      throw new Error(
        `${base}..${head} contains no commits at all, not even merges. That is a degenerate ` +
          'range rather than a clean branch -- a wrong or unfetched base SHA produces exactly ' +
          'this shape. Refusing to report a clean scan of nothing.',
      );
    }
    console.log(
      `::notice::check-commit-message-parses: ${base}..${head} holds ${total} commit(s), every ` +
        'one a merge. GitHub drops merge commits from the squash composition, so none of them ' +
        'reaches the changelog and there is nothing here to judge.',
    );
    return [];
  }

  const malformed = records.filter((c) => !SHA_RE.test(c.sha ?? ''));
  if (malformed.length > 0) {
    throw new Error(
      `${malformed.length} of ${records.length} record(s) do not begin with a 40-character git ` +
        'object name, so the sha/message split did not land where it should have. Refusing to ' +
        'judge messages this guard cannot attribute to a commit. First offender begins: ' +
        JSON.stringify(String(malformed[0].message).slice(0, 120)),
    );
  }

  return /** @type {{sha: string, message: string}[]} */ (records);
}

function main(argv) {
  // Controls first, always. If they disagree the guard has no standing to judge the repo.
  const disagreements = runSelfTest();
  if (disagreements.length > 0) {
    for (const d of disagreements) {
      console.error(`::error::control DISAGREED: ${d.name} — expected ${d.expected}, got ${d.got}`);
    }
    console.error(
      `::error::check-commit-message-parses: ${disagreements.length} of ${SELF_TEST_CASES.length} ` +
        'embedded controls DISAGREED. The parser this guard runs no longer behaves the way its ' +
        'controls were measured against, so it is reporting NOTHING about this PR rather than a ' +
        'clean scan it did not perform. Re-measure the coordinates against the installed parser ' +
        'version before trusting any verdict from this file.',
    );
    process.exit(1);
  }
  // The controls agreeing says nothing about how MANY of them there are. Assert the
  // population separately, because the line printed below cannot.
  const thin = checkControlPopulation();
  if (thin.length > 0) {
    for (const p of thin) console.error(`::error::control population: ${p}`);
    console.error(
      '::error::check-commit-message-parses: controls have been deleted rather than re-measured. ' +
        'A shrunken suite still agrees with itself and still exits 0, which is why the population ' +
        'is asserted here instead of inferred from the summary line. Restore the controls, or ' +
        're-measure them against the installed parser and lower the floor deliberately in a diff.',
    );
    process.exit(1);
  }
  const mustThrow = SELF_TEST_CASES.filter((c) => c.expect !== null).length;
  console.log(
    `check-commit-message-parses: all ${SELF_TEST_CASES.length} embedded controls agree ` +
      `(floor ${CONTROL_FLOOR}), ${mustThrow} of them asserting exact throw coordinates ` +
      `(floor ${THROW_FLOOR}).`,
  );
  if (argv.includes('--self-test')) return;

  const base = process.env.BASE_SHA || argv[0];
  const head = process.env.HEAD_SHA || argv[1] || 'HEAD';
  if (!base) {
    console.error(
      '::error::check-commit-message-parses: no base ref. Pass BASE_SHA/HEAD_SHA in the ' +
        'environment or as two arguments. Refusing to guess a range — a guard that scans the ' +
        'wrong commits reports a clean verdict it did not earn.',
    );
    process.exit(1);
  }

  // commitsIn throws so a test can assert its refusals in-process. The CI-visible
  // behaviour is deliberately unchanged: the same ::error:: annotation, the same exit 1
  // it used to produce inline.
  let commits;
  try {
    commits = commitsIn(base, head);
  } catch (err) {
    console.error(`::error::check-commit-message-parses: ${err?.message ?? err}`);
    process.exit(1);
  }
  const bound = [];
  const failures = [];
  for (const c of commits) {
    const v = judgeMessage(c.message);
    if (!v.changelogBound) continue;
    bound.push(c);
    if (!v.ok) failures.push({ ...c, failure: v.failure });
  }

  // Print the refs verbatim. Truncating them to 8 chars renders `X~40..X^` as `X..X`,
  // which reads as an empty range and hides what was actually scanned.
  console.log(
    `scanned ${commits.length} non-merge commit(s) in ${base}..${head}; ` +
      `${bound.length} are changelog-bound.`,
  );

  if (failures.length === 0) {
    console.log('every changelog-bound commit message parses. Nothing will be silently dropped.');
    return;
  }

  for (const f of failures) {
    const subject = f.message.split('\n')[0];
    const at = f.failure.line != null ? `line ${f.failure.line}, column ${f.failure.col}` : 'an unreported position';
    console.error(`::error::${f.sha.slice(0, 8)} "${subject}" — the changelog parser fails at ${at}.`);
    if (f.failure.offendingLine) console.error(`    ${JSON.stringify(f.failure.offendingLine.slice(0, 140))}`);
    if (f.failure.token === null) console.error(`    parser said: ${f.failure.raw.slice(0, 200)}`);
  }

  console.error('');
  console.error(
    `::error::${failures.length} commit message(s) on this branch cannot be parsed by release-please. ` +
      'Each one will be DROPPED ENTIRELY from the changelog and the GitHub release notes — silently, ' +
      'with the release run still reporting success. This has already cost this repo 15 commits of ' +
      'released work since 2026-06-11.',
  );
  console.error('');
  console.error('THE FIX (measured, not guessed): indent the offending line by two spaces.');
  // On the push-to-main path the offending commit is already PUBLISHED, so `git rebase -i`
  // is the wrong instruction — following it rewrites shared history. The workflow runs on
  // both `pull_request` and `push: [main]`; only the branch-scan path can still reword.
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    console.error('  This commit is already on main, so it CANNOT be reworded — the changelog');
    console.error('  entry for it is lost and the fix is forward-only. Add the missing entry by');
    console.error('  hand after the next release cuts (see #3852), and indent the line in future');
    console.error('  commit bodies so this does not recur.');
  } else {
    console.error(`  git rebase -i ${base}   # reword the commit(s) named above`);
  }
  console.error('');
  console.error('  before |withAudit(async (req) => handler(req)) wraps the route.');
  console.error('  after  |  withAudit(async (req) => handler(req)) wraps the route.');
  console.error('          ^ the | marks column 1; the fixed line starts two spaces in.');
  console.error('');
  console.error(
    'Do NOT wrap it in a fenced code block — that was measured NOT to protect the body; a fence ' +
      'still throws. Indenting renders as a code block in the changelog anyway, so nothing is lost.',
  );
  process.exit(1);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-commit-message-parses.mjs')
) {
  main(process.argv.slice(2));
}
