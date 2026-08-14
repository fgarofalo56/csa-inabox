#!/usr/bin/env node
/**
 * Self-tests for scripts/ci/check-indexer-health-honesty.mjs (#3384).
 *
 * A guard whose population is zero is indistinguishable from a guard that has
 * stopped working, so this suite proves the matcher MOVES:
 *
 *   - the real pre-fix source shapes are FLAGGED,
 *   - the real post-fix source shapes are CLEAN,
 *   - a route that reads the indexer-status endpoint without emitting `health`
 *     is FLAGGED, and the same route with `health` is CLEAN,
 *   - the embedded-control check itself fails when the matcher is broken,
 *   - an empty R2 population is reported as a BROKEN GUARD, not a pass.
 *
 * The last two are the ones that matter: they are what stops this file from
 * becoming another gate that measures nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findStatusAsHealth,
  isIndexerStatusContext,
  routeReadsIndexerStatus,
  routeEmitsHealth,
  runGuard,
  CONTROLS,
} from '../check-indexer-health-honesty.mjs';

// ── The REAL pre-fix source, verbatim from git history ──────────────────────
const PRE_FIX_TREE = `
      if (action === 'status') {
        const st = body.status?.lastResult?.status || body.status?.status || 'unknown';
        setIndexerStatus((m) => ({ ...m, [indexer]: st }));
      }
`;
const PRE_FIX_OPS = `
import { parseExecutionHistory } from '@/lib/azure/search-indexer-shapes';
const parsed = parseExecutionHistory(j.status);
setOverall(parsed.overallStatus);
<Badge size="small" appearance="tint" color={runColor(overall)}>{overall}</Badge>
`;
// ── The post-fix source ─────────────────────────────────────────────────────
const POST_FIX_TREE = `
      if (action === 'status') {
        const h = body.health;
        setIndexerHealth((m) => ({ ...m, [indexer]: h ?? { verdict: 'unknown', healthy: false } }));
      }
`;
const POST_FIX_OPS = `
import { parseExecutionHistory, indexerHealthColor } from '@/lib/azure/search-indexer-shapes';
const parsed = parseExecutionHistory(j.status);
setHealth(j.health ?? null);
<Badge color={indexerHealthColor(health.verdict)}>{health.verdict}</Badge>
`;

test('the pre-fix status fallback chain is FLAGGED', () => {
  const hits = findStatusAsHealth(PRE_FIX_TREE);
  assert.ok(hits.some((h) => h.rule === 'fallback-chain'), `expected a fallback-chain hit, got ${JSON.stringify(hits)}`);
});

test('the pre-fix overall badge is FLAGGED', () => {
  const hits = findStatusAsHealth(PRE_FIX_OPS);
  assert.ok(hits.some((h) => h.rule === 'overall-as-colour'), `expected an overall-as-colour hit, got ${JSON.stringify(hits)}`);
});

test('the post-fix sources are CLEAN — the verdict MOVES', () => {
  assert.deepEqual(findStatusAsHealth(POST_FIX_TREE), []);
  assert.deepEqual(findStatusAsHealth(POST_FIX_OPS), []);
});

test('a commented-out pre-fix snippet is NOT flagged (offsets preserved, comments blanked)', () => {
  const src = `// const st = body.status?.lastResult?.status || body.status?.status || 'unknown';\nconst ok = true;`;
  assert.deepEqual(findStatusAsHealth(src), []);
});

test('overall-as-colour is SCOPED — a pipeline debug run is not an indexer', () => {
  // The real false positives the unscoped rule produced, verbatim in shape.
  const debugPanel = `const [overall, setOverall] = useState('queued');\n{statusBadge(overall)}`;
  assert.equal(isIndexerStatusContext(debugPanel), false);
  assert.deepEqual(findStatusAsHealth(debugPanel), []);
  // …and the SAME line inside a file that does handle indexer status IS flagged,
  // so the scoping narrows the population without blunting the rule.
  const indexerPanel = `import { parseExecutionHistory } from '@/lib/azure/search-indexer-shapes';\n{statusBadge(overall)}`;
  assert.ok(findStatusAsHealth(indexerPanel).some((h) => h.rule === 'overall-as-colour'));
});

test('R2: a route reading the indexer-status endpoint is detected, and `health` presence is measured', () => {
  const bad = `import { getIndexerStatus } from '@/lib/azure/search-index-client';\nconst status = await getIndexerStatus(indexer);\nreturn NextResponse.json({ ok: true, action: 'status', indexer, status });`;
  const good = `import { readIndexerHealth } from '@/lib/azure/search-indexer-health';\nconst { status, health } = await readIndexerHealth(indexer);\nreturn NextResponse.json({ ok: true, action: 'status', indexer, status, health });`;
  assert.equal(routeReadsIndexerStatus(bad), true);
  assert.equal(routeEmitsHealth(bad), false);
  assert.equal(routeReadsIndexerStatus(good), true);
  assert.equal(routeEmitsHealth(good), true);
});

test('runGuard FLAGS a synthetic tree carrying both defects, and CLEARS the fixed one', () => {
  const root = mkdtempSync(join(tmpdir(), 'indexer-guard-'));
  try {
    const api = join(root, 'app', 'api', 'ai-search', 'indexers');
    mkdirSync(api, { recursive: true });
    writeFileSync(join(api, 'route.ts'), `import { getIndexerStatus } from '@/lib/azure/search-index-client';\nconst status = await getIndexerStatus(indexer);\nreturn NextResponse.json({ ok: true, status });\n`);
    const lib = join(root, 'lib', 'components');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'tree.tsx'), PRE_FIX_TREE);

    const bad = runGuard({ roots: [root] });
    assert.equal(bad.brokenMatchers.length, 0, `unexpected broken matcher: ${bad.brokenMatchers.join(' | ')}`);
    assert.ok(bad.violations.some((v) => v.includes('[fallback-chain]')), `expected fallback-chain violation, got ${JSON.stringify(bad.violations)}`);
    assert.ok(bad.violations.some((v) => v.includes('[missing-health]')), `expected missing-health violation, got ${JSON.stringify(bad.violations)}`);

    // MUTATION: fix both files; the verdict must move to clean.
    writeFileSync(join(api, 'route.ts'), `import { readIndexerHealth } from '@/lib/azure/search-indexer-health';\nconst { status, health } = await readIndexerHealth(indexer);\nreturn NextResponse.json({ ok: true, status, health });\n`);
    writeFileSync(join(lib, 'tree.tsx'), POST_FIX_TREE);
    const good = runGuard({ roots: [root] });
    assert.deepEqual(good.violations, []);
    assert.deepEqual(good.brokenMatchers, []);
    assert.equal(good.r2Population, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an EMPTY R2 population is a BROKEN GUARD, not a pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'indexer-guard-empty-'));
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'unrelated.ts'), 'export const x = 1;\n');
    const r = runGuard({ roots: [root] });
    assert.equal(r.r2Population, 0);
    assert.ok(
      r.brokenMatchers.some((b) => b.includes('ZERO routes matched')),
      `an empty population must be reported as broken, got ${JSON.stringify(r.brokenMatchers)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the embedded controls are still detected by the live matcher', () => {
  assert.ok(CONTROLS.length >= 2);
  for (const c of CONTROLS) {
    assert.ok(
      findStatusAsHealth(c.src).some((h) => h.rule === c.rule),
      `embedded control "${c.name}" is no longer detected — the matcher has drifted`,
    );
  }
});

test('the repo itself is clean under this guard', () => {
  const r = runGuard();
  assert.deepEqual(r.violations, [], `live repo violations: ${r.violations.join(' | ')}`);
  assert.deepEqual(r.brokenMatchers, [], `live repo broken matchers: ${r.brokenMatchers.join(' | ')}`);
  assert.ok(r.r2Population > 0, 'the indexer-status route population must not be zero');
});
