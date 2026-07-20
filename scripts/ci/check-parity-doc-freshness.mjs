#!/usr/bin/env node
/**
 * GUARDRAIL: parity-doc-freshness  (WARN-first; opt-in merge-blocker)
 * ---------------------------------------------------------------------------
 * RULE (WS-A3, docs-source-of-truth.md):
 *   A parity / parity-gap doc claims a snapshot of how a Loom surface compares
 *   to Azure/Fabric. When the SOURCE CODE that surface is built from changes,
 *   the doc silently goes stale -- the exact drift that made report.md claim
 *   "powerbi-client NOT INSTALLED" months after the report designer shipped.
 *   This guard maps each doc to its source files (declared IN the doc) and
 *   flags any doc whose sources were committed AFTER the doc's Reviewed-on date.
 *
 * METADATA CONVENTION (add to the TOP of any parity/parity-gap doc):
 *   <!-- parity-doc-meta
 *   Reviewed-on: 2026-07-20
 *   Validated-against:
 *     - apps/fiab-console/lib/editors/phase3/report-editor.tsx
 *     - apps/fiab-console/lib/editors/report-designer.tsx
 *   -->
 *   Validated-against entries are repo-root-relative paths; a `*` / `**` glob
 *   is allowed (e.g. lib/catalog/item-types/*.ts).
 *
 * WHAT IT CHECKS (per doc under docs/fiab/parity/ + docs/fiab/parity-gap/ +
 * docs/fiab/meta/):
 *   1. Has a parity-doc-meta block with a valid Reviewed-on date + >=1
 *      Validated-against source -> else counted as "no metadata yet" (not a
 *      failure; the convention rolls out incrementally).
 *   2. For each source (glob-expanded), the last git commit date is <=
 *      Reviewed-on -> else WARN "source changed after review" with the sources.
 *   3. Every Validated-against path resolves to >=1 real file -> else WARN
 *      "source path not found" (doc points at moved/renamed code).
 *
 * BEHAVIOUR:
 *   - Default: WARN-first. Prints a report, always exits 0, so it never blocks a
 *     merge while the backlog of stale docs is worked down.
 *   - PARITY_DOC_FRESHNESS_ENFORCE=1 : STALE docs (rule 2/3) exit 1 (the
 *     hard-fail mode to flip on once the priority docs carry current metadata,
 *     per the warn-first-then-hard-fail rollout).
 *
 * Requires git history for accurate dates -- the workflow checks out with
 * fetch-depth: 0. If a source has no git date (shallow / new file), it is
 * skipped with an INFO note rather than a false WARN.
 *
 * Run: node scripts/ci/check-parity-doc-freshness.mjs   (repo root)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENFORCE = process.env.PARITY_DOC_FRESHNESS_ENFORCE === '1';
const DOC_DIRS = ['docs/fiab/parity', 'docs/fiab/parity-gap', 'docs/fiab/meta'];

const warnings = [];
const infos = [];
const noMeta = [];
let checked = 0;
let withMeta = 0;

/** All *.md files under the given repo-relative dirs. */
function listDocs() {
  const out = [];
  for (const rel of DOC_DIRS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.md')) out.push(path.join(rel, name));
    }
  }
  return out.sort();
}

/** Parse the parity-doc-meta block. Returns { reviewedOn, sources } or null. */
function parseMeta(text) {
  const m = text.match(/<!--\s*parity-doc-meta\s*([\s\S]*?)-->/);
  if (!m) return null;
  const body = m[1];
  const dateM = body.match(/Reviewed-on:\s*(\d{4}-\d{2}-\d{2})/);
  const sources = [];
  const va = body.match(/Validated-against:\s*([\s\S]*)/);
  if (va) {
    for (const line of va[1].split('\n')) {
      const s = line.match(/^\s*-\s*(\S.*?)\s*$/);
      if (s) sources.push(s[1]);
      else if (/^\s*\w+:/.test(line)) break; // next key ends the list
    }
  }
  if (!dateM || sources.length === 0) return null;
  return { reviewedOn: dateM[1], sources };
}

/** Expand a repo-root-relative path or *,** glob to real files. */
function expandGlob(pattern) {
  if (!pattern.includes('*')) {
    const abs = path.join(ROOT, pattern);
    return fs.existsSync(abs) ? [pattern] : [];
  }
  // fixed prefix dir = path up to the first segment containing a wildcard
  const segs = pattern.split('/');
  const fixed = [];
  for (const s of segs) { if (s.includes('*')) break; fixed.push(s); }
  const baseRel = fixed.join('/');
  const baseAbs = path.join(ROOT, baseRel);
  if (!fs.existsSync(baseAbs)) return [];
  const rx = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*') + '$');
  const found = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, name.name);
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      if (name.isDirectory()) walk(abs);
      else if (rx.test(rel)) found.push(rel);
    }
  })(baseAbs);
  return found;
}

/**
 * Newest commit ISO date across all files matching `pattern`, or null if
 * unavailable. Uses git's own pathspec globbing so a `*.ts` source is ONE git
 * call rather than one-per-expanded-file. Memoized per pattern.
 */
const dateCache = new Map();
function newestCommitDate(pattern) {
  if (dateCache.has(pattern)) return dateCache.get(pattern);
  let iso = null;
  try {
    iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', pattern],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { iso = null; }
  dateCache.set(pattern, iso);
  return iso;
}

for (const doc of listDocs()) {
  checked++;
  const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
  const meta = parseMeta(text);
  if (!meta) { noMeta.push(doc); continue; }
  withMeta++;
  const reviewedEnd = new Date(meta.reviewedOn + 'T23:59:59Z').getTime();
  for (const pattern of meta.sources) {
    // filesystem existence (rule 3): the pattern must resolve to >=1 real file
    if (expandGlob(pattern).length === 0) {
      warnings.push(`${doc}: Validated-against path not found -- "${pattern}" (moved/renamed?).`);
      continue;
    }
    // freshness (rule 2): newest commit touching the pattern vs Reviewed-on
    const iso = newestCommitDate(pattern);
    if (!iso) { infos.push(`${doc}: no git date for "${pattern}" (shallow/new) -- skipped.`); continue; }
    if (new Date(iso).getTime() > reviewedEnd) {
      warnings.push(`${doc}: source changed ${iso.slice(0, 10)} after Reviewed-on ${meta.reviewedOn} -- ${pattern}`);
    }
  }
}

console.log(`\nparity-doc-freshness: scanned ${checked} docs (${withMeta} with metadata, ${noMeta.length} without) in ${DOC_DIRS.join(', ')}.`);
if (noMeta.length) {
  console.log(`\n${noMeta.length} doc(s) have no parity-doc-meta block yet -- convention rolls out incrementally (set VERBOSE=1 to list).`);
  if (process.env.VERBOSE === '1') for (const d of noMeta) console.log('  - ' + d);
}
if (infos.length) { console.log('\nINFO:'); for (const i of infos) console.log('  - ' + i); }
if (warnings.length) {
  console.log(`\n${ENFORCE ? 'STALE (enforced)' : 'WARN'} -- ${warnings.length} finding(s):`);
  for (const w of warnings) console.log('  ! ' + w);
  console.log('\nFix: re-audit the doc against the changed source, then bump its Reviewed-on date.');
  if (ENFORCE) { console.error('\nPARITY_DOC_FRESHNESS_ENFORCE=1 -- failing on stale parity docs.'); process.exit(1); }
} else {
  console.log('\nNo stale parity docs. OK');
}
process.exit(0);
