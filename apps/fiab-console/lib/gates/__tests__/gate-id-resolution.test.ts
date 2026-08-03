/**
 * G2 CLASS GUARD — every gate id referenced in shipped source must name a REAL
 * registry gate. (issue #2624, the half `route-gate-codes.test.ts` scoped out.)
 *
 * WHY THIS EXISTS, and why it is a different check from its sibling.
 *
 * `route-gate-codes.test.ts` pins the *wire codes* one route emits, and says so:
 * it is "deliberately NOT widened to every route in the repo" because most
 * routes still return legacy bespoke codes that predate the registry. That
 * reasoning is right for codes — and it leaves the *gate id* population
 * unguarded, which is a much smaller, fully-migrated set with a far worse
 * failure mode:
 *
 *   `backendGateResponse(id)` reads `gateStatus(id)`, which is `undefined` for
 *   an id that is not an ENV_CHECKS spec. The old `if (status && ...)` then fell
 *   through to `return null` — "not gated" — so `withBackendGate('typo')` wrapped
 *   a route in a gate that COULD NOT FIRE. No error, no log, a green test suite,
 *   and a surface that reports itself as gated while gating nothing. That is the
 *   same class as #2624's orphan codes, one layer down: a control that runs and
 *   reports a confident answer it never established.
 *
 * `gate-envelope.test.ts` cannot catch this: it `vi.mock`s the whole registry,
 * so every id it passes "resolves" by construction. Only a check that reads the
 * REAL registry can tell a live gate id from a dead one — which is why this file
 * imports `getGate` rather than mocking it.
 *
 * Scanning SOURCE rather than exercising handlers is deliberate (same rationale
 * as the sibling): a handler test only covers the branches its mocks reach, so a
 * gate added tomorrow behind an un-mocked condition would sail past it.
 *
 * Comment-stripping is load-bearing. `route-toolkit.ts` carries JSDoc usage
 * examples, and two of them named gate ids that do not exist (`svc-purview`,
 * `svc-costmgmt` — fixed in this change). A scanner that did not strip comments
 * would have reported those doc examples as live defects; one that treated a
 * commented id as a *declaration* would let a real typo hide behind a comment.
 * Both directions are asserted below.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGate } from '../registry';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_DIRS = ['app', 'lib'];

/** Strip block + line comments so a JSDoc example is never read as a call site. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Wrapper/helper calls whose FIRST argument is a registry gate id. */
const CALL_RE =
  /\b(withBackendGate|apiHonestGateError|backendGateResponse|buildGateEnvelope)\(\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*))/g;
/** `<HonestGate gateId="…">` / `{ gateId: '…' }` / `gateId={CONST}`. */
const PROP_RE = /\bgateId(?:=|:\s*)(?:"([^"]+)"|'([^']+)'|\{\s*([A-Z][A-Z0-9_]*)\s*\})/g;
/** `export const SOMETHING_GATE_ID = 'svc-…'` — the indirection call sites use. */
const CONST_RE = /export const ([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g;

export interface GateIdSite {
  file: string;
  line: number;
  via: string;
  raw: string;
  id: string | undefined;
}

/** Collect `CONST -> literal` from one source. */
export function collectConsts(src: string, into: Map<string, string>): Map<string, string> {
  for (const m of stripComments(src).matchAll(CONST_RE)) into.set(m[1], m[2]);
  return into;
}

/** Find every gate-id site in one source. `id` is undefined when a const is unresolved. */
export function scanSource(src: string, consts: Map<string, string>, file = '<mem>'): GateIdSite[] {
  const clean = stripComments(src);
  const lineOf = (i: number) => clean.slice(0, i).split('\n').length;
  const out: GateIdSite[] = [];
  for (const m of clean.matchAll(CALL_RE)) {
    const raw = m[2] ?? m[3];
    out.push({ file, line: lineOf(m.index!), via: m[1], raw, id: m[2] ?? consts.get(m[3]) });
  }
  for (const m of clean.matchAll(PROP_RE)) {
    const raw = m[1] ?? m[2] ?? m[3];
    out.push({ file, line: lineOf(m.index!), via: 'gateId-prop', raw, id: m[1] ?? m[2] ?? consts.get(m[3]) });
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(APP, d)));
const CONSTS = FILES.reduce((acc, f) => collectConsts(fs.readFileSync(f, 'utf8'), acc), new Map<string, string>());
const SITES = FILES.flatMap((f) => scanSource(fs.readFileSync(f, 'utf8'), CONSTS, path.relative(APP, f)));

describe('every referenced gate id resolves to a registry gate (G2 class)', () => {
  it('scans a real corpus and finds real sites — not vacuously green', () => {
    // A scanner that read 0 files, or found 0 sites, would pass the assertion
    // below while measuring nothing. Floors are set well under the current
    // counts so ordinary churn does not trip them.
    expect(FILES.length, 'scanned no source files — is APP resolving?').toBeGreaterThan(500);
    expect(SITES.length, 'found no gate-id call sites — has the wrapper API changed?').toBeGreaterThan(40);
    expect(CONSTS.size, 'resolved no *_GATE_ID constants').toBeGreaterThan(0);
  });

  it('the *_GATE_ID indirection actually resolves (no silent undefined)', () => {
    // If a const failed to resolve, `id` would be undefined and the check below
    // would report it — but only if the indirection is exercised at all. Pin the
    // constants the client modules export so this stays true.
    for (const name of ['ICEBERG_CATALOG_GATE_ID', 'DUCKLAKE_GATE_ID', 'TRINO_GATE_ID', 'RISINGWAVE_GATE_ID']) {
      expect(CONSTS.get(name), `${name} did not resolve to a literal`).toMatch(/^svc-/);
    }
    expect(SITES.filter((s) => s.via !== 'gateId-prop').length).toBeGreaterThan(20);
  });

  it('no gate id names a gate that is not in the registry', () => {
    const unresolved = SITES.filter((s) => !s.id || !getGate(s.id));
    expect(
      unresolved.map((s) => `${s.file}:${s.line} via ${s.via} -> ${s.raw}`),
      'each of these passes an id the registry does not know; withBackendGate/backendGateResponse ' +
        'would produce a gate that cannot evaluate, and the Fix-it deep link would open /admin/gates ' +
        'on a gate that is not listed there',
    ).toEqual([]);
  });

  /**
   * CONTROL — passes BEFORE and AFTER the fix. Proves the detector actually
   * discriminates: if `getGate` were widened to answer "yes" for anything, or
   * the regexes stopped matching, the assertion above would still be green.
   */
  it('CONTROL: the scanner flags a bogus id and the registry rejects it', () => {
    const fixture = `
      export const FAKE_GATE_ID = 'svc-not-a-real-gate-2624';
      export const GET = withBackendGate('svc-definitely-missing-2624', h);
      export const PUT = apiHonestGateError(FAKE_GATE_ID);
      const el = <HonestGate gateId="svc-also-missing-2624" />;
    `;
    const consts = collectConsts(fixture, new Map());
    const sites = scanSource(fixture, consts);
    expect(sites.map((s) => s.id).sort()).toEqual([
      'svc-also-missing-2624',
      'svc-definitely-missing-2624',
      'svc-not-a-real-gate-2624',
    ]);
    // …and every one of them is genuinely unknown to the real registry.
    expect(sites.filter((s) => !s.id || !getGate(s.id))).toHaveLength(3);
    // Sanity in the other direction: a REAL id must resolve, otherwise the
    // "no unresolved ids" result above could be an artefact of getGate failing
    // for everything.
    expect(getGate('svc-adf')).toBeDefined();
  });

  /**
   * CONTROL — comment handling, both directions. A commented-out call must not
   * be reported as a defect (this is what made `route-toolkit.ts`'s JSDoc look
   * like two violations), and a commented-out CONSTANT must not be treated as a
   * declaration that satisfies a live reference.
   */
  it('CONTROL: comments neither raise nor suppress a finding', () => {
    const commentedCall = `
      /** Example: withBackendGate('svc-totally-fake-2624', handler) */
      // withBackendGate('svc-another-fake-2624', handler)
      export const GET = withBackendGate('svc-adf', h);
    `;
    const sites = scanSource(commentedCall, new Map());
    expect(sites.map((s) => s.id)).toEqual(['svc-adf']);

    const commentedConst = `
      // export const SNEAKY_GATE_ID = 'svc-adf';
      export const GET = withBackendGate(SNEAKY_GATE_ID, h);
    `;
    const consts = collectConsts(commentedConst, new Map());
    expect(consts.has('SNEAKY_GATE_ID')).toBe(false);
    const sneaky = scanSource(commentedConst, consts);
    expect(sneaky).toHaveLength(1);
    expect(sneaky[0].id).toBeUndefined(); // unresolved -> reported, not silently passed
  });
});
