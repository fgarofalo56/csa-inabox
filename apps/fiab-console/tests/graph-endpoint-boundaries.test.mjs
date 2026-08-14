/**
 * Microsoft Graph sovereign-boundary endpoint DRIFT guard (#3381).
 *
 * WHY THIS IS SOURCE-ONLY, AND WHAT RUNS THE BEHAVIOUR
 * ----------------------------------------------------
 * The first version of this suite imported `cloud-endpoints.ts` directly and
 * asserted the resolver's actual return values. That worked on the author's
 * Node 24 (type-stripping is unflagged from 22.18) and **failed in CI**, which
 * runs Node 20 everywhere:
 *
 *     TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
 *
 * A suite that cannot load is the mirror image of a gate that cannot fail, so
 * the executable matrix moved to where TypeScript actually runs:
 *
 *     apps/fiab-console/lib/azure/__tests__/cloud-endpoints.test.ts   (vitest)
 *
 * — which covers the per-boundary hosts, the `/v1.0` invariant, the
 * `LOOM_GRAPH_BASE` normalisation, the exact env `main.bicep` emits, and a
 * pairwise-distinct anti-vacuity control.
 *
 * What remains HERE is the part that needs no toolchain and that vitest is the
 * wrong place for: **structural drift across the whole tree.** These run on
 * bare `node --test` (Node 20+, no loader, no dependencies), which is what
 * `scripts/ci/check-node-test-suites.mjs` gives them.
 *
 * GROUNDING (Microsoft Learn, https://learn.microsoft.com/graph/deployments —
 * "Microsoft Graph and Graph Explorer service root endpoints"):
 *     global service (Commercial + GCC)  https://graph.microsoft.com
 *     US Government L4 (GCC High)        https://graph.microsoft.us
 *     US Government L5 (DOD)             https://dod-graph.microsoft.us
 * and, from the same page: "Access tokens acquired for a national cloud
 * deployment are not interchangeable with those acquired for the global service
 * or any other national cloud." A wrong root is a hard failure, not a redirect.
 *
 * MUTATION LEDGER — every row RUN on this file as it now stands, not predicted.
 * Baseline 6 pass / 0 fail (exit 0). Each mutation applied, suite re-run, file
 * restored; the restore was re-run and came back green.
 *
 *   N1  delete the DoD case from getGraphHost()        exit 1, 4 pass / 2 fail
 *   N2  point msal.graphBase() back at AZURE_CLOUD     exit 1, 5 pass / 1 fail
 *   N3  hard-code getGraphHost() to one constant       exit 1, 4 pass / 2 fail
 *   N4  re-derive a Graph host in a sibling file       exit 1, 5 pass / 1 fail
 *   N5  add a file to the literals-guard allowlist     exit 1, 5 pass / 1 fail
 *       that this suite does not exempt
 *
 * N3 is the anti-vacuity control: a resolver collapsed to a single host — the
 * shape a lazy fix takes — cannot pass. N4 proves the sibling sweep still bites
 * after the module split; it is the assertion that caught a real file
 * (`app-multi-agency-onboarding.ts`) during the original fix. N5 proves the
 * cross-file allowlist agreement is enforced rather than merely commented.
 *
 * Run: node --test apps/fiab-console/tests/graph-endpoint-boundaries.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '..');

const read = (...rel) => fs.readFileSync(path.join(CONSOLE_ROOT, ...rel), 'utf8');

const COMMERCIAL = 'https://graph.microsoft.com';
const L4 = 'https://graph.microsoft.us';
const L5 = 'https://dod-graph.microsoft.us';

/**
 * The modules that DEFINE the per-cloud map. Everything else in the console
 * must call into them rather than restate the mapping. Kept in one place
 * because the sibling sweep and the literals guard
 * (`scripts/ci/check-cloud-endpoint-literals.mjs` FILE_ALLOWLIST) have to agree
 * on this list — if they drift, one of them starts measuring nothing.
 */
const DEFINER_FILES = new Set([
  'lib/azure/cloud-endpoints.ts',
  'lib/azure/cloud-endpoints-graph.ts',
  'lib/azure/cloud-boundary.ts',
]);

// ── the defect, asserted structurally ──────────────────────────────────────

test('getGraphHost() maps all three Learn roots, DoD included', () => {
  const src = read('lib', 'azure', 'cloud-endpoints-graph.ts');
  const fn = src.match(/export function getGraphHost\(\): string \{[\s\S]*?\n\}/);
  assert.ok(fn, 'getGraphHost() not found in cloud-endpoints-graph.ts — did it move?');
  const body = fn[0];

  // The DoD case is the one that did not exist. Assert the ARM (case -> host)
  // pairing, not merely that the string appears somewhere in the file.
  assert.match(body, /case 'DoD':\s*\r?\n\s*return 'https:\/\/dod-graph\.microsoft\.us';/, 'DoD -> L5 root');
  assert.match(body, /case 'GCC-High':\s*\r?\n\s*return 'https:\/\/graph\.microsoft\.us';/, 'GCC-High -> L4 root');
  assert.match(body, /return 'https:\/\/graph\.microsoft\.com';/, 'default -> worldwide root');

  // LOOM_GRAPH_BASE must win, and must be NORMALISED — returning it verbatim is
  // what dropped `/v1.0` on every bicep-wired estate, Commercial included.
  assert.match(body, /process\.env\.LOOM_GRAPH_BASE/, 'honours the explicit override');
  assert.match(body, /normalizeGraphRoot\(explicit\)/, 'normalises the override to a root');

  // ...and the boundary read that keeps IL5 distinct from the ARM fold.
  assert.match(body, /graphBoundary\(\)/, 'switches on the Graph-specific boundary');
});

test('CONTROL: the three roots are pairwise distinct in the source map', () => {
  // A resolver collapsed to one constant would satisfy any single-host
  // assertion above. It cannot satisfy this one.
  const src = read('lib', 'azure', 'cloud-endpoints-graph.ts');
  const roots = [...src.matchAll(/return '(https:\/\/(?:dod-)?graph\.microsoft\.(?:com|us))';/g)].map((m) => m[1]);
  const distinct = new Set(roots);
  assert.equal(distinct.size, 3, `expected 3 distinct Graph roots, got: ${[...distinct].join(', ')}`);
  for (const expected of [COMMERCIAL, L4, L5]) {
    assert.ok(distinct.has(expected), `missing root ${expected}`);
  }
});

test('graphBase() appends /v1.0 exactly once, derived from getGraphHost()', () => {
  const src = read('lib', 'azure', 'cloud-endpoints-graph.ts');
  const fn = src.match(/export function graphBase\(\): string \{[\s\S]*?\n\}/);
  assert.ok(fn, 'graphBase() not found');
  assert.match(fn[0], /return `\$\{getGraphHost\(\)\}\/v1\.0`;/, 'must be host + one version segment');
  assert.doesNotMatch(fn[0], /graph\.microsoft\./, 'must not restate a host literal');
});

// ── drift across the tree ──────────────────────────────────────────────────

test('lib/auth/msal.ts delegates to getGraphHost() instead of re-deriving', () => {
  const src = read('lib', 'auth', 'msal.ts');
  const fn = src.match(/export function graphBase\(\)[\s\S]*?\n}/);
  assert.ok(fn, 'graphBase() not found in lib/auth/msal.ts — did it move?');
  const body = fn[0];
  assert.match(body, /return getGraphHost\(\);/, 'must delegate to the one resolver');
  assert.doesNotMatch(body, /graph\.microsoft\./, 'must not hard-code any Graph host literal');
  assert.doesNotMatch(body, /AZURE_CLOUD/, 'must not re-read the cloud env directly');
  assert.match(src, /getGraphHost/, 'must import getGraphHost from cloud-endpoints');
});

test('the literals guard and this sweep agree on which files DEFINE the map', () => {
  // Both skip the definer modules. If the two lists drift, one of them stops
  // measuring — a guard exempting a file this sweep still polices is merely
  // noisy, but a file this sweep exempts and the guard does NOT is a place a
  // re-derived host could sit unseen by both. Asserted rather than left as a
  // "keep in sync" comment, which is the shape that always rots.
  const guard = fs.readFileSync(
    path.resolve(HERE, '..', '..', '..', 'scripts', 'ci', 'check-cloud-endpoint-literals.mjs'),
    'utf8',
  );
  const block = guard.match(/const FILE_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'FILE_ALLOWLIST not found in check-cloud-endpoint-literals.mjs');
  // Match PATHS only — a bare /'([^']+)'/ also catches the apostrophes inside
  // the surrounding prose comments ("its parent does"), which made this
  // assertion fail on its own explanation the first time it ran.
  const allowlisted = [...block[1].matchAll(/'(apps\/[^']+\.tsx?)'/g)].map((m) => m[1]);
  assert.ok(allowlisted.length > 0, 'FILE_ALLOWLIST parsed as empty — the regex has drifted');
  for (const repoRel of allowlisted) {
    const consoleRel = repoRel.replace(/^apps\/fiab-console\//, '');
    assert.ok(
      DEFINER_FILES.has(consoleRel),
      `${repoRel} is exempt from the literals guard but is NOT in this suite's DEFINER_FILES`,
    );
  }
});

test('no console source re-derives a Graph host outside the definer modules', () => {
  // Mechanical sibling sweep — the "seventh consumer" class. Any NEW file that
  // pairs a Graph host literal with a cloud/env branch is a fresh copy of this
  // bug, so it must be dealt with deliberately rather than discovered in Gov.
  // This assertion was RED on its first run and caught
  // lib/apps/content-bundles/app-multi-agency-onboarding.ts, which had hard-coded
  // both the host and the MSI audience while already importing armBase().
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__' || e.name === '.next') continue;
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(e.name) || /\.(test|spec)\.tsx?$/.test(e.name)) continue;
      const rel = path.relative(CONSOLE_ROOT, p).split(path.sep).join('/');
      if (DEFINER_FILES.has(rel)) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        // A host literal on the same line as a cloud/env discriminator is the
        // signature of a re-derived mapping. Comments are ignored — they
        // document the map, they do not build a URL from it.
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
        if (!/https:\/\/(dod-)?graph\.microsoft\.(com|us)/.test(line)) continue;
        if (!/AZURE_CLOUD|LOOM_CLOUD|isGovCloud|detectLoomCloud|LOOM_GRAPH_BASE/.test(line)) continue;
        offenders.push(`${rel}: ${t.slice(0, 140)}`);
      }
    }
  };
  ['lib', 'app'].map((d) => path.join(CONSOLE_ROOT, d)).forEach(walk);
  assert.deepEqual(
    offenders,
    [],
    `these files re-derive a Graph host instead of calling getGraphHost():\n  ${offenders.join('\n  ')}`,
  );
});
