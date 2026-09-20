/**
 * Teeth for check-cargo-dependabot-coverage.mjs (#3982).
 *
 * Each block pairs a case that MUST be flagged with one that MUST NOT be, so a
 * matcher that has degenerated into "always fire" or "never fire" fails here.
 * The value that breaks each assertion is named at its site.
 *
 * The real-tree blocks LIFT the config and the crate list at runtime rather than
 * transcribing them, so a typo in this file cannot make the probe disagree with
 * the thing it is probing.
 *
 * Round-2 note: three assertions here previously named a FAILS-IF their fixture
 * could not actually produce. Each is corrected at its site and the correction
 * is explained, because "the stated kill and the real kill differ" is the exact
 * defect assertion-design.md exists to catch, and leaving it silent would have
 * been worse than the original error.
 *
 * Run: node --test scripts/ci/__tests__/cargo-dependabot-coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findCargoManifestDirs,
  parseUpdates,
  evaluate,
  configRejectionReasons,
  REPO_ROOT,
  DEPENDABOT_PATH,
} from '../check-cargo-dependabot-coverage.mjs';

const GUARD = fileURLToPath(new URL('../check-cargo-dependabot-coverage.mjs', import.meta.url));

/** Build a throwaway repo root. Returned dir is removed by the caller. */
function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), 'cargo-dependabot-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** Run the guard CLI against a root; never throws, returns {code, stdout, stderr}. */
function runGuard(root) {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, root], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const YML_CARGO = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: "cargo"',
  '    directory: "/apps/loom-directlake"',
  '    schedule:',
  '      interval: "weekly"',
  '',
].join('\n');

/**
 * An npm entry aimed at the SAME directory as the crate.
 *
 * This fixture is the round-2 correction. The previous version used an npm
 * entry pointing at `/portal/react-webapp`, so mutating the `ecosystem ===
 * 'cargo'` filter to always-true left `missing` unchanged and the test stayed
 * GREEN — the stated FAILS-IF named a mutation the fixture could not witness.
 * Pointing the npm entry at the crate's own directory is what makes the
 * ecosystem comparison the ONLY thing separating covered from uncovered.
 */
const YML_NPM_SAME_DIR = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: "npm"',
  '    directory: "/apps/loom-directlake"',
  '    schedule:',
  '      interval: "weekly"',
  '',
].join('\n');

const YML_NO_CARGO = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: "npm"',
  '    directory: "/portal/react-webapp"',
  '    schedule:',
  '      interval: "weekly"',
  '',
].join('\n');

const CRATE = '[package]\nname = "x"\nversion = "0.1.0"\n';

// ── the core verdict, both directions ────────────────────────────────────────

test('a crate whose only entry is a DIFFERENT ecosystem at the SAME directory is flagged', () => {
  const { missing, covered } = evaluate(['apps/loom-directlake'], parseUpdates(YML_NPM_SAME_DIR));
  // FAILS IF: evaluate stops filtering on `ecosystem === 'cargo'`. The npm entry
  // names this exact directory, so an unfiltered evaluate marks the crate
  // covered and `missing` goes empty. Verified by mutation, not assumed.
  assert.deepEqual(missing, ['apps/loom-directlake']);
  assert.deepEqual(covered, []);
});

test('a crate WITH a cargo entry is not flagged', () => {
  const { missing, covered } = evaluate(['apps/loom-directlake'], parseUpdates(YML_CARGO));
  // FAILS IF: the guard degenerates to "always fire" — e.g. the leading-slash
  // normalisation is dropped, so "/apps/loom-directlake" never matches
  // "apps/loom-directlake" and a correctly-configured repo reports missing.
  assert.deepEqual(missing, []);
  assert.deepEqual(covered, ['apps/loom-directlake']);
});

test('a cargo entry for a DIFFERENT directory does not cover this crate', () => {
  const yml = YML_CARGO.replace('/apps/loom-directlake', '/apps/some-other-crate');
  const { missing } = evaluate(['apps/loom-directlake'], parseUpdates(yml));
  // FAILS IF: coverage is decided by ecosystem alone and the directory is
  // ignored — which would pass any repo that has one cargo entry anywhere.
  assert.deepEqual(missing, ['apps/loom-directlake']);
});

// ── the inverse direction: an entry aimed at nothing (CSA-0048) ──────────────

test('a cargo entry whose directory EXISTS but holds no Cargo.toml is a ghost', () => {
  // THE DISCRIMINATING FIXTURE (round-3). The rule is "the directory contains
  // no Cargo.toml"; an earlier revision implemented "the directory does not
  // EXIST", and the old fixture passed `() => false` — absent, not empty — so
  // the input that separates the two was never built. `/apps` is present here
  // (it is the parent of the crate) and holds no manifest.
  // FAILS IF: the predicate reverts to an existence test, since `/apps` exists.
  const updates = parseUpdates(YML_CARGO.replace('/apps/loom-directlake', '/apps'));
  const { ghost } = evaluate(['apps/loom-directlake'], updates);
  assert.equal(ghost.length, 1);
  assert.equal(ghost[0].directory, '/apps');
});

test('a cargo entry whose directory is absent entirely is also a ghost', () => {
  const updates = parseUpdates(YML_CARGO.replace('/apps/loom-directlake', '/portal/static-webapp'));
  const { ghost } = evaluate(['apps/mine'], updates);
  // The CSA-0048 shape recorded in dependabot.yml's own comments.
  // FAILS IF: the ghost filter is dropped or inverted.
  assert.equal(ghost.length, 1);
  assert.equal(ghost[0].directory, '/portal/static-webapp');
});

test('a cargo entry whose directory DOES hold a Cargo.toml is not a ghost', () => {
  const { ghost } = evaluate(['apps/loom-directlake'], parseUpdates(YML_CARGO));
  // The paired positive: FAILS IF the ghost check fires on every entry, which
  // would make the real repo permanently red.
  assert.deepEqual(ghost, []);
});

// ── the parser: a later entry's directory must not leak backwards ────────────

test('directory is attributed to its own updates[] entry, not a later one', () => {
  const yml = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: "cargo"', // deliberately has NO directory of its own
    '    schedule:',
    '      interval: "weekly"',
    '  - package-ecosystem: "npm"',
    '    directory: "/apps/loom-directlake"',
    '',
  ].join('\n');
  const updates = parseUpdates(yml);
  assert.equal(updates.length, 2);
  // FAILS IF: the parser scans for `directory:` without resetting on the
  // `- package-ecosystem:` item marker — the cargo entry would inherit the npm
  // entry's directory and the crate would read as covered when it is not.
  assert.equal(updates[0].ecosystem, 'cargo');
  assert.equal(updates[0].directory, null);
  assert.equal(updates[1].directory, '/apps/loom-directlake');
  assert.deepEqual(evaluate(['apps/loom-directlake'], updates).missing, ['apps/loom-directlake']);
});

test('a TRAILING comment does not stop a real entry being read', () => {
  const yml = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: "cargo"  # the repo has exactly one crate',
    '    directory: "/apps/loom-directlake"  # see #3982',
    '',
  ].join('\n');
  // This is the POSITIVE pin on the comment-stripping step, and it is the only
  // assertion here that isolates it. Both key regexes end in `\s*$`, so without
  // the strip neither line matches, the entry vanishes, and a correctly
  // configured repo reports as uncovered.
  // FAILS IF: `line.replace(/\s+#.*$/, '')` is removed.
  const updates = parseUpdates(yml);
  assert.deepEqual(updates, [{ ecosystem: 'cargo', directory: '/apps/loom-directlake' }]);
  assert.deepEqual(evaluate(['apps/loom-directlake'], updates).missing, []);
});

test('`- package-ecosystem:` appearing MID-LINE is not parsed as an entry', () => {
  const yml = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: "npm"',
    '    directory: "/portal/react-webapp"',
    '    commit-message: "prefix - package-ecosystem: cargo"',
    '',
  ].join('\n');
  // This is the POSITIVE pin on the `^\s*` item-marker anchor, and it exists
  // because the mutation harness proved the anchor was otherwise UNPINNED:
  // unanchoring it left the whole suite green. Without the anchor the regex
  // searches anywhere in the line, so the quoted value above parses as a real
  // cargo entry — inventing coverage out of a commit-message string.
  // FAILS IF: `^\s*` is dropped from the package-ecosystem pattern.
  const updates = parseUpdates(yml);
  assert.deepEqual(updates.map((u) => u.ecosystem), ['npm']);
  assert.deepEqual(evaluate(['apps/loom-directlake'], updates).missing, ['apps/loom-directlake']);
});

test('a commented-out entry is not counted as coverage [DEFENCE IN DEPTH — no single-mutation kill]', () => {
  const yml = YML_NO_CARGO + '  # - package-ecosystem: "cargo"\n  #   directory: "/apps/loom-directlake"\n';
  // DISCLOSED per assertion-design.md #5: TWO independent mechanisms reject this
  // line — the comment strip blanks it, AND the `^\s*-\s*` anchor refuses to
  // match a leading `#`. Mutating either ALONE leaves this test green; only both
  // together kill it. An earlier revision claimed this pinned the anchoring,
  // which was false. It is kept as a regression guard on the PAIR, and must not
  // be counted as coverage of either mechanism on its own — the trailing-comment
  // test above is what actually pins the strip.
  assert.deepEqual(parseUpdates(yml).filter((u) => u.ecosystem === 'cargo'), []);
  // Paired positive, so deleting the parser entirely cannot satisfy this block.
  assert.equal(parseUpdates(yml).filter((u) => u.ecosystem === 'npm').length, 1);
});

// ── configs GitHub would reject outright ─────────────────────────────────────

test('tab-indented YAML is reported as a rejected config', () => {
  const tabbed = YML_CARGO.replace(/^ +/gm, (m) => '\t'.repeat(m.length / 2));
  const reasons = configRejectionReasons(tabbed);
  // FAILS IF: the tab check is removed. `\s` in the parser's regexes MATCHES a
  // tab, so the line parser happily reads a file GitHub throws away whole —
  // the guard would report full coverage while every lane in the repo is dead.
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /TAB character/);
});

test('a well-formed config produces no rejection reasons', () => {
  // The paired positive: FAILS IF the rejection check fires on valid YAML,
  // which would red the real repo permanently.
  assert.deepEqual(configRejectionReasons(YML_CARGO), []);
});

test('a DUPLICATE top-level version: is judged LAST-WINS, as YAML resolves it', () => {
  // YAML mappings are last-wins on a duplicate key, so this document resolves
  // to `version: 1` and Dependabot rejects it — every lane in the repo stops.
  // A first-wins lookup reads the `2` and returns ZERO reasons.
  // FAILS IF: `findLast` reverts to `find`.
  const lastInvalid = 'version: 2\nversion: 1\n' + YML_CARGO.replace('version: 2\n', '');
  assert.match(configRejectionReasons(lastInvalid)[0], /not `version: 2`/);
  // The MIRROR, and it is load-bearing: first-wins is wrong in BOTH directions,
  // so without this half a `find`-based implementation that merely reported
  // something would look correct. Here the resolved value IS 2 and the file is
  // valid — flagging it would red a working config.
  const lastValid = 'version: 1\nversion: 2\n' + YML_CARGO.replace('version: 2\n', '');
  assert.deepEqual(configRejectionReasons(lastValid), []);
});

test('a leading UTF-8 BOM does not masquerade as a missing version: key', () => {
  // Valid YAML, and several editors on this Windows repo emit one. Left in
  // place it shifts `version:` off column 0, and the anchor then reports "no
  // top-level `version:` key" about a key that is plainly there — a message
  // asserting more than the code established.
  // FAILS IF: the BOM strip is removed.
  assert.deepEqual(configRejectionReasons('﻿' + YML_CARGO), []);
});

test('tabs PAST a quoted scalar are still structural', () => {
  // Both confirmed parse errors against PyYAML, and both sit beyond the point
  // where a cut-at-the-first-quote scan stops looking.
  // FAILS IF: structuralRegion() reverts to `line.split(/["'#]/)[0]`.
  const trailing = 'version: 2\nupdates:\n  - package-ecosystem: "cargo"\t\n';
  const afterQuotedKey = 'version: 2\nupdates:\n  - "package-ecosystem":\t"cargo"\n';
  assert.match(configRejectionReasons(trailing)[0], /TAB character used as structural whitespace/);
  assert.match(configRejectionReasons(afterQuotedKey)[0], /TAB character used as structural whitespace/);
});

test('every tracked YAML in this repo survives the tab scan [over-fire census]', () => {
  // The widened scan is only safe if it stays silent on valid files. A bare
  // "zero flagged" would be vacuous, so the WITNESS is asserted too: the tree
  // must actually contain a tab somewhere for this to distinguish anything.
  // (Measured 2026-09-18: 393 files, exactly one carries tabs —
  // .github/workflows/loom-dataplane-roll.yml, real TSV separators inside
  // quoted echo strings.)
  // FAILS IF: the scan widens to the raw line — that file then flags.
  const files = execFileSync('git', ['ls-files', '*.yml', '*.yaml'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).split('\n').filter(Boolean);
  let withTab = 0;
  const flagged = [];
  for (const f of files) {
    const text = readFileSync(join(REPO_ROOT, f), 'utf8');
    if (text.includes('\t')) withTab++;
    if (configRejectionReasons(text).some((r) => r.startsWith('TAB'))) flagged.push(f);
  }
  assert.ok(files.length > 100, `expected a real population, got ${files.length} files`);
  assert.ok(withTab > 0, 'no tracked YAML contains a tab, so this census distinguishes nothing');
  assert.deepEqual(flagged, [], 'the tab scan flagged valid repo YAML');
});

test('a missing or wrong version: key is reported as a rejected config', () => {
  const noVersion = YML_CARGO.split('\n').filter((l) => !l.startsWith('version:')).join('\n');
  // FAILS IF: the version check is removed. Dependabot honours only schema 2;
  // without it no version-update PR is ever opened, silently.
  assert.match(configRejectionReasons(noVersion)[0], /no top-level `version:` key/);
  assert.match(configRejectionReasons(YML_CARGO.replace('version: 2', 'version: 1'))[0], /not `version: 2`/);
});

test('a NESTED version: does not satisfy the top-level requirement', () => {
  // Round-3 fixture. The previous test built its input by filtering out the
  // column-0 line, so it never SUPPLIED a nested `version:` — it read as
  // pinning "top-level" while being unable to witness the difference. This
  // file is valid YAML (PyYAML loads it); it is the Dependabot SCHEMA that it
  // violates, and only the column-0 anchor catches that.
  // FAILS IF: the `version:` lookup allows leading whitespace again, in which
  // case the nested key satisfies it and the guard passes a config that opens
  // no PRs — while its message still claims a top-level key was found.
  const nested = [
    'updates:',
    '  - package-ecosystem: "cargo"',
    '    directory: "/apps/loom-directlake"',
    '    version: 2',
    '',
  ].join('\n');
  const reasons = configRejectionReasons(nested);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /no top-level `version:` key at column 0/);
});

test('`version:2` with no space after the colon is a rejected config', () => {
  // PyYAML agrees: "mapping values are not allowed here". YAML reads
  // `version:2` as a plain scalar, not a mapping, so the document fails once
  // `updates:` opens.
  // FAILS IF: the separator check is dropped — the old `split(':')[1]` yielded
  // "2" and the guard passed a file GitHub rejects outright.
  const reasons = configRejectionReasons(YML_CARGO.replace('version: 2', 'version:2'));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /no space after the colon/);
});

test('a tab after the `-` marker or between key and value is a rejected config', () => {
  // Both are hard parse errors (confirmed against PyYAML), and both sit outside
  // the LEADING indent run that the first implementation scanned.
  // FAILS IF: the tab scan narrows back to `line.match(/^[ \t]*/)`.
  const afterMarker = 'version: 2\nupdates:\n  -\tpackage-ecosystem: "cargo"\n';
  const keyValue = 'version: 2\nupdates:\n  - package-ecosystem:\t"cargo"\n';
  assert.match(configRejectionReasons(afterMarker)[0], /TAB character used as structural whitespace/);
  assert.match(configRejectionReasons(keyValue)[0], /TAB character used as structural whitespace/);
});

test('a tab inside a quoted scalar or a comment BODY is NOT flagged', () => {
  // The over-fire guard. PyYAML loads both of these, so flagging them would
  // red a valid config — and a guard that is wrong in this direction gets
  // switched off, which is worse than the gap it was meant to close.
  // FAILS IF: the tab scan searches the raw line instead of the structural
  // region before the first quote or `#`.
  const inScalar =
    'version: 2\nupdates:\n  - package-ecosystem: "cargo"\n' +
    '    directory: "/apps/mine"\n    commit-message: "a\tb"\n';
  const inComment =
    'version: 2\nupdates:\n  # a\tcomment\n  - package-ecosystem: "cargo"\n' +
    '    directory: "/apps/mine"\n';
  assert.deepEqual(configRejectionReasons(inScalar), []);
  assert.deepEqual(configRejectionReasons(inComment), []);
});

// ── the walker ───────────────────────────────────────────────────────────────

test('a vendored Cargo.toml under target/ is not treated as a crate', () => {
  const root = scratch({
    'apps/mine/Cargo.toml': CRATE,
    'apps/mine/target/debug/vendored/Cargo.toml': CRATE,
  });
  try {
    const dirs = findCargoManifestDirs(root);
    // Positive half — FAILS IF the walker stops descending and finds nothing.
    assert.ok(dirs.includes('apps/mine'), `expected apps/mine in ${JSON.stringify(dirs)}`);
    // Negative half — FAILS IF SKIP_DIRS loses 'target': the build directory is
    // full of dependency copies, and demanding a dependabot entry per vendored
    // manifest would make the guard permanently and uselessly red.
    assert.deepEqual(dirs, ['apps/mine']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── self-defence: a broken instrument must not read as a clean repo ──────────

test('zero crates found REFUSES to pass rather than reporting OK', () => {
  const root = scratch({ '.github/dependabot.yml': YML_NO_CARGO });
  try {
    const r = runGuard(root);
    // FAILS IF: the vacuity clause is removed. `missing.length === 0` is true
    // for "nothing to check" and for "everything checks out"; without this the
    // guard would go green the day the walker breaks.
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /REFUSING TO PASS/);
    assert.match(r.stderr, /0 Cargo\.toml manifests/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zero parsed updates REFUSES to pass, and says the PARSER broke [pins the MESSAGE, not the exit code]', () => {
  const root = scratch({
    '.github/dependabot.yml': 'version: 2\nupdates: []\n',
    'apps/mine/Cargo.toml': CRATE,
  });
  try {
    const r = runGuard(root);
    // EXIT CODE HAS NO KILL POWER HERE and this test says so rather than
    // pretending otherwise: deleting the `updates.length === 0` clause still
    // exits 1, because the crate then falls through to the "no cargo update
    // lane" branch. The two differ ONLY in diagnostic, and the diagnostics point
    // at opposite fixes — one says fix this script, the other says fix the
    // config. So the MESSAGE is what is pinned.
    // FAILS IF: the clause is removed (stderr then names the crate instead).
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /parsed 0 updates\[\] entries/);
    assert.match(r.stderr, /PARSER has stopped parsing/);
    assert.doesNotMatch(r.stderr, /have no cargo update lane/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a config GitHub would reject REFUSES to pass even when coverage looks complete', () => {
  const tabbed = YML_CARGO.replace(/^ +/gm, (m) => '\t'.repeat(m.length / 2))
    .replace('/apps/loom-directlake', '/apps/mine');
  const root = scratch({ '.github/dependabot.yml': tabbed, 'apps/mine/Cargo.toml': CRATE });
  try {
    const r = runGuard(root);
    // FAILS IF: the rejection check is removed or moved after the coverage
    // verdict. The crate IS named by an entry, so every coverage test above
    // stays green here — this is the one that notices the file is inert.
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /would reject/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a ghost entry exits 1 END-TO-END even when every crate is covered', () => {
  const yml = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: "cargo"',
    '    directory: "/apps/mine"',
    '  - package-ecosystem: "cargo"',
    '    directory: "/apps"', // EXISTS (parent of the crate), holds no Cargo.toml
    '',
  ].join('\n');
  const root = scratch({ '.github/dependabot.yml': yml, 'apps/mine/Cargo.toml': CRATE });
  try {
    const r = runGuard(root);
    // The realistic form of the defect, end to end. Before round 3 this exact
    // tree printed "OK — 1 crate(s), 2 cargo entr(ies)" and exited 0: the guard
    // published the discrepancy while passing over it.
    // `missing` is empty here (apps/mine IS covered), so nothing else in the
    // suite reddens on this fixture — only the ghost branch can.
    // FAILS IF: the ghost branch is removed, or the predicate narrows back to
    // an existence test (since `/apps` exists).
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /point at a directory/);
    // Pins the remediation wording for the PRESENT case specifically.
    assert.match(r.stderr, /EXISTS but contains no Cargo\.toml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ABSENT ghost directory gets the other remediation wording', () => {
  const yml = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: "cargo"',
    '    directory: "/apps/mine"',
    '  - package-ecosystem: "cargo"',
    '    directory: "/apps/archived-crate"',
    '',
  ].join('\n');
  const root = scratch({ '.github/dependabot.yml': yml, 'apps/mine/Cargo.toml': CRATE });
  try {
    const r = runGuard(root);
    // The two wordings point at different fixes — delete the entry vs. correct
    // its level — so both are pinned rather than asserting a shared prefix.
    // FAILS IF: the existsSync branch is collapsed to a single message.
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /DOES NOT EXIST/);
    assert.doesNotMatch(r.stderr, /EXISTS but contains no Cargo\.toml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing dependabot.yml REFUSES to pass', () => {
  const root = scratch({ 'apps/mine/Cargo.toml': CRATE });
  try {
    const r = runGuard(root);
    // FAILS IF: existsSync short-circuits to "no config, nothing to enforce".
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /REFUSING TO PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crate with no cargo entry exits 1 end-to-end', () => {
  const root = scratch({
    '.github/dependabot.yml': YML_NO_CARGO,
    'apps/mine/Cargo.toml': CRATE,
  });
  try {
    const r = runGuard(root);
    // FAILS IF: the CLI computes `missing` and then returns 0 anyway — a real
    // shape here, where a guard prints its finding and exits green.
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /apps\/mine\/Cargo\.toml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same tree WITH the entry exits 0 end-to-end', () => {
  const root = scratch({
    '.github/dependabot.yml': YML_CARGO.replace('/apps/loom-directlake', '/apps/mine'),
    'apps/mine/Cargo.toml': CRATE,
  });
  try {
    const r = runGuard(root);
    // The paired positive: FAILS IF the guard can only ever exit 1, which the
    // assertions above would not distinguish from a working guard.
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /OK — 1 crate\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the real tree, lifted at runtime ─────────────────────────────────────────

test("this repo's actual crates are all covered by actual dependabot.yml", () => {
  const dirs = findCargoManifestDirs(REPO_ROOT);
  // FAILS IF: the repo gains a second Rust crate with no cargo entry — the
  // regression this guard exists to catch. Also fails if apps/loom-directlake
  // is deleted without this test being revisited, which is the correct outcome:
  // a guard over zero crates should be reconsidered, not left green.
  assert.ok(
    dirs.includes('apps/loom-directlake'),
    `expected apps/loom-directlake among ${JSON.stringify(dirs)}`,
  );
  const updates = parseUpdates(readFileSync(join(REPO_ROOT, DEPENDABOT_PATH), 'utf8'));
  assert.deepEqual(evaluate(dirs, updates).missing, []);
});

test('the real dependabot.yml is one GitHub would accept', () => {
  // FAILS IF: someone indents this file with a tab or drops `version: 2`.
  // Either would silently stop every version-update lane in the repo.
  assert.deepEqual(configRejectionReasons(readFileSync(join(REPO_ROOT, DEPENDABOT_PATH), 'utf8')), []);
});

test('the real dependabot.yml groups the arrow stack in one lockstep group', () => {
  // Not a coverage assertion — a REGRESSION PIN on the reason the group exists.
  // Measured with cargo 1.98.0 on 2026-09-18: resolving parquet 59 + datafusion
  // 55 + deltalake 0.32 together links arrow 58.4.0 AND 59.3.0, datafusion
  // 53.1.0 AND 55.1.0, parquet 58.4.0 AND 59.3.0 — two TableProvider traits, so
  // src/scan.rs stops compiling, and thrift 0.17.0 survives via parquet 58.
  // Grouping does not PREVENT that resolution; it makes the four arrive as one
  // reviewable PR, which `cargo build --locked` in loom-directlake-ci.yml then
  // rejects. FAILS IF: someone removes a pattern, letting dependabot raise the
  // arrow stack one crate at a time.
  const yml = readFileSync(join(REPO_ROOT, DEPENDABOT_PATH), 'utf8');
  const cargoBlock = yml.slice(yml.indexOf('package-ecosystem: "cargo"'));
  assert.ok(cargoBlock.length > 0, 'no cargo entry found in the real dependabot.yml');
  for (const pattern of ['"arrow*"', '"parquet*"', '"datafusion*"', '"deltalake*"']) {
    assert.ok(
      cargoBlock.includes(pattern),
      `arrow-stack group must keep ${pattern} so the stack moves as one unit`,
    );
  }
});
