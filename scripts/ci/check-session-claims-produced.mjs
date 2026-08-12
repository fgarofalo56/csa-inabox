#!/usr/bin/env node
/**
 * check-session-claims-produced.mjs
 *
 * RULE. Every field on `UserClaims` that the app READS must be WRITTEN by the
 * auth callback that mints the session. A field that is declared and consumed
 * but never produced is permanently `undefined`, and every decision that depends
 * on it silently takes the wrong branch.
 *
 * WHY (#3175, P0). `groups?: string[]` was declared on `UserClaims`, read in six
 * places, and assigned nowhere:
 *
 *     const claims: UserClaims = { oid, tid, name, email, upn };   // no groups
 *
 * so `session.claims.groups` was ALWAYS undefined and every group-based
 * authorization path in Loom was dead:
 *
 *   - tenant admin by group could never succeed — only LOOM_TENANT_ADMIN_OID
 *   - capability grants made to a group never matched
 *   - item ACLs granted to a group never matched
 *
 * The operator hit it as "Failed to load the admin overview: forbidden" while
 * being a member of the configured admin group. It had been live for months.
 *
 * WHY TYPES DID NOT CATCH IT. `groups` is OPTIONAL, so omitting it is legal
 * TypeScript. Neither did tests: a unit test of the extraction helper passes
 * whether or not the callback calls it. The only thing that catches a missing
 * PRODUCER is a check that compares the producer against the consumers — which
 * is this file.
 *
 * DELIBERATELY NOT A GREP FOR `groups`. Keyed to the PROPERTY (declared ∧
 * consumed ⇒ produced), so it covers every future field on the interface
 * automatically. Five rules in this repo were keyed to the shape of the code
 * they were written for and each went quiet on exactly the change it watched.
 *
 * SELF-DEFENCE. Fails if it cannot find the interface, cannot find the claims
 * literal, or parses zero fields from either — a parser that has drifted off the
 * code must not report a pass.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const TYPE_FILE = 'apps/fiab-console/lib/auth/msal.ts';
const CALLBACK = 'apps/fiab-console/app/auth/callback/route.ts';

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch (e) {
    console.error(`::error::session-claims-produced: cannot read ${rel} (${(e.message || '').slice(0, 120)}).`);
    process.exit(1);
  }
}

/** Fields declared on `interface UserClaims`. */
function declaredFields(src) {
  const m = /export interface UserClaims\s*\{([\s\S]*?)\n\}/.exec(src);
  if (!m) return null;
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\??\s*:/gm)].map((x) => x[1]);
}

/** Fields assigned in the callback's `const claims: UserClaims = { … }`. */
function producedFields(src) {
  const start = src.indexOf('const claims: UserClaims = {');
  if (start === -1) return null;
  // Walk braces so nested objects/ternaries do not truncate the literal early.
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  const body = src.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // Only top-level keys of THIS literal.
  const fields = [];
  let d = 0;
  for (const line of body.split('\n')) {
    const before = d;
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') d++;
      else if (ch === '}' || ch === ']' || ch === ')') d--;
    }
    if (before !== 0) continue;
    const km = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(line);
    if (km) fields.push(km[1]);
  }
  return fields;
}

const declared = declaredFields(read(TYPE_FILE));
if (!declared || declared.length === 0) {
  console.error(
    `::error::session-claims-produced: parsed ZERO fields from 'interface UserClaims' in ${TYPE_FILE}. ` +
      'The interface was renamed, moved, or reshaped — refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

const produced = producedFields(read(CALLBACK));
if (!produced || produced.length === 0) {
  console.error(
    `::error::session-claims-produced: could not locate 'const claims: UserClaims = {' in ${CALLBACK}, or parsed ` +
      'ZERO assigned fields. The session minting site moved — this guard must be repointed, not deleted.',
  );
  process.exit(1);
}

// How often is each declared field actually READ across the console?
let consumedCounts = {};
try {
  const out = execFileSync(
    'git',
    ['grep', '-hoE', 'claims\\.[a-zA-Z_][a-zA-Z0-9_]*', '--', 'apps/fiab-console/lib', 'apps/fiab-console/app'],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const line of out.split('\n')) {
    const f = line.trim().replace(/^claims\./, '');
    if (f) consumedCounts[f] = (consumedCounts[f] || 0) + 1;
  }
} catch (e) {
  console.error(`::error::session-claims-produced: git grep for claim reads failed (${(e.message || '').slice(0, 120)}).`);
  process.exit(1);
}

const producedSet = new Set(produced);
const missing = declared.filter((f) => (consumedCounts[f] || 0) > 0 && !producedSet.has(f));

if (missing.length > 0) {
  console.error(
    `::error::session-claims-produced: ${missing.length} UserClaims field(s) are DECLARED and READ but never ` +
      'WRITTEN by the auth callback. They are permanently undefined, so every decision that depends on them ' +
      'silently takes the wrong branch — this is exactly how group-based authorization was dead for months ' +
      '(#3175). TypeScript cannot catch it because the fields are optional.',
  );
  for (const f of missing) {
    console.error(
      `::error file=${CALLBACK}::'${f}' is read ${consumedCounts[f]}x but never assigned in 'const claims: UserClaims'`,
    );
  }
  process.exit(1);
}

const summary = declared.map((f) => `${f}(${consumedCounts[f] || 0}r)`).join(' ');
console.log(
  `session-claims-produced OK — ${declared.length} declared field(s), ${produced.length} produced by the callback; ` +
    `every read field is written. ${summary}`,
);
