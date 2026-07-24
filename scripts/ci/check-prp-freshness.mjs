#!/usr/bin/env node
/**
 * GUARDRAIL: prp-freshness  (WARN-ONLY per-phase re-baseline gate) — loom-next-level FRESH0
 * ------------------------------------------------------------------------
 * RULE (PRPs/active/loom-next-level — FRESH0, round 3 F4): the PRP hard-codes
 *   ground-truth numbers that its own execution invalidates ("1,356 hand-rolled
 *   routes", "exactly 256 params", "the DAX evaluator is 3 regexes", "#2389
 *   OPEN"). R29 ratchets parity-doc freshness; this applies the same thesis to
 *   the PRP itself: re-count every stated fact and WARN when live diverges
 *   >10% from the stated value (or a referenced PR's state flipped).
 *
 *   NOT a merge-blocker: exit 0 with ::warning:: annotations. The master
 *   spine's phase boundaries (0→1, 1→2, 2→3, 3→4) each run this and commit a
 *   ~30-minute PRP re-verification updating the stale numbers/statuses.
 *   `--strict` exits 1 on any warning (for the boundary run itself).
 *
 * BASELINE: the FACTS table below states each fact AS WRITTEN IN THE PRP,
 *   where it is written, and how to re-count it. After a boundary
 *   re-verification updates the PRP text, update `stated` here in the same
 *   commit ("--update-baseline" prints the refreshed table to paste).
 *
 * Owner: loom-next-level orchestrator. Unblock: this gate never blocks; a
 *   false-positive warning is silenced by re-baselining `stated` with a
 *   one-line justification in the commit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'fiab-console');

function sh(cmd, args, cwd = REPO_ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
function gitFiles(pattern, cwd) {
  const out = sh('git', ['ls-files', pattern], cwd);
  return out ? out.split(/\r?\n/) : [];
}
function gitGrepFiles(regex, pathspec, cwd) {
  try {
    const out = sh('git', ['grep', '-l', '-E', regex, '--', pathspec], cwd);
    return out ? out.split(/\r?\n/) : [];
  } catch {
    return []; // grep exits 1 on zero matches
  }
}

// --- counters ---------------------------------------------------------------

function countAdminPlaneParams() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'platform/fiab/bicep/modules/admin-plane/main.bicep'), 'utf-8');
  return (src.match(/^param /gm) || []).length;
}

function countRoutes() {
  return gitFiles('app/api/**/route.ts', APP_DIR).length;
}

function countHandRolledRoutes() {
  // Session-touching routes NOT on any toolkit wrapper (R1 wrappers included).
  const sessionRoutes = new Set(gitGrepFiles(
    'getSession|withSession|withWorkspaceOwner|withBackendGate', 'app/api/**/route.ts', APP_DIR));
  const migrated = new Set(gitGrepFiles(
    'withSession|withWorkspaceOwner|withBackendGate|withTenantAdmin|withDlzAccess',
    'app/api/**/route.ts', APP_DIR));
  let n = 0;
  for (const f of sessionRoutes) if (!migrated.has(f)) n += 1;
  return n;
}

function prState(num) {
  try {
    return sh('gh', ['pr', 'view', String(num), '--json', 'state', '-q', '.state']);
  } catch {
    return 'UNKNOWN';
  }
}

// --- the facts table (stated = as currently written in the PRP text) --------
// numeric facts warn when |live - stated| / stated > 0.10; state facts warn on
// any mismatch.

const FACTS = [
  {
    id: 'param-cap',
    where: 'PRP.md ground-truth #9 / ws-ratchets.md R0',
    statement: 'admin-plane/main.bicep param declarations',
    stated: 232, // 0→1 boundary re-baseline (R0 #2398 landed; PRP text updated same commit)
    live: countAdminPlaneParams,
  },
  {
    id: 'route-total',
    where: 'ws-ratchets.md §0 ground truth',
    statement: 'total app/api/**/route.ts files',
    stated: 1638, // 4c/4d/openness boundary re-baseline (N16/17/18 + M1/M2/M3 migrate + N7a streaming-sql / N7e trino / N8 labs routes)
    live: countRoutes,
  },
  {
    id: 'route-toolkit-gap',
    where: 'PRP.md ground-truth #4 / ws-ratchets.md §0',
    statement: 'hand-rolled session routes not on the route-toolkit',
    stated: 1338, // 4c/4d/openness boundary re-baseline; ratchet continues to shrink (1343→1338)
    live: countHandRolledRoutes,
  },
  {
    id: 'pr-2389-state',
    where: 'PRP.md WS-U §0 precondition',
    statement: 'PR #2389 (dark-theme sweep 2) — WS-U dark-font coverage precondition',
    stated: 'MERGED', // round-3 text already records it merged
    live: () => prState(2389),
  },
  {
    id: 'pr-2392-state',
    where: 'PRP.md header',
    statement: 'PR #2392 (PRP v2)',
    stated: 'MERGED',
    live: () => prState(2392),
  },
];

// --- run --------------------------------------------------------------------

const strict = process.argv.includes('--strict');
let warnings = 0;

for (const f of FACTS) {
  let live;
  try {
    live = f.live();
  } catch (e) {
    warnings += 1;
    console.log(`::warning::[prp-freshness] ${f.id}: could not re-count (${e.message || e}) — the counter's target may have moved; re-baseline.`);
    continue;
  }
  if (typeof f.stated === 'number') {
    const drift = Math.abs(live - f.stated) / f.stated;
    const pct = (drift * 100).toFixed(1);
    if (drift > 0.10) {
      warnings += 1;
      console.log(`::warning::[prp-freshness] ${f.id}: PRP states ${f.stated} (${f.where}); live is ${live} (${pct}% drift) — update the PRP text + this baseline at the phase boundary.`);
    } else {
      console.log(`[prp-freshness] ${f.id}: stated ${f.stated}, live ${live} (${pct}% drift) — ok`);
    }
  } else if (String(live) !== String(f.stated)) {
    warnings += 1;
    console.log(`::warning::[prp-freshness] ${f.id}: PRP states ${f.stated} (${f.where}); live is ${live} — update the PRP reference.`);
  } else {
    console.log(`[prp-freshness] ${f.id}: ${f.stated} — ok`);
  }
}

console.log(`[prp-freshness] ${warnings} warning(s). ${strict ? '(strict mode)' : '(warn-only)'}`);
process.exit(strict && warnings > 0 ? 1 : 0);
