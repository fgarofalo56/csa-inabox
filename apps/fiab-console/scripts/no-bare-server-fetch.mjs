#!/usr/bin/env node
/**
 * no-bare-server-fetch — CI guard that makes the page-load-timeout claim
 * ENFORCEABLE: every server-side HTTP round-trip MUST go through
 * `fetchWithTimeout` (lib/azure/fetch-with-timeout.ts) so a hung Azure-native
 * backend can never pin a BFF worker — and, transitively, a page spinner —
 * forever. A bare global `fetch(` in server code reintroduces exactly the
 * "no-timeout" defect PR #1198 set out to eliminate, so this fails CI.
 *
 * Scope: lib/azure/** and lib/install/** — the Azure-native DEFAULT data-plane
 * clients (ADX, Cost, Monitor, AI Search, Cosmos, ADLS, Purview, Synapse, …)
 * and the provisioners. These are pure server modules (credential-backed REST),
 * so any `fetch(` here runs on the server and must be bounded.
 *
 * Allowed forms (NOT flagged): `fetchWithTimeout(`, method calls (`x.fetch(`),
 * `fetch` inside comments or string literals (e.g. codegen templates), and a
 * file marked `'use client'` (those belong to the CLIENT half — clientFetch).
 *
 * Escape hatch (rare, must be justified): append `// bare-fetch-ok: <reason>`
 * on the same line. Use only when a 30s/120s ceiling is genuinely wrong AND a
 * caller-supplied AbortSignal already bounds the request.
 *
 * Exit 1 on any violation; prints file:line so the fix is obvious.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DIRS = ['lib/azure', 'lib/install'];
const SELF = 'lib/azure/fetch-with-timeout.ts';

function listFiles() {
  // Cross-platform: shell out to git for tracked files, fall back to find.
  try {
    const out = execSync(`git ls-files ${DIRS.join(' ')}`, { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter((f) => /\.tsx?$/.test(f) && !f.includes('__tests__'));
  } catch {
    const out = execSync(`find ${DIRS.join(' ')} -name '*.ts' -o -name '*.tsx'`, { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter((f) => f && !f.includes('__tests__'));
  }
}

// Global `fetch(` not preceded by a word char, dot, or `$` (so `.fetch(`,
// `prefetch(`, `globalThis.fetch(`, and `fetchWithTimeout(` are all excluded).
const RE = /(?<![\w.$])fetch(?=\s*\()/g;

function inCommentOrString(line, idx) {
  const before = line.slice(0, idx);
  if (before.includes('//')) return true;            // line / trailing comment
  if (/^\s*\*/.test(line)) return true;              // block-comment body
  if (/^\s*\/\*/.test(line)) return true;            // block-comment open
  if ((before.match(/[`'"]/g) || []).length % 2 === 1) return true; // inside a string
  return false;
}

const violations = [];
for (const file of listFiles()) {
  if (file.endsWith(SELF)) continue;
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  // 'use client' modules run in the browser — they are the clientFetch domain.
  if (/^\s*(['"])use client\1/m.test(src.slice(0, 120))) continue;

  src.split('\n').forEach((line, i) => {
    if (line.includes('bare-fetch-ok')) return;
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(line))) {
      if (!inCommentOrString(line, m.index)) {
        violations.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    }
  });
}

if (violations.length) {
  console.error(`\n✖ no-bare-server-fetch: ${violations.length} bare server-side fetch( call(s) found.`);
  console.error('  Route each through fetchWithTimeout (lib/azure/fetch-with-timeout) so a hung');
  console.error('  backend cannot pin the request — and the page spinner — forever.\n');
  for (const v of violations) console.error('   ' + v);
  console.error('');
  process.exit(1);
}

console.log('✓ no-bare-server-fetch: every server fetch in lib/azure + lib/install is bounded by fetchWithTimeout.');
