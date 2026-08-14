#!/usr/bin/env node
/**
 * neutralize-release-close-keywords.mjs — a release merge must close NOTHING.
 *
 * THE DEFECT (measured 2026-08-14, #3393)
 * ---------------------------------------
 * release-please builds its release-PR body by aggregating the changelog it
 * generates from the constituent commits. conventional-changelog renders EVERY
 * footer reference as ", closes #N" — regardless of the action word the author
 * actually wrote. So this commit body:
 *
 *     fix(deploy): the copilot-function lane cancelled its own deploys …
 *     …
 *     Refs #3429                          <-- deliberately NOT "Closes"
 *
 * became this line in release PR #3419's body:
 *
 *     * **deploy:** … ([#3431](…)), closes [#3429](…/issues/3429)
 *
 * `closes <issue-url>` is a GitHub closing keyword. PR #3419 merged at
 * 2026-08-14T09:43:28Z; issue #3429 — an open P0 — was closed at 09:43:30Z, two
 * seconds later, by nobody's decision. It was reopened by hand at 09:45:11Z.
 *
 * Corpus measurement over the whole committed CHANGELOG.md at that commit:
 * 66 `closes [#N]` claims, of which **37** name an issue the attributed commit
 * never asked to close. #1470 alone is "closed" by seven separate entries.
 *
 * WHY NEUTRALIZE ALL OF THEM, not just the unclaimed ones
 * ------------------------------------------------------
 *  1. `deploy-integrity.md` R2 and `task-tracking.md` both say an issue is
 *     closed only on DEPLOYED-and-verified, never on merge alone. A release
 *     merge is a merge. It should close nothing, ever.
 *  2. Nothing is lost. A constituent PR that genuinely claimed an issue already
 *     closed it when IT merged — verified: #3428's commit carried `Closes #3426`
 *     and #3426 closed at 2026-08-14T04:46:38Z, the moment that PR landed, long
 *     before the release PR existed.
 *  3. Deciding WHICH references were "really" claimed means re-deriving author
 *     intent from commit footers — the exact parsing step that produced the bug.
 *     Neutralizing unconditionally requires no intent inference and therefore
 *     cannot be wrong in the direction that hurts.
 *
 * `refs` is the replacement because it is provably NOT a closing keyword *in
 * this repo*: commit 1b555a02 landed on main at 06:12 carrying `Refs #3429`,
 * and #3429's timeline records a `referenced` event at 06:12:55 — not a close.
 *
 * USAGE
 *   node scripts/ci/neutralize-release-close-keywords.mjs <file>            # rewrite to stdout
 *   node scripts/ci/neutralize-release-close-keywords.mjs --check <file>    # exit 1 if any remain
 *
 * Tests: node --test scripts/ci/__tests__/release-please-integrity.test.mjs
 */
import { readFileSync } from 'node:fs';

/**
 * GitHub's closing keywords, verbatim from
 * docs.github.com "Linking a pull request to an issue".
 */
export const CLOSING_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

/**
 * The issue-reference forms GitHub honours after a keyword. The optional `[`
 * is not GitHub's — it is release-please's, which emits the reference as a
 * markdown link (`closes [#3429](https://…/issues/3429)`). The keyword and the
 * URL are still adjacent enough for GitHub to link them, so the bracket must
 * not make the match miss.
 */
const REFERENCE =
  String.raw`\[?` +
  String.raw`(?:` +
  String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+` + // #123 or owner/repo#123
  String.raw`|GH-\d+` + //                   GH-123
  String.raw`|https?:\/\/[^\s)\]]*?\/issues\/\d+` + // full issue URL
  String.raw`)`;

/**
 * A keyword followed by a reference. `[ \t]*:?[ \t]*` covers `closes #1`,
 * `Closes: #1` and `closes  [#1]`; a newline between the two is deliberately
 * NOT matched, because GitHub does not link across one either.
 */
const CLOSING_RE = new RegExp(
  String.raw`\b(` + CLOSING_KEYWORDS.join('|') + String.raw`)\b([ \t]*:?[ \t]*)(?=` + REFERENCE + `)`,
  'gi',
);

/**
 * Every closing reference in `body`, in order.
 *
 * @param {string} body
 * @returns {{keyword:string,index:number,excerpt:string}[]}
 */
export function findClosingKeywords(body) {
  const out = [];
  const re = new RegExp(CLOSING_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(body))) !== null) {
    out.push({
      keyword: m[1],
      index: m.index,
      excerpt: String(body).slice(m.index, m.index + 80).split('\n')[0],
    });
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
  }
  return out;
}

/**
 * Replace every closing keyword that precedes an issue reference with `refs`,
 * leaving the reference itself — and everything else — byte-identical.
 *
 * @param {string} body
 * @returns {string}
 */
export function neutralizeClosingKeywords(body) {
  const re = new RegExp(CLOSING_RE.source, 'gi');
  return String(body).replace(re, (_full, _kw, sep) => `refs${sep}`);
}

function main(argv) {
  const check = argv.includes('--check');
  const file = argv.find((a) => a !== '--check');
  if (!file) {
    console.error(
      '::error::neutralize-release-close-keywords: no file given. Usage: node scripts/ci/neutralize-release-close-keywords.mjs [--check] <file>',
    );
    process.exit(2);
  }
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch (err) {
    // R7: say what actually happened. An unreadable file is NOT an empty one,
    // and treating it as clean would be the whole defect class again.
    console.error(
      `::error::neutralize-release-close-keywords: cannot read ${file}: ${err.message}. Refusing to report a clean body I never read.`,
    );
    process.exit(2);
  }

  if (check) {
    const found = findClosingKeywords(body);
    if (found.length > 0) {
      console.error(
        `::error::neutralize-release-close-keywords: ${found.length} closing keyword(s) SURVIVE in the release PR body. Merging it would close issues nobody claimed (#3393):`,
      );
      for (const f of found) console.error(`::error::  ${f.keyword} -> ${f.excerpt}`);
      process.exit(1);
    }
    console.log('neutralize-release-close-keywords: 0 closing keywords remain.');
    return;
  }

  process.stdout.write(neutralizeClosingKeywords(body));
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('neutralize-release-close-keywords.mjs')
) {
  main(process.argv.slice(2));
}
