#!/usr/bin/env node
/**
 * Stage the E1 golden eval sets (repo content/evals/*.jsonl) into ./evals so
 * the deployed Function package carries them (resolveEvalRoot checks ./evals
 * first). Run before `func start` (prestart) and before
 * `func azure functionapp publish` in the bootstrap workflow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const src = path.resolve(pkgRoot, '..', '..', 'content', 'evals');
const dest = path.join(pkgRoot, 'evals');

if (!fs.existsSync(src)) {
  console.error(`[stage-evals] source not found: ${src} (run from a repo checkout)`);
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.jsonl')) continue;
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  n++;
}
console.log(`[stage-evals] staged ${n} eval sets → ${dest}`);
