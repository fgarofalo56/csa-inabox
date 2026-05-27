#!/usr/bin/env node
/**
 * Copy monaco-editor/min/vs into public/monaco/vs so the AMD loader can
 * fetch worker scripts from our own origin. Without this Monaco's loader
 * pulls from cdn.jsdelivr.net which is blocked by our CSP and prevents
 * Monaco from initializing on every code-editor surface.
 *
 * Idempotent: skips copy when the destination already exists and has the
 * same number of top-level entries.
 *
 * Runs in pnpm prebuild + at the top of pnpm dev.
 */
import { existsSync, mkdirSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(APP_ROOT, 'node_modules', 'monaco-editor', 'min', 'vs');
const DEST = path.join(APP_ROOT, 'public', 'monaco', 'vs');

if (!existsSync(SRC)) {
  console.warn(`[copy-monaco] monaco-editor min/vs not found at ${SRC} — skipping.`);
  process.exit(0);
}

// Idempotency check — if dest exists with matching subtree size, skip.
let copy = true;
if (existsSync(DEST)) {
  try {
    const srcEntries = readdirSync(SRC).length;
    const dstEntries = readdirSync(DEST).length;
    if (srcEntries === dstEntries) copy = false;
  } catch { /* fall through and re-copy */ }
}

if (!copy) {
  console.log(`[copy-monaco] public/monaco/vs already in sync — skipping.`);
  process.exit(0);
}

console.log(`[copy-monaco] copying ${SRC} -> ${DEST}`);
if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
mkdirSync(path.dirname(DEST), { recursive: true });
cpSync(SRC, DEST, { recursive: true });

const total = readdirSync(DEST, { recursive: true }).length;
console.log(`[copy-monaco] done — ${total} files in public/monaco/vs`);
