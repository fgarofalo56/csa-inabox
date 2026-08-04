#!/usr/bin/env node
/**
 * URL-boundary check guard — bans substring validation of URLs.
 *
 * WHY THIS EXISTS. Four call sites validated a URL by searching the WHOLE
 * string for a domain:
 *
 *   endpoint.includes('openai.azure.us')     → https://evil.test/?x=openai.azure.us
 *   vaultUri.includes('.usgovcloudapi.net')  → https://evil.test/.usgovcloudapi.net/
 *   host.includes('.us')                     → login.contoso.com.usercontent.net
 *   url.startsWith('https://learn.microsoft.com')
 *                                            → https://learn.microsoft.com.evil.test/
 *
 * The path, query and fragment are attacker-controlled, so a check that searches
 * them is not a domain check at all. The last one omits the boundary at the
 * other end.
 *
 * The correct rule already existed IN THIS REPO, twice — `cloud-endpoints.ts`
 * carried it with the reasoning written out from CodeQL #540, and `egress-ssrf.ts`
 * had its own copy. The knowledge was present and simply never reached the other
 * four sites. Documentation did not close this class; a grep does.
 *
 * Fix a hit with `lib/util/host-match.ts`:
 *   urlHostHasSuffix(url, 'contoso.com')   // parses, then matches the label
 *   hostHasSuffix(host, 'contoso.com')     // when you already have a hostname
 *
 * Usage: node scripts/ci/check-url-boundary.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

const SCAN = [
  { dir: 'apps/fiab-console/lib', exts: ['.ts', '.tsx'] },
  { dir: 'apps/fiab-console/app', exts: ['.ts', '.tsx'] },
];

const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', '__tests__', '__mocks__', 'coverage']);

/**
 * `.includes('…')` / `.indexOf('…')` / `.startsWith('…')` where the argument
 * looks like a domain (a dotted name ending in a real TLD we use). Deliberately
 * narrow: matching every `.includes()` would drown the signal and get the guard
 * switched off, which is how a control ends up measuring nothing.
 */
const BAD = /\.(includes|indexOf|startsWith)\(\s*(['"`])((?:https?:\/\/)?[A-Za-z0-9*.-]*\.(?:com|net|us|io|org|ai|dev|gov))[^'"`]*\2/g;

/**
 * `.endsWith('registrable.tld')` — the shape with NO leading dot.
 *
 * WHY THIS IS A SEPARATE PATTERN, AND WHY IT WAS MISSING. `host-match.ts` opens
 * by naming five spellings of this bug. Four of them appear in the header above;
 * the fifth is
 *
 *     host.endsWith('azconfig.io')   → evilazconfig.io
 *
 * and it is the ORIGIN of the class — CodeQL #540, the alert `cloud-endpoints.ts`
 * was changed for, and the reason `hostHasSuffix` exists at all. The guard
 * written to close the class never included `endsWith` in its method list, so
 * the one spelling that started it was the one spelling it could not see. A new
 * `host.endsWith('azconfig.io')` anywhere under lib/ or app/ passed silently.
 *
 * The leading dot is the whole distinction, so it is matched precisely rather
 * than by adding `endsWith` to BAD:
 *
 *     host.endsWith('.ghe.com')     SAFE   — the dot IS the label boundary
 *     host.endsWith('ghe.com')      UNSAFE — `evilghe.com` matches
 *
 * Three live sites use the safe form (git-integration-client, updates/apply,
 * git-credential). Folding `endsWith` into BAD would have flagged all three, and
 * three false positives is how a guard gets switched off.
 *
 * Still prefer `hostHasSuffix` for the safe form: `endsWith('.ghe.com')` also
 * rejects the apex `ghe.com`, which is usually not what the author meant.
 */
const BAD_ENDSWITH = /\.endsWith\(\s*(['"`])((?:https?:\/\/)?[A-Za-z0-9*-]+(?:\.[A-Za-z0-9*-]+)*\.(?:com|net|us|io|org|ai|dev|gov))[^'"`]*\1/g;

/**
 * Allowed hits, each with a REASON. An entry here is a claim that the string is
 * not a host boundary check — not a "this one is fine, trust me".
 */
const ALLOW = [
  {
    // The origin+path prefix pins the host: for a URL to start with
    // 'https://h/p/', everything up to the first '/' after the scheme must be
    // exactly 'h'. Prefix matching on a FULL ORIGIN is sound; it is prefix
    // matching that stops inside the host that is not.
    match: (line) => /startsWith\(\s*(['"`])https?:\/\/[^'"`]+\/[^'"`]*\1/.test(line),
    why: 'startsWith on a full origin INCLUDING the trailing slash — the host is pinned',
  },
  {
    match: (line) => /^\s*(\/\/|\*|\/\*)/.test(line),
    why: 'comment',
  },
];

function walk(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/**
 * Findings for one source line. Exported so the self-test can drive the real
 * matcher with fixtures instead of asserting on a copy of the regex — a guard
 * whose test re-implements it is a guard that cannot fail (see #2729).
 *
 * @param {string} line
 * @returns {{needle:string, why:string}[]}
 */
export function scanLine(line) {
  const out = [];
  if (ALLOW.some((a) => a.match(line))) return out;
  BAD.lastIndex = 0;
  let m;
  while ((m = BAD.exec(line)) !== null) {
    out.push({
      needle: m[3],
      why: 'is matched against the whole string — the path, query and fragment are attacker-controlled, so this is not a host check',
    });
  }
  BAD_ENDSWITH.lastIndex = 0;
  while ((m = BAD_ENDSWITH.exec(line)) !== null) {
    out.push({
      needle: m[2],
      why: 'has no leading dot, so it matches a DIFFERENT registrable domain too (evil<suffix>) — the missing label boundary is CodeQL #540',
    });
  }
  return out;
}

function main() {
  const violations = [];
  for (const { dir, exts } of SCAN) {
    for (const file of walk(join(ROOT, dir), exts)) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const f of scanLine(line)) {
          violations.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 120), ...f });
        }
      });
    }
  }

  if (violations.length === 0) {
    console.log('[url-boundary] OK — no substring URL validation found.');
    return 0;
  }

  console.error(`\n[url-boundary] FAIL — ${violations.length} substring URL check(s).\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
    console.error(`    "${v.needle}" ${v.why}.\n`);
  }
  console.error("  Fix: import { urlHostHasSuffix, hostHasSuffix } from '@/lib/util/host-match'");
  console.error('  It parses the URL and matches the host at a DNS label boundary.\n');
  return 1;
}

// Only run when invoked directly, so the self-test can import scanLine().
if (process.argv[1] && process.argv[1].endsWith('check-url-boundary.mjs')) process.exit(main());
