#!/usr/bin/env node
/**
 * Log-injection guard — closes CodeQL js/log-injection as a CLASS.
 *
 * WHY THIS EXISTS. A request-derived value interpolated into a log line can
 * forge log records: a `\n` in the value makes its tail render as its own,
 * attacker-authored entry. That poisons incident review and any line-parsing
 * alert rule. Verified, not assumed:
 *
 *   console.error('[x] failed:', 'boom\n[api] FORGED admin=true')
 *     -> "[api] FORGED admin=true" lands as a SEPARATE record.
 *
 * TWO RULES, because the class re-opened once already.
 *
 * RULE 1 — the sanitizer must stay CodeQL-recognisable.
 *   PR #2768 added `logSafe()` and wrapped the flagged call sites. The alerts
 *   stayed OPEN at main for the next week, because CodeQL never saw a sanitizer.
 *   `StringReplaceSanitizer` in LogInjectionQuery.qll is EXACTLY:
 *       exists(string s | this.(StringReplaceCall).replaces(s, "") and
 *                         s.regexpMatch("\\n"))
 *   The replacement must be the EMPTY string, and the replaced string must be
 *   exactly "\n". #2768's step replaced with a SPACE, using a quantified
 *   character RANGE (which yields no `getAMatchedString()`), so it matched
 *   NEITHER half and the whole helper was invisible to the scanner.
 *   That is the failure this repo keeps repeating: a control that runs, reports
 *   success, and measures nothing. Rule 1 fails CI if that construct goes away.
 *
 * RULE 2 — default-deny at the request boundary.
 *   Every non-literal argument to `console.*` in an API/auth route handler must
 *   pass through the shared sanitizer. Default-deny, not a denylist of "scary"
 *   accessor patterns: all six js/log-injection alerts arrived through a local
 *   VARIABLE (`detail`, `this.label`, `model`, `issueTitle`), so a guard keyed on
 *   `req.query`-shaped syntax would have matched 2 sites and missed the class.
 *
 * SCOPE, stated honestly. Rule 2 covers `app/api/ ** /route.ts` and
 * `app/auth/ ** /route.ts` — the boundary where request data demonstrably
 * enters. It does NOT cover all of `lib/`; most console calls there are
 * server-origin diagnostics and default-deny would drown the signal, which is
 * how a guard gets switched off. The two `lib/` sinks CodeQL found
 * (`lib/api/respond.ts`, `lib/azure/paging-budget.ts`) are fixed at their
 * chokepoints and covered by unit tests.
 *
 * FIX A HIT:
 *   import { logSafe, logSafeError } from '@/lib/util/log-safe';
 *   console.warn(`[route] failed for ${logSafe(id)}`);   // any value
 *   console.error('[route] threw:', logSafeError(e));    // an Error, keeps stack
 *
 * NEVER wrap an object/array in logSafe — `String({})` is "[object Object]".
 * Structured args are already safe: Node's util.inspect quotes nested strings
 * and escapes control characters, so they cannot forge a line. (An Error is NOT
 * safe that way — Node prints `.stack` verbatim — hence logSafeError.)
 *
 * Usage: node scripts/ci/check-log-injection.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SANITIZER = 'apps/fiab-console/lib/util/log-safe.ts';
const SCAN_DIRS = ['apps/fiab-console/app/api', 'apps/fiab-console/app/auth'];
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__tests__', '__mocks__']);

const problems = [];

// ---------------------------------------------------------------- RULE 1 ----
function checkSanitizerIntegrity() {
  let src;
  try {
    src = readFileSync(join(ROOT, SANITIZER), 'utf8');
  } catch {
    problems.push({
      file: SANITIZER,
      line: 0,
      why: 'the shared sanitizer is MISSING. Every console.* guard below depends on it.',
    });
    return;
  }
  // The exact construct CodeQL models: .replaceAll('\n', '') / .replace(/\n/g, '')
  // with an EMPTY-STRING replacement.
  const modelled =
    /\.replaceAll\(\s*(['"])\\n\1\s*,\s*(['"])\2\s*\)/.test(src) ||
    /\.replace\(\s*\/\\n\/g\s*,\s*(['"])\1\s*\)/.test(src);
  if (!modelled) {
    problems.push({
      file: SANITIZER,
      line: src.split('\n').findIndex((l) => l.includes('replaceAll') || l.includes('replace(')) + 1,
      why:
        "logSafe() no longer contains the newline-strip CodeQL recognises.\n" +
        "    Required (replacement must be the EMPTY string):  .replaceAll('\\n', '')\n" +
        '    Without it CodeQL sees NO sanitizer and every call site is re-flagged,\n' +
        '    exactly as happened after #2768.',
    });
  }
  // Raw C0/DEL bytes in the source are invisible in review and one reformat away
  // from silently neutering the strip. Escapes only.
  const rawControl = [...src].some((c) => {
    const n = c.charCodeAt(0);
    return (n < 0x20 && c !== '\n' && c !== '\r' && c !== '\t') || n === 0x7f;
  });
  if (rawControl) {
    problems.push({
      file: SANITIZER,
      line: 0,
      why:
        'contains RAW control bytes. Spell them as \\u0000-\\u001F\\u007F escapes —\n' +
        '    literal bytes are invisible in review and survive no reformat.',
    });
  }
}

// ---------------------------------------------------------------- RULE 2 ----
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}

/** Index of the `)` closing the `(` at `open`, skipping strings/templates. */
function matchParen(src, open) {
  let depth = 0, inS = null, tick = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (inS) { if (c === inS && prev !== '\\') inS = null; continue; }
    if (c === '`') { tick ^= 1; continue; }
    if (tick) continue;
    if (c === '"' || c === "'") { inS = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split top-level comma arguments. */
function splitArgs(t) {
  const out = [];
  let d = 0, inS = null, tick = 0, cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i], prev = t[i - 1];
    if (inS) { cur += c; if (c === inS && prev !== '\\') inS = null; continue; }
    if (c === '`') { tick ^= 1; cur += c; continue; }
    if (!tick && (c === '"' || c === "'")) { inS = c; cur += c; continue; }
    if (!tick) {
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) d--;
      else if (c === ',' && d === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Identifiers this FILE defines as a thin delegate over logSafe(), so a local
 * wrapper needs no allowlist entry. Heuristic and deliberately narrow: the
 * definition must mention logSafe( within 500 chars.
 */
function localDelegates(src) {
  const names = new Set();
  const re = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] || m[2];
    if (name && src.slice(m.index, m.index + 500).includes('logSafe(')) names.add(name);
  }
  names.delete('logSafe');
  names.delete('logSafeError');
  return names;
}

const isSanitized = (expr, delegates) =>
  /\blogSafe(?:Error)?\s*\(/.test(expr) ||
  /JSON\.stringify\s*\(/.test(expr) ||
  /\.(length|size)\b/.test(expr) ||
  [...delegates].some((d) => new RegExp(`\\b${d}\\s*\\(`).test(expr));

const isPlainLiteral = (a) => {
  const t = a.trim();
  return /^(['"])(?:[^\\]|\\.)*?\1$/s.test(t) || (t.startsWith('`') && !t.includes('${'));
};
/** Object/array literal: util.inspect quotes + escapes, so it cannot forge. */
const isStructured = (a) => /^[{[]/.test(a.trim());

function checkRouteHandlers() {
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const src = readFileSync(file, 'utf8');
      const delegates = localDelegates(src);
      const re = /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const open = src.indexOf('(', m.index);
        const close = matchParen(src, open);
        if (close === -1) continue;
        const line = src.slice(0, m.index).split('\n').length;
        for (const arg of splitArgs(src.slice(open + 1, close))) {
          const t = arg.trim();
          if (!t || isPlainLiteral(arg) || isStructured(arg)) continue;
          if (t.startsWith('`')) {
            for (const im of t.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
              const inner = im[1].trim();
              if (inner && !isSanitized(inner, delegates)) {
                problems.push({ file: rel, line, why: `unsanitized \`\${${inner}}\` in a console.* template` });
              }
            }
          } else if (!isSanitized(t, delegates)) {
            problems.push({ file: rel, line, why: `unsanitized console.* argument \`${t.slice(0, 80)}\`` });
          }
        }
      }
    }
  }
}

checkSanitizerIntegrity();
checkRouteHandlers();

if (problems.length === 0) {
  console.log('[log-injection] OK — sanitizer is CodeQL-recognisable and every route console.* argument is sanitized.');
  process.exit(0);
}

console.error(`\n[log-injection] FAIL — ${problems.length} problem(s).\n`);
for (const p of problems) {
  console.error(`  ${p.file}${p.line ? `:${p.line}` : ''}`);
  console.error(`    ${p.why}\n`);
}
console.error("  Fix: import { logSafe, logSafeError } from '@/lib/util/log-safe'");
console.error('    logSafe(v)        — any request-derived value (flattens CR/LF, bounds length)');
console.error('    logSafeError(e)   — a caught Error (keeps the stack, flattened to one record)');
console.error('    Object/array args need NO wrapper, and must not get one: String({}) is "[object Object]".\n');
process.exit(1);
