#!/usr/bin/env node
/**
 * Copy the duckdb-wasm engine assets into public/duckdb so the in-browser
 * query tier (N2a) loads them from OUR OWN ORIGIN.
 *
 * duckdb-wasm's `getJsDelivrBundles()` helper points at cdn.jsdelivr.net, which
 * Loom's CSP blocks and an air-gapped IL5 enclave cannot reach at all. Copying
 * the `.wasm` + worker into `public/` (exactly how Monaco is self-hosted by the
 * sibling copy-monaco-assets.mjs) makes the fastest tier in the product also the
 * one that works fully disconnected.
 *
 * Idempotent: skips the copy when every expected file is already present.
 * NON-FATAL when the package isn't installed — the loader degrades to the
 * server tier with an honest message rather than breaking the build.
 *
 * Runs in pnpm prebuild + at the top of pnpm dev.
 */
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(APP_ROOT, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
const DEST = path.join(APP_ROOT, 'public', 'duckdb');

/** The four files `selectBundle` may ask for (mvp + exception-handling builds). */
const ASSETS = [
  'duckdb-mvp.wasm',
  'duckdb-browser-mvp.worker.js',
  'duckdb-eh.wasm',
  'duckdb-browser-eh.worker.js',
];

if (!existsSync(SRC)) {
  console.warn(
    `[copy-duckdb] @duckdb/duckdb-wasm dist not found at ${SRC} — skipping. `
    + 'The in-browser query tier will report itself unavailable and queries will use the server tier.',
  );
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });

let copied = 0;
let skipped = 0;
const missing = [];

for (const asset of ASSETS) {
  const from = path.join(SRC, asset);
  const to = path.join(DEST, asset);
  if (!existsSync(from)) {
    missing.push(asset);
    continue;
  }
  if (existsSync(to) && statSync(to).size === statSync(from).size) {
    skipped += 1;
    continue;
  }
  copyFileSync(from, to);
  copied += 1;
}

if (missing.length) {
  console.warn(`[copy-duckdb] not present in the package (skipped): ${missing.join(', ')}`);
}
console.log(`[copy-duckdb] ${copied} copied, ${skipped} already in sync -> public/duckdb`);
