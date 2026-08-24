#!/usr/bin/env node
/**
 * LOOM BRAIN — produce the extracted SecurityGraph artifact.
 *
 * ── WHY THIS EXISTS AS A BUILD STEP ──────────────────────────────────────
 *
 * `apps/fiab-console/lib/brain/security/**` is nine pure detectors over a
 * `SecurityGraph`. Their input is facts about SOURCE — which function reads an
 * admin claim, whether a caller consumed a verdict as a refusal, which access
 * path reaches a publication sink. The deployed console reads Azure Resource
 * Graph; it has no checkout of the repository it was built from. So the
 * extraction cannot run in the container at any time, and must run HERE, once,
 * over the real tree, with the result committed and shipped inside the image.
 *
 * ── MODES ────────────────────────────────────────────────────────────────
 *
 *   node scripts/brain/extract-security-graph.mjs
 *       Regenerate the artifact and write it.
 *
 *   node scripts/brain/extract-security-graph.mjs --check
 *       Regenerate in memory and FAIL (exit 1) if the committed artifact does
 *       not match the tree. This is the drift gate: a stale artifact must not
 *       survive a merge, because at runtime the console cannot recompute the
 *       inputs digest and can only fall back to an age check.
 *
 * ── NO RESULT IS DISCARDED ───────────────────────────────────────────────
 *
 * There is no `|| true`, no `2>/dev/null` and no `continue-on-error` anywhere in
 * this script or in the workflow step that runs it. Every failure path exits
 * non-zero with the reason on stderr. A build step that exits 0 having produced
 * nothing is precisely what `deploy-integrity.md` R1 classes as silently broken.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CONSOLE_DIR = path.join(REPO_ROOT, 'apps', 'fiab-console');
const EXTRACT_DIR = path.join(CONSOLE_DIR, 'lib', 'brain', 'security', 'extract');
const OUT_FILE = path.join(EXTRACT_DIR, '__generated__', 'security-graph.json');

/** Repo-relative, forward slashes — the path format the extractor's ids embed. */
function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

/** Recursively collect files under `dir` matching `predicate`. */
function walk(dir, predicate, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    throw e;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
      walk(full, predicate, out);
      continue;
    }
    const rel = repoRelative(full);
    if (predicate(rel)) out.push(full);
  }
  return out;
}

/**
 * Compile the extractor to CommonJS in a temp dir and return its `build.js`.
 *
 * `tsc` is already a dependency of the console, so this adds no tooling. The
 * compile is to CommonJS deliberately: extensionless relative imports (the style
 * the whole repo uses) do not resolve under plain Node ESM, and adding explicit
 * `.ts` extensions to satisfy a loader would break `tsc -p tsconfig.build.json`
 * for everyone else. Compiling sidesteps both.
 */
function compileExtractor() {
  const outDir = mkdtempSync(path.join(tmpdir(), 'loom-security-extract-'));
  // Invoke tsc's JS entry point with the CURRENT node rather than the `.bin`
  // shim. The shim is a `.CMD` on Windows and `spawnSync` refuses it with
  // EINVAL unless a shell is involved; going straight to the entry point is
  // portable across Windows and Linux and needs no shell at all.
  const tscEntry = path.join(CONSOLE_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [
      tscEntry,
      path.join(EXTRACT_DIR, 'build.ts'),
      '--outDir', outDir,
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'es2022',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict', 'false',
    ],
    { stdio: 'inherit', cwd: CONSOLE_DIR },
  );

  const found = walk(outDir, (rel) => rel.endsWith('build.js'), []);
  const entry = found.find((f) => f.endsWith(`${path.sep}build.js`));
  if (!entry) {
    throw new Error(
      `tsc produced no build.js under ${outDir}. The extractor did not compile, so NO artifact ` +
        'was produced — refusing to continue rather than writing an empty graph.',
    );
  }
  return { entry, outDir };
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    // A shallow/absent git context is a legitimate build environment. `null` is
    // recorded as "unknown", never as a fabricated sha.
    return null;
  }
}

function main() {
  const check = process.argv.includes('--check');

  const routeFiles = walk(
    path.join(CONSOLE_DIR, 'app'),
    (rel) => /\/route\.tsx?$/.test(rel),
  );
  const scriptFiles = walk(
    path.join(REPO_ROOT, 'scripts'),
    (rel) => /\.(?:mjs|cjs|js)$/.test(rel),
  );

  const files = [...routeFiles, ...scriptFiles].map((absolute) => ({
    path: repoRelative(absolute),
    text: readFileSync(absolute, 'utf8'),
  }));

  if (files.length === 0) {
    console.error(
      '[security-extract] scanned ZERO files. That is not a clean result — it means the scan ' +
        'scopes matched nothing. Refusing to write an empty artifact.',
    );
    process.exit(1);
  }

  const guardPath = path.join(REPO_ROOT, 'scripts', 'ci', 'check-route-guards.mjs');
  let routeGuardSource = null;
  try {
    routeGuardSource = readFileSync(guardPath, 'utf8');
  } catch {
    console.error(
      `[security-extract] could not read ${repoRelative(guardPath)}. ALLOWLIST_PREFIXES will be ` +
        'empty, which UNDERSTATES C3. Continuing, and the gap is recorded in the artifact meta.',
    );
  }

  const { entry, outDir } = compileExtractor();
  let artifact;
  try {
    const require_ = createRequire(import.meta.url);
    const mod = require_(entry);
    artifact = mod.buildSecurityGraphArtifact({
      files,
      routeGuardSource,
      commit: currentCommit(),
      now: new Date(),
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  const nodes = artifact.graph.nodes.length;
  const edges = artifact.graph.edges.length;
  if (nodes === 0) {
    console.error(
      `[security-extract] extraction produced ZERO nodes over ${files.length} scanned file(s). ` +
        'A zero-node graph reports zero findings, which is indistinguishable from a clean ' +
        'estate. Refusing to write it.',
    );
    process.exit(1);
  }

  const payload = `${JSON.stringify({ _comment: 'GENERATED — do not edit by hand. Produced by scripts/brain/extract-security-graph.mjs.', artifact }, null, 2)}\n`;

  if (check) {
    const committed = readFileSync(OUT_FILE, 'utf8');
    const a = JSON.parse(committed).artifact;
    if (!a) {
      console.error(
        '[security-extract] DRIFT: the committed artifact is null but the extractor produces ' +
          `${nodes} node(s). Run: node scripts/brain/extract-security-graph.mjs`,
      );
      process.exit(1);
    }

    // Compare the GRAPH AND JOIN, not merely the inputs digest.
    //
    // The digest covers input drift (the tree changed) but is BLIND to extractor
    // drift (the analyzers changed while the tree did not) — and that case is
    // real: fixing the generic-call matcher in sinks.ts moved the node count
    // 905 -> 908 with a byte-identical digest. A check that only compared
    // digests would have called the stale artifact current. `generatedAt` and
    // `commit` are excluded because they legitimately differ on every run.
    const norm = (x) => JSON.stringify({ graph: x.graph, join: x.join });
    if (norm(a) !== norm(artifact)) {
      console.error(
        '[security-extract] DRIFT: the committed artifact does not match what the extractor ' +
          `produces from this tree (committed ${a.graph.nodes.length} nodes / ` +
          `${a.graph.edges.length} edges, current ${nodes} / ${edges}). Either the source ` +
          'changed or the extractor did. Run: node scripts/brain/extract-security-graph.mjs',
      );
      process.exit(1);
    }
    console.log(
      `[security-extract] OK — committed artifact matches the tree (${nodes} nodes, ${edges} edges, ` +
        `digest ${artifact.meta.inputsDigest}).`,
    );
    return;
  }

  writeFileSync(OUT_FILE, payload, 'utf8');

  const painted = artifact.join.painted.length;
  const unjoined = artifact.join.unjoined.length;
  console.log(`[security-extract] files scanned      : ${files.length}`);
  for (const scope of artifact.meta.scanScopes) {
    console.log(`[security-extract]   ${scope.scope}: ${scope.filesMatched} file(s) -> ${scope.nodesEmitted} node(s)`);
  }
  console.log(`[security-extract] nodes / edges       : ${nodes} / ${edges}`);
  console.log(`[security-extract] join painted        : ${painted}`);
  console.log(`[security-extract] join unjoined       : ${unjoined}`);
  console.log(`[security-extract] skipped subjects    : ${artifact.meta.skipped.length}`);
  console.log(`[security-extract] inputs digest       : ${artifact.meta.inputsDigest}`);
  console.log(`[security-extract] wrote ${repoRelative(OUT_FILE)}`);
}

main();
