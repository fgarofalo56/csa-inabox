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
 *       WHAT IT COMPARES CHANGED ON #4128. It used to compare `{graph, join}`
 *       and nothing else, so a change that moved the POPULATION without moving
 *       the GRAPH — a new `.mjs` inside the publication scope that carries no
 *       publication construct, i.e. zero nodes — passed it while the REQUIRED
 *       census in `no-estate-identifiers.test.ts` went red. It now compares the
 *       WHOLE artifact except the run-volatile fields named in
 *       `_artifact-drift.mjs`, so `meta.scanScopes[].filesMatched`,
 *       `meta.filesScanned`, `meta.skipped` and `meta.generatorVersion` are all
 *       covered, along with any field a later extractor version adds.
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
import { driftDifferences, populationRefusals } from './_artifact-drift.mjs';

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

  // ── THE PUBLICATION SCOPE, WALKED AND DECLARED FROM ONE PLACE ──────────
  //
  // These roots are passed into `buildSecurityGraphArtifact`, which derives BOTH
  // the file partition and the scope string the artifact reports from them. They
  // used to be a hand-written literal here and a second hand-written literal in
  // build.ts, and the two disagreed: the artifact declared `scripts/**,
  // .github/**` while this walk covered `scripts/` alone. Measured on the
  // committed bytes — 0 `.github` nodes, 0 `skipped` entries naming it — and
  // `.github/scripts/deploy-notify-failure.mjs`, a FAILURE NOTIFIER whose whole
  // job is publishing to a public issue and a public run log, sat outside a
  // population the artifact claimed to cover.
  const PUBLICATION_ROOTS = ['scripts', '.github'];
  /** What this extractor can lex. */
  const PUBLICATION_INCLUDE = /\.(?:mjs|cjs|js)$/;
  /**
   * Publication-capable languages under the SAME roots that this extractor
   * cannot lex. Counted rather than ignored: a workflow `run:` block and a `.sh`
   * step echo into the same PUBLIC Actions log a `console.log` does, so the
   * narrowing is reported into `meta.skipped` with a real number.
   */
  const PUBLICATION_UNMODELED = /\.(?:sh|ps1|psm1|py|yml|yaml)$/;

  const scriptFiles = [];
  const unmodeledPublicationSurfaces = [];
  for (const root of PUBLICATION_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    scriptFiles.push(...walk(absRoot, (rel) => PUBLICATION_INCLUDE.test(rel)));

    const unread = walk(absRoot, (rel) => PUBLICATION_UNMODELED.test(rel));
    unmodeledPublicationSurfaces.push({
      root: `${root}/`,
      fileCount: unread.length,
      extensions: [...new Set(unread.map((f) => path.extname(f)))].sort(),
    });
  }

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
      publicationRoots: PUBLICATION_ROOTS.map((r) => `${r}/`),
      unmodeledPublicationSurfaces,
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

    // ── THE POPULATION FLOOR, BEFORE ANY COMPARISON ────────────────────
    //
    // Two empty things compare equal. A drift gate that passes because BOTH
    // sides measured nothing is green and blind, so the floor is asserted on
    // each side first and a degenerate population is REFUSED rather than
    // certified.
    const refusals = [
      ...populationRefusals(a, 'the COMMITTED artifact'),
      ...populationRefusals(artifact, 'the artifact just extracted from this tree'),
    ];
    if (refusals.length > 0) {
      console.error(
        '[security-extract] REFUSING TO CERTIFY: the comparison would have run over a degenerate ' +
          'population, where "they match" means only that both sides measured nothing.',
      );
      for (const r of refusals) console.error(`  - ${r}`);
      process.exit(1);
    }

    // Compare the WHOLE artifact minus the run-volatile fields — not an
    // enumeration of watched ones.
    //
    // The digest covers input drift (the tree changed) but is BLIND to extractor
    // drift (the analyzers changed while the tree did not) — and that case is
    // real: fixing the generic-call matcher in sinks.ts moved the node count
    // 905 -> 908 with a byte-identical digest. A check that only compared
    // digests would have called the stale artifact current.
    //
    // Until #4128 this compared `{graph, join}`, which had the mirror-image
    // blind spot: a file inside the declared scan scope that emits NO node moved
    // `meta.scanScopes[].filesMatched` and `meta.filesScanned` while the graph
    // held identical, and this gate passed while the REQUIRED census went red.
    // Naming `meta.scanScopes` as a third watched field would have left
    // `filesScanned` — and every future field — invisible, so the comparison is
    // inverted instead: everything is compared, and exemptions are declared with
    // a reason in `_artifact-drift.mjs`.
    const CAP = 20;
    const differences = driftDifferences(a, artifact, CAP);
    if (differences.length > 0) {
      console.error(
        '[security-extract] DRIFT: the committed artifact does not match what the extractor ' +
          `produces from this tree (committed ${a.graph.nodes.length} nodes / ` +
          `${a.graph.edges.length} edges, current ${nodes} / ${edges}). Either the source ` +
          'changed or the extractor did. Run: node scripts/brain/extract-security-graph.mjs',
      );
      console.error(
        `[security-extract] ${differences.length} differing field(s)` +
          (differences.length >= CAP
            ? ` (the walk stopped at its ${CAP}-field cap, so there may be more)`
            : '') +
          ', committed -> current:',
      );
      for (const d of differences) {
        console.error(`  - ${d.path === '' ? '<root>' : d.path}: ${d.committed} -> ${d.current}`);
      }
      process.exit(1);
    }
    console.log(
      `[security-extract] OK — committed artifact matches the tree (${nodes} nodes, ${edges} edges, ` +
        `${artifact.meta.filesScanned} file(s) across ${artifact.meta.scanScopes.length} declared ` +
        `scan scope(s), digest ${artifact.meta.inputsDigest}).`,
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
