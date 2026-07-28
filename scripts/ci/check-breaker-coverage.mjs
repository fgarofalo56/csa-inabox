#!/usr/bin/env node
/**
 * GUARDRAIL: breaker-coverage  (merge-blocker, RATCHETING — loom-next-level CH1)
 * ---------------------------------------------------------------------------
 * RULE (CH1 resilience floor): every Azure client under `lib/azure/**` makes
 *   its network round-trips through the BOUNDED transport wrapper
 *   `fetchWithTimeout()` (or `withDeadline()`), never a raw unbounded
 *   `fetch(...)`. An unbounded fetch can pin a worker forever when a backend
 *   hangs — the exact failure the CH1 chaos harness injects
 *   (`aoai-timeout`) and the resilience matrix (`docs/fiab/resilience-matrix.md`)
 *   documents every client is protected against. This guard keeps that floor:
 *   no NEW raw `fetch(` may enter a `lib/azure` client.
 *
 * DETECTION — after stripping comments + string literals (so a `fetch(` inside
 *   a doc comment or a URL string is NOT a false positive), a file is a
 *   violation for each remaining bare `fetch(` call that is NOT
 *   `fetchWithTimeout(` and not a method call (`.fetch(`). The transport
 *   definition file (`fetch-with-timeout.ts`) is exempt — it OWNS the one real
 *   `fetch(`.
 *
 * RATCHET SEMANTICS (shared _ratchet-count mechanic):
 *   - current = map of repo-relative client path → count of raw fetch(.
 *   - CHECK fails when any file's count RISES above its baseline (a net-new
 *     unbounded fetch). The baseline only shrinks.
 *   - `--update-baseline` regenerates the file (run in the blocked PR with a
 *     one-line justification; a GROW regen prints a loud warning).
 *
 * The resilience matrix inventory itself lives in
 *   apps/fiab-console/lib/resilience/breaker-audit.ts (the human artifact); this
 *   guard is the machine-enforced timeout-coverage floor beneath it.
 *
 * Built on the SHARED ratchet mechanic scripts/ci/_ratchet-count.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRatchet, gitTouchedFiles } from './_ratchet-count.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AZURE_DIR = path.join(REPO_ROOT, 'apps', 'fiab-console', 'lib', 'azure');
const BASELINE_FILE = path.join(__dirname, 'breaker-coverage-baseline.json');

const META = {
  owner: 'loom-next-level CH1 — platform/resilience',
  why: 'Every lib/azure client must make network calls through the bounded transport (fetchWithTimeout / withDeadline), never a raw unbounded fetch() that can pin a worker on a hung backend. Baseline = the grandfathered raw fetches; it only shrinks.',
  unblock:
    'Route the call through fetchWithTimeout()/withDeadline(), then: node scripts/ci/check-breaker-coverage.mjs --update-baseline (run in the blocked PR with a one-line justification).',
};

/** The transport definition file OWNS the one real fetch() — exempt. */
const EXEMPT_BASENAMES = new Set(['fetch-with-timeout.ts']);

/** Strip block comments, line comments, and string/template literals so a
 *  `fetch(` inside a comment or a URL string is not counted. Coarse but safe
 *  for counting call sites (it only over-removes, never over-counts). */
function stripCommentsAndStrings(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments (avoid ://)
  out = out.replace(/'(?:\\.|[^'\\])*'/g, "''"); // single-quoted strings
  out = out.replace(/"(?:\\.|[^"\\])*"/g, '""'); // double-quoted strings
  out = out.replace(/`(?:\\.|[^`\\])*`/g, '``'); // template literals (coarse)
  return out;
}

/** Count raw `fetch(` calls (not fetchWithTimeout, not a `.fetch(` method). */
function countRawFetch(src) {
  const code = stripCommentsAndStrings(src);
  let n = 0;
  // Match `fetch(` where the char before `fetch` is not an identifier char or `.`
  const re = /(^|[^A-Za-z0-9_.])fetch\s*\(/g;
  while (re.exec(code) !== null) n += 1;
  return n;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function buildCurrent() {
  const current = {};
  for (const file of walk(AZURE_DIR)) {
    if (EXEMPT_BASENAMES.has(path.basename(file))) continue;
    const n = countRawFetch(fs.readFileSync(file, 'utf8'));
    if (n > 0) current[path.relative(REPO_ROOT, file).split(path.sep).join('/')] = n;
  }
  return current;
}

const current = buildCurrent();
const touchedFiles = gitTouchedFiles({ cwd: REPO_ROOT });

process.exit(
  runRatchet({
    name: 'breaker-coverage',
    baselineFile: BASELINE_FILE,
    meta: META,
    current,
    touched: touchedFiles
      ? {
          files: touchedFiles,
          message: () => 'raw fetch( in a touched lib/azure client — route it through fetchWithTimeout()/withDeadline().',
        }
      : { files: null },
  }),
);
