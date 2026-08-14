#!/usr/bin/env node
/**
 * check-platform-runs-it-not-you.mjs — an in-product string may not tell the
 * operator to hand-run a script the PLATFORM ships.
 *
 * ## The rule
 *
 * `.claude/rules/auto-bind-by-default.md` §5 — "Infra prerequisites are
 * DEPLOYED, not requested" — and its Explicitly-Forbidden list: *"Requiring the
 * operator to hand-run a script/portal step to make a first-class item type
 * work"* and *"a MessageBar whose remediation is an action the PLATFORM could
 * have taken"*. `ux-baseline.md` G2 says the same from the UX side.
 *
 * ## Why a guard, and not just the two fixes
 *
 * Measured on 2026-08-13 (#3374): `apps/fiab-console` carried EIGHT separate
 * strings telling the operator to run `scripts/csa-loom/grant-graph-approles.sh`
 * — while `csa-loom-post-deploy-bootstrap.yml` had been performing exactly that
 * grant inline, with the same five app-role ids, the whole time. The remediation
 * was not merely unnecessary; several copies also instructed a
 * "Tenant Admin issues admin consent" step that DOES NOT EXIST for a managed
 * identity (the app-role assignment IS the grant), so following the instruction
 * cost the operator a trip to Entra to look for a button that was not there.
 *
 * That is a CLASS, not two instances: every new honest-gate string is written by
 * copying a neighbouring one, so the stale instruction propagates. #3437 fixed
 * the same shape in the operator runbook a day earlier. Nothing stopped the
 * ninth copy.
 *
 * ## What this fails on
 *
 *   A. An in-product string imperatively telling the user to run
 *      `scripts/csa-loom/<x>.sh` when a WORKFLOW ALREADY RUNS `<x>.sh`.
 *      The platform demonstrably performs it — the string is stale by proof.
 *
 *   B. An in-product string imperatively telling the user to run a shipped
 *      `scripts/csa-loom/<x>.sh` that NO workflow runs, unless `<x>.sh` is in
 *      {@link ACKNOWLEDGED} with a recorded reason. B is the honest half: the
 *      platform COULD run it and does not, so the exception has to be argued in
 *      writing rather than left silent.
 *
 * Documentation under `docs/` is deliberately OUT of scope: a runbook may
 * legitimately show the command the platform runs. This guard judges what the
 * PRODUCT says to the operator at the moment they are blocked.
 *
 * ## Embedded control
 *
 * A clean tree and a matcher that has drifted off the code produce the same
 * empty result, so six fixtures run BEFORE the repo is judged — three that MUST
 * be flagged and three that MUST NOT. It also refuses to pass when it finds no
 * workflow-invoked scripts or no product files, because in this repo a zero
 * there means the scan broke, not that the repo changed
 * (`guard_with_zero_population_needs_embedded_control`).
 *
 * PHYSICAL-LINES-OK: the corpus is TypeScript/TSX string literals and the match
 * is single-token (a `scripts/csa-loom/<name>.sh` path plus an imperative verb
 * in the same literal). TS has no trailing-backslash line continuation, so no
 * token this guard needs can land on a continuation line.
 *
 * Usage:
 *   node scripts/ci/check-platform-runs-it-not-you.mjs             # CHECK
 *   node scripts/ci/check-platform-runs-it-not-you.mjs --self-test # controls only
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const WORKFLOW_DIR = '.github/workflows';
/** The surfaces that speak to the operator while they are blocked. */
const PRODUCT_ROOTS = ['apps/fiab-console/app', 'apps/fiab-console/lib'];
const PRODUCT_EXT = ['.ts', '.tsx'];

/**
 * Scripts a product string may still name imperatively, with the reason no
 * workflow invokes them. Every entry is a debt with an argument attached — not
 * a way to silence the guard.
 */
export const ACKNOWLEDGED = Object.freeze({
  'openlineage-pool-setup.sh':
    'Re-running MINTS AND ROTATES the per-workspace ingest token (openssl rand, then a containerapp secret set). Wiring it into the bootstrap would rotate that credential on EVERY bootstrap run and break any Spark pool stamped by an earlier run, since the pool carries the old token in its Spark conf. Automating it needs a per-pool, non-rotating credential design first — tracked on #3374.',
});

/** A path to a shipped csa-loom script, captured with its file name. */
const SCRIPT_RE = /scripts\/csa-loom\/([A-Za-z0-9._-]+\.sh)/g;

/**
 * The RATCHET. Sites that already carried this defect when the guard landed
 * (#3374). Keyed `<path>::<script>` — no line number, so an unrelated edit above
 * one does not silently drop it out of the baseline.
 *
 * This list may only ever SHRINK. Two properties keep it from becoming cover:
 *
 *   1. A NEW site not in this list fails the build. The class cannot grow.
 *   2. A baseline entry that NO LONGER triggers ALSO fails the build, telling
 *      you to delete the line. A baseline that can rot is a second copy of the
 *      problem this guard exists to catch — it would eventually list sites that
 *      no longer exist and vouch for sites that had changed underneath it.
 *
 * The eight `grant-graph-approles.sh` sites #3374 filed are deliberately ABSENT:
 * they were fixed in the same change that added this guard, which is what makes
 * the guard's verdict demonstrably sensitive to the code rather than baked in.
 */
export const BASELINE = new Set([
  'apps/fiab-console/app/admin/users/page.tsx::grant-uami-graph-roles.sh',
  'apps/fiab-console/app/api/admin/tenant-settings/groups/route.ts::grant-identity-graph-approles.sh',
  'apps/fiab-console/app/api/catalog/metastores/route.ts::add-loom-uami-to-uc-metastore-admin.sh',
  'apps/fiab-console/app/api/governance/identities/search/route.ts::grant-identity-graph-approles.sh',
  'apps/fiab-console/app/api/help-copilot/reindex/route.ts::stage-copilot-corpus.sh',
  'apps/fiab-console/app/api/items/eventhouse/[id]/ingest/preview/route.ts::grant-adx-storage-rbac.sh',
  'apps/fiab-console/app/api/marketplace/sharing/_lib.ts::grant-databricks-delta-sharing.sh',
  'apps/fiab-console/app/api/setup/deploy/route.ts::post-deploy-bootstrap.sh',
  'apps/fiab-console/app/api/setup/identity/route.ts::bootstrap-msal-app-reg.sh',
  'apps/fiab-console/app/api/setup/wire-existing/route.ts::grant-navigator-rbac.sh',
  'apps/fiab-console/app/api/setup/wire-existing/route.ts::patch-navigator-env.sh',
  'apps/fiab-console/app/apps/page.tsx::seed-catalogs.sh',
  'apps/fiab-console/lib/admin/env-checks/azure-services.ts::grant-powerplatform-sp.sh',
  'apps/fiab-console/lib/admin/health-probes.ts::grant-powerplatform-sp.sh',
  'apps/fiab-console/lib/admin/self-audit.ts::ensure-search-index.sh',
  'apps/fiab-console/lib/admin/self-audit.ts::grant-databricks-delta-sharing.sh',
  'apps/fiab-console/lib/admin/self-audit.ts::grant-purview-datamap-role.sh',
  'apps/fiab-console/lib/apps/content-bundles/catalog-meta.ts::seed-catalogs.sh',
  'apps/fiab-console/lib/azure/domain-groups.ts::grant-identity-graph-approles.sh',
  'apps/fiab-console/lib/azure/graph-drive-client.ts::grant-shortcut-graph-approles.sh',
  'apps/fiab-console/lib/azure/graph-identity-client.ts::grant-identity-graph-approles.sh',
  'apps/fiab-console/lib/azure/topology.ts::bootstrap-dlz-rgs.sh',
  'apps/fiab-console/lib/components/recommended-apps.tsx::seed-catalogs.sh',
  'apps/fiab-console/lib/editors/geo-editors.tsx::install-synapse-h3.sh',
  'apps/fiab-console/lib/gates/registry/azure-services.ts::grant-powerplatform-sp.sh',
  'apps/fiab-console/lib/panes/setup-service-choices.tsx::scan-and-deploy.sh',
]);

/**
 * Does this string tell the READER to run the script, rather than merely
 * mentioning that something runs it?
 *
 * PURE. `text` is the whole source line plus the line before it, which is where
 * the imperative reliably sits in the wrapped template literals this codebase
 * uses. Passive constructions ("is assigned by", "the bootstrap runs") are the
 * COMPLIANT phrasing and must not be flagged.
 */
export function isImperative(text) {
  const t = String(text);
  // Explicit compliant phrasings win — these describe the platform acting.
  if (/\b(?:performs|performed|already (?:runs|grants|performs)|is (?:assigned|granted|performed|run) by|rather than (?:granting|running)|does not|no script to run)\b/i.test(t)) {
    return false;
  }
  return /(?:^|[^a-z])(?:run|runs|running|execute|invoke|bash|sh)\s+(?:\S*\s+)??scripts\/csa-loom\//i.test(t)
    || /\brun\b[^.]{0,60}scripts\/csa-loom\//i.test(t);
}

/** Recursively list files under `dir` with one of `exts`, skipping tests. */
export function listFiles(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
      listFiles(p, exts, out);
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

/** Every csa-loom script named anywhere in a workflow body. */
export function scriptsInvokedByWorkflows(repo = REPO) {
  const dir = resolve(repo, WORKFLOW_DIR);
  const found = new Set();
  if (!existsSync(dir)) return found;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
    const body = readFileSync(join(dir, f), 'utf8');
    for (const m of body.matchAll(SCRIPT_RE)) found.add(m[1]);
  }
  return found;
}

/**
 * PURE. Judge one file's text. `invoked` is the workflow-invoked script set.
 *
 * Returns `{ key, message }` — the key is `<relPath>::<script>` and deliberately
 * carries NO line number, so a baseline entry survives an unrelated edit above
 * it while still naming exactly one site.
 */
export function findProblems(relPath, text, invoked) {
  const problems = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    SCRIPT_RE.lastIndex = 0;
    for (const m of line.matchAll(SCRIPT_RE)) {
      const script = m[1];
      // Look at the previous line too: these strings wrap.
      const context = `${lines[i - 1] ?? ''} ${line}`;
      if (!isImperative(context)) continue;
      const key = `${relPath}::${script}`;
      if (invoked.has(script)) {
        problems.push({
          key,
          message:
            `${relPath}:${i + 1} tells the operator to run scripts/csa-loom/${script}, but a workflow ALREADY runs it. ` +
            'State that the platform performs it (and which job), not that the user should.',
        });
      } else if (!ACKNOWLEDGED[script]) {
        problems.push({
          key,
          message:
            `${relPath}:${i + 1} tells the operator to run scripts/csa-loom/${script}, which NO workflow runs. ` +
            'Either wire it into csa-loom-post-deploy-bootstrap.yml (auto-bind-by-default.md §5), or add it to ' +
            'ACKNOWLEDGED in this guard with the reason the platform genuinely cannot run it.',
        });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Embedded control
// ---------------------------------------------------------------------------

const MUST_FLAG = [
  {
    name: 'imperative + workflow already runs it',
    text: "remediation: 'Run scripts/csa-loom/grant-graph-approles.sh, then admin-consent.'",
    invoked: ['grant-graph-approles.sh'],
    expect: 1,
  },
  {
    name: 'imperative + no workflow runs it and it is not acknowledged',
    text: "hint: 'run scripts/csa-loom/totally-unwired.sh to fix this'",
    invoked: [],
    expect: 1,
  },
  {
    name: 'imperative split across a wrapped literal',
    text: "followUp:\n  'Operator action: run ' +\n  'scripts/csa-loom/grant-graph-approles.sh now.'",
    invoked: ['grant-graph-approles.sh'],
    expect: 1,
  },
];

const MUST_NOT_FLAG = [
  {
    name: 'passive — states the platform performs it',
    text: "detail: 'The roles are assigned by csa-loom-post-deploy-bootstrap (scripts/csa-loom/grant-graph-approles.sh).'",
    invoked: ['grant-graph-approles.sh'],
  },
  {
    name: 'acknowledged script with a recorded reason',
    text: "remediation: 'Run scripts/csa-loom/openlineage-pool-setup.sh to install the listener.'",
    invoked: [],
  },
  {
    name: 'explicitly tells the reader NOT to run it by hand',
    text: "hint: 're-run that job rather than running scripts/csa-loom/grant-graph-approles.sh by hand'",
    invoked: ['grant-graph-approles.sh'],
  },
];

export function runControls() {
  const failures = [];
  for (const c of MUST_FLAG) {
    const got = findProblems('fixture.ts', c.text, new Set(c.invoked));
    if (got.length !== c.expect) {
      failures.push(`control MUST-FLAG "${c.name}": expected ${c.expect} problem(s), got ${got.length}`);
    }
  }
  for (const c of MUST_NOT_FLAG) {
    const got = findProblems('fixture.ts', c.text, new Set(c.invoked));
    if (got.length !== 0) {
      failures.push(`control MUST-NOT-FLAG "${c.name}": expected 0 problems, got ${got.length} — ${got[0]}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------

export function runCheck(repo = REPO) {
  const invoked = scriptsInvokedByWorkflows(repo);
  const files = PRODUCT_ROOTS.flatMap((r) => listFiles(resolve(repo, r), PRODUCT_EXT));
  const fresh = [];
  const seenBaselineKeys = new Set();
  let referenceCount = 0;

  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!text.includes('scripts/csa-loom/')) continue;
    referenceCount += (text.match(SCRIPT_RE) || []).length;
    for (const p of findProblems(relative(repo, f).replace(/\\/g, '/'), text, invoked)) {
      if (BASELINE.has(p.key)) seenBaselineKeys.add(p.key);
      else fresh.push(p);
    }
  }

  // A baseline entry that no longer triggers must be DELETED, not left to rot.
  const stale = [...BASELINE].filter((k) => !seenBaselineKeys.has(k));

  return {
    fresh,
    stale,
    baselineHit: seenBaselineKeys.size,
    invokedCount: invoked.size,
    fileCount: files.length,
    referenceCount,
  };
}

function main() {
  const selfTestOnly = process.argv.includes('--self-test');

  const controlFailures = runControls();
  if (controlFailures.length > 0) {
    console.error('[platform-runs-it] EMBEDDED CONTROL FAILED — reporting nothing about the repo:\n');
    for (const f of controlFailures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`[platform-runs-it] controls ok (${MUST_FLAG.length} must-flag, ${MUST_NOT_FLAG.length} must-not-flag)`);
  if (selfTestOnly) return;

  let result;
  try {
    result = runCheck();
  } catch (err) {
    console.error(`[platform-runs-it] FAILED to run: ${err.message}`);
    process.exit(1);
  }

  // Fail closed on a scan that cannot have looked. In THIS repo both of these
  // are always non-zero; a zero means the scan broke.
  if (result.invokedCount === 0) {
    console.error('[platform-runs-it] no workflow invokes any scripts/csa-loom/*.sh — the workflow scan drifted. Refusing to report.');
    process.exit(1);
  }
  if (result.fileCount === 0) {
    console.error('[platform-runs-it] no product source files were scanned — the corpus paths drifted. Refusing to report.');
    process.exit(1);
  }

  let failed = false;

  if (result.fresh.length > 0) {
    failed = true;
    console.error(`[platform-runs-it] ${result.fresh.length} NEW problem(s):\n`);
    for (const p of result.fresh) console.error(`  ✗ ${p.message}\n`);
  }

  if (result.stale.length > 0) {
    failed = true;
    console.error(
      `[platform-runs-it] ${result.stale.length} BASELINE entr(y|ies) no longer trigger — delete them from BASELINE ` +
        'in this file so the ratchet keeps meaning something:\n',
    );
    for (const k of result.stale) console.error(`  ✗ ${k}\n`);
  }

  if (failed) process.exit(1);

  console.log(
    `[platform-runs-it] ok — ${result.fileCount} product files, ${result.referenceCount} script reference(s), ` +
      `${result.invokedCount} script(s) invoked by workflows, ${result.baselineHit} known site(s) still on the ratchet. ` +
      'No NEW in-product string asks the operator to run one the platform runs.',
  );
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) main();
