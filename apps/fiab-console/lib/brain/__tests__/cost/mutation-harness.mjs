#!/usr/bin/env node
/**
 * LOOM BRAIN cost — MUTATION HARNESS.
 *
 * A test that passes proves nothing about whether it would FAIL. This harness
 * breaks each guard's subject in the SOURCE, re-runs the suite, and records
 * both exit codes. A mutation that does not move the verdict is a finding about
 * the test, not a clean bill of health.
 *
 * WRITTEN IN NODE, NOT PYTHON, ON PURPOSE. On this box Python defaults to
 * cp1252: `text=True` mis-decodes the em-dashes and section signs that are all
 * over these files, so a needle containing one silently fails to match on a
 * WORKING arm — a false negative that reads exactly like "the guard is theatre".
 * Python's universal-newline write also rewrites CRLF to LF, leaving a file
 * dirty with an empty `git diff`.
 *
 * CRLF: this repo has `core.autocrlf=true`, so a needle authored with LF can
 * match ZERO times against a file on disk. Every mutation below therefore
 * ASSERTS ITS NEEDLE MATCHED EXACTLY ONCE and aborts otherwise. An unmatched
 * needle is reported as a HARNESS FAILURE, never as a passing arm — that
 * confusion is the whole reason this note exists.
 *
 * Usage (from apps/fiab-console):
 *   node lib/brain/__tests__/cost/mutation-harness.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = resolve(HERE, '../../../..');
const COST = resolve(CONSOLE_ROOT, 'lib/brain/cost');

/**
 * Each mutation names the PROPERTY it attacks, so a reader can judge whether
 * the mutation is a real evasion or a strawman. Per the narrow-bypass lesson:
 * these break the DEFENCE, not the test.
 */
const MUTATIONS = [
  {
    id: 'M1-render-billed-accepts-derived',
    property: 'renderBilled refuses a derived figure at runtime (the cast bypass)',
    file: resolve(COST, 'figure.ts'),
    find: "  if (figure.source !== 'billed') {\n    throw new Error(\n      `renderBilled received a figure whose source is '${String(",
    replace: "  if (false) {\n    throw new Error(\n      `renderBilled received a figure whose source is '${String(",
  },
  {
    id: 'M2-derived-renders-without-label',
    property: 'a derived rendering carries the DERIVED marker',
    file: resolve(COST, 'figure.ts'),
    find: "export const DERIVED_MARKER = 'DERIVED estimate — not a bill';",
    replace: "export const DERIVED_MARKER = '';",
  },
  {
    id: 'M3-absent-scale-becomes-zero',
    property: 'absent scale facts are NOT MEASURED, never $0.00',
    file: resolve(COST, 'derived.ts'),
    find:
      "  if (node.scale === undefined) {\n    return skip(\n      subject,\n      'no scale facts — replica count NOT MEASURED. Not priced, and NOT counted as $0.00',\n    );\n  }",
    replace:
      "  if (node.scale === undefined) {\n    return skip(subject, 'no scale facts — NOT MEASURED');\n  }",
  },
  {
    id: 'M4-unknown-region-falls-back-to-commercial',
    property: 'an unclassifiable region is skipped, not priced at Commercial rates',
    file: resolve(COST, 'rate-card.ts'),
    find: "  return COMMERCIAL_PREFIXES.some((p) => r.startsWith(p)) ? 'commercial' : null;",
    replace: "  return COMMERCIAL_PREFIXES.some((p) => r.startsWith(p)) ? 'commercial' : 'commercial';",
  },
  {
    id: 'M5-no-manifest-reports-complete',
    property: "a read with no manifest reports 'unknown', never 'complete'",
    file: resolve(COST, 'export-reader.ts'),
    find: "  let completeness: Completeness = 'unknown';",
    replace: "  let completeness: Completeness = 'complete';",
  },
  {
    id: 'M6-non-usd-recorded-as-usd',
    property: 'a non-USD row is skipped rather than mislabelled as USD',
    file: resolve(COST, 'export-reader.ts'),
    find:
      "        } else {\n          note(\n            `${partition.blobName}#${r}`,\n            `billing currency is '${currency}', not USD, and no explicit USD column is present — ` +\n              'refusing to convert; there is no exchange rate this reader can establish',\n          );\n          continue;\n        }",
    replace:
      "        } else {\n          usdText = (fields[costIdx] ?? '').trim();\n          currencyNote = `column '${bound.cost}'`;\n        }",
  },
  {
    id: 'M7-naive-csv-split',
    property: 'the quoted Tags column does not shift the resource id',
    file: resolve(COST, 'export-reader.ts'),
    find: 'export function parseCsvFields(record: string): string[] {\n  const out: string[] = [];',
    replace:
      "export function parseCsvFields(record: string): string[] {\n  return record.split(',');\n  // eslint-disable-next-line no-unreachable\n  const out: string[] = [];",
  },
  {
    id: 'M8-missing-export-yields-zero',
    property: 'a missing export degrades to DERIVED, not to $0.00 or a throw',
    file: resolve(COST, 'attribute.ts'),
    find:
      '    if (!isBand(outcome)) {\n      // D2 — unpriceable. No figure, a reason, and it is NOT counted as zero.\n      skipped.push({ subject: outcome.subject, reason: outcome.reason });\n      continue;\n    }\n    const figure = boundOf(outcome, options.bound);',
    replace:
      '    if (!isBand(outcome)) {\n      skipped.push({ subject: outcome.subject, reason: outcome.reason });\n      continue;\n    }\n    const figure = { ...boundOf(outcome, options.bound), amountUsd: 0 };',
  },
  {
    id: 'M9-rollup-conflates-sources',
    property: 'billed and derived subtotals are never merged',
    file: resolve(COST, 'figure.ts'),
    find: "    dominantSource: derivedCount === 0 && billedCount > 0 ? 'billed' : 'derived',",
    replace: "    dominantSource: 'billed',",
  },
  {
    id: 'M10-blind-population-hidden',
    property: 'an empty read population reports blind',
    file: resolve(COST, 'population.ts'),
    find: '    blind: args.examined === 0,',
    replace: '    blind: false,',
  },

  // ── NARROW MUTATIONS ─────────────────────────────────────────────────────
  // A broad mutation is the easy one to kill. The evasion that actually works
  // in this repo is the NARROW one: scope the hole to a single currency, a
  // single region, a single branch, and a broad-looking guard plus a full suite
  // both stay green. These exist to find where a test's POPULATION is 1.
  {
    id: 'N1-currency-exemption-for-one-currency',
    property: 'the currency check rejects EVERY non-USD currency, not just the one under test',
    file: resolve(COST, 'export-reader.ts'),
    find: "        if (currency === 'USD') {",
    replace: "        if (currency === 'USD' || currency === 'GBP') {",
  },
  {
    id: 'N2-usd-assumption-no-longer-opt-in',
    property: 'a currency-less export is accepted only on explicit caller opt-in',
    file: resolve(COST, 'export-reader.ts'),
    find: "        } else if (!currency && input.assumeUsdWhenCurrencyAbsent) {",
    replace: "        } else if (!currency) {",
  },
  {
    id: 'N3-one-region-family-falls-back',
    property: 'region classification refuses EVERY unknown region, not just the one under test',
    file: resolve(COST, 'rate-card.ts'),
    find: "  if (r.startsWith('usgov') || r.startsWith('usdod')) return 'usgov';",
    replace:
      "  if (r.startsWith('usgov') || r.startsWith('usdod')) return 'usgov';\n  if (r.startsWith('chinanorth') || r.startsWith('chinaeast')) return 'commercial';",
  },
  {
    id: 'N4-bare-number-memory-accepted',
    property: 'a bare-number memory is rejected rather than assumed to be GiB',
    file: resolve(COST, 'derived.ts'),
    find: "  const match = /^([0-9]*\\.?[0-9]+)\\s*(Gi|Mi|G|M)$/i.exec(m);",
    replace: "  const match = /^([0-9]*\\.?[0-9]+)\\s*(Gi|Mi|G|M)?$/i.exec(m);",
  },
  {
    id: 'N5-rowcount-crosscheck-removed',
    property: 'a truncated blob is caught by the row-count cross-check, not only by blob names',
    file: resolve(COST, 'export-reader.ts'),
    find: "    completeness === 'complete' &&\n    manifestFacts?.dataRowCount !== null &&",
    replace: "    false &&\n    manifestFacts?.dataRowCount !== null &&",
  },
  {
    id: 'N6-derived-only-when-no-export-at-all',
    property: 'a resource with no ROW in a present export still degrades to derived',
    file: resolve(COST, 'attribute.ts'),
    find: '    // D1 — no bill for this resource. Derive, and LABEL. Never fall to $0.00.\n    const outcome = deriveContainerAppCost(node, {',
    replace:
      '    if (exp) {\n      skipped.push({ subject: node.id, reason: "no billing row" });\n      continue;\n    }\n    const outcome = deriveContainerAppCost(node, {',
  },
  {
    id: 'N7-idle-and-active-bounds-collapsed',
    property: 'the band has width — lower and upper are computed from DIFFERENT rates',
    file: resolve(COST, 'derived.ts'),
    find:
      '  const lowerUsd =\n    vcpuSeconds * card.vcpuIdleUsdPerSecond + gibSeconds * card.memoryIdleUsdPerGibSecond;',
    replace:
      '  const lowerUsd =\n    vcpuSeconds * card.vcpuActiveUsdPerSecond + gibSeconds * card.memoryActiveUsdPerGibSecond;',
  },
];

function runSuite() {
  try {
    execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', 'lib/brain/__tests__/cost', '--reporter=dot'],
      { cwd: CONSOLE_ROOT, stdio: 'pipe' },
    );
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

const results = [];
const cleanRc = runSuite();
console.log(`CLEAN                                        RC=${cleanRc}`);
if (cleanRc !== 0) {
  console.error('ABORT: the clean arm is not green. Fix that before mutating anything.');
  process.exit(2);
}

for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  const hits = countOccurrences(original, m.find);
  if (hits !== 1) {
    // NOT a passing arm. An unmatched needle mutated nothing, so a green run
    // here would be a measurement of the unmutated code.
    console.log(`${m.id.padEnd(44)} HARNESS FAILURE: needle matched ${hits} times, expected exactly 1`);
    results.push({ id: m.id, cleanRc, mutatedRc: null, note: `needle matched ${hits}x` });
    continue;
  }
  writeFileSync(m.file, original.replace(m.find, m.replace), 'utf8');
  let mutatedRc;
  try {
    mutatedRc = runSuite();
  } finally {
    writeFileSync(m.file, original, 'utf8');
  }
  const verdict = mutatedRc === 0 ? 'SURVIVED — the guard does not watch this' : 'killed';
  console.log(`${m.id.padEnd(44)} RC=${mutatedRc}  ${verdict}   (${m.property})`);
  results.push({ id: m.id, cleanRc, mutatedRc, property: m.property });
}

const revertRc = runSuite();
console.log(`REVERTED                                     RC=${revertRc}`);

const survivors = results.filter((r) => r.mutatedRc === 0 || r.mutatedRc === null);
if (survivors.length > 0) {
  console.log(`\n${survivors.length} mutation(s) did not move the verdict:`);
  for (const s of survivors) console.log(`  - ${s.id} ${s.note ?? ''}`);
}
console.log(`\nPOPULATION: ${MUTATIONS.length} mutation(s) attempted across 5 source files.`);
process.exit(revertRc === 0 && survivors.length === 0 ? 0 : 1);
