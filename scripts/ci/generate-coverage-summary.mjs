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
${measuredPy ? `| ${measuredLabel} | ${measuredPy}% | latest \`pytest --cov\` (\`coverage.json\`/\`coverage.xml\`) |` : `| Last measured | _run \`pytest --cov\` to populate_ | \`coverage.json\` \`totals.percent_covered\` |`}

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

if (process.argv.includes('--check')) {
  const current = readOptional(OUT_REL);
  // Compare ignoring the Generated-on date line (which changes every run).
  const strip = (s) => (s || '').replace(/Generated-on:.*?-->/s, '').trim();
  if (strip(current) !== strip(doc)) {
    console.error(
      `[coverage-summary] ${OUT_REL} is stale. Run:\n  node scripts/ci/generate-coverage-summary.mjs`,
    );
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
