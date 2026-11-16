#!/usr/bin/env node
/**
 * GUARDRAIL: no template may reference a RETIRED VM marketplace image (#4672).
 *
 * Why: a Microsoft compliance notice flagged a Loom VM running the legacy
 * `MicrosoftWindowsServer:WindowsServer` offer (.NET 6 preinstalled, EOL).
 * Azure refuses an imageReference change on an existing VM, so the fix is a
 * delete + re-create (scripts/csa-loom/replace-retired-image-vms.mjs) - and
 * this guard makes sure no template can put a VM back on a retired image.
 *
 * Denylist: scripts/ci/retired-vm-images.json [{publisher, offer, reason, since}].
 *
 * What it scans: every *.bicep / *.bicepparam / *.json under the repo root
 * (skipping node_modules, .git, temp, .claude, build output). Anywhere an
 * object carries BOTH a `publisher` and an `offer` key, the pair is checked,
 * case-insensitively. The offer/publisher may be:
 *   - a string literal                      -> compared directly
 *   - an identifier (bicep param/var)       -> its literal default is resolved
 *   - [parameters('x')] / [variables('x')]  -> resolved in the nearest ARM scope
 * An offer that cannot be resolved to a literal FAILS (file:line): otherwise
 * the retired offer could be laundered through a param with no default.
 * `.bicepparam` assignments to an identifier used as an offer are checked too.
 *
 * Usage: node scripts/ci/check-retired-vm-images.mjs [repo-root]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'temp', '.claude', '.next', 'bin', 'obj', 'dist', '.venv', '__pycache__',
]);

export function loadDenylist(file = path.join(HERE, 'retired-vm-images.json')) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${file}: denylist is empty or not an array - a guard with nothing to match watches nothing`);
  }
  return list;
}

const lc = (s) => String(s).trim().toLowerCase();

function matchDeny(deny, publisher, offer) {
  return deny.find((d) => lc(d.offer) === lc(offer) && (publisher === null || lc(d.publisher) === lc(publisher)));
}

/** Blank out line and block comments while preserving offsets and quoted strings. */
export function stripBicepComments(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === "'") inStr = false;
      i++;
      continue;
    }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function enclosingObject(text, idx) {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{') { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

const STR = "'((?:[^']|'')*)'";

function resolveBicepValue(text, expr) {
  const e = expr.trim().replace(/,$/, '').trim();
  let m = new RegExp(`^${STR}$`).exec(e);
  if (m) return { value: m[1], how: 'literal' };
  m = /^([A-Za-z_]\w*)$/.exec(e);
  if (m) {
    const d = new RegExp(`^\\s*(?:param\\s+${m[1]}\\s+string\\s*=|var\\s+${m[1]}\\s*=)\\s*${STR}\\s*$`, 'm').exec(text);
    if (d) return { value: d[1], how: `default of ${m[1]} (line ${lineOf(text, d.index)})`, ident: m[1] };
    return { value: null, ident: m[1] };
  }
  return { value: null };
}

export function scanBicepText(file, rawText, deny) {
  const text = stripBicepComments(rawText);
  const violations = [];
  const idents = new Set();
  let checked = 0;
  const re = /(^|[\s{,])offer\s*:\s*([^\n}]*?)\s*(?=$|\n|,|\})/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = m.index + m[1].length;
    const line = lineOf(text, idx);
    const obj = enclosingObject(text, idx);
    if (!obj || !/(^|[\s{,])publisher\s*:/.test(obj)) continue;
    checked++;
    const off = resolveBicepValue(text, m[2]);
    const pm = /(^|[\s{,])publisher\s*:\s*([^\n}]*?)\s*(?=$|\n|,|\})/m.exec(obj);
    const pub = pm ? resolveBicepValue(text, pm[2]) : { value: null };
    if (off.ident) idents.add(off.ident);
    if (off.value === null) {
      violations.push({ file, line, kind: 'unresolvable', message: `${file}:${line}: VM image offer \`${m[2].trim()}\` is not a string literal or a param/var with a literal default, so it cannot be checked against the retired-image denylist. Give it a literal default.` });
      continue;
    }
    const hit = matchDeny(deny, pub.value, off.value);
    if (hit) {
      violations.push({ file, line, kind: 'retired', message: `${file}:${line}: VM image ${hit.publisher}:${off.value} (${off.how}) is RETIRED - ${hit.reason} (since ${hit.since})` });
    }
  }
  return { violations, idents, checked };
}

/** .bicepparam: `param <ident> = '<retired offer>'` for an ident used as an offer elsewhere. */
export function scanBicepparamAssignments(file, rawText, deny, idents) {
  const text = stripBicepComments(rawText);
  const out = [];
  const re = new RegExp(`^\\s*param\\s+([A-Za-z_]\\w*)\\s*=\\s*${STR}\\s*$`, 'gm');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!idents.has(m[1])) continue;
    const hit = matchDeny(deny, null, m[2]);
    if (hit) {
      const line = lineOf(text, m.index + m[0].indexOf('param'));
      out.push({ file, line, kind: 'retired', message: `${file}:${line}: param ${m[1]} = '${m[2]}' feeds a VM image offer and is RETIRED - ${hit.reason} (since ${hit.since})` });
    }
  }
  return out;
}

function jsonLine(raw, needle) {
  const i = raw.indexOf(needle);
  return i < 0 ? 1 : lineOf(raw, i);
}

export function scanArmJson(file, raw, deny) {
  const violations = [];
  let checked = 0;
  let root;
  try { root = JSON.parse(raw); } catch { return { violations, checked }; }
  const resolve = (val, scope) => {
    if (typeof val !== 'string') return null;
    const m = /^\[\s*(parameters|variables)\(\s*'([^']+)'\s*\)\s*\]$/.exec(val.trim());
    if (!m) return /^\[/.test(val) && !/^\[\[/.test(val) ? null : val;
    if (m[1] === 'parameters') {
      const dv = scope?.parameters?.[m[2]]?.defaultValue;
      return typeof dv === 'string' && !/^\[/.test(dv) ? dv : null;
    }
    const v = scope?.variables?.[m[2]];
    return typeof v === 'string' && !/^\[/.test(v) ? v : null;
  };
  const walk = (node, scope) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, scope)); return; }
    if (!node || typeof node !== 'object') return;
    const sc = node.resources !== undefined && node.parameters !== undefined && (node.$schema || node.contentVersion) ? node : scope;
    if (typeof node.offer === 'string' && typeof node.publisher === 'string') {
      checked++;
      const off = resolve(node.offer, sc);
      const pub = resolve(node.publisher, sc);
      const line = jsonLine(raw, JSON.stringify(node.offer).slice(0, -1)) ;
      if (off === null) {
        violations.push({ file, line, kind: 'unresolvable', message: `${file}:${line}: VM image offer ${JSON.stringify(node.offer)} is an expression that cannot be resolved to a literal, so it cannot be checked against the retired-image denylist.` });
      } else {
        const hit = matchDeny(deny, pub, off);
        if (hit) violations.push({ file, line, kind: 'retired', message: `${file}:${line}: VM image ${hit.publisher}:${off} is RETIRED - ${hit.reason} (since ${hit.since})` });
      }
    }
    for (const v of Object.values(node)) walk(v, sc);
  };
  walk(root, root);
  return { violations, checked };
}

function* walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkFiles(path.join(dir, e.name));
    } else if (/\.(bicep|bicepparam|json)$/i.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

export function scanRoot(root, deny = loadDenylist()) {
  const violations = [];
  let checked = 0;
  const idents = new Set();
  for (const f of walkFiles(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    // The denylist itself names the retired offer by design.
    if (rel === 'scripts/ci/retired-vm-images.json') continue;
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!/offer/i.test(raw)) continue;
    if (/\.json$/i.test(f)) {
      const r = scanArmJson(rel, raw, deny);
      violations.push(...r.violations); checked += r.checked;
    } else {
      const r = scanBicepText(rel, raw, deny);
      violations.push(...r.violations); checked += r.checked;
      r.idents.forEach((i) => idents.add(i));
    }
  }
  // bicepparam files may carry no `offer:` themselves, so re-read them all.
  for (const f of walkFiles(root)) {
    if (!/\.bicepparam$/i.test(f)) continue;
    const rel = path.relative(root, f).split(path.sep).join('/');
    violations.push(...scanBicepparamAssignments(rel, fs.readFileSync(f, 'utf8'), deny, idents));
  }
  return { violations, checked };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = path.resolve(process.argv[2] ?? path.join(HERE, '..', '..'));
  const { violations, checked } = scanRoot(root);
  if (checked === 0) {
    console.error('check-retired-vm-images: FAIL - examined 0 VM image references; the scan is blind (wrong root?).');
    process.exit(1);
  }
  if (violations.length) {
    for (const v of violations) console.error(`::error::${v.message}`);
    console.error(`check-retired-vm-images: FAIL - ${violations.length} violation(s) across ${checked} image reference(s). Retired images: scripts/ci/retired-vm-images.json. Remediate live VMs with scripts/csa-loom/replace-retired-image-vms.mjs (#4672).`);
    process.exit(1);
  }
  console.log(`check-retired-vm-images: OK - ${checked} VM image reference(s) checked, none retired.`);
}
