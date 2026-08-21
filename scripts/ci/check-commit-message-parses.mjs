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

/** The real parser release-please uses. A missing dependency is a hard failure, never a
 * skip: a guard that quietly no-ops when its dependency is absent is worse than none. */
let parser;
try {
  ({ parser } = await import('@conventional-commits/parser'));
} catch (err) {
  console.error(
    '::error::check-commit-message-parses: @conventional-commits/parser is not installed, ' +
      'so this guard cannot judge anything. It is reporting NOTHING about this PR rather ' +
      'than a clean scan it did not perform. Install it before running: ' +
      `npm install --no-save @conventional-commits/parser@0.4.1  (${err?.message ?? err})`,
  );
  process.exit(1);
}

/** Does the parser accept this text? The single primitive both questions are asked with. */
function parses(text) {
  try {
    parser(text);
    return true;
  } catch {
    return false;
  }
}

/** Where did it throw? Returns null when the text parses. */
function locate(text) {
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

// ---------------------------------------------------------------------------
// Repo scan
// ---------------------------------------------------------------------------
// Commit bodies contain blank lines, bullets and code, so no printable delimiter is
// safe. Separate records with U+0001 and the sha from the message with NUL; neither
// can occur in a git commit message. Written as escapes, never as literal control
// bytes -- a literal one is invisible in review and an editor or line-ending pass can
// silently eat it, which would make this guard scan one giant malformed record.
const RS = '\u0001';
const FS = '\u0000';

function commitsIn(base, head) {
  const out = execFileSync(
    'git',
    ['log', '--no-merges', `--format=%H%x00%B${RS}`, `${base}..${head}`],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return out
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rec) => {
      const i = rec.indexOf(FS);
      return { sha: rec.slice(0, i), message: rec.slice(i + 1) };
    })
    .filter((c) => c.sha);
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
  console.log(
    `check-commit-message-parses: ${SELF_TEST_CASES.length}/${SELF_TEST_CASES.length} embedded controls agree.`,
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

  const commits = commitsIn(base, head);
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
  console.error(`  git rebase -i ${base}   # reword the commit(s) named above`);
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
