#!/usr/bin/env node
/**
 * GUARDRAIL: every Rust crate in this repo has a `cargo` version-update lane.
 *
 * WHY THIS EXISTS (#3982, 2026-09-18)
 * -----------------------------------
 * `apps/loom-directlake/Cargo.lock` carried an open security alert — thrift
 * < 0.23.0, GHSA-2f9f-gq7v-9h6m, dependabot alert #94 — for months while
 * `.github/dependabot.yml` had no `cargo` entry at all.
 *
 * Those two facts are not in tension, and the reason they are not is the whole
 * point of this guard. Dependabot has TWO independent mechanisms:
 *
 *   - security ALERTS, derived from the dependency graph, which fire with no
 *     dependabot.yml entry whatsoever. This is why #94 existed.
 *   - version-update PRs, which fire ONLY for an ecosystem/directory pair
 *     listed in dependabot.yml.
 *
 * So the crate was watched for "you are vulnerable" and never for "a fix is
 * now available". For #3982 that second half was the load-bearing one: thrift
 * cannot leave the graph by anything done in this repo (deltalake-core 0.32.4
 * still pins parquet ^58, and parquet drops thrift only at 59.0.0), so the fix
 * arrives as an upstream delta-rs release — the exact event a version-update
 * lane exists to notice, and the exact event nothing here was watching for.
 *
 * An alert with no update lane is a control that can only ever tell you bad
 * news. It reads as coverage on the security tab while being structurally
 * unable to deliver the remedy.
 *
 * SCOPE — DELIBERATELY NARROW, AND SAY SO
 * ---------------------------------------
 * This checks CARGO ONLY, and is named for that. It is NOT a "dependabot
 * coverage is complete" guard and must not be read as one. Measured 2026-09-18
 * against the open-alert list, the same gap is wider elsewhere:
 *
 *   - npm: SEVEN manifest paths across SIX directories carry open alerts and
 *     are absent from dependabot.yml, whose only npm entry is
 *     `/portal/react-webapp` — `apps/fiab-console` (both `pnpm-lock.yaml` and
 *     `package.json`), `apps/loom-sdk`, `apps/loom-embed`, `apps/loom-cli`,
 *     `apps/fiab-label-propagation`, `azure-functions/secret-expiry-monitor`.
 *   - pip: `requirements/locks/copilot/requirements.txt` carries FOUR open
 *     alerts, TWO of them HIGH. The `/` pip entry does not reach it — the same
 *     shape as the `apps/loom-duckdb` entry above it in that file, which exists
 *     precisely because `/` did not reach that lock either.
 *
 * That is a real finding, tracked separately (#4592). Widening this guard to
 * npm or pip without first adding those entries would just turn it red on day
 * one, and a guard that is red the moment it lands is one the team learns to
 * ignore. Widening it SILENTLY would be worse: the name would stop matching the
 * scope, which is the blind-instrument shape this guard exists to prevent.
 * Cargo is in scope here because #3982 is a cargo issue and the repo has
 * exactly one crate, so the fix is one entry and the guard lands green over a
 * complete population.
 *
 * THE RULE
 * --------
 * BOTH directions, because only checking one of them has already cost this repo
 * a defect in each:
 *   1. Every directory containing a `Cargo.toml` has an `updates[]` entry with
 *      `package-ecosystem: cargo` and a `directory:` naming it. (The #3982
 *      shape: a crate nothing proposes updates for.)
 *   2. Every cargo entry's `directory:` actually contains a `Cargo.toml`. (The
 *      CSA-0048 shape recorded in dependabot.yml itself: `portal/static-webapp`
 *      was archived and its entry was left pointing at a directory that no
 *      longer existed.)
 *
 * The config must also be one GitHub will actually honour. A dependabot.yml
 * that fails to parse does not degrade gracefully — GitHub rejects the WHOLE
 * file, so every version-update lane in the repo dies at once, including this
 * crate's. A guard that reports OK over such a file is reporting coverage that
 * does not exist. Two families are checked:
 *   - TAB characters used as STRUCTURAL whitespace — in the indent, after a `-`
 *     sequence marker, or between a key and its value. YAML forbids all three.
 *     A tab inside a quoted scalar or a comment is legal and is NOT flagged.
 *   - A top-level `version:` that is absent, not at column 0, missing the space
 *     after its colon, or not `2`. Dependabot honours only schema 2, a nested
 *     `version:` is a different key, and `version:2` is a plain scalar rather
 *     than a mapping — the document then fails with "mapping values are not
 *     allowed here".
 *
 * DELIBERATELY NOT CHECKED:
 *   - The schedule, labels, limit or groups of the entry. Those are policy, and
 *     a weekly-vs-daily argument is not an outage.
 *   - Whether the pinned versions are current. That is dependabot's job; this
 *     guard only cares that dependabot is ASKED.
 *   - Full YAML well-formedness. This is not a YAML parser and must not be
 *     mistaken for one: unclosed quotes, bad indentation levels and other parse
 *     errors pass straight through it. Duplicate keys are not flagged either,
 *     and correctly so — YAML accepts them. Hand-rolled rather than using a
 *     library because the `guardrails` job is `checkout` + `setup-node` then a
 *     bare `node scripts/ci/*.mjs`: neither `yaml` nor `js-yaml` resolves from
 *     the repo root, so a dependency here would not run at all.
 *
 * ESCAPE HATCH: none. A crate nobody wants update PRs for is a crate that
 * should not be in the tree.
 *
 * SELF-DEFENCE: four separate refusals, each with its OWN diagnostic, because
 * "exit 1" is not the useful part — WHICH of these fired tells you whether to
 * fix the repo or fix the scanner, and those are opposite actions:
 *   - dependabot.yml absent            -> the config is gone, not "nothing to do"
 *   - zero Cargo.toml manifests found  -> the walker broke; a dead walker and a
 *                                         clean repo are otherwise identical
 *   - zero updates[] entries parsed    -> the PARSER broke (the file is
 *                                         non-empty), not "the repo is uncovered"
 *   - config GitHub would reject       -> every lane is dead, coverage is fiction
 *
 * Usage: node scripts/ci/check-cargo-dependabot-coverage.mjs [repoRoot]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Repo-relative and POSIX-shaped: it is printed in remediation text, and a
 *  Windows-separator path in a "add this to .github/dependabot.yml" message
 *  reads as a different file than the one the author must edit. */
export const DEPENDABOT_PATH = '.github/dependabot.yml';

/** Directories never worth walking into; `target/` in particular is full of
 *  vendored Cargo.toml copies that are NOT crates of ours. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  '.next',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'temp',
]);

/**
 * Every directory under `root` that contains a Cargo.toml, as repo-relative
 * POSIX paths WITHOUT a leading slash (e.g. `apps/loom-directlake`).
 */
export function findCargoManifestDirs(root) {
  const found = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable dir is not a crate; the vacuity check catches a dead walker
    }
    if (entries.some((e) => e.isFile() && e.name === 'Cargo.toml')) {
      const rel = relative(root, abs).split(sep).join('/');
      if (rel !== '') found.push(rel);
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(join(abs, e.name));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Parse the `updates:` list of a dependabot.yml into `{ecosystem, directory}`.
 *
 * Hand-rolled rather than a YAML dependency on purpose: this guard runs in the
 * guardrails lane with no install step, and the shape it reads is two scalar
 * keys inside a top-level sequence. It keys off the `- package-ecosystem:` item
 * marker, so a `directory:` belonging to a later entry cannot be attributed to
 * an earlier one.
 */
export function parseUpdates(yamlText) {
  const entries = [];
  let current = null;
  for (const raw of yamlText.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    const eco = line.match(/^\s*-\s*package-ecosystem:\s*["']?([\w-]+)["']?\s*$/);
    if (eco) {
      if (current) entries.push(current);
      current = { ecosystem: eco[1], directory: null };
      continue;
    }
    if (!current) continue;
    const dir = line.match(/^\s*directory:\s*["']?(\S+?)["']?\s*$/);
    if (dir && current.directory === null) current.directory = dir[1];
  }
  if (current) entries.push(current);
  return entries;
}

/** Normalise a dependabot `directory:` to the same shape findCargoManifestDirs emits. */
const normaliseDir = (d) => String(d ?? '').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * Reasons GitHub would REJECT this dependabot.yml outright.
 *
 * Rejection is not partial: GitHub discards the whole file, so every
 * version-update lane in the repo stops at once. A guard that reports coverage
 * over a rejected config is reporting something that cannot happen — which is
 * exactly the defect this guard was built to catch, so being blind to it here
 * would reintroduce that defect inside the fix for it.
 *
 * NOT a YAML parser, and must not be mistaken for one: it catches two specific
 * rejection modes and says so.
 *
 * @returns {string[]} one message per reason; empty means "none of the two
 *   modes checked here fired", NOT "this file is valid YAML".
 */
export function configRejectionReasons(yamlText) {
  const reasons = [];
  const lines = yamlText.split(/\r?\n/);

  // 1. Tabs used as STRUCTURAL whitespace. YAML forbids the tab character for
  //    indentation and as a key/value separator; such a file does not load at
  //    all. `\s` in a JS regex MATCHES a tab, so the line parser below happily
  //    reads a file GitHub would throw away -- the blind spot this catches.
  //
  //    Scanning only the LEADING indent run was too narrow (round-3): a tab
  //    after the `-` sequence marker, or between a key and its value, is just
  //    as fatal and lands wherever the cursor was. So the scan covers the whole
  //    structural region of the line -- everything before the first quote or
  //    `#`. Beyond that point a tab is legal content (inside a quoted scalar or
  //    a comment) and flagging it would be an over-fire, which is why the cut
  //    is made there rather than searching the raw line.
  const tabbed = [];
  lines.forEach((line, i) => {
    const structural = line.split(/["'#]/)[0];
    if (structural.includes('\t')) tabbed.push(i + 1);
  });
  if (tabbed.length > 0) {
    reasons.push(
      `TAB character used as structural whitespace on line(s) ${tabbed.slice(0, 5).join(', ')}` +
        `${tabbed.length > 5 ? ` (+${tabbed.length - 5} more)` : ''}. YAML forbids tabs for ` +
        'indentation and as a key/value separator, so GitHub rejects the ENTIRE file and ' +
        'every version-update lane in the repo — not just cargo — stops running.',
    );
  }

  // 2. `version: 2` is mandatory, and must be a TOP-LEVEL key.
  //
  //    Anchored to column 0 (round-3). The previous pattern allowed leading
  //    whitespace, so a NESTED `version:` on an entry satisfied it while the
  //    diagnostic went on claiming a "top-level" key had been found — a message
  //    asserting a property the code had not established.
  //
  //    The colon must be followed by whitespace or end-of-line. `version:2` is
  //    not a mapping at all: YAML reads it as the plain scalar "version:2", and
  //    a document that then opens `updates:` fails with "mapping values are not
  //    allowed here". Accepting it would pass a file GitHub rejects.
  const TOP_LEVEL_VERSION = /^version[ \t]*:/;
  const versionLine = lines.find((l) => TOP_LEVEL_VERSION.test(l));
  if (!versionLine) {
    reasons.push(
      'no top-level `version:` key at column 0. Dependabot requires `version: 2`; without ' +
        'it the file is not honoured and no version-update PR is ever opened. A `version:` ' +
        'nested under an entry does not count — it is a different key.',
    );
  } else {
    const rest = versionLine.replace(TOP_LEVEL_VERSION, '');
    if (rest !== '' && !/^[ \t]/.test(rest)) {
      reasons.push(
        'the top-level `version:` has no space after the colon. YAML reads `version:2` as ' +
          'the plain scalar "version:2" rather than a mapping, and the document then fails ' +
          'to parse ("mapping values are not allowed here") — GitHub rejects the whole file.',
      );
    } else {
      const value = rest.replace(/\s+#.*$/, '').trim().replace(/["']/g, '');
      if (value !== '2') {
        reasons.push(
          `\`version: ${value}\` is not \`version: 2\`. Only schema version 2 is honoured; ` +
            'anything else means no version-update PR is ever opened.',
        );
      }
    }
  }

  return reasons;
}

/**
 * @returns {{missing: string[], covered: string[], ghost: object[], cargoEntries: object[]}}
 *   `missing` = crates with no entry (#3982). `ghost` = entries whose directory
 *   holds no Cargo.toml (CSA-0048). Both directions, because each has already
 *   been a real defect in this file.
 *
 * GHOST IS ONE COMPARISON, AND THAT IS DELIBERATE (round-3 correction).
 * `manifestDirs` is precisely the set of directories that CONTAIN a Cargo.toml,
 * so `!known.has(dir)` IS rule 2 stated directly. An earlier revision wrote
 * `!known.has(dir) && !dirExists(dir)`, which silently narrowed the rule to
 * "the directory does not EXIST" — a different, weaker predicate. A directory
 * that is present but holds no manifest (`directory: "/apps"`) then escaped
 * entirely: the guard printed `1 crate(s), 2 cargo entr(ies)` and exited 0,
 * publishing the discrepancy while passing over it.
 *
 * Both halves of that conjunction were un-killable, which is how it survived a
 * green mutation matrix: `!known.has(...)` was dead (a known crate directory
 * always exists, so the second clause already excluded it), and deleting
 * `&& !dirExists(...)` was the FIX, so it read as an equivalent mutant. Neither
 * mutation could go red, so the arm was counted as covering a rule it did not
 * implement. Whether the directory exists is now used ONLY to choose the
 * remediation wording in main() — it does not participate in the verdict.
 */
export function evaluate(manifestDirs, updates) {
  const cargoEntries = updates.filter((u) => u.ecosystem === 'cargo');
  const watched = new Set(cargoEntries.map((u) => normaliseDir(u.directory)));
  const known = new Set(manifestDirs.map(normaliseDir));
  const missing = manifestDirs.filter((d) => !watched.has(normaliseDir(d)));
  const covered = manifestDirs.filter((d) => watched.has(normaliseDir(d)));
  const ghost = cargoEntries.filter((u) => !known.has(normaliseDir(u.directory)));
  return { missing, covered, ghost, cargoEntries };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(root) {
  const dependabotAbs = join(root, DEPENDABOT_PATH);
  if (!existsSync(dependabotAbs)) {
    console.error(
      `[cargo-dependabot-coverage] REFUSING TO PASS: ${DEPENDABOT_PATH} not found under ${root}. ` +
        'A missing config is not "no crates to watch".',
    );
    return 1;
  }
  const raw = readFileSync(dependabotAbs, 'utf8');

  // Checked FIRST: if GitHub would reject this file, every lane is already dead
  // and any coverage verdict computed below would be describing a world that
  // does not exist.
  const rejections = configRejectionReasons(raw);
  if (rejections.length > 0) {
    console.error(
      `\n[cargo-dependabot-coverage] REFUSING TO PASS: ${DEPENDABOT_PATH} is a config GitHub ` +
        `would reject (${rejections.length} reason(s)):\n`,
    );
    for (const r of rejections) console.error(`  - ${r}`);
    console.error(
      '\n  A rejected dependabot.yml does not fail partially. The whole file is\n' +
        '  discarded, so EVERY version-update lane stops — and coverage measured\n' +
        '  against it is fiction. Fix the config before trusting any green here.\n',
    );
    return 1;
  }

  const updates = parseUpdates(raw);
  const manifestDirs = findCargoManifestDirs(root);
  const { missing, covered, ghost, cargoEntries } = evaluate(manifestDirs, updates);

  // Vacuity, checked BEFORE the verdict. The two clauses below are SEPARATE
  // findings with opposite remediations, so they get separate messages: one
  // says the walker broke, the other says the parser broke. Collapsing them
  // into "something is empty" would hand the reader the wrong thing to fix.
  if (manifestDirs.length === 0) {
    console.error(
      '[cargo-dependabot-coverage] REFUSING TO PASS: found 0 Cargo.toml manifests. ' +
        'This repo has at least one (apps/loom-directlake). The WALKER has stopped ' +
        'walking — fix the scanner, do not ship a green check that measures nothing.',
    );
    return 1;
  }
  if (updates.length === 0) {
    console.error(
      `[cargo-dependabot-coverage] REFUSING TO PASS: parsed 0 updates[] entries from ` +
        `${DEPENDABOT_PATH}, which is ${raw.length} bytes and non-empty. The PARSER has ` +
        'stopped parsing. This is NOT the same finding as "the crates are uncovered": ' +
        'the fix is in this script, not in the config.',
    );
    return 1;
  }

  if (ghost.length > 0) {
    console.error(
      `\n[cargo-dependabot-coverage] ${ghost.length} cargo entr(ies) point at a directory ` +
        'with no Cargo.toml:\n',
    );
    for (const g of ghost) {
      // Whether the directory exists does NOT decide the verdict — it only
      // chooses the remediation, and the two remediations differ: a vanished
      // directory means delete the entry, a present one means the entry is
      // aimed at the wrong level (`/apps` instead of `/apps/loom-directlake`).
      const present = existsSync(join(root, normaliseDir(g.directory)));
      console.error(
        `  directory: "${g.directory}"  -> ${
          present
            ? 'directory EXISTS but contains no Cargo.toml — entry aimed at the wrong level?'
            : 'directory DOES NOT EXIST — stale entry left behind?'
        }`,
      );
    }
    console.error(
      '\n  dependabot.yml records this exact failure already (CSA-0048): when\n' +
        '  portal/static-webapp was archived its entry was left behind, pointing at\n' +
        '  a directory that no longer existed. An entry aimed at nothing produces no\n' +
        '  PRs while looking like coverage on the page.\n' +
        '\n  Fix: delete the stale entry, or correct its directory.\n',
    );
    return 1;
  }

  if (missing.length > 0) {
    console.error(
      `\n[cargo-dependabot-coverage] ${missing.length} Rust crate(s) have no cargo update lane:\n`,
    );
    for (const d of missing) console.error(`  ${d}/Cargo.toml  -> no cargo entry in ${DEPENDABOT_PATH}`);
    console.error(
      '\n  Security ALERTS fire from the dependency graph without a dependabot.yml\n' +
        '  entry; version-update PRs do NOT. A crate with alerts and no update lane\n' +
        '  can only ever be told it is vulnerable, never that a fix has shipped —\n' +
        '  which is how #3982 (thrift <0.23.0) sat open with its remedy gated on an\n' +
        '  upstream delta-rs release nobody was watching for.\n' +
        '\n  Fix: add to .github/dependabot.yml:\n' +
        '    - package-ecosystem: "cargo"\n' +
        `      directory: "/${missing[0]}"\n` +
        '      schedule:\n' +
        '        interval: "weekly"\n',
    );
    return 1;
  }

  console.log(
    `[cargo-dependabot-coverage] OK — ${manifestDirs.length} crate(s), ` +
      `${cargoEntries.length} cargo entr(ies); all covered: ${covered.join(', ')}.`,
  );
  return 0;
}

// Only run when invoked directly, so the test can import the pure functions.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv[2] || REPO_ROOT));
}
