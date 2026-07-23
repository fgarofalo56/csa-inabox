#!/usr/bin/env node
/**
 * GUARDRAIL: route-toolkit  (merge-blocker, RATCHETING — loom-next-level R3)
 * ---------------------------------------------------------------------------
 * RULE: BFF routes use the route toolkit (`lib/api/route-toolkit.ts` —
 *   withSession / withWorkspaceOwner / withTenantAdmin / withDlzAccess /
 *   withBackendGate) instead of hand-rolling the getSession() prologue. The
 *   toolkit runs the EXACT same checks with byte-compatible envelopes while
 *   killing the copy-paste drift that produced the cross-tenant holes
 *   check-route-guards.mjs exists for.
 *
 * DETECTION — a route.ts is "hand-rolled session" when it:
 *   1. exports a data surface (GET or a mutating verb — same regexes as
 *      check-route-guards.mjs), AND
 *   2. imports `getSession` from '@/lib/auth/session' (alias-aware — the
 *      hand-rolled marker; a `getSession` from another module, e.g. the
 *      copilot-orchestrator's, does NOT count), AND
 *   3. references NO toolkit wrapper (not migrated).
 *
 * RATCHET SEMANTICS (two-mode, stricter than a pure count):
 *   1. Global/per-key count — a NEW hand-rolled route (net-new file, or a
 *      de-migration of a toolkit route back to getSession) FAILS.
 *   2. Touched-file rule (the forbidding part) — a route in the baseline that
 *      this PR MODIFIES must be migrated while you're here:
 *        node scripts/codemods/migrate-route-toolkit.mjs --apply --family=<area>
 *      then regen:  node scripts/ci/check-route-toolkit.mjs --update-baseline
 *      Escape hatch for a prologue the codemod legitimately can't transform:
 *      add the path to TOUCH_EXEMPT below with a one-line reason.
 *
 * The baseline lives in scripts/ci/route-toolkit-baseline.json (own file, not
 * inline — ~1,3xx entries; deviation from the inline-allowlist pattern is
 * size-justified). It only shrinks; regen via --update-baseline.
 *
 * Built on the SHARED ratchet mechanic scripts/ci/_ratchet-count.mjs (R3) —
 * X1 / I5 / R17 / R19 / U11 / LIC0 consume the same helper.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runRatchet, gitTouchedFiles } from './_ratchet-count.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const BASELINE_FILE = path.join(__dirname, 'route-toolkit-baseline.json');

// Same data-surface regexes as check-route-guards.mjs.
const MUTATING_EXPORT_RE = /export\s+(?:async\s+function\s+(?:POST|PUT|PATCH|DELETE)\b|const\s+(?:POST|PUT|PATCH|DELETE)\s*=)/;
const GET_EXPORT_RE = /export\s+(?:async\s+function\s+GET\b|const\s+GET\s*=)/;
// The hand-rolled marker: an auth-session getSession import (alias-aware).
const AUTH_SESSION_IMPORT_RE = /import\s*(?:type\s*)?\{[^}]*\bgetSession\b[^}]*\}\s*from\s*['"]@\/lib\/auth\/session['"]/;
// Any toolkit wrapper reference = migrated (or composing) — out of the ratchet.
const TOOLKIT_RE = /\bwith(?:Session|WorkspaceOwner|BackendGate|TenantAdmin|DlzAccess)\s*\(/;

// ── Touched-file escape hatch ───────────────────────────────────────────────
// Paths (repo-relative) a PR may modify WITHOUT migrating, each with a one-line
// reason (e.g. a prologue the codemod legitimately can't transform yet). Keep
// this SHORT — prefer running the codemod.
const TOUCH_EXEMPT = new Map([
  // N9 wired semantic-contract (VQR-first + refuse) evaluation into this streaming
  // data-agent chat hot-path; it returns a custom SSE stream + bespoke NextResponse
  // error envelopes, so withSession's try/catch→apiServerError wrapper would break
  // streaming — a legitimate codemod-resistant prologue. Migrate when the streaming
  // routes get a dedicated stream-safe toolkit wrapper.
  ['apps/fiab-console/app/api/items/data-agent/[id]/chat/route.ts', 'N9: streaming SSE agent route, custom envelopes — not withSession-migratable yet'],
]);

/** All route files (repo-relative POSIX paths) under app/api. */
function listRouteFiles() {
  // NB: double quotes — single quotes are not quoting chars in cmd.exe.
  const out = execSync('git ls-files "app/api/**/route.ts"', { cwd: APP_ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((f) => `apps/fiab-console/${f}`);
}

/** Measure the current hand-rolled set → { repoRelPath: 1 }. */
export function scanHandRolled() {
  const current = {};
  for (const rel of listRouteFiles()) {
    const abs = path.join(REPO_ROOT, rel);
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!MUTATING_EXPORT_RE.test(src) && !GET_EXPORT_RE.test(src)) continue; // no data surface
    if (!AUTH_SESSION_IMPORT_RE.test(src)) continue; // not session-based (or session via toolkit only)
    if (TOOLKIT_RE.test(src)) continue; // migrated / composing the toolkit
    current[rel] = 1;
  }
  return current;
}

function main() {
  const current = scanHandRolled();
  const exit = runRatchet({
    name: 'route-toolkit',
    baselineFile: BASELINE_FILE,
    meta: {
      owner: 'loom-next-level WS-R (R3) — platform/code-health',
      why:
        'Hand-rolled getSession() prologues drift (cross-tenant-hole class); every route ' +
        'migrates to lib/api/route-toolkit.ts wrappers. Baseline = the grandfathered ' +
        'hand-rolled set; it only shrinks.',
      unblock:
        'migrate: node scripts/codemods/migrate-route-toolkit.mjs --apply --family=<area>  ' +
        'then: node scripts/ci/check-route-toolkit.mjs --update-baseline  ' +
        '(codemod-resistant prologue? add the path to TOUCH_EXEMPT in check-route-toolkit.mjs with a reason)',
    },
    current,
    touched: {
      files: gitTouchedFiles({ cwd: REPO_ROOT }),
      exempt: TOUCH_EXEMPT,
      message: (key) => {
        const family = key.match(/app\/api\/([^/]+)\//)?.[1] ?? '<area>';
        return (
          `you touched ${key}; migrate it to the route-toolkit while you're here ` +
          `(node scripts/codemods/migrate-route-toolkit.mjs --apply --family=${family})`
        );
      },
    },
  });
  process.exit(exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
