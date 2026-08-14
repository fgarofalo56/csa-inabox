#!/usr/bin/env node
/**
 * check-indexer-health-honesty.mjs
 *
 * RULE. An Azure AI Search indexer's HEALTH may never be derived from the
 * top-level `status` field of `GET /indexers/{name}/status`, and any route that
 * reads that endpoint must return the derived `health` verdict alongside it.
 *
 * ── THE SHAPE (measured 2026-08-13, issue #3384) ───────────────────────────
 *
 * `research-knowledge-indexer` on dlz-aisearch-dev-eastus2 returned:
 *
 *     "status": "running"                <- the field every consumer reached for
 *     lastResult.status: "transientFailure"
 *     executionHistory: 50 runs, ALL transientFailure, itemsProcessed 0
 *     target index: 0 documents, schedule P1D, disabled false
 *
 * Per Learn (Get Indexer Status) the top-level `status` is `running | error` and
 * describes the INDEXER OBJECT — "enabled, and the service can execute it". It
 * carries no information about whether any execution succeeded. Two consumers
 * used it anyway:
 *
 *     ai-search-tree.tsx
 *       const st = body.status?.lastResult?.status || body.status?.status || 'unknown';
 *     indexer-ops.tsx
 *       <Badge color={runColor(overall)}>{overall}</Badge>   // overall = status.status
 *
 * So a pipeline that had failed fifty consecutive runs rendered the word
 * "running" in a neutral badge. Seven weeks of retained history, an empty index,
 * and a live daily schedule — all invisible.
 *
 * ── WHAT THIS GUARD ENFORCES ───────────────────────────────────────────────
 *
 *   R1  No `…status?.lastResult?.status || …status?.status` fallback chain, and
 *       no `overallStatus` fed into a colour/badge/verdict function. The whole
 *       point of the fallback is that it reaches the object-level field.
 *   R2  Every API route that reads the indexer-status endpoint must also emit
 *       `health` — a route that returns the raw payload alone hands the caller
 *       the same trap and no way out of it.
 *
 * ── SELF-DEFENCE (memory: a guard with zero population needs an embedded
 *     control) ─────────────────────────────────────────────────────────────
 *
 * R1's population is ZERO after the fix, so "no violations found" proves nothing
 * about whether the matcher still works. The guard therefore runs R1 against an
 * EMBEDDED CONTROL — the two real pre-fix snippets above — and FAILS if it
 * cannot find them. A matcher that drifts off the language reds the build rather
 * than passing on an empty population.
 *
 * R2's population is non-zero and is asserted to be non-zero for the same
 * reason: if the discovery predicate stops matching any route, that is a broken
 * guard, not a clean repo.
 *
 * Exit 0 = clean. Exit 1 = a violation, a broken matcher, or an empty R2
 * population. Nothing here is wrapped in `|| true` and no stream is discarded.
 *
 * Tests: node --test scripts/ci/__tests__/indexer-health-honesty.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const CONSOLE_ROOT = join(REPO, 'apps', 'fiab-console');
const SCAN_ROOTS = [join(CONSOLE_ROOT, 'lib'), join(CONSOLE_ROOT, 'app')].filter(existsSync);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__tests__']);

/** Walk for .ts/.tsx sources. */
export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/** Blank comments while PRESERVING offsets so reported line numbers stay true. */
export function blankComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * R1 — the object-level `status` field used as a health signal.
 *
 * Two independent shapes, because the two real defects took two different
 * forms and a single regex covering both would have to be so loose it would
 * cry wolf:
 *
 *   FALLBACK_CHAIN  `x.status?.lastResult?.status || x.status?.status`
 *                   — the `||` is what makes it lethal: it looks like a safe
 *                     default and silently substitutes the object-level field.
 *   OVERALL_AS_COLOUR
 *                   `runColor(overall)` / `statusColor(parsed.overallStatus)`
 *                   — `overallStatus` is `parseExecutionHistory`'s name for the
 *                     same field; feeding it to a colour/verdict function is
 *                     rendering it AS health.
 */
export const FALLBACK_CHAIN =
  /\.status\s*\??\.\s*lastResult\s*\??\.\s*status\s*\|\|[\s\S]{0,60}?\.status\s*\??\.\s*status/;
export const OVERALL_AS_COLOUR =
  /\b(?:\w*(?:Color|Colour|Intent|Verdict|Health|Badge))\s*\(\s*[\w$.?]*overall(?:Status)?\b/i;

/**
 * Is this file handling an AI SEARCH INDEXER status payload at all?
 *
 * `OVERALL_AS_COLOUR` cannot be applied repo-wide: `overall` is an ordinary
 * variable name. Run unscoped it flagged `statusBadge(overall)` in
 * pipeline/debug-monitor-panel.tsx and pipeline/pipeline-debug-overlay.tsx,
 * where `overall` is a pipeline DEBUG-RUN outcome — a genuine run status, and
 * exactly the right thing to colour. Two false positives out of two hits.
 * Per this repo's own lesson (check-loaded-flag-honesty: "a rule that cries
 * wolf gets muted, which is worse than no rule"), the rule is scoped to files
 * that actually touch the indexer-status contract.
 */
export function isIndexerStatusContext(src) {
  return /search-indexer-shapes|parseExecutionHistory|overallStatus|getIndexerStatus|readIndexerHealth/.test(blankComments(src));
}

/** Every R1 violation in one source text, with line numbers. */
export function findStatusAsHealth(src) {
  const clean = blankComments(src);
  const rules = [['fallback-chain', FALLBACK_CHAIN]];
  // Scoped: see isIndexerStatusContext.
  if (isIndexerStatusContext(src)) rules.push(['overall-as-colour', OVERALL_AS_COLOUR]);
  const found = [];
  for (const [rule, re] of rules) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(clean))) {
      found.push({ rule, line: clean.slice(0, m.index).split('\n').length, snippet: m[0].replace(/\s+/g, ' ').slice(0, 120) });
      if (m.index === g.lastIndex) g.lastIndex += 1;
    }
  }
  return found;
}

/**
 * R2 — a route that reads the indexer-status endpoint must return `health`.
 *
 * `reads` is deliberately BOTH the low-level client call and the composed
 * helper: a route that calls `getIndexerStatus` directly is exactly the pre-fix
 * shape, and one that calls `readIndexerHealth` but drops the verdict on the
 * floor is the same defect wearing the fix's name.
 */
export function routeReadsIndexerStatus(src) {
  const clean = blankComments(src);
  return /\bgetIndexerStatus\s*\(|\breadIndexerHealth\s*\(/.test(clean);
}
export function routeEmitsHealth(src) {
  const clean = blankComments(src);
  return /\bhealth\b\s*[,:}]/.test(clean);
}

// ── Embedded controls: the REAL pre-fix snippets. ──────────────────────────
// If the matcher stops finding THESE, it has drifted and must not report a pass.
export const CONTROLS = [
  {
    name: 'ai-search-tree.tsx pre-fix status fallback',
    src: "const st = body.status?.lastResult?.status || body.status?.status || 'unknown';\nsetIndexerStatus((m) => ({ ...m, [indexer]: st }));",
    rule: 'fallback-chain',
  },
  {
    name: 'indexer-ops.tsx pre-fix overall badge',
    src:
      "import { parseExecutionHistory } from '@/lib/azure/search-indexer-shapes';\n" +
      'const parsed = parseExecutionHistory(j.status); setOverall(parsed.overallStatus);\n' +
      '<Badge size="small" appearance="tint" color={runColor(overall)}>{overall}</Badge>',
    rule: 'overall-as-colour',
  },
];

export function runGuard({ roots = SCAN_ROOTS } = {}) {
  const violations = [];
  const brokenMatchers = [];
  let r2Population = 0;

  // Self-defence first: a broken matcher must be reported even if the tree is
  // clean, because on a clean tree it is indistinguishable from a working one.
  for (const c of CONTROLS) {
    const hits = findStatusAsHealth(c.src);
    if (!hits.some((h) => h.rule === c.rule)) {
      brokenMatchers.push(`${c.rule}: the embedded control "${c.name}" is NO LONGER DETECTED — the matcher has drifted off the language it guards.`);
    }
  }

  for (const root of roots) {
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(REPO, file).replace(/\\/g, '/');
      for (const v of findStatusAsHealth(src)) {
        violations.push(`${rel}:${v.line} [${v.rule}] ${v.snippet}`);
      }
      if (rel.includes('/app/api/') && routeReadsIndexerStatus(src)) {
        r2Population += 1;
        if (!routeEmitsHealth(src)) {
          violations.push(`${rel} [missing-health] reads the indexer-status endpoint but returns no derived \`health\` verdict — the caller is handed the raw payload whose top-level \`status\` reads "running" on a dead pipeline.`);
        }
      }
    }
  }

  if (roots.length && r2Population === 0) {
    brokenMatchers.push('missing-health: ZERO routes matched the indexer-status discovery predicate. Either every reader was renamed (in which case this rule is now blind) or the scan root is wrong. Refusing to report a pass on an empty population.');
  }

  return { violations, brokenMatchers, r2Population };
}

function main() {
  const { violations, brokenMatchers, r2Population } = runGuard();
  for (const b of brokenMatchers) console.log(`::error::check-indexer-health-honesty — ${b}`);
  for (const v of violations) console.log(`::error::check-indexer-health-honesty — ${v}`);
  if (violations.length || brokenMatchers.length) {
    console.log(
      `check-indexer-health-honesty: FAIL — ${violations.length} violation(s), ${brokenMatchers.length} broken matcher(s). ` +
        'Derive health with classifyIndexerHealth (lib/azure/search-indexer-shapes) and return it from the route; ' +
        'the top-level `status` field is the indexer OBJECT state, not a run outcome. See #3384.',
    );
    process.exit(1);
  }
  console.log(`check-indexer-health-honesty: OK — 0 violations; ${r2Population} indexer-status route(s) all emit a derived health verdict; ${CONTROLS.length} embedded control(s) still detected.`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
