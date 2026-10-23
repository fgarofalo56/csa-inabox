#!/usr/bin/env node
/**
 * plan-image-builds.mjs - decide WHICH images a push to main must rebuild.
 *
 * WHY. build-fiab-images-acr-tasks.yml rebuilt all 13 images on every push to
 * main (~45-60 min). Rapid merges then queued behind each other, pending runs
 * were replaced, and the roll for the replaced commit was stranded. Most pushes
 * touch exactly one app.
 *
 * THE INVARIANT THIS PLAN PRESERVES. After a push run succeeds, EVERY image in
 * the matrix has a `<name>:<sha>` tag whose content equals the tree at <sha>:
 * built apps by `az acr build`, unchanged apps by the carry_forward job
 * (re-tagging the digest already behind `<name>:<TAG>`). The rolls
 * (loom-roll-and-validate, loom-dataplane-roll) address `<name>:<head_sha>`, so
 * that tag must exist for every app, built or not.
 *
 * WHY THE DIFF BASE IS "THE LAST SUCCESSFUL PUSH RUN", NOT github.event.before.
 * `before` is the previous tip, but the build for the previous tip may have been
 * cancelled (superseded in the pending queue) or may have failed for one app.
 * Diffing against `before` would then drop that commit's app change on the floor
 * - merged, never built. The last run that CONCLUDED success is the newest point
 * at which, by the invariant above, every image matched the tree.
 *
 * FAIL CLOSED. Anything this script cannot establish -> mode "all" with a reason
 * naming it: no/zero/unknown base, base not an ancestor (force push), git error,
 * unparseable matrix, a change to a shared build input. "all" is today's
 * behaviour, so a wrong guess costs time, never a missing image.
 *
 * CLI:
 *   node plan-image-builds.mjs --matrix '<json array of {name,ctx}>' --sha <40hex> [--base <40hex>]
 * stdout: ONE line of JSON {mode, reason, build[], carry[], ignored[]}.
 * stderr: human log. Exit 0 with a plan (possibly "all"); exit 1 only when the
 * matrix itself is unusable (nothing could be built from it either way).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA_RE = /^0{40}$/;

/**
 * Paths whose change can alter ANY image: a shared build input. Prefix match.
 * Each one is here for a reason; keep the list short and explain additions.
 */
export const SHARED_PREFIXES = [
  '.github/workflows/build-fiab-images-acr-tasks.yml', // the producer itself
  'scripts/ci/acr-', // pool / run / login / dataplane helpers the build step calls
  'scripts/ci/plan-image-builds', // this planner and its test
  'scripts/ci/deploy-retry', // wraps every build submit
  'scripts/ci/cosign-', // sign step: a change must be proven on a real image
  'scripts/ci/_azure-redact', // log redaction used by the failure diagnosis
  'scripts/csa-loom/acr-firewall-lease', // the lease every build holds
  'scripts/csa-loom/stage-copilot-corpus', // stages the console corpus
  'packages/', // distributable packages shared across apps
];

/** Repo-root build config (a file directly at the root, not a doc). */
const ROOT_CONFIG_RE =
  /^(package(-lock)?\.json|pnpm-(lock|workspace)\.yaml|yarn\.lock|pyproject\.toml|uv\.lock|requirements[^/]*\.txt|Makefile|\.dockerignore|\.trivyignore|\.npmrc|\.nvmrc|\.tool-versions|tsconfig[^/]*\.json)$/;

/** Built on every push; see planBuild. */
export const CONSOLE = 'loom-console';

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const ctxDir = (ctx) => norm(ctx).replace(/\/+$/, '');

/** A plan that builds everything. `reason` is always user-visible in the log. */
function all(names, reason) {
  return { mode: 'all', reason, build: [...names], carry: [], ignored: [] };
}

/**
 * Pure planning step.
 * @param {{changedFiles: string[]|null, matrix: {name:string,ctx:string}[], unknown?: string}} i
 *   changedFiles === null means "the diff could not be computed" (reason in unknown).
 */
export function planBuild({ changedFiles, matrix, unknown }) {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new Error('plan-image-builds: matrix is empty or not an array');
  }
  const names = matrix.map((a) => a.name);
  if (changedFiles === null || changedFiles === undefined) {
    return all(names, `cannot compute the changed set (${unknown || 'unspecified'}) - building ALL`);
  }
  if (changedFiles.length === 0) {
    // An empty diff on a push run is not evidence of "nothing to build": it is
    // what a mis-resolved base looks like. Build everything rather than nothing.
    return all(names, 'diff between base and sha is EMPTY - not trusting an empty diff, building ALL');
  }
  const ctxs = matrix.map((a) => ({ name: a.name, dir: ctxDir(a.ctx) }));
  const hit = new Set();
  const ignored = [];
  for (const raw of changedFiles) {
    const f = norm(raw);
    if (!f) continue;
    const shared = SHARED_PREFIXES.find((p) => f === p || f.startsWith(p));
    if (shared) return all(names, `shared build input changed: ${f} (matches '${shared}') - building ALL`);
    if (!f.includes('/') && ROOT_CONFIG_RE.test(f)) {
      return all(names, `root build config changed: ${f} - building ALL`);
    }
    const owner = ctxs.find((c) => f.startsWith(`${c.dir}/`));
    if (owner) {
      hit.add(owner.name);
      continue;
    }
    ignored.push(f);
  }
  // ALWAYS BUILD THE CONSOLE (reviewer B1 on #5070). loom-roll-and-validate
  // rolls the console per run and a superseded PENDING roll is dropped
  // (cancel-in-progress false: newest pending wins). The old invariant that
  // makes that safe is "the newest run builds the console, so it carries every
  // earlier merge". A carried console would break it: push N+1 changes the
  // console, push N+2 changes only loom-unity, N+2's roll replaces N+1's
  // pending roll and the console change is never rolled. This also covers the
  // corpus the console embeds (docs/, PRPs/*, via stage-copilot-corpus.sh):
  // those paths map to no context, and the console is built regardless.
  hit.add(CONSOLE);
  const build = names.filter((n) => hit.has(n));
  const carry = names.filter((n) => !hit.has(n));
  return {
    mode: 'subset',
    reason: `changed contexts + ${CONSOLE} (always built) -> build ${build.join(',')}; carry ${carry.length} unchanged`,
    build,
    carry,
    ignored,
  };
}

/** git wrapper; throws with git's own stderr in the message. */
function git(args, run = execFileSync) {
  return run('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Resolve the changed-file list base..sha, or {files:null, unknown:<why>}.
 * `run` is injectable so tests drive the failure branches without a repo.
 */
export function readChangedFiles({ base, sha, run = execFileSync }) {
  if (!SHA_RE.test(sha || '')) return { files: null, unknown: `sha '${sha}' is not 40 hex` };
  if (!base || !String(base).trim()) {
    return { files: null, unknown: 'no base (no prior successful push run found - first run or API unreadable)' };
  }
  if (ZERO_SHA_RE.test(base)) return { files: null, unknown: 'base is the all-zero SHA (first push)' };
  if (!SHA_RE.test(base)) return { files: null, unknown: `base '${base}' is not 40 hex` };
  try {
    git(['cat-file', '-e', `${base}^{commit}`], run);
  } catch (e) {
    return { files: null, unknown: `base ${base} is not in this checkout (force push or shallow clone): ${String(e.message).split('\n')[0]}` };
  }
  try {
    git(['merge-base', '--is-ancestor', base, sha], run);
  } catch {
    return { files: null, unknown: `base ${base} is not an ancestor of ${sha} (history rewritten)` };
  }
  try {
    // -z + quotepath=false: without them git C-quotes names with a double quote
    // or non-ASCII bytes (`"apps/x/we\"ird \303\251"`), the leading quote makes
    // the path match no context, and a real app change is silently ignored.
    const out = git(['-c', 'core.quotepath=false', 'diff', '-z', '--name-only', '--no-renames', `${base}..${sha}`], run);
    return { files: out.split('\0').filter(Boolean) };
  } catch (e) {
    return { files: null, unknown: `git diff failed: ${String(e.message).split('\n')[0]}` };
  }
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv) {
  let matrix;
  try {
    matrix = JSON.parse(arg(argv, '--matrix') ?? '');
  } catch (e) {
    console.error(`::error::plan-image-builds: --matrix is not JSON: ${e.message}`);
    return 1;
  }
  let plan;
  try {
    const { files, unknown } = readChangedFiles({ base: arg(argv, '--base'), sha: arg(argv, '--sha') });
    plan = planBuild({ changedFiles: files, matrix, unknown });
  } catch (e) {
    if (!Array.isArray(matrix) || matrix.length === 0) {
      console.error(`::error::plan-image-builds: ${e.message}`);
      return 1;
    }
    plan = all(matrix.map((a) => a.name), `planner threw (${e.message}) - building ALL`);
  }
  console.error(`::notice::image build plan: mode=${plan.mode}; ${plan.reason}`);
  if (plan.mode === 'subset') {
    console.error(`::notice::build=[${plan.build.join(',')}] carry=[${plan.carry.join(',')}] ignored=${plan.ignored.length} path(s)`);
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
