#!/usr/bin/env node
/**
 * GUARDRAIL: kv-secret-purpose  (merge-blocker, zero tolerance)
 * ------------------------------------------------------------------------
 * RULE
 *   Every `getKeyVaultSecretValue(...)` call MUST pass a LITERAL purpose from
 *   the KvSecretPurpose union as its second argument.
 *
 * WHY
 *   Several call sites derive the secret NAME from user-writable item state or a
 *   request body. The purpose decides which Key Vault name-space that read may
 *   touch (apps/fiab-console/lib/azure/kv-secret-purpose.ts), which is what keeps
 *   the platform's own credentials — `loom-msal-client-secret` above all, whose
 *   leak caused a full production sign-in outage on 2026-07-19 — structurally
 *   unreachable from a request-driven path.
 *
 *   TypeScript already requires the argument. This guard exists because a
 *   VARIABLE purpose (`getKeyVaultSecretValue(n, p)`) type-checks while making
 *   the policy dynamic and un-auditable, and because it keeps the inventory of
 *   "which surface may read what" reviewable in one place.
 *
 * HOW TO SATISFY IT
 *   Pass one of the declared purposes as a string literal. If a genuinely new
 *   kind of secret read appears, add a purpose to the union in
 *   kv-secret-purpose.ts (with its name-space policy) and to PURPOSES below.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');
const POLICY_FILE = path.join(CONSOLE_ROOT, 'lib', 'azure', 'kv-secret-purpose.ts');

/** Keep in sync with the KvSecretPurpose union. */
const PURPOSES = [
  'connection-secret',
  'git-credential',
  'udf-function-key',
  'variable-library',
  'directquery-source',
  'app-env-binding',
];

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const violations = [];

// 1) The policy module must still declare every purpose (a silent deletion would
//    make this guard's list drift away from the type).
if (!fs.existsSync(POLICY_FILE)) {
  violations.push(`${path.relative(REPO_ROOT, POLICY_FILE)} is missing — the Key Vault purpose policy must exist.`);
} else {
  const policy = fs.readFileSync(POLICY_FILE, 'utf8');
  for (const p of PURPOSES) {
    if (!policy.includes(`'${p}'`)) {
      violations.push(`${path.relative(REPO_ROOT, POLICY_FILE)}: purpose '${p}' is no longer declared.`);
    }
  }
}

// 2) Every call site passes a literal purpose.
const CALL_RE = /getKeyVaultSecretValue\s*\(/g;
const files = [
  ...walk(path.join(CONSOLE_ROOT, 'app')),
  ...walk(path.join(CONSOLE_ROOT, 'lib')),
];

for (const file of files) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  // Not production reads: the definition itself, the policy module's own prose,
  // and tests (which legitimately iterate the union to prove refusals).
  if (rel.endsWith('lib/azure/kv-secrets-client.ts')) continue;
  if (rel.endsWith('lib/azure/kv-secret-purpose.ts')) continue;
  if (rel.includes('/__tests__/')) continue;
  const src = fs.readFileSync(file, 'utf8');
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src)) !== null) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index) === -1 ? src.length : src.indexOf('\n', m.index));
    // Skip comments/JSDoc mentions and import/destructure lines like
    // `const { getKeyVaultSecretValue } = await import(...)`.
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    if (/^\s*(import|export)\b/.test(line) || /\{\s*getKeyVaultSecretValue\s*[},]/.test(line)) continue;

    // Read the argument list, balancing parens so nested calls do not confuse it.
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (let i = end; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const args = src.slice(m.index + m[0].length, end);
    const hasLiteralPurpose = PURPOSES.some((p) => args.includes(`'${p}'`) || args.includes(`"${p}"`));
    if (!hasLiteralPurpose) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      violations.push(
        `${rel}:${lineNo}: getKeyVaultSecretValue(${args.trim().slice(0, 80)}) has no literal purpose. ` +
        `Pass one of: ${PURPOSES.join(', ')}.`,
      );
    }
  }
}

if (violations.length) {
  console.error('[kv-secret-purpose] FAIL — every Key Vault read must declare a literal purpose:\n');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nSee apps/fiab-console/lib/azure/kv-secret-purpose.ts. A purpose is what keeps ' +
    'loom-msal-client-secret unreachable from an item-state-driven read.',
  );
  process.exit(1);
}

console.log('[kv-secret-purpose] OK — 0 violations; every Key Vault read declares a literal purpose.');
