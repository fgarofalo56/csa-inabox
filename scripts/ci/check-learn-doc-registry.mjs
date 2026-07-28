#!/usr/bin/env node
/**
 * GUARDRAIL: learn-doc-registry  (merge-blocker) — loom-apex D1
 * ------------------------------------------------------------------------
 * RULE: the Learning Hub's two slug registries in
 *   apps/fiab-console/lib/learn/content.ts
 *     • EDITOR_DOC_SLUGS   — slugs with an authored per-editor guide
 *     • EDITOR_THUMB_SLUGS — the SUBSET whose screenshot is actually captured
 * must stay 1:1 with what is really on disk under docs/fiab/tutorials/.
 *
 * WHY THIS EXISTS: before D1, seven authored guides
 * (ai-enrichment, batch-pool, databricks-pipeline, digital-twin,
 * lakebase-postgres, loom-app, loom-app-runtime) sat on disk fully written
 * while their Learn cards still advertised "Loom guide coming" — the work was
 * done and the users could not reach it. Thirty-seven captured screenshots
 * were likewise unregistered, so those cards rendered a placeholder tile
 * instead of the real capture. Nothing failed loudly; the content just
 * silently did not ship. This guard turns that class of rot into a red build.
 *
 * FAIL conditions:
 *   1. `docs/fiab/tutorials/editor-<slug>.md` exists but <slug> is NOT in
 *      EDITOR_DOC_SLUGS                      → authored content unreachable.
 *   2. <slug> in EDITOR_DOC_SLUGS with no such file
 *                                            → dead nav entry / 404 link.
 *   3. <slug> in EDITOR_THUMB_SLUGS with no
 *      `img/editor-<slug>-1.png`             → broken-image icon in the Hub.
 *   4. `img/editor-<slug>-1.png` exists AND <slug> is a doc slug, but <slug>
 *      is NOT in EDITOR_THUMB_SLUGS          → captured screenshot not shown.
 *   5. EDITOR_THUMB_SLUGS ⊄ EDITOR_DOC_SLUGS → the documented invariant.
 *
 * UNBLOCK: add/remove the slug in the matching set (the failure prints the
 * exact list). An image captured for a slug that has no doc yet is fine and
 * is NOT reported — author the doc and it becomes reportable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONTENT_TS = path.join(REPO_ROOT, 'apps/fiab-console/lib/learn/content.ts');
const TUT_DIR = path.join(REPO_ROOT, 'docs/fiab/tutorials');
const IMG_DIR = path.join(TUT_DIR, 'img');

/** Parse `export const <NAME>: ... = new Set([ 'a', 'b', ... ]);` */
function parseSet(src, name) {
  const re = new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = re.exec(src);
  if (!m) throw new Error(`could not locate ${name} in content.ts`);
  // strip line comments so commented-out slugs are not counted as registered
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  return new Set([...body.matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

function listSlugs(dir, prefix, suffix) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
      .map((f) => f.slice(prefix.length, f.length - suffix.length)),
  );
}

const src = fs.readFileSync(CONTENT_TS, 'utf8');
const docSlugs = parseSet(src, 'EDITOR_DOC_SLUGS');
const thumbSlugs = parseSet(src, 'EDITOR_THUMB_SLUGS');
const diskDocs = listSlugs(TUT_DIR, 'editor-', '.md');
const diskImgs = listSlugs(IMG_DIR, 'editor-', '-1.png');

const sorted = (s) => [...s].sort();
const problems = [];

const unreachable = sorted(new Set([...diskDocs].filter((s) => !docSlugs.has(s))));
if (unreachable.length) {
  problems.push(
    `authored guide on disk but NOT in EDITOR_DOC_SLUGS (users cannot reach it): ${unreachable.join(', ')}`,
  );
}
const deadDocs = sorted(new Set([...docSlugs].filter((s) => !diskDocs.has(s))));
if (deadDocs.length) {
  problems.push(`EDITOR_DOC_SLUGS entry with no docs/fiab/tutorials/editor-<slug>.md: ${deadDocs.join(', ')}`);
}
const brokenThumbs = sorted(new Set([...thumbSlugs].filter((s) => !diskImgs.has(s))));
if (brokenThumbs.length) {
  problems.push(`EDITOR_THUMB_SLUGS entry with no img/editor-<slug>-1.png (broken image): ${brokenThumbs.join(', ')}`);
}
const unshown = sorted(new Set([...diskImgs].filter((s) => docSlugs.has(s) && !thumbSlugs.has(s))));
if (unshown.length) {
  problems.push(`captured screenshot NOT in EDITOR_THUMB_SLUGS (card shows a placeholder): ${unshown.join(', ')}`);
}
const notSubset = sorted(new Set([...thumbSlugs].filter((s) => !docSlugs.has(s))));
if (notSubset.length) {
  problems.push(`EDITOR_THUMB_SLUGS must be a subset of EDITOR_DOC_SLUGS; extra: ${notSubset.join(', ')}`);
}

if (problems.length) {
  console.log('[learn-doc-registry] FAIL — Learning Hub registries drifted from disk:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('\nFix: add/remove the slug in the matching set in apps/fiab-console/lib/learn/content.ts.');
  process.exit(1);
}

console.log(
  `[learn-doc-registry] OK — ${docSlugs.size} doc slugs / ${thumbSlugs.size} thumb slugs match disk ` +
  `(${diskDocs.size} guides, ${diskImgs.size} captures).`,
);
