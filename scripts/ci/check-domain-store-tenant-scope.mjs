#!/usr/bin/env node
/**
 * check-domain-store-tenant-scope.mjs
 *
 * RULE. The FIRST argument to `loadTenantDomains()` / `loadOrSeedDomains()` is
 * the Cosmos partition key for the tenant's domain document. It must be a tenant
 * scope (`tenantScopeId(session)` = `tid || oid`), never the caller's own object
 * id.
 *
 * WHY (#3282). `app/api/admin/chargeback/route.ts` keyed that document with
 * `tenantScopeId(s)` while `app/api/admin/domains/route.ts` keyed the SAME
 * document with `s.claims.oid`. Two routes, one document id, two partitioning
 * schemes. Probed against the real GET handler with two sessions sharing one
 * `tid`:
 *
 *     read: domains:user-A-oid   -> loadOrSeedDomains CREATED it
 *     read: domains:user-B-oid   -> loadOrSeedDomains CREATED it too
 *
 * Each user silently got a PRIVATE copy, seeded on read with the same starter
 * set (default, finance, sales-marketing, operations, people) and 0 workspaces
 * each. No error, no empty state — it renders fine and means nothing, which is
 * exactly the 0-counts shape ux-baseline G1 exists to catch.
 *
 * The worst site was not a page: `lib/auth/dlz-gate.ts` is an AUTHORIZATION gate
 * that read the domain list to make its decision, so the decision was made
 * against a per-user set.
 *
 * KEYED TO THE PROPERTY, NOT THE SPELLING. This checks the FIRST ARGUMENT of the
 * call. It deliberately does NOT grep for `claims.oid`, because:
 *
 *   - `loadOrSeedDomains(tenantId, s.claims.upn || s.claims.oid)` is CORRECT —
 *     the second argument is "who touched it", where an oid is the right value.
 *     A rule matching `claims.oid` anywhere on the line would flag every correct
 *     call and get muted.
 *   - `claims.oid` is also correct in dozens of ownership/actor contexts across
 *     the app. This repo has been bitten five times by rules keyed to the shape
 *     of the current code rather than to the property being enforced; each went
 *     quiet on exactly the change it was written to watch.
 *
 * SELF-DEFENCE. Fails if it finds no domain-store calls at all — a matcher that
 * has drifted off the code must not report a pass on an empty population.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const CONSOLE_DIR = 'apps/fiab-console';

/** Functions whose first parameter IS the tenant partition key. */
const STORE_FNS = ['loadTenantDomains', 'loadOrSeedDomains'];

/** A first argument that is an acceptable tenant scope. */
const OK_FIRST_ARG = /^(tenantScopeId\s*\(|tenantId\b|scopeId\b|tid\b)/;

/** A first argument that is the caller's own identity. */
const BAD_FIRST_ARG = /\bclaims\s*\.\s*oid\b|\boid\b\s*$/;

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '--', `${CONSOLE_DIR}/app`, `${CONSOLE_DIR}/lib`], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && /\.tsx?$/.test(l) && !l.includes('__tests__'));
  } catch (e) {
    console.error(
      `::error::domain-store-tenant-scope: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

/** Split the first argument off a call's argument list, respecting nesting. */
function firstArgOf(text, openParenIdx) {
  let depth = 0;
  let out = '';
  for (let i = openParenIdx; i < text.length && i < openParenIdx + 400; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) {
      break;
    }
    if (depth >= 1) out += ch;
  }
  return out.trim();
}

const files = trackedFiles();
const violations = [];
let calls = 0;

for (const rel of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (!STORE_FNS.some((fn) => text.includes(`${fn}(`))) continue;

  for (const fn of STORE_FNS) {
    let idx = 0;
    for (;;) {
      idx = text.indexOf(`${fn}(`, idx);
      if (idx === -1) break;
      const openParen = idx + fn.length;
      // Skip the declaration itself (`export async function loadTenantDomains(`).
      const before = text.slice(Math.max(0, idx - 40), idx);
      if (/\bfunction\s+$/.test(before)) {
        idx = openParen;
        continue;
      }
      const arg = firstArgOf(text, openParen);
      calls++;
      if (arg && !OK_FIRST_ARG.test(arg) && BAD_FIRST_ARG.test(arg)) {
        const line = text.slice(0, idx).split('\n').length;
        violations.push({ file: rel, line, fn, arg: arg.slice(0, 60) });
      }
      idx = openParen;
    }
  }
}

if (calls === 0) {
  console.error(
    '::error::domain-store-tenant-scope: found ZERO calls to loadTenantDomains/loadOrSeedDomains. This repo has ' +
      'many, so the matcher has drifted off the code (renamed store? moved module?). Refusing to report a pass ' +
      'on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::domain-store-tenant-scope: ${violations.length} call(s) key the tenant domain document by the ` +
      "CALLER's object id instead of the tenant scope. Every user then gets a PRIVATE domain set, silently seeded " +
      'on read with the starter list and 0 workspaces — it renders fine and means nothing. Sibling readers ' +
      '(chargeback) use tenantScopeId() on the SAME document id, so the two disagree. Use tenantScopeId(session). ' +
      'See #3282.',
  );
  for (const v of violations) {
    console.error(`::error file=${v.file},line=${v.line}::${v.fn}(${v.arg} …) — first arg must be tenantScopeId(session)`);
  }
  process.exit(1);
}

console.log(
  `domain-store-tenant-scope OK — ${calls} domain-store call(s) across ${files.length} tracked file(s); ` +
    'every one keys the document by the tenant scope.',
);
