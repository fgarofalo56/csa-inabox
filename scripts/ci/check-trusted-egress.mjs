#!/usr/bin/env node
/**
 * GUARDRAIL: trusted-egress  (merge-blocker, ZERO tolerance)
 * ------------------------------------------------------------------------
 * RULE (issue #2652, CodeQL js/request-forgery): a server-side fetch that
 *   carries a managed-identity token or a Key Vault secret must take its
 *   DESTINATION from configuration. The recurring shape in this tree was
 *
 *       const url = path.startsWith('http') ? path : `${ARM}${path}`;
 *
 *   which exists so ARM/Graph `nextLink` + LRO `Location` polling works, but
 *   also silently accepts ANY absolute URL. One caller that forwards a request
 *   value as `path` turns a Loom BFF route into "make Azure calls as the
 *   Console's identity". It appeared in 12 ARM/Graph clients; CodeQL only ever
 *   flagged one of them.
 *
 *   The sanctioned replacement keeps the nextLink capability and makes the
 *   off-origin case unrepresentable:
 *
 *       import { resolveSameOriginUrl } from '@/lib/azure/trusted-egress';
 *       const url = resolveSameOriginUrl(ARM, path, 'monitor ARM');
 *
 * SCOPE: server-side TypeScript under apps/fiab-console (lib/ + app/api/),
 *   excluding tests. Client components never hold these credentials.
 *
 * HOW TO CLEAR A FAILURE: use resolveSameOriginUrl(base, pathOrUrl, label).
 *   If a call genuinely must reach a DIFFERENT origin, that origin has to come
 *   from config — use resolveConfiguredBase() (lib/azure/trusted-egress.ts) so a
 *   request can only SELECT an approved endpoint, never supply one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const SCOPE_DIRS = ['lib', 'app/api'];

/** `X.startsWith('http')` used as the test of a ternary that yields a URL. */
const PASSTHROUGH_RE =
  /([A-Za-z_$][\w$]*)\s*\.startsWith\(\s*['"]https?['"]\s*\)\s*\?\s*\1\s*:\s*`/g;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === '.next') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const rel of SCOPE_DIRS) {
  for (const file of walk(path.join(APP_ROOT, rel))) {
    const src = fs.readFileSync(file, 'utf8');
    // Client components hold no server credential.
    if (/^\s*['"]use client['"]/m.test(src.slice(0, 200))) continue;
    PASSTHROUGH_RE.lastIndex = 0;
    let m;
    while ((m = PASSTHROUGH_RE.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length;
      violations.push(`${path.relative(REPO_ROOT, file).replace(/\\/g, '/')}:${line}  ${m[0].trim()}…`);
    }
  }
}

if (violations.length) {
  console.error('[trusted-egress] FAIL — absolute-URL passthrough in credential-bearing server code:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nReplace with resolveSameOriginUrl(base, pathOrUrl, label) from ' +
      "'@/lib/azure/trusted-egress'. A destination that must differ from the base " +
      'has to come from config — see resolveConfiguredBase().',
  );
  process.exit(1);
}
console.log('[trusted-egress] OK — no absolute-URL passthrough in server code (0 violations)');
