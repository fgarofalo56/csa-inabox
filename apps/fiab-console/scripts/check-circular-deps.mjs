#!/usr/bin/env node
/**
 * Circular-dependency guard for lib/editors  (Enterprise-Hardening Phase-0).
 *
 * Fails if a NEW import cycle appears in lib/editors/ beyond the documented
 * baseline. Added after the phase3-editors.tsx split (18,078-line monolith →
 * 13 per-editor modules + 3 shared siblings + a barrel) so the barrel + the new
 * cross-importing modules can't silently re-introduce a cycle. It already caught
 * one: paginated-report-editor.tsx imported `ReportLite` from the barrel instead
 * of its defining sibling (./report-editor) — fixed by pointing at the sibling.
 *
 * BASELINE — known pre-existing cycles that are intentional / runtime-acyclic
 * (madge counts type-only and lazy `import()` edges, so it flags these even
 * though no runtime value cycle exists). Each entry is the set of basenames in
 * the allowed cycle:
 *   1. format-pane.tsx ⇄ conditional-format.tsx
 *      format-pane LAZY-loads (`lazy(() => import('./conditional-format'))`) +
 *      type-imports conditional-format; conditional-format statically imports
 *      LOOM_DATA_PALETTE from format-pane. No runtime cycle. See format-pane.tsx:83-90.
 *   2. apim-editors.tsx ⇄ data-product-detail.tsx  (pre-existing).
 *
 * Run: `pnpm guard:circular`  (uses madge via npx; no runtime dep added).
 */
import { execSync } from 'node:child_process';

const ROOT = 'lib/editors';
const BASELINE = [
  ['conditional-format.tsx', 'format-pane.tsx'],
  ['apim-editors.tsx', 'data-product-detail.tsx'],
];

const cycleKey = (files) => files.map((f) => f.split(/[\\/]/).pop()).sort().join('|');

let out = '';
try {
  out = execSync(`npx --yes madge --circular --json --extensions ts,tsx ${ROOT}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (e) {
  // madge may exit non-zero when cycles exist; its JSON still lands on stdout.
  out = (e && e.stdout ? e.stdout.toString() : '');
}

let cycles;
try {
  cycles = JSON.parse(out);
} catch {
  console.error('guard:circular — could not run or parse madge output. Is madge resolvable via npx?');
  process.exit(2);
}

const allowed = new Set(BASELINE.map((c) => c.slice().sort().join('|')));
const offending = (cycles || []).filter((c) => !allowed.has(cycleKey(c)));

if (offending.length) {
  console.error(`✖ ${offending.length} NEW circular dependency(ies) in ${ROOT}/ beyond the documented baseline:`);
  for (const c of offending) console.error('  - ' + c.join(' → '));
  console.error(
    '\nBreak the cycle: import from the defining sibling module (not a barrel/index),\n' +
    'or use a type-only (`import type`) / lazy (`lazy(() => import())`) edge.\n' +
    'If the new cycle is genuinely intentional + runtime-acyclic, add it to BASELINE in this file with a justification.',
  );
  process.exit(1);
}

console.log(`✓ No new circular dependencies in ${ROOT}/ (baseline allows ${BASELINE.length} known).`);
