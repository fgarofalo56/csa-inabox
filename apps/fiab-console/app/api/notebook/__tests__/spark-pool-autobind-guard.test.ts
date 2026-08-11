/**
 * GUARD (#3171) — a caller-supplied Spark pool may never be a REQUIRED input.
 *
 * The defect this exists to prevent: three sibling routes each read the Spark
 * pool from the request only (`body.pool` / `?pool=`) and rejected its absence
 * with a bare 400. A freshly created notebook has no saved `bigDataPool`, so the
 * very first Run cell 400'd — `auto-bind-by-default.md` §1 ("creating a Loom item
 * binds its backing resource; the user never performs the plumbing"). A correct
 * server-side resolver already existed and no sibling had adopted it, which is
 * the guard-adoption gap this file closes mechanically.
 *
 * WHY IT IS KEYED THIS WAY. The rule is NOT "the string 'pool is required' must
 * not appear" — adopting the fix deletes that string, so such a rule would go
 * quiet on exactly the files it just certified. It is keyed to the MISMATCH:
 *   a route READS a caller-supplied pool  ⇒  that pool must not be rejectable,
 *                                            and (notebook family) must be run
 *                                            through resolveSparkPool().
 * The trigger is the READ, which the fix does not remove, so the rule keeps
 * watching every fixed file and every new sibling.
 *
 * FAIL-CLOSED PROPERTIES:
 *   • an EMPTY population fails — zero scanned files means the matcher drifted,
 *     not that the repo is clean;
 *   • the three routes the defect was found in must be IN the population by
 *     path — if one is renamed or the marker set stops matching it, that is a
 *     failure, not a silent shrink;
 *   • a pool read whose owning declaration cannot be parsed FAILS rather than
 *     being skipped — an unparseable shape is unknown, and unknown is not safe.
 *
 * CLOUD PARITY: this is a source-shape rule over `app/api/**`, so it is
 * boundary-independent — the same routes serve Commercial, GCC, GCC-High and
 * IL5 (all four param files set `loomSynapseEnabled = true`). There is no
 * per-cloud branch to miss.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const API_ROOT = path.resolve(process.cwd(), 'app', 'api');

/** Livy interactive session/statement helpers — the notebook-execution family. */
const LIVY_MARKER =
  /\b(createLivySession|createLivySessionAsync|submitLivyStatement|getLivyStatement|getLivySession|killLivySession|keepaliveLivySession)\b/;

/** A pool value that arrives from the CALLER (request body or query string). */
const POOL_READ = /body\??\.pool\b|searchParams\.get\('pool'\)|sp\.get\('pool'\)/;

/** The three routes the #3171 defect was found in. Their absence is a failure. */
const REQUIRED_MEMBERS = [
  'app/api/notebook/[id]/execute/route.ts',
  'app/api/notebook/[id]/session/route.ts',
  'app/api/synapse/notebooks/[name]/run-cell/route.ts',
].map((p) => p.split('/').join(path.sep));

/** Those same routes must use the workspace-verifying resolver, not just env. */
const MUST_USE_RESOLVER = REQUIRED_MEMBERS;

function walkRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkRoutes(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

/**
 * A falsy test only counts as a REJECTION when it actually returns an error to
 * the caller. `if (!requestedPool || resolved.source === 'request')` is an
 * eligibility test, not a rejection — reporting it as one would assert a cause
 * the code never established (deploy-integrity R7).
 */
const REJECTING_RETURN = /return[^;]*status:\s*[45]\d\d|\bjerr\s*\(|\bapiBadRequest\s*\(/;
/** How many lines after the `if` to look for the rejecting return. */
const REJECT_WINDOW = 3;

interface PoolRead {
  line: number;
  text: string;
  /** Identifier the caller-supplied pool was bound to. */
  variable: string;
}

/** Split on either line ending — a trailing \r defeats `.` and `$` in JS regex. */
function lines(source: string): string[] {
  return source.replace(/\r\n?/g, '\n').split('\n');
}

/** Strip `//` trailing comments and whole-line JSDoc/block-comment bodies. */
function codeOf(line: string): string {
  if (/^\s*(\*|\/\*)/.test(line)) return '';
  return line.replace(/\/\/.*/, '');
}

/**
 * Extract the variable a caller-supplied pool read is bound to. Returns null
 * when the shape is not a single-line declaration — the caller FAILS on null
 * rather than skipping, because an unattributable read is unknown, not safe.
 */
function poolReadVariable(line: string): string | null {
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/.exec(line);
  return decl ? decl[1] : null;
}

function poolReads(source: string): { reads: PoolRead[]; unparseable: { line: number; text: string }[] } {
  const reads: PoolRead[] = [];
  const unparseable: { line: number; text: string }[] = [];
  lines(source).forEach((raw, i) => {
    // Comments describe the rule; they are not code that reads a pool.
    const code = codeOf(raw);
    if (!POOL_READ.test(code)) return;
    const v = poolReadVariable(code);
    if (v) reads.push({ line: i + 1, text: raw.trim(), variable: v });
    else unparseable.push({ line: i + 1, text: raw.trim() });
  });
  return { reads, unparseable };
}

/**
 * Lines where `variable` is tested for falsiness AND the branch returns an
 * HTTP 4xx/5xx within REJECT_WINDOW lines — i.e. an absent caller-supplied
 * pool is rejected. That is the #3171 defect.
 */
function falsyRejections(source: string, variable: string): { line: number; text: string }[] {
  const v = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`if\\s*\\(\\s*!\\s*${v}\\b`),
    new RegExp(`!\\s*${v}\\s*(\\|\\||&&)`),
    new RegExp(`(\\|\\||&&)\\s*!\\s*${v}\\b`),
  ];
  const src = lines(source);
  const hits: { line: number; text: string }[] = [];
  src.forEach((raw, i) => {
    const code = codeOf(raw);
    if (!patterns.some((p) => p.test(code))) return;
    const window = src.slice(i, i + 1 + REJECT_WINDOW).map(codeOf).join('\n');
    if (REJECTING_RETURN.test(window)) hits.push({ line: i + 1, text: raw.trim() });
  });
  return hits;
}

const rel = (f: string) => path.relative(process.cwd(), f);

describe('#3171 guard — a caller-supplied Spark pool is never REQUIRED', () => {
  it('the API tree exists and yields a non-empty population', () => {
    expect(existsSync(API_ROOT), `${API_ROOT} must exist — otherwise this guard scans nothing`).toBe(true);
    const routes = walkRoutes(API_ROOT);
    expect(routes.length, 'zero route.ts files scanned means the matcher drifted').toBeGreaterThan(0);
  });

  const population = walkRoutes(API_ROOT).filter((f) => {
    const s = readFileSync(f, 'utf8');
    return LIVY_MARKER.test(s) && POOL_READ.test(s);
  });

  it('the population is non-empty and still contains all three defect routes', () => {
    expect(
      population.length,
      'no route both drives Livy and reads a caller-supplied pool — the matcher drifted, ' +
        'this is NOT evidence the repo is clean',
    ).toBeGreaterThan(0);
    const relPaths = population.map(rel);
    for (const member of REQUIRED_MEMBERS) {
      expect(
        relPaths,
        `${member.split(path.sep).join('/')} must be in the scanned population — if it moved, ` +
          'update REQUIRED_MEMBERS deliberately rather than letting the guard shrink silently',
      ).toContain(member);
    }
  });

  it('every caller-supplied pool read is attributable to a declaration', () => {
    for (const file of population) {
      const { unparseable } = poolReads(readFileSync(file, 'utf8'));
      expect(
        unparseable.map((u) => `${rel(file)}:${u.line}  ${u.text}`),
        `${rel(file)}: a caller-supplied pool read that this guard cannot attribute to a ` +
          'declaration is UNKNOWN, not safe — rewrite it as a single-line const, or teach ' +
          'poolReadVariable() the new shape',
      ).toEqual([]);
    }
  });

  it('no route rejects a caller-supplied pool for being absent', () => {
    const violations: string[] = [];
    for (const file of population) {
      const source = readFileSync(file, 'utf8');
      const { reads } = poolReads(source);
      for (const read of reads) {
        for (const hit of falsyRejections(source, read.variable)) {
          violations.push(
            `${rel(file)}:${hit.line} tests "${read.variable}" (read from the caller at line ` +
              `${read.line}) for falsiness and returns an HTTP error within ${REJECT_WINDOW} lines — ` +
              `an absent caller-supplied pool must be resolved server-side, not rejected: ${hit.text}`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the notebook execute/session/run-cell routes resolve through resolveSparkPool', () => {
    const violations: string[] = [];
    for (const file of population) {
      if (!MUST_USE_RESOLVER.includes(rel(file))) continue;
      const source = readFileSync(file, 'utf8');
      if (!/resolveSparkPool\s*\(/.test(source)) {
        violations.push(
          `${rel(file)} reads a caller-supplied pool but never calls resolveSparkPool() — the ` +
            'env-only defaultSparkPool() is NOT sufficient here: its terminal fallback is the ' +
            "literal 'loompool', which the live estate replaced with loompool2.",
        );
        continue;
      }
      const { reads } = poolReads(source);
      for (const read of reads) {
        const consumed = new RegExp(`resolveSparkPool\\s*\\(\\s*${read.variable}\\b`).test(source);
        if (!consumed) {
          violations.push(
            `${rel(file)}:${read.line} binds the caller's pool to "${read.variable}", but no ` +
              `resolveSparkPool(${read.variable}) consumes it — that read bypasses auto-bind.`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
