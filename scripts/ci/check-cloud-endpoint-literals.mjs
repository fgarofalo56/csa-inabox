#!/usr/bin/env node
/**
 * GUARDRAIL: cloud-endpoint-literals  (merge-blocker, RATCHETING — X1)
 * ---------------------------------------------------------------------------
 * RULE (cloud-neutral, shrink-only adoption ratchet):
 *
 *   Azure host suffixes must be resolved through the ONE cloud-neutral map —
 *     apps/fiab-console/lib/azure/cloud-endpoints.ts
 *   — never hard-coded as a bare literal in client/route code. A wired-in
 *   `management.azure.com` / `*.vault.azure.net` / `*.kusto.windows.net` (etc.)
 *   is the Commercial host; the same string breaks silently in Azure
 *   Government (`management.usgovcloudapi.net`, `vault.usgovcloudapi.net`,
 *   `kusto.usgovcloudapi.net`, `openai.azure.us`, …). Every straggler literal
 *   must migrate to the cloud-endpoints resolver so a single deployment builds
 *   the right sovereign host for every cloud.
 *
 * SCOPE — SOURCE files only, under:
 *     apps/fiab-console/lib/azure/**   apps/fiab-console/app/api/**
 *     apps/fiab-console/lib/auth/**    apps/fiab-console/lib/admin/**
 *     apps/fiab-console/lib/apps/**
 *
 *   THE LAST THREE WERE ADDED BY #3381, AND THE OMISSION IS WHY THAT BUG
 *   SURVIVED. `lib/auth/msal.ts:381` held a two-branch Graph-host switch with
 *   no DoD case — a wired-in `graph.microsoft.com` on the fallback branch, the
 *   exact literal this guard forbids — and the guard never saw it, because
 *   `lib/auth` was not in SCOPE_DIRS. Same for `lib/admin/secret-health.ts` and
 *   the Graph host baked into `lib/apps/content-bundles/`. A guard that reads
 *   as "every straggler literal must migrate" while scanning two of the five
 *   directories that hold them is the presence-not-enforcement shape.
 *
 *   Adding scope GROWS the ratchet baseline once (grandfathering what is
 *   already there); it does not fix those literals, it makes them visible and
 *   stops NEW ones landing beside them.
 *
 *   Excluded:
 *     - lib/azure/cloud-endpoints.ts itself (it DEFINES the per-cloud suffixes)
 *     - test files (`**\/__tests__\/**`, `*.test.ts(x)`, `*.spec.ts(x)`) —
 *       endpoint-assertion tests legitimately embed a RESOLVED host as their
 *       expected value; they are not stragglers wired into the app. (Mirrors
 *       both the "cloud-endpoints.ts and its tests" carve-out in the X1 spec
 *       and the test exclusion in check-workspace-credential-adoption.mjs.)
 *
 * FORBIDDEN LITERAL SET (Commercial host suffixes):
 *   management.azure.com, vault.azure.net, servicebus.windows.net,
 *   dfs.core.windows.net, kusto.windows.net, search.windows.net,
 *   documents.azure.com, database.windows.net, api.loganalytics.io,
 *   cognitiveservices.azure.com, graph.microsoft.com,
 *   openai.azure.us | openai.azure.com, analysis.windows.net,
 *   blob.core.windows.net
 *
 * ALLOWLIST — an INTENTIONAL occurrence (a doc comment naming the host, a
 *   @deprecated scope constant, sovereign-suffix validation copy) may be marked
 *   with an inline `cloud-endpoint-literal-ok` comment on the same line; the
 *   scanner ignores that line. Whole-file exemptions live in FILE_ALLOWLIST.
 *
 * RATCHET SEMANTICS (shared mechanic — scripts/ci/_ratchet-count.mjs, R3):
 *   per-file counts of forbidden literals are frozen as the baseline; CI fails
 *   only when a file's count RISES (a NEW hard-coded host) or a NEW file
 *   introduces one. The floor only SHRINKS. Convert the literal to a
 *   cloud-endpoints.ts resolver call to clear, then regenerate the baseline.
 *
 * MODES:
 *   node scripts/ci/check-cloud-endpoint-literals.mjs                 # CHECK (default; the self-test)
 *   node scripts/ci/check-cloud-endpoint-literals.mjs --update-baseline   # regen (shrink-only; justify a grow in the PR)
 *
 * Baseline: scripts/ci/cloud-endpoint-literals-baseline.json (own file — ~1xx
 * entries; carries the owner/why/how-to-unblock header via the shared helper).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runRatchet } from './_ratchet-count.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const BASELINE_FILE = path.join(__dirname, 'cloud-endpoint-literals-baseline.json');

// Every console directory that builds an Azure/Graph URL. `lib/auth`,
// `lib/admin` and `lib/apps` were added by #3381 — see the SCOPE note above for
// why their absence was the mechanism, not an oversight of degree.
const SCOPE_DIRS = ['lib/azure', 'app/api', 'lib/auth', 'lib/admin', 'lib/apps'];

// Commercial host suffixes that must flow through cloud-endpoints.ts instead.
const FORBIDDEN_LITERALS = [
  'management.azure.com',
  'vault.azure.net',
  'servicebus.windows.net',
  'dfs.core.windows.net',
  'kusto.windows.net',
  'search.windows.net',
  'documents.azure.com',
  'database.windows.net',
  'api.loganalytics.io',
  'cognitiveservices.azure.com',
  'graph.microsoft.com',
  'openai.azure.us',
  'openai.azure.com',
  'analysis.windows.net',
  'blob.core.windows.net',
];
const LITERAL_RE = new RegExp(FORBIDDEN_LITERALS.map((s) => s.replace(/\./g, '\\.')).join('|'), 'g');

// Inline marker: a line carrying this comment is an intentional occurrence
// (doc comment / @deprecated scope / sovereign-suffix validation copy) and is
// NOT counted. Keep the marker adjacent to a one-line justification.
const INLINE_ALLOW_MARKER = 'cloud-endpoint-literal-ok';

// Whole-file exemptions (repo-relative POSIX paths). These modules DEFINE the
// per-cloud suffixes; every other file must call into them. Test files are
// excluded structurally (see isTestFile).
//
// KEEP IN SYNC with DEFINER_FILES in
// apps/fiab-console/tests/graph-endpoint-boundaries.test.mjs — that suite's
// sibling sweep skips the same set, and if the two lists drift, one of them
// starts measuring nothing.
const FILE_ALLOWLIST = new Set([
  'apps/fiab-console/lib/azure/cloud-endpoints.ts',
  // Split out of cloud-endpoints.ts by #3381 (file-size ratchet + the Graph
  // boundary genuinely diverging from ARM's). It carries the three Learn-
  // documented Graph roots for the same reason its parent does.
  'apps/fiab-console/lib/azure/cloud-endpoints-graph.ts',
]);

const isTestFile = (rel) => /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.tsx?$/.test(rel);

/** Source files (repo-relative POSIX) in scope. */
function listSourceFiles() {
  const files = [];
  for (const dir of SCOPE_DIRS) {
    let out;
    try {
      // NB: double quotes — single quotes are not quoting chars in cmd.exe.
      out = execSync(`git ls-files "${dir}"`, { cwd: APP_ROOT, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const f of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (!/\.(ts|tsx)$/.test(f)) continue;
      if (isTestFile(f)) continue;
      files.push(`apps/fiab-console/${f}`);
    }
  }
  return files;
}

/** Measure current forbidden-literal counts → { repoRelPath: count }. */
export function scanLiterals() {
  const current = {};
  for (const rel of listSourceFiles()) {
    if (FILE_ALLOWLIST.has(rel)) continue;
    let src;
    try {
      src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    let n = 0;
    for (const line of src.split('\n')) {
      if (line.includes(INLINE_ALLOW_MARKER)) continue; // intentional occurrence
      const m = line.match(LITERAL_RE);
      if (m) n += m.length;
    }
    if (n > 0) current[rel] = n;
  }
  return current;
}

function main() {
  const current = scanLiterals();
  const exit = runRatchet({
    name: 'cloud-endpoint-literals',
    baselineFile: BASELINE_FILE,
    meta: {
      owner: 'loom-next-level WS-R (X1) — platform/cloud-neutrality',
      why:
        'Bare Commercial host literals (management.azure.com, *.vault.azure.net, ' +
        '*.kusto.windows.net, openai.azure.com, …) break silently in Azure Government / ' +
        'sovereign clouds. Every straggler must resolve through ' +
        'apps/fiab-console/lib/azure/cloud-endpoints.ts. Baseline = the grandfathered ' +
        'source-file literal count; it only shrinks.',
      unblock:
        'convert the literal to a cloud-endpoints.ts resolver call (import from ' +
        "'@/lib/azure/cloud-endpoints'), then regen: " +
        'node scripts/ci/check-cloud-endpoint-literals.mjs --update-baseline ' +
        '(genuinely intentional line — doc comment / @deprecated scope? add an inline ' +
        '`cloud-endpoint-literal-ok` comment on that line with a one-line reason).',
    },
    current,
  });
  process.exit(exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
