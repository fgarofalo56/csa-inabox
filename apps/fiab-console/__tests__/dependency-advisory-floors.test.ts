/**
 * Dependency-floor guard for the Batch-1 transitive advisories (refs #2671).
 *
 * WHAT THIS PROTECTS, AND WHY IT IS NOT JUST A VERSION STRING CHECK.
 *
 * Five advisories landed against four transitive packages in this manifest.
 * None of them appears in package.json, so there is no direct dependency to
 * bump — the floors live in `pnpm.overrides`. There are two distinct ways
 * that fix can silently stop working, and this file catches BOTH:
 *
 *  1. TOO LOW — an override is dropped or weakened, or a re-resolve floats a
 *     vulnerable version back in. Caught by the lockfile + resolution floors.
 *
 *  2. TOO BROAD — someone "simplifies" the three per-major brace-expansion
 *     entries into one blanket `brace-expansion: '>=5.0.7'`. That reads
 *     tidier and is a hard break, because the package's PUBLIC SHAPE differs
 *     across its majors:
 *
 *        1.x / 2.x  ->  module.exports = expandTop   (callable)
 *        4.x        ->  ESM-only, no CJS entry
 *        5.x        ->  exports.expand = expand      (NOT callable)
 *
 *     minimatch@3 does `var expand = require('brace-expansion')` then
 *     `expand(pattern)`. Give it a 5.x and every eslint run dies with
 *     "expand is not a function" — at runtime, in a devDependency, which no
 *     type-check and no unit test of application code would ever notice.
 *     Caught by the callability assertion, which resolves the module exactly
 *     the way minimatch resolves it and then inspects what came back.
 *
 * WHAT THIS DELIBERATELY DOES *NOT* MEASURE, and why. The first draft listed
 * the directories under `node_modules/.pnpm` and failed if a vulnerable
 * version was present. That was wrong, and it was caught by running it:
 * **pnpm 9 does not prune the virtual store on install.** After moving the
 * floors up and reinstalling, `node_modules/.pnpm` still held js-yaml@4.1.1
 * AND js-yaml@4.3.1 side by side, so the check went red on a tree that was
 * in fact fully patched. A guard that fires on orphaned directories is noise,
 * and noise is how a real signal gets ignored.
 *
 * The two things that ARE authoritative:
 *   - pnpm-lock.yaml — what a clean `pnpm install` (CI, and the Dockerfile)
 *     will materialise, and what dependency scanners actually read.
 *   - `require.resolve` from each real consumer — what the code loads. This
 *     follows the symlink graph, so a stale orphan in the store cannot fool
 *     it (verified: with 4.1.1 and 4.3.1 both on disk, @eslint/eslintrc
 *     resolves 4.3.1).
 *
 * That distinction is the whole lesson of #2729: a floor declared, a lockfile
 * updated and CI green, while the shipped image resolved the unpatched
 * version anyway. Assert the fact, not the claim.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const LOCKFILE = join(CONSOLE_ROOT, 'pnpm-lock.yaml');
const PNPM_STORE = join(CONSOLE_ROOT, 'node_modules', '.pnpm');

/** [major, minor, patch] */
function parse(v: string): [number, number, number] {
  const [a, b, c] = v.split('.').map((n) => parseInt(n, 10));
  return [a, b, c];
}

/** true when `v` >= `floor`, numerically — string compare would call 1.1.9 > 1.1.16. */
function gte(v: string, floor: string): boolean {
  const a = parse(v);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/**
 * Every version of `name` the lockfile resolves.
 *
 * Only matches `packages:` / `snapshots:` keys, which are `  name@x.y.z:` at
 * exactly two spaces and end in a colon. The `overrides:` block sits at the
 * same indent and holds keys like `brace-expansion@1: '>=1.1.16 <2'` — those
 * are excluded twice over: the version must be a full three-part semver, and
 * the line must end at the colon with no value after it.
 */
function lockedVersions(lock: string, name: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`^ {2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@(\\d+\\.\\d+\\.\\d+[^:]*):$`, 'gm');
  for (const m of lock.matchAll(re)) {
    // Drop any peer-dependency suffix, e.g. `1.2.3(react@19.0.0)`.
    out.add(m[1].replace(/\(.*$/, ''));
  }
  return [...out].sort();
}

const lock = readFileSync(LOCKFILE, 'utf8');

/** Floors are per-major: a parent's declared range cannot cross a major. */
const FLOORS: Array<{ pkg: string; major: number; floor: string; why: string }> = [
  { pkg: 'js-yaml', major: 4, floor: '4.3.1', why: 'advisories fixed in 4.2.0 and 4.3.0' },
  { pkg: 'form-data', major: 4, floor: '4.0.6', why: 'advisory fixed in 4.0.6' },
  { pkg: 'brace-expansion', major: 1, floor: '1.1.16', why: 'advisory fixed in the 1.1.x line' },
  { pkg: 'brace-expansion', major: 2, floor: '2.1.2', why: 'advisory fixed in 2.1.2' },
  { pkg: 'brace-expansion', major: 5, floor: '5.0.7', why: 'advisory fixed in 5.0.7' },
];

const BANNED: ReadonlyArray<readonly [string, string]> = [
  ['js-yaml', '4.1.1'],
  ['form-data', '4.0.5'],
  ['brace-expansion', '1.1.14'],
  ['brace-expansion', '2.1.1'],
  ['brace-expansion', '5.0.6'],
];

describe('Batch-1 advisory floors — pnpm-lock.yaml (what a clean install produces)', () => {
  for (const { pkg, major, floor, why } of FLOORS) {
    it(`${pkg} ${major}.x resolves >= ${floor} (${why})`, () => {
      const inMajor = lockedVersions(lock, pkg).filter((v) => parse(v)[0] === major);
      // The lockfile must actually contain this major — otherwise the
      // assertion below would pass over an empty list and prove nothing.
      expect(inMajor.length, `${pkg} ${major}.x is absent from the lockfile; this guard would be vacuous`)
        .toBeGreaterThan(0);
      for (const v of inMajor) {
        expect(gte(v, floor), `${pkg}@${v} is below the ${floor} floor`).toBe(true);
      }
    });
  }

  it('no vulnerable version of any Batch-1 package is resolved', () => {
    const stillHere = BANNED.filter(([n, v]) => lockedVersions(lock, n).includes(v)).map(([n, v]) => `${n}@${v}`);
    expect(stillHere, `vulnerable versions still in the lockfile: ${stillHere.join(', ')}`).toEqual([]);
  });
});

// The resolution assertions need an installed tree. vitest cannot run without
// one, so in practice this never skips; the guard is here so the file degrades
// honestly rather than throwing if it is ever run against a bare checkout.
describe.skipIf(!existsSync(PNPM_STORE))('Batch-1 floors — what each consumer actually resolves', () => {
  /** Resolve `dep` the way `consumer` resolves it: version + declared range. */
  function resolveFrom(consumer: string, dep: string): { version: string; declared: string | undefined; mod: unknown } {
    const req = createRequire(join(PNPM_STORE, consumer, 'node_modules', 'x', 'package.json'));
    const version = JSON.parse(readFileSync(req.resolve(`${dep}/package.json`), 'utf8')).version as string;
    const consumerName = consumer.replace(/@\d.*$/, '').replace('+', '/');
    const consumerPkg = JSON.parse(
      readFileSync(join(PNPM_STORE, consumer, 'node_modules', consumerName, 'package.json'), 'utf8'),
    );
    let mod: unknown;
    try {
      mod = req(dep);
    } catch (e) {
      mod = e;
    }
    return { version, declared: consumerPkg.dependencies?.[dep], mod };
  }

  /** The exact virtual-store dirs for the consumers this batch touches. */
  const CONSUMERS: Array<{ dir: string; dep: string; floor: string; callable: boolean }> = [
    { dir: 'minimatch@3.1.5', dep: 'brace-expansion', floor: '1.1.16', callable: true },
    { dir: 'minimatch@9.0.9', dep: 'brace-expansion', floor: '2.1.2', callable: true },
    // minimatch 10 is the ONLY consumer that wants the named-export 5.x shape.
    { dir: 'minimatch@10.2.5', dep: 'brace-expansion', floor: '5.0.7', callable: false },
    { dir: '@eslint+eslintrc@3.3.5', dep: 'js-yaml', floor: '4.3.1', callable: false },
    { dir: 'jsdom@25.0.1', dep: 'form-data', floor: '4.0.6', callable: false },
  ];

  for (const { dir, dep, floor, callable } of CONSUMERS) {
    const present = existsSync(join(PNPM_STORE, dir));
    // A pinned consumer version can legitimately move under us (a later
    // minimatch, a later jsdom). Skipping is honest; asserting against a
    // directory that no longer exists would be a false failure.
    it.skipIf(!present)(`${dir} resolves ${dep} >= ${floor}`, () => {
      const { version, declared } = resolveFrom(dir, dep);
      expect(gte(version, floor), `${dir} resolved ${dep}@${version}, below the ${floor} floor`).toBe(true);
      // And it must not have jumped a major past what the consumer declared —
      // that is the blanket-override failure mode.
      if (declared) {
        const declaredMajor = parseInt(declared.replace(/^[^\d]*/, ''), 10);
        expect(
          parse(version)[0],
          `${dir} declares ${dep} "${declared}" but resolved ${version} — an override crossed a major boundary`,
        ).toBe(declaredMajor);
      }
    });

    if (callable) {
      it.skipIf(!present)(`${dir} gets a CALLABLE ${dep} (blanket-override detector)`, () => {
        const { mod, version } = resolveFrom(dir, dep);
        expect(
          typeof mod,
          `${dir} does \`require('${dep}')(pattern)\`, so it needs a function; ` +
            `got ${typeof mod} from ${dep}@${version}` +
            (typeof mod === 'object' && mod ? ` with keys [${Object.keys(mod)}]` : '') +
            '. This is exactly what a single blanket brace-expansion override produces.',
        ).toBe('function');
      });
    }
  }

  // ── CONTROL ─────────────────────────────────────────────────────────────
  // Passes before the floors, after them, and under a blanket override too.
  // Its job is to fail only if the probe itself is pointed at nothing — so an
  // "everything green" result cannot come from an empty or unresolvable tree.
  it('CONTROL: the console dependency tree is present and resolvable', () => {
    const req = createRequire(join(CONSOLE_ROOT, 'package.json'));
    expect(() => req.resolve('typescript/package.json')).not.toThrow();
    expect(() => req.resolve('minimatch/package.json')).not.toThrow();
    expect(lockedVersions(lock, 'minimatch').length).toBeGreaterThan(0);
  });
});

/**
 * The #2729 class: a floor declared in only ONE of the two homes is inert
 * under the other pnpm major, silently, with CI green. pnpm 9 (which builds
 * the image) reads package.json `pnpm.overrides`; pnpm 10+ reads
 * pnpm-workspace.yaml. scripts/ci/check-pnpm-overrides.mjs enforces the
 * general rule; this pins it for the Batch-1 keys so the guard travels with
 * the fix rather than living only in a CI script.
 */
describe('Batch-1 overrides are declared in BOTH pnpm homes', () => {
  const KEYS = ['js-yaml', 'form-data', 'brace-expansion@1', 'brace-expansion@2', 'brace-expansion@5'];

  const pkgOverrides = (JSON.parse(readFileSync(join(CONSOLE_ROOT, 'package.json'), 'utf8')).pnpm?.overrides ??
    {}) as Record<string, string>;

  const wsOverrides: Record<string, string> = {};
  {
    let inBlock = false;
    for (const raw of readFileSync(join(CONSOLE_ROOT, 'pnpm-workspace.yaml'), 'utf8').split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (/^overrides:\s*$/.test(line)) { inBlock = true; continue; }
      if (!inBlock) continue;
      if (/^\S/.test(line)) break;
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s+(?:'([^']+)'|"([^"]+)"|([^:\s]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/);
      if (m) wsOverrides[m[1] || m[2] || m[3]] = m[4] ?? m[5] ?? m[6];
    }
  }

  for (const key of KEYS) {
    it(`"${key}" is declared identically in package.json and pnpm-workspace.yaml`, () => {
      expect(pkgOverrides[key], 'missing from package.json pnpm.overrides — inert under pnpm 9').toBeDefined();
      expect(wsOverrides[key], 'missing from pnpm-workspace.yaml — inert under pnpm 10+').toBeDefined();
      expect(wsOverrides[key]).toBe(pkgOverrides[key]);
    });
  }

  it('brace-expansion is scoped per major, never declared blanket', () => {
    const msg =
      'a blanket "brace-expansion" override crosses majors and breaks minimatch@3 at runtime — ' +
      'keep the brace-expansion@1 / @2 / @5 entries separate';
    expect('brace-expansion' in pkgOverrides, msg).toBe(false);
    expect('brace-expansion' in wsOverrides, msg).toBe(false);
  });

  it('every Batch-1 floor carries a major ceiling', () => {
    // A pnpm override REPLACES the parent's range rather than intersecting it.
    // Proof in this very manifest: `uuid: '>=11.1.1'` resolved uuid 14 — three
    // majors past anything a parent asked for. A bare `>=` floor on these five
    // would float them into majors their parents never declared support for.
    for (const key of KEYS) {
      expect(pkgOverrides[key], `${key} floor must be bounded, got "${pkgOverrides[key]}"`).toMatch(/<\s*\d/);
    }
  });
});
