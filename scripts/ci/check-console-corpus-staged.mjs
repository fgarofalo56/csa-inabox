#!/usr/bin/env node
/**
 * GUARDRAIL: every workflow that BUILDS the loom-console image must stage the
 * in-product Copilot RAG corpus into the build context first.
 *
 * WHY THIS EXISTS (#2929, 2026-08-04)
 * -----------------------------------
 * The Copilot corpus lives at repo-root `docs/` + `PRPs/`, which are OUTSIDE the
 * `apps/fiab-console` Docker build context. `apps/fiab-console/copilot-corpus/`
 * is tracked in git as EXACTLY ONE FILE — `.gitkeep`. The Dockerfile's
 * `COPY --from=builder /app/copilot-corpus ./copilot-corpus` therefore succeeds
 * whether or not the corpus was staged: with no staging it silently copies an
 * empty directory. Nothing fails. Nothing warns. The image simply ships with no
 * corpus.
 *
 * That is exactly what happened. `scripts/csa-loom/stage-copilot-corpus.sh` was
 * run by ONE workflow (full-app-deploy-commercial.yml) while the routine console
 * builders — build-fiab-images-acr-tasks.yml, build-fiab-images.yml,
 * console-bluegreen-roll.yml, gov-console-roll.yml, gov-build-images.yml — did
 * not. So the live console served a corpus of zero files,
 * `POST /api/help-copilot/reindex` returned
 *   502 {"ok":false,"backend":"none","totalChunks":0,…,
 *        "error":"No corpus chunks discovered — …"}
 * in ~160 ms, and copilot-quality-evals measured a STALE index while reporting
 * per-surface hit-rates as though they were fresh (run 30937670794).
 *
 * This is the guard-ADOPTION-gap shape the repo keeps getting bitten by: the
 * correct step existed in-repo and its siblings never adopted it. Fixing the
 * five workflows without a ratchet just resets the clock until the next
 * console-building workflow is added.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * A workflow is a CONSOLE BUILDER when it contains a real image-build
 * invocation (`az acr build`, `docker build`, or `docker/build-push-action`)
 * AND names the `apps/fiab-console` build context on a line that is not a YAML
 * comment and not an `echo` / `::warning::`-style annotation — the same
 * "a MENTION IS NOT A BUILD" narrowing check-image-producer-coverage.mjs uses,
 * and for the same reason.
 *
 * Every console builder must also invoke `stage-copilot-corpus.sh` on a real
 * (non-comment, non-echo) line.
 *
 * Usage: node scripts/ci/check-console-corpus-staged.mjs [--root <dir>]
 *
 * `--root` exists ONLY so scripts/ci/__tests__/console-corpus-staged.test.mjs
 * can point the real checker at fixture trees and prove it goes red for the
 * right reasons. CI never passes it, and it cannot hollow the check out: the
 * self-check below fails when a run finds ZERO console builders, which is what
 * a bogus root produces.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd();
const WORKFLOW_DIR = '.github/workflows';
const CONSOLE_CTX = 'apps/fiab-console';
const STAGE_SCRIPT = 'stage-copilot-corpus.sh';

/** A workflow that runs one of these actually produces an image. */
const BUILD_INVOCATION = /(az\s+acr\s+build|docker\s+build|docker\/build-push-action)/;

/** Workflow-command markers. A line carrying one of these is OUTPUT, not a build. */
const ANNOTATION = /::(?:warning|notice|error|debug)::/;

/**
 * True when `line` does real work mentioning `needle` — i.e. it is not a YAML
 * comment, not an `echo`, and not a workflow annotation.
 *
 * The `echo` test is `\becho\b` over the WHOLE line, not `^\s*echo`: in a
 * workflow the echo is almost always nested inside a step, as
 * `- run: echo "…"`, so anchoring at the start of the line lets an echoed
 * mention through and scores it as real work. That is the "a mention is not a
 * build" narrowing check-image-producer-coverage.mjs settled on, and the
 * fixture test 'a commented-out / echoed staging line does NOT satisfy the
 * guard' pins it.
 */
function isRealMention(line, needle) {
  if (!line.includes(needle)) return false;
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return false;
  if (ANNOTATION.test(line)) return false;
  if (/\becho\b/.test(line)) return false;
  return true;
}

/** Workflow files under `<root>/.github/workflows`. */
function listWorkflows(root) {
  const dir = join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * @returns {{ builders: string[], missing: string[] }}
 *   builders — workflows that build the console image
 *   missing  — those of them that never stage the corpus
 */
export function scanConsoleCorpusStaging(root = ROOT) {
  const builders = [];
  const missing = [];
  for (const file of listWorkflows(root)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!BUILD_INVOCATION.test(text)) continue;
    const lines = text.split(/\r?\n/);
    const buildsConsole = lines.some((l) => isRealMention(l, CONSOLE_CTX));
    if (!buildsConsole) continue;

    const name = file.split(/[\\/]/).pop();
    builders.push(name);
    const stages = lines.some((l) => isRealMention(l, STAGE_SCRIPT));
    if (!stages) missing.push(name);
  }
  return { builders, missing };
}

function main() {
  const { builders, missing } = scanConsoleCorpusStaging(ROOT);

  // SELF-CHECK: a run that finds no console builders is measuring nothing —
  // a moved workflow dir, a renamed context, or a bad --root. Fail, never pass.
  if (builders.length === 0) {
    console.error(
      '::error::check-console-corpus-staged found ZERO workflows that build the loom-console ' +
        `image under ${join(ROOT, WORKFLOW_DIR)}. This guard cannot be satisfied by finding ` +
        'nothing — the build context string or the workflow directory has moved. Fix the guard.',
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      `::error::${missing.length} workflow(s) build the loom-console image WITHOUT staging the ` +
        `Copilot RAG corpus: ${missing.join(', ')}. docs/ + PRPs/ live outside the ` +
        'apps/fiab-console build context, and apps/fiab-console/copilot-corpus/ is only a tracked ' +
        '.gitkeep — so the Dockerfile COPY silently packages an EMPTY corpus, the console serves a ' +
        'dead loom-docs index, and POST /api/help-copilot/reindex 502s with "No corpus chunks ' +
        'discovered" (#2929). Add a step running `bash scripts/csa-loom/stage-copilot-corpus.sh` ' +
        'BEFORE the build.',
    );
    process.exit(1);
  }

  console.log(
    `check-console-corpus-staged OK — ${builders.length} console-image builder(s) all stage the ` +
      `Copilot corpus: ${builders.join(', ')}`,
  );
}

if (process.argv[1] && process.argv[1].endsWith('check-console-corpus-staged.mjs')) {
  main();
}
