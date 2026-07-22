#!/usr/bin/env node
/**
 * GUARDRAIL: bicep-param-cap  (merge-blocker)  — loom-next-level R0
 * ------------------------------------------------------------------------
 * RULE (PRPs/active/loom-next-level — R0): ARM templates hard-cap at 256
 *   `param` declarations per file. `modules/admin-plane/main.bicep` hit the
 *   cap on 2026-07-22 and was consolidated back to 232 by moving related
 *   params into typed config-object (bag) params (aasConfig, adxConfig,
 *   eventsConfig, functionAppsConfig + reserved observability/dr/
 *   workspace-identity bags).
 *
 *   New deploy-time settings MUST land as properties on one of those bags
 *   (or as a nested-module param) — NEVER as a new top-level `param`.
 *   This guard keeps the headroom loud: creeping back toward the cap is a
 *   silent deploy-breaker (ARM rejects the template at 257 with a max-params
 *   error only at deploy time).
 *
 * THRESHOLDS (per watched file):
 *   • warn  — prints a loud advisory; CI stays green.
 *   • fail  — exits 1; consolidate params into a bag before merging.
 *
 * HOW TO FIX A FAILURE: move related params into an existing config bag
 *   (add a typed property + a shim `var name = bag.?name ?? <default>`), or
 *   introduce a new typed bag. See the R0 section comment in
 *   modules/admin-plane/main.bicep and docs/fiab/deployment/index.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// file → thresholds. admin-plane/main.bicep per the R0 spec (warn 240 / fail
// 250); the top-level orchestrator sits at 248 today, so its thresholds only
// catch NEW growth (it gets its own consolidation pass when an item needs
// params there — same bag rule applies).
const WATCHED = [
  {
    file: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
    warn: 240,
    fail: 250,
  },
  {
    file: 'platform/fiab/bicep/main.bicep',
    warn: 249,
    fail: 253,
  },
];

let failed = false;
for (const { file, warn, fail } of WATCHED) {
  const abs = path.join(REPO_ROOT, file);
  const src = fs.readFileSync(abs, 'utf8');
  const count = (src.match(/^param /gm) || []).length;
  const status = count >= fail ? 'FAIL' : count >= warn ? 'WARN' : 'ok';
  console.log(`[bicep-param-cap] ${file}: ${count} params (warn ${warn}, fail ${fail}, ARM cap 256) → ${status}`);
  if (count >= fail) {
    failed = true;
    console.error(
      `  ✖ ${file} has ${count} top-level params — within ${256 - count} of the ARM 256 cap.\n` +
        `    Move related params into a config bag (R0 pattern) instead of adding top-level params.`,
    );
  } else if (count >= warn) {
    console.warn(`  ⚠ approaching the ARM cap — plan a bag consolidation before adding more params.`);
  }
}

process.exit(failed ? 1 : 0);
