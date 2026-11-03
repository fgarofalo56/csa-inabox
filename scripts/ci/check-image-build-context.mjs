#!/usr/bin/env node
/**
 * GUARDRAIL: an app whose Dockerfile needs the REPO ROOT as build context must
 * not be built with its own directory as the context (#5171).
 *
 * `apps/loom-health-cp/Dockerfile` COPYs `apps/loom-health-cp/...` and
 * `platform/fiab/bicep/modules/health/`. The producers built it with
 * `az acr build ... apps/loom-health-cp` (context = the app dir), where none of
 * those paths exist, so the image build would have failed at the first COPY.
 * check-image-producer-coverage.mjs could not see this: it only asks whether a
 * workflow NAMES `apps/<name>` as a build context, and the broken line did.
 *
 * A Dockerfile is "root-context" when a non-`--from` COPY/ADD source starts with
 * `apps/` or `platform/` (a path that can only resolve from the repo root).
 * For each such app, no workflow line may bind the context to the app dir:
 *   - YAML matrix:  `ctx: ./apps/<name>`   /  JSON `"ctx":"./apps/<name>"`
 *   - shell:        `az acr build ... apps/<name>` as the trailing positional
 *     (the context), as opposed to `--file apps/<name>/Dockerfile .`
 * Comments are ignored. Usage: node scripts/ci/check-image-build-context.mjs [--root <dir>]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicalLines } from './_logical-lines.mjs';

const ROOT_SRC = /^\s*(?:COPY|ADD)\s+(?!--from=)(?:--\S+\s+)*(?:apps|platform)\//im;

export function rootContextApps(root) {
  const appsDir = join(root, 'apps');
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir).filter((d) => {
    const f = join(appsDir, d, 'Dockerfile');
    return existsSync(f) && readFileSync(f, 'utf8').split(/\r?\n/).some((l) => ROOT_SRC.test(l));
  }).sort();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Findings: [{wf, line, app}] for lines that bind the context to the app dir. */
export function findViolations(root, apps) {
  const dir = join(root, '.github', 'workflows');
  const out = [];
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  for (const wf of files) {
    const lines = readLogicalLines(readFileSync(join(dir, wf), 'utf8'));
    lines.forEach(({ line, text: raw }) => {
      if (/^\s*#/.test(raw)) return;
      for (const app of apps) {
        const a = esc(app);
        const matrixCtx = new RegExp(`(?:^\\s*ctx:\\s*|"ctx"\\s*:\\s*")["']?\\.?/?apps/${a}/?["']?\\s*(?:$|")`);
        const trailingCtx = new RegExp(`az\\s+acr\\s+build\\b.*\\s["']?\\.?/?apps/${a}/?["']?\\s*$`);
        if (matrixCtx.test(raw) || trailingCtx.test(raw) || new RegExp(`"name"\\s*:\\s*"${a}"[^}]*"ctx"\\s*:\\s*"\\.?/?apps/${a}"`).test(raw)) {
          out.push({ wf, line, app });
        }
      }
    });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? resolve(process.argv[i + 1]) : resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const apps = rootContextApps(root);
  if (apps.length === 0) {
    console.error('[image-build-context] FAIL: no root-context Dockerfile found (expected at least apps/loom-health-cp). Wrong root, or the tree moved; refusing to report a pass over nothing.');
    process.exit(2);
  }
  const bad = findViolations(root, apps);
  for (const a of apps) console.log(`${bad.some((b) => b.app === a) ? 'BAD' : 'ok '}  ${a}`);
  if (bad.length) {
    for (const b of bad) console.error(`::error file=.github/workflows/${b.wf},line=${b.line}::${b.app} needs the repo root as build context (its Dockerfile COPYs apps/ and platform/ paths) but this line builds with the app dir as context.`);
    process.exit(1);
  }
  console.log(`[image-build-context] ok: ${apps.length} root-context app(s), no producer binds the app dir as context.`);
}
