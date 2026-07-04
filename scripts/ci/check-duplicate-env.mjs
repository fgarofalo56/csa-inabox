#!/usr/bin/env node
/**
 * GUARDRAIL: duplicate-env  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE (rel-T33 / B7 — deterministic container env):
 *   A Container App's env array is `concat(<common set>, <app-specific set>)`.
 *   If the SAME env `name` can appear twice in ONE runtime realization of that
 *   array, Azure keeps the LAST occurrence — so which value wins depends on
 *   array ordering, and a redeploy that reorders (or a conditional branch that
 *   toggles) silently flips the container's configuration. That is the B7
 *   non-determinism this guard blocks: every env `name` must resolve to
 *   EXACTLY ONE emission in every runtime combination of the conditionals.
 *
 * BRANCH-AWARE (important):
 *   The env is `concat(seg1, seg2, ...)`. A segment may be an array literal, a
 *   nested `concat(...)`, or a ternary `cond ? [A] : [B]`. Only ONE side of a
 *   ternary fires at runtime, so a name emitted in BOTH sides of the SAME
 *   ternary is NOT a duplicate — the codebase deliberately uses that pattern
 *   to keep an env name single (e.g. Purview account, SCC labels, Grafana
 *   endpoint). This guard therefore computes each name's MAXIMUM runtime
 *   multiplicity = SUM across concat segments, MAX across ternary branches,
 *   and fails only when that maximum is >= 2 (a real co-occurrence).
 *
 * WHAT IT DOES:
 *   1. Reads the standardized common env set every app receives from
 *      app-deployments.bicep (leading array of the container `env: concat`).
 *   2. Reads each app object in the `apps: [...]` array in admin-plane/main.bicep
 *      and its per-app `env:` expression.
 *   3. For each app, max-multiplicity over concat(<common>, <app env>) per name;
 *      FAILS on any name whose maximum is >= 2. Exits 1 with the offenders.
 *
 * WHY UPPERCASE-ONLY NAMES:
 *   Container-App env names are SCREAMING_SNAKE_CASE (LOOM_*, NEXT_PUBLIC_*,
 *   AZURE_CLIENT_ID, KEYVAULT_URI, ...). App ids, secret refs and scale rules
 *   use lower-kebab names, so filtering `name:` literals to /^[A-Z][A-Z0-9_]*$/
 *   isolates exactly the env entries without a full bicep parse.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ADMIN_PLANE = path.join(
  REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'main.bicep',
);
const APP_DEPLOYMENTS = path.join(
  REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'app-deployments.bicep',
);

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

// ── Low-level, string+comment-aware scanning ─────────────────────────────────

/** Advance past a bicep string literal (single '…' or triple '''…''') that
 *  starts at i; return the index just after the closing quote(s). */
function skipString(text, i) {
  if (text.startsWith("'''", i)) {
    const end = text.indexOf("'''", i + 3);
    return end < 0 ? text.length : end + 3;
  }
  i += 1; // opening '
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === "'") return i + 1;
    i += 1;
  }
  return text.length;
}

/** Advance past a // or /* *\/ comment starting at i; return index after it. */
function skipComment(text, i) {
  if (text[i] === '/' && text[i + 1] === '/') {
    const nl = text.indexOf('\n', i);
    return nl < 0 ? text.length : nl;
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
  }
  return i + 1;
}

const OPENERS = { '[': ']', '{': '}', '(': ')' };

/** Return substring [openIdx .. matching close] for the bracket at openIdx,
 *  skipping strings + comments so quotes/brackets in prose never miscount. */
export function extractBalanced(text, openIdx) {
  const open = text[openIdx];
  const close = OPENERS[open];
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") { i = skipString(text, i); continue; }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { i = skipComment(text, i); continue; }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return text.slice(openIdx, i + 1); }
    i += 1;
  }
  throw new Error(`unbalanced '${open}' at index ${openIdx}`);
}

/** Given the text just INSIDE a concat(...) or a [...] (the content between the
 *  delimiters), split it into top-level comma-separated arguments. */
function splitTopLevelCommas(inner) {
  const args = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === "'") { i = skipString(inner, i); continue; }
    if (c === '/' && (inner[i + 1] === '/' || inner[i + 1] === '*')) { i = skipComment(inner, i); continue; }
    if (c === '[' || c === '{' || c === '(') depth += 1;
    else if (c === ']' || c === '}' || c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { args.push(inner.slice(start, i)); start = i + 1; }
    i += 1;
  }
  const tail = inner.slice(start);
  if (tail.trim()) args.push(tail);
  return args;
}

/** If node is a top-level ternary `cond ? A : B`, return {a, b}; else null.
 *  Ignores `?`/`:` inside brackets, strings, comments, and the `??`/`?.`/`.?`
 *  operators. Handles nested ternaries in the branches. */
function splitTernary(node) {
  let depth = 0;
  let i = 0;
  let qIdx = -1;
  // find the first top-level ternary '?'
  while (i < node.length) {
    const c = node[i];
    if (c === "'") { i = skipString(node, i); continue; }
    if (c === '/' && (node[i + 1] === '/' || node[i + 1] === '*')) { i = skipComment(node, i); continue; }
    if (c === '[' || c === '{' || c === '(') { depth += 1; i += 1; continue; }
    if (c === ']' || c === '}' || c === ')') { depth -= 1; i += 1; continue; }
    if (c === '?' && depth === 0) {
      // exclude ?? (nullish) and ?. / .? (safe access)
      if (node[i + 1] === '?' || node[i + 1] === '.' || node[i - 1] === '.' || node[i - 1] === '?') { i += 2; continue; }
      qIdx = i; break;
    }
    i += 1;
  }
  if (qIdx < 0) return null;
  // find the matching top-level ':' (accounting for nested ternaries)
  depth = 0;
  let tern = 0;
  i = qIdx + 1;
  while (i < node.length) {
    const c = node[i];
    if (c === "'") { i = skipString(node, i); continue; }
    if (c === '/' && (node[i + 1] === '/' || node[i + 1] === '*')) { i = skipComment(node, i); continue; }
    if (c === '[' || c === '{' || c === '(') { depth += 1; i += 1; continue; }
    if (c === ']' || c === '}' || c === ')') { depth -= 1; i += 1; continue; }
    if (depth === 0) {
      if (c === '?' && node[i + 1] !== '?' && node[i + 1] !== '.' && node[i - 1] !== '.' && node[i - 1] !== '?') tern += 1;
      else if (c === ':') { if (tern === 0) return { a: node.slice(qIdx + 1, i), b: node.slice(i + 1) }; tern -= 1; }
    }
    i += 1;
  }
  return null;
}

/** Count the direct env-entry occurrences of `name` in a flat array text. */
function countFlat(name, text) {
  const re = new RegExp(`\\bname:\\s*'${name}'`, 'g');
  const stripped = stripComments(text);
  const m = stripped.match(re);
  return m ? m.length : 0;
}

/** Blank ONLY comment regions (// line, /* block *\/), leaving string literals
 *  intact — env entry names live inside `'…'` strings, so those must survive;
 *  we only need to prevent a NAME mentioned in a comment from being counted.
 *  String-aware so a `//` inside a quoted URL is not treated as a comment. */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") { const j = skipString(text, i); out += text.slice(i, j); i = j; continue; }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { const j = skipComment(text, i); out += ' '.repeat(j - i); i = j; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** Maximum runtime multiplicity of `name` in a bicep env expression:
 *  SUM across concat args / array elements, MAX across ternary branches. */
export function maxCount(name, exprRaw) {
  const expr = exprRaw.trim();
  if (!expr || expr === '[]') return 0;
  // Strip one layer of wrapping parens: `( ... )`.
  if (expr[0] === '(') {
    const bal = extractBalanced(expr, 0);
    if (bal.length === expr.length) return maxCount(name, expr.slice(1, -1));
  }
  // concat(...) → sum of args.
  const cm = expr.match(/^concat\s*\(/);
  if (cm) {
    const open = expr.indexOf('(');
    const body = extractBalanced(expr, open);
    const inner = body.slice(1, -1);
    return splitTopLevelCommas(inner).reduce((s, a) => s + maxCount(name, a), 0);
  }
  // ternary cond ? A : B → max(A, B).
  const t = splitTernary(expr);
  if (t) return Math.max(maxCount(name, t.a), maxCount(name, t.b));
  // array literal [...] → sum of its (flat) entries.
  if (expr[0] === '[') return countFlat(name, expr);
  // bare expression (e.g. a var) → no env entry.
  return 0;
}

/** All uppercase env NAME literals referenced anywhere in an expression
 *  (ignoring names that appear only inside comments). */
function allNames(exprRaw) {
  const names = new Set();
  const code = stripComments(exprRaw);
  const re = /\bname:\s*'([A-Z][A-Z0-9_]*)'/g;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return names;
}

/** The common env expression every app inherits (app-deployments.bicep). */
export function commonEnvExpr() {
  const src = fs.readFileSync(APP_DEPLOYMENTS, 'utf8');
  const marker = src.indexOf('env: concat(');
  if (marker < 0) throw new Error('app-deployments.bicep: `env: concat(` not found');
  const open = src.indexOf('(', marker);
  return 'concat' + extractBalanced(src, open); // concat(...) — leading array + app.env
}

/** Split the `apps: [...]` array into per-app { name, envExpr }. */
export function collectApps() {
  const src = fs.readFileSync(ADMIN_PLANE, 'utf8');
  const marker = src.indexOf('apps: [');
  if (marker < 0) throw new Error('admin-plane/main.bicep: `apps: [` not found');
  const arrOpen = src.indexOf('[', marker);
  const appsArr = extractBalanced(src, arrOpen);

  const apps = [];
  let i = 1; // skip leading '['
  while (i < appsArr.length) {
    const c = appsArr[i];
    if (c === "'") { i = skipString(appsArr, i); continue; }
    if (c === '/' && (appsArr[i + 1] === '/' || appsArr[i + 1] === '*')) { i = skipComment(appsArr, i); continue; }
    if (c === '{') {
      const obj = extractBalanced(appsArr, i);
      const nameMatch = obj.match(/\bname:\s*'([^']+)'/);
      const appName = nameMatch ? nameMatch[1] : `app#${apps.length + 1}`;
      // Extract the `env:` expression of this app object.
      const envIdx = obj.indexOf('env:');
      let envExpr = '';
      if (envIdx >= 0) {
        let j = envIdx + 4;
        while (j < obj.length && /\s/.test(obj[j])) j += 1;
        if (obj.startsWith('concat', j)) {
          const p = obj.indexOf('(', j);
          envExpr = 'concat' + extractBalanced(obj, p);
        } else if (obj[j] === '[') {
          envExpr = extractBalanced(obj, j);
        }
      }
      apps.push({ name: appName, envExpr });
      i += obj.length;
      continue;
    }
    i += 1;
  }
  return apps;
}

export function computeDuplicates() {
  const common = commonEnvExpr();
  const apps = collectApps();
  const report = [];
  for (const app of apps) {
    // Final container env = concat(common-leading-array, app.env).
    const names = new Set([...allNames(common), ...allNames(app.envExpr)]);
    const dups = [];
    for (const n of [...names].sort()) {
      if (!ENV_NAME_RE.test(n)) continue;
      const total = maxCount(n, common) + maxCount(n, app.envExpr);
      if (total >= 2) dups.push({ name: n, count: total });
    }
    if (dups.length) report.push({ app: app.name, dups });
  }
  return { apps, report };
}

function main() {
  const { apps, report } = computeDuplicates();
  console.log(`[duplicate-env] apps inspected (admin-plane/main.bicep): ${apps.length}`);
  for (const app of apps) console.log(`[duplicate-env]   ${app.name}`);
  if (report.length) {
    console.error('\n[duplicate-env] FAIL — an env `name` can be emitted more than once in a');
    console.error('single app at runtime (common set + per-app env, branch-aware). Azure keeps');
    console.error('the LAST occurrence, so the winning value depends on array order — a redeploy');
    console.error('can silently flip it (B7). Emit each env name exactly once (one effective-*');
    console.error('var, or a single ternary whose branches are mutually exclusive):');
    for (const { app, dups } of report) {
      console.error(`\n  ${app}:`);
      for (const d of dups) console.error(`    - ${d.name}  (max x${d.count})`);
    }
    process.exit(1);
  }
  console.log('[duplicate-env] OK — every env name resolves to exactly one emission per app.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
