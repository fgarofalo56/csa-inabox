#!/usr/bin/env node
/**
 * GUARDRAIL: file-size / monolith-creep  (merge-blocker, RATCHETING)  — WS-E E3
 * ------------------------------------------------------------------------
 * RULE (remediation WS-E — Monolith Decomposition / Maintainability): multiple
 *   3k–5k+ LOC editors impede maintainability. There is no preventive guard
 *   against files growing monolithic again. This guard adds one.
 *
 * WHAT IT DOES (ratchet, not full-clean — same shape as check-no-raw-px):
 *   Scans git-tracked `.ts` / `.tsx` source under apps/fiab-console/{lib,app}
 *   (excluding tests, generated .d.ts, .next, node_modules) and measures LOC.
 *
 *   Three signals:
 *     • WARN_THRESHOLD (1500 LOC) — a file above this is "large". Large files
 *       are ADVISORY (printed) and only BLOCK when NEW (see FAIL rule 1).
 *     • Ratchet ceiling (per-file, in ALLOWLIST) — every file already above the
 *       warn line today is frozen at its current LOC (rounded up to the next
 *       100 for a little churn slack). Growth past that ceiling BLOCKS.
 *     • HARD_MAX (6000 LOC) — an absolute backstop. Any file above it that is
 *       not `bundleExempt` (a generated content bundle) BLOCKS regardless.
 *
 *   NET EFFECT: CI is green on today's tree (all current offenders are
 *   allowlisted at their real LOC), but (a) NO new file may cross 1500 LOC
 *   without an explicit, reviewed allowlist entry, and (b) NO allowlisted
 *   monolith may grow past its frozen ceiling. The ratchet only tightens:
 *   decompose a file and its ceiling drops on the next --update-baseline.
 *
 * FAIL conditions:
 *   1. A file > WARN_THRESHOLD that is NOT in ALLOWLIST  → new monolith.
 *   2. An ALLOWLISTED file whose LOC > its ceiling       → monolith grew.
 *   3. Any file > HARD_MAX that is not `bundleExempt`     → absolute backstop.
 *
 * ESCALATION POLICY (documented per E3 acceptance criteria):
 *   - Preferred fix for a new failure: split the file by bounded context
 *     (UI sections / hooks / service adapters / validators) below 1500 LOC.
 *     See docs/fiab/decomposition-plan.md for the WS-E extraction blueprint of
 *     the five priority editors.
 *   - If a large file is genuinely unavoidable (e.g. a generated bundle, a
 *     single exhaustive catalog), add it to ALLOWLIST with a one-line reason.
 *     Reviewers gate new allowlist entries — an entry IS the exception request.
 *   - After decomposing a file, refresh the baseline so the ratchet tightens:
 *       node scripts/ci/check-file-size.mjs --update-baseline
 *     and paste the emitted JSON into ALLOWLIST below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_REL = path.join('apps', 'fiab-console');
const APP_ROOT = path.join(REPO_ROOT, APP_REL);
const SCOPE_DIRS = ['lib', 'app'];

const WARN_THRESHOLD = 1500; // "large file" line — new files above this block
const HARD_MAX = 6000;       // absolute backstop — non-bundle files above this block

/** Round a LOC up to the next 100 to give a small churn slack on the ratchet. */
function ceilTo100(loc) {
  return Math.ceil(loc / 100) * 100;
}

function isScanned(rel) {
  if (!/\.(ts|tsx)$/.test(rel)) return false;
  if (/\.d\.ts$/.test(rel)) return false;
  if (/(^|\/)__tests__\//.test(rel)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) return false;
  if (/(^|\/)(node_modules|\.next)\//.test(rel)) return false;
  return true;
}

/** LOC = number of newline-separated lines in the file. */
function loc(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  if (src.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  // a trailing newline shouldn't inflate the count by one phantom line
  if (src.charCodeAt(src.length - 1) === 10) n--;
  return n;
}

function listFiles() {
  const out = execSync(`git ls-files ${SCOPE_DIRS.join(' ')}`, { cwd: APP_ROOT, encoding: 'utf8' });
  const files = [];
  for (const rel of out.split('\n').map((s) => s.trim())) {
    if (!rel) continue;
    if (!isScanned(rel)) continue;
    files.push(path.join(APP_ROOT, rel));
  }
  return files;
}

function rel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

function scan() {
  const counts = {};
  for (const abs of listFiles()) {
    let n;
    try { n = loc(abs); } catch { continue; }
    counts[rel(abs)] = n;
  }
  return counts;
}

// __ALLOWLIST_START__  (regenerate with --update-baseline)
// Every file already above WARN_THRESHOLD (1500 LOC) on 2026-07-20, frozen at
// its current LOC (rounded up to the next 100). `max` is the ratchet ceiling;
// growth past it fails CI. The five WS-E priority editors carry the
// decomposition reason; generated content bundles are `bundleExempt` (they are
// machine-emitted and are the WS-E E2 externalization target). Everything else
// is a pre-existing large module, ratchet-frozen so it cannot grow further.
const ALLOWLIST = {
  // --- WS-E E1 priority editors (tracked for decomposition; do NOT grow) -----
  "apps/fiab-console/lib/editors/lakehouse/lakehouse-editor-shell.tsx": { max: 5300, reason: "tracked for WS-E decomposition" },
  "apps/fiab-console/lib/editors/report-designer.tsx": { max: 5200, reason: "tracked for WS-E decomposition" },
  "apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx": { max: 4700, reason: "tracked for WS-E decomposition; +WS-3.3 Direct Lake (Azure-native) storage-mode UI" },
  "apps/fiab-console/lib/editors/notebook-editor.tsx": { max: 3900, reason: "tracked for WS-E decomposition" },
  "apps/fiab-console/lib/editors/apim-editors.tsx": { max: 3600, reason: "tracked for WS-E decomposition" },
  // --- Generated content bundles (WS-E E2 target; machine-emitted) -----------
  "apps/fiab-console/lib/apps/content-bundles/app-supercharge-gold.ts": { max: 6100, reason: "generated by scripts/csa-loom/import-supercharge-notebooks.mjs; WS-E E2 externalization target", bundleExempt: true },
  "apps/fiab-console/lib/apps/content-bundles/app-supercharge-silver.ts": { max: 5300, reason: "generated by scripts/csa-loom/import-supercharge-notebooks.mjs; WS-E E2 externalization target", bundleExempt: true },
  "apps/fiab-console/lib/apps/content-bundles/app-supercharge-bronze.ts": { max: 4200, reason: "generated by scripts/csa-loom/import-supercharge-notebooks.mjs; WS-E E2 externalization target", bundleExempt: true },
  // --- Pre-existing large modules (ratchet-frozen — decompose to lower) -------
  "apps/fiab-console/lib/pipeline/connector-catalog.ts": { max: 3400, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/foundry-sub-editors.tsx": { max: 3300, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/databricks/uc-dialogs.tsx": { max: 3100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/aas-client.ts": { max: 3000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/unity-catalog-client.ts": { max: 2900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase4/plan-editor.tsx": { max: 2900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase4/ontology-editor.tsx": { max: 2900, reason: "large module — WS-4.3 Security tab wiring; heavy markings UI extracted to ontology-security-panel.tsx" },
  "apps/fiab-console/lib/azure/purview-client.ts": { max: 2800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/charts/loom-chart.tsx": { max: 2800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/copilot-orchestrator.ts": { max: 2800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase3/eventhouse-editor.tsx": { max: 2800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/databricks-client.ts": { max: 2700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/deployment/deployment-pipelines-pane.tsx": { max: 2600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/foundry-hub-editor.tsx": { max: 2600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase3/eventstream-editor.tsx": { max: 2600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/foundry-client.ts": { max: 2600, reason: "pre-existing large module — ratchet-frozen; +WS-2.2 AI Search deleteDocuments + semantic-rerank config for Delta-synced vector search" },
  "apps/fiab-console/lib/editors/phase3/kql-database-editor.tsx": { max: 2500, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/unified-sql-database-editor.tsx": { max: 2400, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/mcp/catalog.ts": { max: 2400, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/powerplatform-editors.tsx": { max: 2400, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/databricks/sql-warehouse-editor.tsx": { max: 2200, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/kusto-client.ts": { max: 2200, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase3/kql-dashboard-editor.tsx": { max: 2200, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/monitor/monitor-pane.tsx": { max: 2100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/report/analytics-pane.tsx": { max: 2100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/report-model-resolver.ts": { max: 2100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/phase4/data-agent-editor.tsx": { max: 2100, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/adf-client.ts": { max: 2000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/copilot-studio-editors.tsx": { max: 2000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/admin/mcp-servers-panel.tsx": { max: 2000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/eventstream/visual-designer.tsx": { max: 2000, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/powerplatform-client.ts": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/synapse-notebook-editor.tsx": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/azure-sql-editors.tsx": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/panes/setup-wizard.tsx": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/monitor-client.ts": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/data-pipeline-editor.tsx": { max: 1900, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/pipeline/activity-catalog.ts": { max: 1800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/report/report-definition-sanitizer.ts": { max: 2200, reason: "pure format-whitelist sanitizer; grew for WS-3.1 Wave-6 persistence (axis/title/legend/effects/data-label cards). Follow-on: extract the card sub-sanitizers to report-format-sanitizer.ts (tracked in docs/fiab/decomposition-plan.md)" },
  "apps/fiab-console/lib/pipeline/dataflow-transform-catalog.ts": { max: 1800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/workshop/workshop-app-builder.tsx": { max: 1800, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/powerbi-client.ts": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/mirror-engine.ts": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/admin-security/purview-panel.tsx": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/azure-services-editors.tsx": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/fabric-client.ts": { max: 1700, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/canvas/canvas-node-kit.tsx": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/apim-client.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/foundry-cs-client.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/components/onelake/shortcut-wizard.tsx": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/sql-objects-client.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/editors/data-api-builder-editor.tsx": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/copilot-studio-client.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/spark-session-pool.ts": { max: 1600, reason: "pre-existing large module — ratchet-frozen" },
  "apps/fiab-console/lib/azure/cosmos-client.ts": { max: 1600, reason: "the single exhaustive Cosmos container registry (one declaration + accessor per container); crossed 1500 with the WS-5.2 a2a-tasks container. Necessarily grows one entry per new container" },
};
// __ALLOWLIST_END__

const WS_E_EDITORS = new Set([
  "apps/fiab-console/lib/editors/lakehouse/lakehouse-editor-shell.tsx",
  "apps/fiab-console/lib/editors/report-designer.tsx",
  "apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx",
  "apps/fiab-console/lib/editors/notebook-editor.tsx",
  "apps/fiab-console/lib/editors/apim-editors.tsx",
]);

function updateBaseline(counts) {
  const large = Object.entries(counts)
    .filter(([, n]) => n > WARN_THRESHOLD)
    .sort((a, b) => b[1] - a[1]);
  const out = {};
  for (const [file, n] of large) {
    const prev = ALLOWLIST[file];
    out[file] = {
      max: ceilTo100(n),
      reason: prev?.reason ?? 'pre-existing large module — ratchet-frozen',
    };
    if (prev?.bundleExempt) out[file].bundleExempt = true;
  }
  console.log(`// ${large.length} files above ${WARN_THRESHOLD} LOC (ratchet ceilings rounded up to next 100)`);
  console.log(JSON.stringify(out, null, 2));
}

function main() {
  const counts = scan();

  if (process.argv.includes('--update-baseline')) {
    updateBaseline(counts);
    process.exit(0);
  }

  const failures = [];
  const large = [];
  for (const [file, n] of Object.entries(counts)) {
    if (n > WARN_THRESHOLD) large.push({ file, n });
    const entry = ALLOWLIST[file];
    if (!entry) {
      if (n > WARN_THRESHOLD) {
        failures.push({ file, n, kind: 'new-monolith', limit: WARN_THRESHOLD });
      }
      if (n > HARD_MAX) {
        failures.push({ file, n, kind: 'hard-backstop', limit: HARD_MAX });
      }
      continue;
    }
    if (n > entry.max) {
      failures.push({ file, n, kind: 'ratchet-regression', limit: entry.max });
    }
    if (n > HARD_MAX && !entry.bundleExempt) {
      failures.push({ file, n, kind: 'hard-backstop', limit: HARD_MAX });
    }
  }

  large.sort((a, b) => b.n - a.n);
  const allowlistedLarge = large.filter((l) => ALLOWLIST[l.file]);
  console.log(`[file-size] scanned git-tracked .ts/.tsx under ${APP_REL}/{${SCOPE_DIRS.join(',')}}`);
  console.log(`[file-size] warn threshold ${WARN_THRESHOLD} LOC, hard backstop ${HARD_MAX} LOC`);
  console.log(`[file-size] ${large.length} large files (all ratchet-frozen in the allowlist):`);
  for (const { file, n } of allowlistedLarge) {
    const tag = WS_E_EDITORS.has(file) ? '  [WS-E priority]' : ALLOWLIST[file].bundleExempt ? '  [generated bundle]' : '';
    console.log(`    ${String(n).padStart(5)}  ${file}${tag}`);
  }

  if (failures.length) {
    console.error('\n[file-size] FAIL — monolith-creep detected:');
    for (const f of failures) {
      if (f.kind === 'new-monolith') {
        console.error(`  - NEW large file ${f.file}: ${f.n} LOC > ${f.limit} warn threshold`);
        console.error('      Fix: split by bounded context (< 1500 LOC) — see docs/fiab/decomposition-plan.md.');
        console.error('      Or, if unavoidable, add a reviewed ALLOWLIST entry with a one-line reason.');
      } else if (f.kind === 'ratchet-regression') {
        console.error(`  - GREW ${f.file}: ${f.n} LOC > ${f.limit} frozen ceiling`);
        console.error('      Fix: reduce below the ceiling, or justify + bump via --update-baseline.');
      } else {
        console.error(`  - BACKSTOP ${f.file}: ${f.n} LOC > ${f.limit} absolute hard cap`);
        console.error('      A non-generated file this large must be decomposed before merge.');
      }
    }
    process.exit(1);
  }

  console.log('[file-size] OK — no new monoliths, no ratchet regressions, no backstop breaches.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
