#!/usr/bin/env node
/**
 * check-build-trigger-covers-matrix.mjs
 *
 * RULE. Every build context in build-fiab-images-acr-tasks.yml's default ("all")
 * matrix must be covered by the workflow's `push:` path filter.
 *
 * WHY. That workflow is the push-triggered producer for the app images. If a
 * context it BUILDS is not in the paths that TRIGGER it, a change to that app
 * merges green and never reaches any registry — merged-is-not-deployed with no
 * signal at all, because nothing failed.
 *
 * Measured 2026-08-11: the "all" matrix builds twelve contexts, and
 * `./apps/copilot-maf` — the MAF Copilot tier — is matched by none of
 *
 *     apps/fiab-*, apps/loom-unity, apps/loom-trino,
 *     apps/loom-migrate, apps/loom-risingwave
 *
 * The other eleven are covered: seven by the `apps/fiab-*` glob and four
 * explicitly. So exactly one app in the default build set could never be built
 * by a push, and nothing anywhere said so.
 *
 * This repo has been bitten by path filters twice already (#2775, #2939 — "a
 * path filter is how the sibling gates in this repo went quiet"). The difference
 * here is that both sets are machine-readable, so the drift is checkable rather
 * than reviewable.
 *
 * NOT IN SCOPE. Images outside the "all" set — loom-duckdb, loom-transform-runner,
 * loom-uat — are deliberately dispatch-only, with full-app-deploy-commercial.yml
 * as their documented producer. This rule judges the DEFAULT push matrix against
 * the PUSH trigger; it does not argue with that design.
 *
 * SELF-DEFENCE. Fails if the matrix or the path list cannot be read, or comes
 * back empty — a rule that checks nothing must not report a pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF = join(ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');

let text;
try {
  text = readFileSync(WF, 'utf8');
} catch (e) {
  console.error(`::error::build-trigger-covers-matrix: cannot read ${WF}: ${e.message}`);
  process.exit(1);
}

// ── the "all" matrix, read out of the shipped shell rather than re-declared ──
const allLine = /APPS='(\[[^']*\])'/.exec(text);
if (!allLine) {
  console.error(
    "::error::build-trigger-covers-matrix: could not find the default APPS='[...]' matrix in " +
      'build-fiab-images-acr-tasks.yml. The resolver was rewritten and this rule can no longer read what it ' +
      'judges — refusing to report a pass.',
  );
  process.exit(1);
}

let apps;
try {
  apps = JSON.parse(allLine[1]);
} catch (e) {
  console.error(`::error::build-trigger-covers-matrix: the default APPS matrix is not parseable JSON: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(apps) || apps.length === 0) {
  console.error('::error::build-trigger-covers-matrix: the default APPS matrix is empty. A push would build nothing.');
  process.exit(1);
}

// ── the push path filter ─────────────────────────────────────────────────────
// Scanned by INDENTATION, not by one regex: the `push:` block sits after a long
// `workflow_dispatch:` and its `paths:` list is interleaved with comments, so a
// lazy match stops at the first comment and reports "no path filter" — which
// this rule would then have to treat as a failure, on a healthy workflow.
// PHYSICAL-LINES-OK: parses the `on: push: paths:` YAML LIST by indentation.
// YAML sequence items are not spliced by a trailing backslash (#3420).
const wfLines = text.split(/\r?\n/);
const paths = [];
const pushIdx = wfLines.findIndex((l) => /^\s{2}push:\s*$/.test(l));
if (pushIdx !== -1) {
  const pathsIdx = wfLines.findIndex((l, i) => i > pushIdx && /^\s{4}paths:\s*$/.test(l));
  if (pathsIdx !== -1) {
    for (let i = pathsIdx + 1; i < wfLines.length; i++) {
      const raw = wfLines[i];
      if (/^\s*#/.test(raw)) continue; // comments interleave the list
      const m = /^\s{6,}-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(raw);
      if (m) {
        paths.push(m[1]);
        continue;
      }
      if (raw.trim() === '') continue;
      break; // dedented -> end of the list
    }
  }
}

if (paths.length === 0) {
  console.error(
    '::error::build-trigger-covers-matrix: found NO push path filter. Either the trigger was removed (in which ' +
      'case nothing builds on merge) or this rule can no longer read it. Refusing to report a pass.',
  );
  process.exit(1);
}

/** Does a `paths:` glob cover this build context directory? */
function covered(ctx) {
  const dir = ctx.replace(/^\.\//, '').replace(/\/$/, ''); // ./apps/foo -> apps/foo
  return paths.some((p) => {
    const re = new RegExp(
      '^' +
        p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, ' ')
          .replace(/\*/g, '[^/]*')
          .replace(/ /g, '.*') +
        '$',
    );
    // `apps/fiab-*/**` covers the DIRECTORY apps/fiab-console because any file
    // under it matches; test a representative file path as well as the dir.
    return re.test(dir) || re.test(`${dir}/Dockerfile`);
  });
}

const missing = apps.filter((a) => !covered(a.ctx));

if (missing.length > 0) {
  console.error(
    `::error::build-trigger-covers-matrix: ${missing.length} context(s) in the DEFAULT build matrix are not ` +
      'matched by the push path filter. A change to them merges green and never builds — no failure, no signal, ' +
      'and the image on the estate stays whatever was last pushed.',
  );
  for (const m of missing) {
    const want = `${m.ctx.replace(/^\.\//, '')}/**`;
    console.error(
      `::error file=.github/workflows/build-fiab-images-acr-tasks.yml::${m.name} builds from ${m.ctx}, which no push path matches. Add "${want}".`,
    );
  }
  console.error(`   push paths currently: ${paths.join(', ')}`);
  process.exit(1);
}

console.log(
  `build-trigger-covers-matrix OK — ${apps.length} default build context(s), all matched by ${paths.length} push path(s).`,
);
