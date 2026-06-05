#!/usr/bin/env node
/**
 * Publish reviewed Loom tutorial captures into the docs tree.
 *
 * The tutorial-capture UAT (apps/fiab-console/e2e/tutorial-capture.uat.ts) stages
 * step-by-step screenshots + markdown into temp/azure-screenshots/redacted/loom-tutorials/.
 * Per the Azure-imagery privacy workflow, those are NOT auto-published — a human
 * reviews them first. Once approved, this copies the approved slugs into
 * docs/fiab/tutorials/items/<slug>/ (markdown + screenshots) so MkDocs serves them.
 *
 * Usage:
 *   node scripts/csa-loom/publish-tutorials.mjs            # publish ALL staged slugs
 *   node scripts/csa-loom/publish-tutorials.mjs item-lakehouse item-notebook
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const STAGE = path.join(repo, 'temp', 'azure-screenshots', 'redacted', 'loom-tutorials');
const DOCS = path.join(repo, 'docs', 'fiab', 'tutorials', 'items');

if (!fs.existsSync(STAGE)) {
  console.error(`No staged captures at ${STAGE}. Run the tutorial-capture UAT first.`);
  process.exit(1);
}

const wanted = process.argv.slice(2);
const slugs = fs.readdirSync(STAGE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_raw-'))
  .map((d) => d.name)
  .filter((s) => wanted.length === 0 || wanted.includes(s));

if (!slugs.length) { console.error('No matching staged slugs.'); process.exit(1); }
fs.mkdirSync(DOCS, { recursive: true });

let published = 0;
for (const slug of slugs) {
  const src = path.join(STAGE, slug);
  const dst = path.join(DOCS, slug);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  console.log(`published ${slug} → docs/fiab/tutorials/items/${slug}/`);
  published++;
}
console.log(`\nDone — ${published} tutorial(s) published. Review with \`git diff\`, then commit.`);
