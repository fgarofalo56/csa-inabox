/**
 * THE EXTRACTOR'S OWN POPULATION CONTRACT.
 *
 * These two helpers are what makes a loop-level narrowing inside the extractor
 * fatal instead of invisible. On 2026-08-24 an independent review injected one
 * `continue` on `/admin/` into `extractRouteNodes`, regenerated, and measured
 * 909 -> 511 nodes (-44%, -65% of authorizers) with the generator RC=0, the
 * drift gate RC=0 ("OK — 511 nodes") and 77/77 vitest green — because
 * `inputsDigest`, `filesScanned` and `skipped` all held identical.
 *
 * A guard is only a guard if it goes red when it should, so both the POSITIVE
 * and the NEGATIVE arm are asserted here. A spec that only ever exercises the
 * passing path cannot distinguish a working contract from a `return`.
 */

import { describe, expect, it } from 'vitest';
import { assertCensusAgrees, assertEveryCandidateJudged } from '../population-contract';
import { buildSecurityGraphArtifact } from '../build';
import type { SourceFile } from '../types';

describe('assertEveryCandidateJudged', () => {
  it('accepts a walk that produced a verdict for every candidate', () => {
    expect(() => assertEveryCandidateJudged('w', ['a', 'b'], ['a', 'b'])).not.toThrow();
  });

  it('accepts the verdicts in a different ORDER — it is a set contract, not a sequence', () => {
    expect(() => assertEveryCandidateJudged('w', ['a', 'b'], ['b', 'a'])).not.toThrow();
  });

  it('THROWS when a candidate left the loop without a verdict (the `continue` shape)', () => {
    expect(() => assertEveryCandidateJudged('extractRouteNodes', ['a', 'b', 'c'], ['a', 'c'])).toThrow(
      /1 of 3 subject\(s\) entered the population and left it WITHOUT a verdict/,
    );
  });

  it('names the missing subject, so the failure is actionable rather than a count', () => {
    expect(() => assertEveryCandidateJudged('w', ['a', 'b'], ['a'])).toThrow(/\bb\b/);
  });

  it('THROWS on a duplicate verdict — a padded list restores the count while narrowing the set', () => {
    // The same evasion `join.ts#assertJoinCoversGraph` refuses: judging 'a'
    // twice makes judged.length match candidates.length while 'b' is dropped.
    expect(() => assertEveryCandidateJudged('w', ['a', 'b'], ['a', 'a'])).toThrow(/judged twice/);
  });

  it('THROWS on a duplicate candidate — the denominator must be a count of distinct subjects', () => {
    expect(() => assertEveryCandidateJudged('w', ['a', 'a'], ['a'])).toThrow(
      /entered the population twice/,
    );
  });

  it('THROWS when something was judged that was never enumerated', () => {
    expect(() => assertEveryCandidateJudged('w', ['a'], ['a', 'z'])).toThrow(
      /never enumerated as candidates/,
    );
  });

  it('accepts an empty population — emptiness is the CALLER’s to refuse', () => {
    // `scripts/brain/extract-security-graph.mjs` already exits 1 on a zero-node
    // graph. Duplicating that refusal here would make this helper unusable for a
    // legitimately empty scope.
    expect(() => assertEveryCandidateJudged('w', [], [])).not.toThrow();
  });
});

describe('assertCensusAgrees', () => {
  it('accepts agreement', () => {
    expect(() => assertCensusAgrees('scope', 1692, 1692, 'how')).not.toThrow();
  });

  it('THROWS when the walk examined FEWER subjects than an independent census counts', () => {
    expect(() => assertCensusAgrees('app/**/route.ts', 1492, 1692, 'isRouteModule')).toThrow(
      /examined 1492 subject\(s\) but an independent census counts 1692/,
    );
  });

  it('THROWS when the walk examined MORE — disagreement in either direction is fatal', () => {
    expect(() => assertCensusAgrees('scope', 10, 4, 'how')).toThrow(/independent census counts 4/);
  });

  it('names the independent derivation, so the message does not assert a cause it did not establish', () => {
    expect(() => assertCensusAgrees('scope', 1, 2, 'build.ts#isRouteModule')).toThrow(
      /build\.ts#isRouteModule/,
    );
  });
});

// ── THE BUILD-LEVEL LEDGER ───────────────────────────────────────────────────

const NOW = new Date('2026-08-24T12:00:00.000Z');

const CORPUS: SourceFile[] = [
  {
    path: 'apps/fiab-console/app/api/alpha/route.ts',
    text: `export const GET = withTenantAdmin(async () => ok());`,
  },
  {
    path: 'scripts/ci/some-guard.mjs',
    text: `console.log('hello');`,
  },
];

/** The real ALLOWLIST_PREFIXES shape, so the parser has something to succeed on. */
const GUARD_SOURCE = `
const ALLOWLIST_PREFIXES = [
  ['apps/fiab-console/app/api/setup/', 'setup wizard runs pre-auth'],
];
`;

function build(overrides: Partial<Parameters<typeof buildSecurityGraphArtifact>[0]> = {}) {
  return buildSecurityGraphArtifact({
    files: CORPUS,
    publicationRoots: ['scripts/'],
    routeGuardSource: GUARD_SOURCE,
    commit: null,
    now: NOW,
    ...overrides,
  });
}

const allowlistEntries = (a: ReturnType<typeof build>) =>
  a.meta.skipped.filter((s) => s.subject.includes('ALLOWLIST_PREFIXES'));

describe('the allowlist parse cannot degrade silently', () => {
  // MEASURED, 2026-08-24. Renaming `ALLOWLIST_PREFIXES` upstream took the
  // `allowlisted: true` count from 23 to 0 while the node count (909), the
  // skipped count (243) and the inputs digest all stayed IDENTICAL, and the
  // suite stayed green. `route-nodes.ts#parseAllowlistPrefixes` returns `[]` for
  // BOTH "declares none" and "declared under a name I no longer find", and only
  // the null-SOURCE case was ever recorded.

  it('records NOTHING when the parse actually found prefixes (control)', () => {
    // Without this arm the assertion below cannot tell a working ledger from one
    // that fires unconditionally.
    expect(allowlistEntries(build())).toHaveLength(0);
  });

  it('RECORDS the gap when the source is PRESENT but the parse yields zero prefixes', () => {
    const a = build({ routeGuardSource: 'const ALLOWLIST_PREFIXES_RENAMED = [];' });
    expect(allowlistEntries(a)).toHaveLength(1);
    expect(allowlistEntries(a)[0].reason).toContain('UNDERSTATE C3');
  });

  it('does not assert WHICH cause it was — the extractor cannot establish that', () => {
    // deploy-integrity.md R7: an error must not state as fact something it did
    // not establish. "Renamed" and "genuinely empty" are indistinguishable here.
    const reason = allowlistEntries(build({ routeGuardSource: 'const NOPE = [];' }))[0].reason;
    expect(reason).toContain('does not establish which');
  });

  it('still records the ABSENT-source case separately', () => {
    // #4057 — THE SUBJECT IS ONE LITERAL AGAIN, and that reversion is the
    // acceptance test for that issue.
    //
    // It used to be asserted in two halves (prefix + suffix) because
    // `__tests__/spec-imported-scripts-have-no-shebang.test.ts` treated any
    // quoted `scripts/**.mjs` literal inside a spec as an IMPORT of that script,
    // and `check-route-guards.mjs` correctly carries a `#!` line. That guard
    // reddened over this spec on PR #4022 — while this spec's 20 tests RAN AND
    // PASSED in the same suite, making the guard's own message ("the listed
    // spec(s) are NOT RUNNING AT ALL") false in that instance. The guard now
    // reads the IMPORT GRAPH: this spec imports only `vitest` and three `../`
    // siblings, so naming the path here is a mention and costs nothing.
    const a = build({ routeGuardSource: null });
    const absent = a.meta.skipped.filter((s) => s.subject === 'scripts/ci/check-route-guards.mjs');
    expect(absent).toHaveLength(1);
  });
});

describe('a declared scan root that was never walked cannot survive', () => {
  it('THROWS when a declared publication root matched zero supplied files', () => {
    // The structural half of the `.github/**` fix: until 2026-08-24 the artifact
    // declared a root the CLI did not walk, and nothing could tell.
    expect(() => build({ publicationRoots: ['scripts/', '.github/'] })).toThrow(
      /declared publication root '\.github\/' matched ZERO supplied files/,
    );
  });

  it('accepts a root that did match, and DERIVES the reported scope from it', () => {
    const a = build({
      files: [...CORPUS, { path: '.github/scripts/notify.mjs', text: `console.log('x');` }],
      publicationRoots: ['scripts/', '.github/'],
    });
    const publication = a.meta.scanScopes.find((s) => s.scope.includes('publication surfaces'));
    expect(publication?.scope).toContain('.github/**');
    expect(publication?.scope).toContain('scripts/**');
  });

  it('reports what it saw under a scanned root and could not read, WITH A COUNT', () => {
    const a = build({
      unmodeledPublicationSurfaces: [
        { root: '.github/', fileCount: 141, extensions: ['.sh', '.yml'] },
      ],
    });
    const unread = a.meta.skipped.filter((s) => s.reason.includes('were seen and NOT read'));
    expect(unread).toHaveLength(1);
    expect(unread[0].reason).toContain('141 file(s)');
    expect(unread[0].subject).toContain('*.yml');
  });

  it('records nothing for a root with zero unread files (control)', () => {
    const a = build({
      unmodeledPublicationSurfaces: [{ root: 'scripts/', fileCount: 0, extensions: [] }],
    });
    expect(a.meta.skipped.filter((s) => s.reason.includes('were seen and NOT read'))).toHaveLength(0);
  });
});
