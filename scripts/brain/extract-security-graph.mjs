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
 *       not match the tree. This is the drift gate, and a REQUIRED context on
 *       `main`: a stale artifact must not survive a merge.
 *
 *       WHAT IT COMPARES. The WHOLE committed artifact, with no exemptions
 *       (#4128 inverted the old `{graph, join}` comparison so a field added
 *       later is covered without being named). Since #4798 the committed
 *       artifact carries nothing that moves when an unrelated file is added —
 *       no file counts, no digest, no clock, no sha — so two PRs that each add
 *       a file under a scanned root no longer conflict on it. Those values are
 *       printed per run, floored on before the comparison, and REFUSED if they
 *       reappear in the committed bytes (`_artifact-drift.mjs#RUN_ONLY_FIELDS`).
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
import {
  censusRefusals,
  driftDifferences,
  gitCensus,
  gitUnreadCensus,
  populationRefusals,
  runOnlyFieldsPresent,
  unreadCensusRefusals,
} from './_artifact-drift.mjs';

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
function walk(dir, predicate, out = [], repoRoot = REPO_ROOT) {
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
      walk(full, predicate, out, repoRoot);
      continue;
    }
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (predicate(rel)) out.push(full);
  }
  return out;
}

/**
 * The repo-relative paths git actually carries under `roots` — TRACKED plus
 * UNTRACKED-BUT-NOT-IGNORED.
 *
 * ── WHY THE WALK ALONE WAS WRONG (#4216) ─────────────────────────────────
 *
 * The scan used to be a bare `readdirSync` recursion that skipped only
 * `node_modules`, `.next` and `.git`, so it read whatever happened to be sitting
 * on the developer's disk. Measured on this tree: `git status --porcelain`
 * reporting ZERO lines while `--check` exited 1, because one `.gitignore`d
 * `.yml` under `scripts/` had moved `meta.skipped[].fileCount` 187 → 188 and
 * added `*.yml` to that scope's extension list. The gate was then unsatisfiable
 * in both directions — regenerating locally BAKED the ignored file into the
 * artifact, which is drift the moment CI (which never sees it) re-derives.
 *
 * `--cached` alone would be wrong in the other direction: a file that has been
 * written but not yet `git add`ed is genuinely part of the change under review
 * and must be scanned, or a new publication surface could be introduced and
 * certified clean in the same commit. `--others --exclude-standard` covers
 * exactly that case and nothing more.
 *
 * Intersecting the result with the filesystem walk (rather than reading git's
 * list directly) keeps one behaviour that matters: a path still in the INDEX but
 * deleted from the worktree is listed by `--cached` and would throw on read.
 *
 * FAILS CLOSED. Without git this cannot establish what is ignored, and guessing
 * would reintroduce the exact defect above — so it exits non-zero naming git's
 * own error rather than falling back to an unfiltered walk (deploy-integrity
 * R6/R7: classify the failure, and say only what was established).
 */
function gitVisibleFiles(roots, cwd = REPO_ROOT) {
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots],
      { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (e) {
    const detail = (e && (e.stderr || e.message)) ? String(e.stderr || e.message).trim() : 'no error text';
    console.error(
      '[security-extract] REFUSING TO SCAN: `git ls-files` failed, so this run cannot establish which ' +
        'files under the scan roots are gitignored. Reading the filesystem directly would let an ignored ' +
        'file into the artifact, which is #4216 — a gate that is then unsatisfiable both locally and in ' +
        `CI. git said: ${detail}`,
    );
    process.exit(1);
  }
  return new Set(raw.split('\0').filter(Boolean));
}

/**
 * The enumeration EVERY scan root goes through: the filesystem walk, intersected
 * with what git carries. Exported (with `gitVisibleFiles`) so the ignore filter
 * can be exercised against a throwaway fixture repository — the #4216 regression
 * is not reachable from this repo's own tree, because this repo has no ignored
 * file under a scan root today, and a filter that is only ever handed inputs it
 * accepts has not been shown to reject anything.
 */
export function scanFiles(repoRoot, root, predicate, visible) {
  return walk(
    path.join(repoRoot, root),
    (rel) => predicate(rel) && visible.has(rel),
    [],
    repoRoot,
  );
}

export { gitVisibleFiles };

// ── THE PUBLICATION SCOPE, WALKED AND DECLARED FROM ONE PLACE ──────────
//
// These roots are passed into `buildSecurityGraphExtraction`, which derives BOTH
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
 * narrowing is reported into `meta.skipped` and its count into the run.
 */
const PUBLICATION_UNMODELED = /\.(?:sh|ps1|psm1|py|yml|yaml)$/;
const ROUTE_ROOT = 'apps/fiab-console/app';

/**
 * EVERY file the extractor reads, and what it saw and could not read.
 *
 * Exported so `scripts/ci/__tests__/security-graph-drift-shape.test.mjs` can
 * count THIS enumeration against an independent `git ls-files` census on a
 * required lane. Until #4798 that census compared the COMMITTED `filesMatched`;
 * the count is no longer committed, so the census now reads the enumeration it
 * was a proxy for.
 */
export function enumerateScan(repoRoot = REPO_ROOT) {
  // EVERY scan root's enumeration is filtered through this (#4216) — the routes
  // walk included, so a gitignored `route.ts` cannot mint a node either.
  const visible = gitVisibleFiles([ROUTE_ROOT, ...PUBLICATION_ROOTS], repoRoot);

  const routeFiles = scanFiles(repoRoot, ROUTE_ROOT, (rel) => /\/route\.tsx?$/.test(rel), visible);

  const scriptFiles = [];
  const unmodeledPublicationSurfaces = [];
  for (const root of PUBLICATION_ROOTS) {
    scriptFiles.push(...scanFiles(repoRoot, root, (rel) => PUBLICATION_INCLUDE.test(rel), visible));

    const unread = scanFiles(repoRoot, root, (rel) => PUBLICATION_UNMODELED.test(rel), visible);
    unmodeledPublicationSurfaces.push({
      root: `${root}/`,
      fileCount: unread.length,
      extensions: [...new Set(unread.map((f) => path.extname(f)))].sort(),
    });
  }
  return { routeFiles, scriptFiles, unmodeledPublicationSurfaces };
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

  const { routeFiles, scriptFiles, unmodeledPublicationSurfaces } = enumerateScan();

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
  let run;
  let serialize;
  try {
    const require_ = createRequire(import.meta.url);
    const mod = require_(entry);
    ({ artifact, run } = mod.buildSecurityGraphExtraction({
      files,
      publicationRoots: PUBLICATION_ROOTS.map((r) => `${r}/`),
      unmodeledPublicationSurfaces,
      routeGuardSource,
      commit: currentCommit(),
      now: new Date(),
    }));
    serialize = mod.serializeArtifact;
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

  // The committed bytes. `serializeArtifact` is the same function the
  // merge-stability spec simulates a three-way merge over, so what that spec
  // measures is what lands here.
  const payload = serialize(artifact);

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

    // ── A RUN-ONLY FIELD IN THE COMMITTED BYTES IS REFUSED, NOT IGNORED ──
    //
    // #4798: these values move with every file added under a scanned root, so
    // committing any of them brings back the conflict between every pair of open
    // PRs. Ignoring them here would let one creep back in by a hand-merge or an
    // older generator and stay; refusing makes the regression red on the PR that
    // introduces it.
    const runOnly = runOnlyFieldsPresent(a);
    if (runOnly.length > 0) {
      console.error(
        '[security-extract] REFUSING: the committed artifact carries run-only field(s) that must not be ' +
          `committed: ${runOnly.join(', ')}. Each one moves whenever any file under a scanned root is ` +
          'added, so every open PR that touches the artifact would conflict with every other (#4798). ' +
          'Run: node scripts/brain/extract-security-graph.mjs',
      );
      process.exit(1);
    }

    // ── THE POPULATION FLOOR, BEFORE ANY COMPARISON ────────────────────
    //
    // Two empty things compare equal. A drift gate that passes because BOTH
    // sides measured nothing is green and blind, so the floor is asserted on
    // each side first and a degenerate population is REFUSED rather than
    // certified. The file counts exist only for the side extracted just now, so
    // that side is floored on its run as well.
    const refusals = [
      ...populationRefusals(a, 'the COMMITTED artifact'),
      ...populationRefusals(artifact, 'the artifact just extracted from this tree', run),
    ];
    if (refusals.length > 0) {
      console.error(
        '[security-extract] REFUSING TO CERTIFY: the comparison would have run over a degenerate ' +
          'population, where "they match" means only that both sides measured nothing.',
      );
      for (const r of refusals) console.error(`  - ${r}`);
      process.exit(1);
    }

    // ── THE BUILDER'S INPUT, RECONCILED AGAINST AN INDEPENDENT CENSUS ──────
    //
    // Both sides of the comparison below come from the files `main()` handed
    // the builder, so a file dropped on the way leaves them agreeing. A file that
    // emits no node does not move the artifact at all. So the counts the builder
    // received are reconciled against a separate `git ls-files` count before any
    // comparison. See `_artifact-drift.mjs#censusRefusals`, and
    // `#unreadCensusRefusals` for the per-root counts of files this extractor
    // cannot lex, which are no longer committed either.
    let census;
    let unreadCensus;
    try {
      census = gitCensus(REPO_ROOT);
      unreadCensus = gitUnreadCensus(REPO_ROOT);
    } catch (e) {
      const detail = (e && (e.stderr || e.message)) ? String(e.stderr || e.message).trim() : 'no error text';
      console.error(
        '[security-extract] REFUSING TO CERTIFY: the independent `git ls-files` census failed, so this run ' +
          `cannot establish that the builder received every file the tree holds. git said: ${detail}`,
      );
      process.exit(1);
    }
    const censusMismatch = [...censusRefusals(run, census), ...unreadCensusRefusals(run, unreadCensus)];
    if (censusMismatch.length > 0) {
      console.error(
        '[security-extract] REFUSING TO CERTIFY: the files the builder received do not reconcile with ' +
          '`git ls-files`, so "the artifact matches the tree" would be a claim about a narrower population ' +
          'than the tree holds.',
      );
      for (const r of censusMismatch) console.error(`  - ${r}`);
      process.exit(1);
    }

    // Compare the WHOLE artifact — not an enumeration of watched fields.
    //
    // The digest was never enough on its own: it is BLIND to extractor drift
    // (the analyzers changed while the tree did not) — fixing the generic-call
    // matcher in sinks.ts moved the node count 905 -> 908 with a byte-identical
    // digest. Until #4128 this compared `{graph, join}`, and naming fields one
    // at a time would leave every future field invisible, so everything is
    // compared. Since #4798 there is also nothing to exempt: the run-volatile
    // fields are not committed at all, and their presence is refused above.
    const CAP = 20;
    const differences = driftDifferences(a, artifact, CAP);
    if (differences.length > 0) {
      // R7. The sentence that stood here read "Either the source changed or the
      // extractor did", and #4216 falsified it: NEITHER had changed — one
      // gitignored file under a scanned root had been read, and `git status`
      // showed a clean tree while this exited 1. An error must assert only what
      // it established, so the cause is now DIAGNOSED from the differences
      // themselves and the residual case says plainly that it cannot tell.
      const graphHeld = a.graph.nodes.length === nodes && a.graph.edges.length === edges;
      const onlySkipped = differences.every((d) => String(d.path).startsWith('meta.skipped'));
      const diagnosis = graphHeld && onlySkipped
        ? 'Every difference is under `meta.skipped` and the node/edge counts are identical, so no modelled '
          + 'construct moved: a ledger entry did. That includes the set of EXTENSIONS this extractor does '
          + 'not lex under a scanned root, which moves when the first file of a new one is added or the '
          + 'last is removed. (Before #4216 a GITIGNORED file could produce exactly this shape; enumeration '
          + 'now comes from `git ls-files`, so a file git does not carry cannot.)'
        : 'This check establishes only that the committed bytes and the bytes produced from this tree '
          + 'differ; it does not establish WHICH of the source, the extractor or the scanned file set moved.';
      console.error(
        '[security-extract] DRIFT: the committed artifact does not match what the extractor ' +
          `produces from this tree (committed ${a.graph.nodes.length} nodes / ` +
          `${a.graph.edges.length} edges, current ${nodes} / ${edges}). ${diagnosis} ` +
          'Run: node scripts/brain/extract-security-graph.mjs',
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
      `[security-extract] OK — committed artifact matches the tree (${nodes} nodes, ${edges} edges; ` +
        `this run scanned ${run.filesScanned} file(s) across ${run.scanScopes.length} declared ` +
        `scan scope(s), reconciled against \`git ls-files\` (${census.map((c) => `${c.label}: ${c.files}`).join('; ')}; ` +
        `unread ${unreadCensus.map((c) => `${c.root}: ${c.files}`).join(', ')}), ` +
        `digest ${run.inputsDigest} — run values, not committed).`,
    );
    return;
  }

  writeFileSync(OUT_FILE, payload, 'utf8');

  const painted = artifact.join.painted.length;
  const unjoined = artifact.join.unjoined.length;
  console.log(`[security-extract] files scanned      : ${run.filesScanned}`);
  for (const scope of run.scanScopes) {
    console.log(`[security-extract]   ${scope.scope}: ${scope.filesMatched} file(s) -> ${scope.nodesEmitted} node(s)`);
  }
  for (const surface of run.unmodeledPublicationSurfaces) {
    console.log(`[security-extract]   ${surface.root}** not lexed: ${surface.fileCount} file(s) (${surface.extensions.join(', ')})`);
  }
  console.log(`[security-extract] nodes / edges       : ${nodes} / ${edges}`);
  console.log(`[security-extract] join painted        : ${painted}`);
  console.log(`[security-extract] join unjoined       : ${unjoined}`);
  console.log(`[security-extract] skipped subjects    : ${artifact.meta.skipped.length}`);
  console.log(`[security-extract] non-spawn sinks     : ${run.nonSpawnSinks}`);
  console.log(`[security-extract] inputs digest       : ${run.inputsDigest}`);
  console.log(`[security-extract] wrote ${repoRelative(OUT_FILE)} (run values above are printed, not committed — #4798)`);
}

// The default is UNCONDITIONAL: every CLI shape — `node <path>`, a relative
// path, a symlink, an npm script — runs the extraction, so there is no
// invocation that can silently exit 0 having produced nothing. The single
// opt-out exists so `gitVisibleFiles`/`scanFiles`/`enumerateScan` can be imported by a test
// without the whole extraction running, and it announces itself on stderr so a
// run that took it cannot be mistaken for a run that extracted.
if (process.env.LOOM_SECURITY_EXTRACT_IMPORT_ONLY === '1') {
  console.error(
    '[security-extract] main() NOT RUN: LOOM_SECURITY_EXTRACT_IMPORT_ONLY=1 — this process imported the ' +
      'module for its enumeration helpers and extracted nothing.',
  );
} else {
  main();
}
