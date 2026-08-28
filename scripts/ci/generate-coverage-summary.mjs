#!/usr/bin/env node
/**
 * GENERATOR: coverage-summary  (WS-F1 — coverage transparency)
 * ------------------------------------------------------------------------
 * RULE (no-vaporware.md + the coverage-ratchet policy):
 *   The coverage threshold quoted in docs MUST match the number CI actually
 *   enforces — never an aspirational figure. There are two coverage numbers
 *   in the repo and they used to disagree; this generator derives the truth
 *   straight from the config files so the published summary can never drift
 *   from what blocks a merge.
 *
 * WHAT IT DOES:
 *   1. Reads the ENFORCED Python gate from `.github/workflows/test.yml`
 *      (`pytest --cov-fail-under=<N>` — the pytest-cov CLI flag that OVERRIDES
 *      pyproject at runtime, i.e. the number that actually fails CI).
 *   2. Reads the DECLARED gate + gated `source` packages + `--ignore`d suites
 *      from `pyproject.toml`.
 *   3. Reads the enforced Vitest floor from `apps/fiab-console/vitest.config.ts`.
 *   4. If a `coverage.xml` produced by the last `pytest --cov` run is present,
 *      parses its overall `line-rate` to embed the LAST MEASURED coverage %.
 *   5. Writes `docs/fiab/coverage-summary.md` — a machine-generated summary.
 *
 * USAGE:
 *   node scripts/ci/generate-coverage-summary.mjs           # (re)write the doc
 *   node scripts/ci/generate-coverage-summary.mjs --check   # fail if stale
 *
 * The doc is GENERATED — do not hand-edit it; change the config and rerun.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const OUT_REL = 'docs/fiab/coverage-summary.md';

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}
function readOptional(rel) {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  } catch {
    return null;
  }
}

// 1) Enforced Python gate — the --cov-fail-under CLI flag in the Test workflow.
const testYml = read('.github/workflows/test.yml');
const enforcedMatch = testYml.match(/--cov-fail-under=(\d+)/);
const enforcedPy = enforcedMatch ? Number(enforcedMatch[1]) : null;

// 2) Declared Python gate + gated source + ignored suites — from pyproject.
const pyproject = read('pyproject.toml');
const declaredMatch = pyproject.match(/^fail_under\s*=\s*(\d+)/m);
const declaredPy = declaredMatch ? Number(declaredMatch[1]) : null;

const sourceBlock = pyproject.match(/\[tool\.coverage\.run\][\s\S]*?source\s*=\s*\[([\s\S]*?)\]/);
const gatedSource = sourceBlock
  ? sourceBlock[1]
      .split('\n')
      // Drop commented-out entries (e.g. `# "csa_platform/common",`) so the
      // doc only lists packages that are ACTUALLY gated.
      .filter((line) => !line.trim().startsWith('#'))
      .flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]))
  : [];

const addopts = (pyproject.match(/^addopts\s*=\s*"([^"]*)"/m) || [, ''])[1];
const ignoredSuites = [...addopts.matchAll(/--ignore=(\S+)/g)].map((m) => m[1]);

// 3) Enforced Vitest floor — thresholds block in the console vitest config.
const vitestCfg = readOptional('apps/fiab-console/vitest.config.ts') || '';
const thBlock = vitestCfg.match(/thresholds:\s*\{([\s\S]*?)\}/);
const vitestFloor = {};
if (thBlock) {
  for (const m of thBlock[1].matchAll(/(statements|branches|functions|lines):\s*(\d+)/g)) {
    vitestFloor[m[1]] = Number(m[2]);
  }
}

// 4) Last measured Python coverage — the branch-inclusive TOTAL that the
//    `--cov-fail-under` gate actually compares against (branch=true in config).
//    Prefer coverage.json `totals.percent_covered` (the exact gated metric);
//    fall back to coverage.xml, whose `line-rate` is line-only (higher than the
//    gate) — labelled as such so it is never mistaken for the enforced number.
const covJson = readOptional('coverage.json');
const covXml = readOptional('coverage.xml');
let measuredPy = null;
let measuredLabel = 'Last measured (branch-inclusive total — the gated metric)';
if (covJson) {
  try {
    const pc = JSON.parse(covJson)?.totals?.percent_covered;
    if (typeof pc === 'number') measuredPy = pc.toFixed(2);
  } catch {
    /* ignore malformed json */
  }
}
if (measuredPy === null && covXml) {
  const lr = covXml.match(/line-rate="([\d.]+)"/);
  if (lr) {
    measuredPy = (parseFloat(lr[1]) * 100).toFixed(2);
    measuredLabel = 'Last measured (line-only from coverage.xml — gate uses the lower branch-inclusive total)';
  }
}

// CARRY FORWARD the last-measured row when no coverage artefact is present
// (refs #2860). coverage.json/xml are produced by `pytest --cov`, so they exist
// on a machine that just ran the Python suite and NOWHERE ELSE — not in a fresh
// clone, and not in the loom-guardrails lane. Without this, the generator's
// output depended on the environment, `--check` compared a doc built WITH the
// number against one built WITHOUT it, and the drift gate could only be made
// green by deleting a real measured figure from the doc. That is why the gate
// could not be wired, which is why the vitest floors in this doc were allowed
// to drift 33 points from the config for weeks. A measurement we did not take
// this run is not a measurement of zero: keep the committed row verbatim and
// let the next real `pytest --cov` update it.
const CARRIED_ROW = /^\|\s*(Last measured[^|]*?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/m;
const carried = measuredPy === null ? (readOptional(OUT_REL) || '').match(CARRIED_ROW) : null;

const genDate = new Date().toISOString().slice(0, 10);

const vitestRows = ['statements', 'branches', 'functions', 'lines']
  .filter((k) => vitestFloor[k] !== undefined)
  .map((k) => `| ${k} | ${vitestFloor[k]}% |`)
  .join('\n');

const doc = `<!-- GENERATED FILE — do not edit by hand.
     Source of truth: pyproject.toml, .github/workflows/test.yml,
     apps/fiab-console/vitest.config.ts.
     Regenerate: \`node scripts/ci/generate-coverage-summary.mjs\`.
     Generated-on: ${genDate} -->

# CSA Loom — Coverage Summary

**Machine-generated** from the live coverage config. This file states the
**real, enforced** coverage gates — the numbers that actually fail CI — not
aspirational targets (per \`no-vaporware.md\`). If a number here looks wrong,
fix the config and rerun the generator; do not edit this file.

Companion narrative + the three-number reconciliation live in
[\`meta/canonical-metrics.md\`](meta/canonical-metrics.md).

## Python coverage

| Gate | Value | Source of truth |
|---|---|---|
| **Enforced (fails CI)** | **${enforcedPy}%** | \`pytest --cov-fail-under=${enforcedPy}\` in \`.github/workflows/test.yml\` |
| Declared (pyproject) | ${declaredPy}% | \`fail_under = ${declaredPy}\` in \`pyproject.toml\` \`[tool.coverage.report]\` |
${measuredPy ? `| ${measuredLabel} | ${measuredPy}% | latest \`pytest --cov\` (\`coverage.json\`/\`coverage.xml\`) |` : carried ? `| ${carried[1]} | ${carried[2]} | ${carried[3]} |` : `| Last measured | _run \`pytest --cov\` to populate_ | \`coverage.json\` \`totals.percent_covered\` |`}

> The pytest-cov CLI flag **overrides** the pyproject value at runtime, so the
> enforced number is the one to quote. They are kept in lockstep — both **${enforcedPy}%**.

### Gated source packages (what the % measures)

Only these packages are counted toward the gate (\`pyproject.toml\`
\`[tool.coverage.run] source\`). Broader \`csa_platform/**\` and
\`portal/shared/api/\` are measured in the report but **not** gated — their
suites are still growing.

${gatedSource.length ? gatedSource.map((s) => `- \`${s}\``).join('\n') : '_none parsed_'}

### Ignored test suites (\`pytest --ignore\`)

${
  ignoredSuites.length
    ? ignoredSuites.map((s) => `- \`${s}\``).join('\n')
    : '_none — all discovered suites run._'
}

${
  ignoredSuites.length
    ? '> Re-enabling these is tracked as WS-F2. See the `addopts` comment in ' +
      '`pyproject.toml` and ADR 0024 for the exact blocker per suite.'
    : ''
}

## Console (Vitest) coverage floor

Enforced by \`pnpm vitest run --coverage\` in
\`.github/workflows/fiab-console-ci.yml\`; the job fails if coverage drops
below the floor in \`apps/fiab-console/vitest.config.ts\`.

${vitestRows ? `| Metric | Floor |\n|---|---|\n${vitestRows}` : '_thresholds not parsed_'}

> These are FLOORS set a couple of points below the last measured reality
> (ratchet-UP-only convention). Raising them further — plus the route-handler
> toolkit tests — is deferred to **WS-D / WS-F4** (the toolkit that F4's tests
> target is not yet built).

## Ratchet roadmap

- Python: 60 → 65 → **75** (current) → 80 (next, once streaming / portal-backend
  suites join the gated \`source\` set). Raise one notch only after CI sits 5+
  points above the current floor for a full release cycle.
- Vitest: ratchet each metric to \`(new measured − ~2pts)\` whenever a wave adds
  tests and coverage climbs; never lower it.
`;

const outPath = path.join(repoRoot, OUT_REL);

/**
 * POPULATION FLOOR — refuse to judge a doc assembled from parsers that read
 * NOTHING (#4058 review).
 *
 * Every figure in this doc comes from a regex over a config file. If one of
 * those configs is reformatted past its matcher, the corresponding value goes
 * `null` / `[]` / `{}` and the doc renders `_thresholds not parsed_` or
 * `_none parsed_` — and `--check` then compares that empty doc against an
 * equally empty committed copy and reports "up to date". The gate stays green
 * over a summary that states nothing, which is exactly the failure the
 * generator exists to prevent (a published number that has drifted from the
 * one CI enforces).
 *
 * So a collapsed parse is a HARD failure on both paths, not a rendered
 * placeholder. `measuredPy` is deliberately NOT in this list: it comes from a
 * coverage artefact that legitimately does not exist outside a machine that
 * just ran `pytest --cov`, and the carry-forward above handles it.
 */
function assertParsedPopulation() {
  const empty = [];
  if (enforcedPy === null) empty.push('enforced Python gate (--cov-fail-under in .github/workflows/test.yml)');
  if (declaredPy === null) empty.push('declared Python gate (fail_under in pyproject.toml)');
  if (gatedSource.length === 0) empty.push('gated source packages ([tool.coverage.run] source in pyproject.toml)');
  if (Object.keys(vitestFloor).length === 0) {
    empty.push('Vitest floors (thresholds block in apps/fiab-console/vitest.config.ts)');
  }
  if (empty.length === 0) return;
  console.error(
    '[coverage-summary] REFUSING to render or judge this doc: the following inputs parsed to nothing, so the ' +
      'summary would publish placeholders instead of the gates CI enforces.',
  );
  for (const e of empty) console.error(`  - ${e}`);
  console.error(
    '  A matcher here has drifted off its config file. Fix the matcher — do NOT commit a doc with "_not parsed_" ' +
      'in it, because --check would then be permanently green over an empty summary.',
  );
  process.exit(1);
}
assertParsedPopulation();

if (process.argv.includes('--check')) {
  const current = readOptional(OUT_REL);
  if (current === null) {
    console.error(
      `[coverage-summary] ${OUT_REL} does not exist. Run:\n  node scripts/ci/generate-coverage-summary.mjs`,
    );
    process.exit(1);
  }
  // NORMALISE LINE ENDINGS BEFORE COMPARING (#4058).
  //
  // `doc` is assembled in memory from template literals, so it is LF-only.
  // `current` is read from disk verbatim. `.gitattributes` does not cover
  // `docs/**`, so with `core.autocrlf=true` Git materialises this path as CRLF
  // on a Windows checkout — correct, expected Git behaviour. The comparison was
  // a raw `!==`, so EVERY line differed by one byte and `--check` failed on a
  // pristine tree with zero local modifications: measured 3103 bytes / 77 CR /
  // 77 LF on disk against 3026 bytes / 0 CR / 77 LF in memory. Delta 77 —
  // exactly the CR count.
  //
  // Worse than a false red: the message told the developer to regenerate, which
  // rewrites the file LF-only and attributes a whole-file line-ending change to
  // whatever PR they happened to be on. CI is Linux, so the checkout is LF there
  // and this never fired in CI — it only bit the person the gate exists to help.
  //
  // This normalises the COMPARISON, not the checkout; it does not touch what is
  // written, and it changes nothing about which CONTENT differences are
  // detected. A changed row, a deleted row, a reordered table all still fail.
  // The `Generated-on:` strip is unchanged — that line genuinely varies per run.
  const strip = (s) => (s || '').replace(/\r\n/g, '\n').replace(/Generated-on:.*?-->/s, '').trim();
  const a = strip(current);
  const b = strip(doc);
  if (a !== b) {
    // Say WHAT differs, not just that something does (deploy-integrity.md R7).
    // "is stale" on its own sent this exact investigation down a line-ending
    // rabbit hole once already.
    const al = a.split('\n');
    const bl = b.split('\n');
    let i = 0;
    while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
    console.error(
      `[coverage-summary] ${OUT_REL} does not match the live coverage config (compared with line endings ` +
        `normalised, and with the Generated-on line ignored).`,
    );
    console.error(`  first difference at line ${i + 1} of the compared text:`);
    console.error(`    on disk:   ${al[i] === undefined ? '<end of file>' : JSON.stringify(al[i])}`);
    console.error(`    generated: ${bl[i] === undefined ? '<end of file>' : JSON.stringify(bl[i])}`);
    console.error(`  Regenerate with:\n    node scripts/ci/generate-coverage-summary.mjs`);
    process.exit(1);
  }
  console.log(`[coverage-summary] ${OUT_REL} is up to date.`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, doc);
console.log(
  `[coverage-summary] wrote ${OUT_REL} (Python enforced ${enforcedPy}%, declared ${declaredPy}%` +
    `${measuredPy ? `, measured ${measuredPy}%` : ''}).`,
);
