#!/usr/bin/env node
/**
 * GUARDRAIL: every deploy source a WATCHED workflow actually applies must be in
 * that entry's `paths` in check-deploy-staleness.mjs.
 *
 * WHY THIS EXISTS (#2775, one rung below the watchdog it protects).
 *
 * #2775 found three deploy paths carrying code that had never been applied, and
 * #2776 shipped check-deploy-staleness.mjs to make that visible. The watchdog
 * names each deploy workflow and compares its last successful run against the
 * most recent commit touching that entry's `paths`.
 *
 * The gap: `paths` was hand-written, and for these three entries it listed
 * almost nothing the workflow actually deploys.
 *
 *   gov-uc-purview-wire.yml watched 2 paths. It BUILDS THE IMAGE from
 *   apps/loom-unity (`az acr build --file apps/loom-unity/Dockerfile
 *   apps/loom-unity`) — and apps/loom-unity was NOT among them. So the watchdog
 *   written because a #2643 fix sat undeployed did not watch the directory the
 *   #2643 fix lives in: commit b4dcf1e4 (2026-08-04) changed apps/loom-unity for
 *   #2643 and could not have registered as drift.
 *
 *   csa-loom-post-deploy-bootstrap.yml watched exactly ONE path — its own YAML —
 *   while executing ~28 scripts/csa-loom/*.sh and applying two bicep templates,
 *   including data-plane/iceberg-catalog-aca.bicep, the #2757 Iceberg deploy
 *   that same issue names as never having executed.
 *
 * That is a measurement gap, not a reporting one. Today those entries read STALE
 * for an unrelated reason (their YAML changed), which MASKS it. The moment an
 * operator runs them the entries go green — and every later change to the 30+
 * real deploy sources drifts silently, because nothing compares them. A control
 * that reads green while measuring a fraction of its subject is the exact shape
 * #2775 exists to catch, so this asserts the watchdog measures what it claims.
 *
 * THE RULE, per WATCHED entry: every repo file the workflow EXECUTES or APPLIES
 * in a `run:` step is either
 *   a) covered by that entry's `paths` (exact match, or a `dir/**` prefix), or
 *   b) listed in {@link CI_PLUMBING} with a reason — a named, reasoned loan for
 *      sources that genuinely do not change the deployed estate.
 *
 * DETECTION is deliberately narrow and shares the sibling's discipline: a line
 * that merely NAMES a path (YAML comment, `echo`, `::warning::`) is a mention,
 * not an execution. Being permissive here would re-admit the false positive that
 * let #2816 sit unnoticed — a warning string counted as a deploy path.
 *
 * Usage: node scripts/ci/check-deploy-paths-coverage.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WATCHED } from './check-deploy-staleness.mjs';

const ROOT = process.cwd();
const WORKFLOW_DIR = '.github/workflows';
const STALENESS = 'scripts/ci/check-deploy-staleness.mjs';

/** Repo top-level directories a deploy source can live under. */
const SRC_ROOTS = '(?:apps|scripts|platform|azure-functions|infra)';

/** Workflow-command markers. A line carrying one of these is OUTPUT, not execution. */
const ANNOTATION = /::(?:warning|notice|error|debug)::/;

/**
 * Sources that a watched workflow executes but which do NOT change the deployed
 * estate, so a commit touching them is not deploy drift. Each is a NAMED,
 * REASONED loan — never a blanket mute. Adding one is a claim that editing this
 * file cannot change what runs in Azure; if that stops being true, remove it.
 */
export const CI_PLUMBING = {
  'scripts/csa-loom/acr-firewall-lease.sh': 'Opens/closes the ACR data-plane firewall around a push and releases the lease. It shapes how the RUN behaves, not what the run deploys — the image bytes and the template are identical either way, so a commit here is not estate drift.',
  'scripts/csa-loom/kv-firewall-window.sh': 'Same shape for Key Vault: brackets the bootstrap with an ingress window so the runner can read secrets. It grants the RUNNER temporary access; it deploys nothing and leaves no artifact behind.',
  'scripts/csa-loom/verify-console-runtime.sh': 'A post-deploy ASSERTION over the already-deployed Console. It reads runtime state and fails the job; it changes nothing, so a commit here cannot leave the estate diverged from main.',
  'scripts/csa-loom/gov-verify-evidence.sh': 'The GCC-High/IL5 deploy-verification EVIDENCE harness. It runs pytest/vitest and a read-only endpoint sweep, and with --live adds `redeploy-gov.sh --what-if` — a what-if applies nothing. Its output is a receipt uploaded as an artifact, and deploy-fiab-gcch.yml invokes it with a trailing `|| true`, so it can neither change the estate nor stop the deploy. It is the verify-console-runtime.sh shape exactly: an assertion, not a deploy source. NOTE the boundary this loan does NOT cross — the two image PREFLIGHTS on the same lane (assert-acr-image-tags.sh, preflight-image-tags.sh) CAN refuse the apply, so they are watched in the WATCHED entry and are not plumbing.',
};

/**
 * Is `line` real shell execution of `path` (not a comment / echo / annotation)?
 * Mirrors check-deploy-script-reachability.mjs deliberately: the two guards must
 * agree on what "executes" means, or a script could pass one and fail the other.
 */
export function isExecution(line, path) {
  if (/^\s*#/.test(line)) return false;
  if (!line.includes(path)) return false;
  if (ANNOTATION.test(line)) return false;
  if (/\becho\b/.test(line)) return false;
  const p = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const viaInterpreter = new RegExp(
    `(?:^|[\\s;&|(])(?:bash|sh|source|\\.)\\s+["']?(?:\\$\\{?GITHUB_WORKSPACE\\}?/|\\./)?${p}\\b`,
  );
  const direct = new RegExp(`(?:^|[\\s;&|(])["']?\\./${p}\\b`);
  return viaInterpreter.test(line) || direct.test(line);
}

/** A line is inert if it is a comment or merely prints the path. */
function isInert(line) {
  const t = line.trim();
  return t.startsWith('#') || t.startsWith('*') || t.startsWith('//')
    || ANNOTATION.test(line) || /\becho\b/.test(line);
}

/**
 * Extract every repo path a workflow EXECUTES or APPLIES, with the shape that
 * proved it. PURE over the workflow text so the self-test can drive it.
 *
 * Shapes detected (all must be real execution, never a mention):
 *   script   `bash X.sh` / `./X.sh` / `source X.sh`
 *   bicep    `-f X.bicep` / `--template-file X.bicep`   (az deployment)
 *   image    `az acr build --file X/Dockerfile X`       (file AND build context)
 *   asset    `--definition "@platform/.../x.json"`      (literal dir if templated)
 *   funcpub  `cd <dir> && npm ci … func azure functionapp publish`
 *
 * @param {string} text workflow YAML
 * @returns {Map<string,string>} path → detection shape
 */
export function extractDeploySources(text) {
  const found = new Map();
  const add = (p, how) => {
    if (!p) return;
    const clean = p.replace(/^["'`]+|["'`.,)]+$/g, '');
    if (!new RegExp(`^${SRC_ROOTS}/`).test(clean)) return;
    if (!found.has(clean)) found.set(clean, how);
  };

  // PHYSICAL-LINES-OK: DELIBERATELY so. One rule below matches the trailing
  // build CONTEXT of an `az acr build`, anchored as a line containing only a path
  // (`^\s*(path)\s*$`) — i.e. it exists to read the CONTINUATION LINE ITSELF.
  // Folding would merge it into the command and the anchor would stop matching,
  // so folding here removes a finding rather than adding one (#3420).
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (isInert(line)) continue;

    // shell script execution — reuse the sibling's exact discipline
    for (const m of line.matchAll(new RegExp(`${SRC_ROOTS}/[A-Za-z0-9._/-]+\\.sh`, 'g'))) {
      if (isExecution(line, m[0])) add(m[0], 'script');
    }
    // bicep application: -f / --template-file
    for (const m of line.matchAll(new RegExp(`(?:-f|--template-file)\\s+["']?(${SRC_ROOTS}/[A-Za-z0-9._/-]+\\.bicep)`, 'g'))) {
      add(m[1], 'bicep');
    }
    // image build: --file <dockerfile>, and the build CONTEXT directory
    for (const m of line.matchAll(new RegExp(`--file\\s+["']?(${SRC_ROOTS}/[A-Za-z0-9._/-]+)`, 'g'))) {
      add(m[1], 'image');
    }
    // trailing build context on an `az acr build` continuation line
    const ctx = line.match(new RegExp(`^\\s*(${SRC_ROOTS}/[A-Za-z0-9._/-]+)\\s*$`));
    if (ctx) add(ctx[1], 'image-context');
    // deployed asset: --definition "@path"; if templated (${D}.json) take the dir
    for (const m of line.matchAll(new RegExp(`--definition\\s+["']?@(${SRC_ROOTS}/[A-Za-z0-9._/\\-\${}]+)`, 'g'))) {
      const p = m[1];
      add(p.includes('${') ? p.slice(0, p.indexOf('${')).replace(/\/$/, '') : p, 'asset');
    }
    // function code publish: `cd <dir> && npm …` in a publish chain
    if (/\bnpm (?:ci|run build)\b|\bfunc azure functionapp publish\b/.test(line)) {
      for (const m of line.matchAll(new RegExp(`\\bcd\\s+["']?(${SRC_ROOTS}/[A-Za-z0-9._/-]+)`, 'g'))) {
        add(m[1], 'func-publish');
      }
    }
  }
  return found;
}

/** Does `paths` cover `file`? Exact match, or a `dir/**` (or bare dir) prefix. */
export function isCovered(file, paths) {
  return paths.some((w) => {
    if (w === file) return true;
    const base = w.endsWith('/**') ? w.slice(0, -3) : w.endsWith('/*') ? w.slice(0, -2) : w;
    if (base === w && !w.endsWith('/**') && !w.endsWith('/*')) {
      // a plain directory entry covers everything beneath it
      return file === base || file.startsWith(`${base}/`);
    }
    return file === base || file.startsWith(`${base}/`);
  });
}

/**
 * Classify one watched entry. PURE — the whole decision lives here so the
 * self-test drives every branch with fixtures, no fs and no YAML.
 * @returns {{workflow:string, uncovered:{path:string,how:string}[], plumbing:string[], checked:number}}
 */
export function classifyEntry({ workflow, paths, text, plumbing = CI_PLUMBING }) {
  const sources = extractDeploySources(text);
  const uncovered = [];
  const plumbingHit = [];
  for (const [p, how] of sources) {
    if (isCovered(p, paths)) continue;
    if (Object.prototype.hasOwnProperty.call(plumbing, p)) { plumbingHit.push(p); continue; }
    uncovered.push({ path: p, how });
  }
  uncovered.sort((a, b) => a.path.localeCompare(b.path));
  return { workflow, uncovered, plumbing: plumbingHit.sort(), checked: sources.size };
}

/** Exit decision over classified rows. PURE. Any uncovered source ⇒ exit 1. */
export function decide(rows) {
  const bad = rows.filter((r) => r.uncovered.length > 0);
  return { bad, code: bad.length ? 1 : 0 };
}

function main() {
  if (!existsSync(join(ROOT, STALENESS))) {
    console.error(`[deploy-paths-coverage] FAIL — ${STALENESS} not found. A guard that silently`);
    console.error('  finds nothing to check is the failure mode it exists to prevent.');
    return 1;
  }
  if (!Array.isArray(WATCHED) || WATCHED.length === 0) {
    console.error('[deploy-paths-coverage] FAIL — WATCHED is empty; nothing would be checked.');
    return 1;
  }

  const rows = [];
  for (const entry of WATCHED) {
    const wf = join(ROOT, WORKFLOW_DIR, entry.workflow);
    if (!existsSync(wf)) {
      console.error(`[deploy-paths-coverage] FAIL — WATCHED names ${entry.workflow}, which does not exist.`);
      return 1;
    }
    rows.push(classifyEntry({
      workflow: entry.workflow,
      paths: entry.paths,
      text: readFileSync(wf, 'utf8'),
    }));
  }

  console.log(`[deploy-paths-coverage] ${rows.length} watched deploy path(s):`);
  for (const r of rows) {
    const tail = r.plumbing.length ? `  [${r.plumbing.length} CI-plumbing allowed]` : '';
    // A workflow with NO mechanically-detectable deploy source is reported
    // distinctly, never as a plain "ok". Detection covers execution shapes
    // (bash/bicep/image/asset/publish); a lane that only ASSERTS against a
    // running estate, or reads a repo file as its source of truth, has none —
    // and printing "ok" there would claim a verification this never performed.
    // That is the "UNKNOWN reported as a result" trap, so it gets its own word.
    const verdict = r.uncovered.length ? 'GAP  ' : r.checked === 0 ? 'none ' : 'ok   ';
    console.log(`  ${verdict}  ${r.workflow.padEnd(38)} ${r.checked} deploy source(s)${tail}`);
  }
  if (rows.some((r) => r.checked === 0)) {
    console.log('  none = no mechanically-detectable deploy source; NOT a verification.');
    console.log('        Such an entry\'s `paths` is maintained by hand — see its comment in WATCHED.');
  }

  const { bad, code } = decide(rows);
  if (!bad.length) {
    console.log('[deploy-paths-coverage] OK — every watched workflow declares every source it deploys.');
    return code;
  }

  console.error(`\n[deploy-paths-coverage] FAIL — ${bad.length} watched workflow(s) deploy from sources their entry does not watch.\n`);
  for (const r of bad) {
    console.error(`  ${r.workflow}`);
    for (const u of r.uncovered) console.error(`    ${u.how.padEnd(13)} ${u.path}`);
    console.error('');
  }
  console.error('  check-deploy-staleness.mjs compares each entry\'s last successful run against');
  console.error('  commits touching its `paths`. A deploy source missing from `paths` cannot ever');
  console.error('  register as drift — the entry reads green while that source diverges.');
  console.error('  Fix: add the path to that WATCHED entry, or — if editing it genuinely cannot');
  console.error('  change the deployed estate — add it to CI_PLUMBING here WITH a reason.\n');
  return code;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-deploy-paths-coverage.mjs');
if (invokedDirectly) process.exit(main());
