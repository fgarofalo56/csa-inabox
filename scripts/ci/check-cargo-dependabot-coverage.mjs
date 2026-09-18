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
 * coverage is complete" guard and must not be read as one. Measured the same
 * day, the npm side has the same gap and a wider one: `apps/fiab-console`,
 * `apps/loom-sdk`, `apps/loom-embed`, `apps/loom-cli`,
 * `apps/fiab-label-propagation` and `azure-functions/secret-expiry-monitor`
 * all carry open npm alerts and none of them appear in dependabot.yml, whose
 * only npm entry is `/portal/react-webapp`. That is a real finding and it is
 * tracked separately — widening this guard to npm without also adding those
 * entries would just turn it red on day one, and widening it silently would
 * make its name lie. Cargo is in scope here because #3982 is a cargo issue and
 * because the repo has exactly one crate, so the fix is one entry.
 *
 * THE RULE
 * --------
 * For every directory containing a `Cargo.toml`, `.github/dependabot.yml` must
 * contain an `updates[]` entry with `package-ecosystem: cargo` and a
 * `directory:` naming it.
 *
 * DELIBERATELY NOT CHECKED:
 *   - The schedule, labels, limit or groups of the entry. Those are policy, and
 *     a weekly-vs-daily argument is not an outage.
 *   - Whether the pinned versions are current. That is dependabot's job; this
 *     guard only cares that dependabot is ASKED.
 *
 * ESCAPE HATCH: none. A crate nobody wants update PRs for is a crate that
 * should not be in the tree.
 *
 * SELF-DEFENCE: refuses to pass vacuously. Zero Cargo.toml manifests found, or
 * a dependabot.yml that parsed to zero entries of ANY ecosystem, FAILS rather
 * than printing OK — a broken walker and a clean repo are otherwise the same
 * observation, which is the failure mode this repo keeps rediscovering.
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
 * @returns {{missing: string[], covered: string[], cargoEntries: object[]}}
 */
export function evaluate(manifestDirs, updates) {
  const cargoEntries = updates.filter((u) => u.ecosystem === 'cargo');
  const watched = new Set(cargoEntries.map((u) => normaliseDir(u.directory)));
  const missing = manifestDirs.filter((d) => !watched.has(normaliseDir(d)));
  const covered = manifestDirs.filter((d) => watched.has(normaliseDir(d)));
  return { missing, covered, cargoEntries };
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
  const updates = parseUpdates(readFileSync(dependabotAbs, 'utf8'));
  const manifestDirs = findCargoManifestDirs(root);
  const { missing, covered, cargoEntries } = evaluate(manifestDirs, updates);

  // Vacuity, checked BEFORE the verdict: a walker that found nothing and a repo
  // with nothing to find produce identical `missing.length === 0`.
  if (manifestDirs.length === 0) {
    console.error(
      '[cargo-dependabot-coverage] REFUSING TO PASS: found 0 Cargo.toml manifests. ' +
        'This repo has at least one (apps/loom-directlake). The walker has stopped ' +
        'walking — fix the scanner, do not ship a green check that measures nothing.',
    );
    return 1;
  }
  if (updates.length === 0) {
    console.error(
      `[cargo-dependabot-coverage] REFUSING TO PASS: parsed 0 updates[] entries from ` +
        `${DEPENDABOT_PATH}. The file is non-empty, so the parser has stopped parsing.`,
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
