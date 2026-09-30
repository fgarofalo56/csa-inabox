/**
 * EVERY REFUSAL BRANCH, REACHED.
 *
 * `artifact.ts` exists to make "not evaluated" a state the surface can actually
 * be in. A refusal branch no test can enter is not a guard, so this spec enters
 * all of them and asserts the reason names the CAUSE — never a generic failure.
 *
 * The pattern being guarded against is live one directory away:
 * `lib/brain/live-graph.ts:215` hard-codes `configured.collected: true`
 * regardless of whether the env read succeeded, which makes NOT-EVALUATED
 * unreachable on that lane and lets a clean zero be reported for something
 * nobody examined. Nothing here may be written that way.
 */

import { describe, expect, it } from 'vitest';
import type { SecurityGraph } from '../../substrate';
import type { SecurityGraphArtifact } from '../types';
import { GENERATOR_VERSION } from '../build';
import { MAX_ARTIFACT_AGE_DAYS, resolveSecurityGraph, type ResolveOptions } from '../artifact';
import { IMAGE_BUILD_DATE_FILE, type ImageBuildDate } from '../build-date';

/** A fixed clock, so no assertion here depends on the calendar. */
const NOW = new Date('2026-09-29T12:00:00Z');
const DAY_MS = 86_400_000;

/**
 * An ISO date `days` before {@link NOW} (negative = in the future), in the exact
 * shape the Dockerfile's `date -u +%Y-%m-%dT%H:%M:%SZ` writes: no milliseconds.
 */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const FRESH: ImageBuildDate = { state: 'present', value: daysAgo(28) };

function opts(imageBuiltAt: ImageBuildDate = FRESH): ResolveOptions {
  return { now: NOW, imageBuiltAt };
}

function graphWith(nodes: SecurityGraph['nodes']): SecurityGraph {
  return { nodes, edges: [], annotations: { expectedPredicateClusterSize: {} }, source: 'extracted' };
}

const ONE_NODE: SecurityGraph['nodes'] = [
  {
    id: 'sec:authorizer:apps/fiab-console/app/api/x/route.ts#GET',
    kind: 'authorizer',
    provenance: 'declared',
    label: 'GET /api/x',
    facet: {
      kind: 'authorizer',
      fnName: 'GET /api/x',
      params: [],
      resourceScoped: false,
      callerNamedResourceInputs: [],
      allowPaths: [],
      reachesPrivilegedSink: false,
      privilegedSinkKinds: [],
    },
  },
];

function artifactWith(overrides: Partial<SecurityGraphArtifact> = {}): SecurityGraphArtifact {
  const graph = overrides.graph ?? graphWith(ONE_NODE);
  return {
    graph,
    join: overrides.join ?? {
      painted: graph.nodes.map((n) => ({
        nodeId: n.id,
        codeModuleId: 'code:apps/fiab-console/app/api/x/route.ts',
        deployedAs: 'loom-console',
      })),
      unjoined: [],
    },
    meta: {
      generatorVersion: GENERATOR_VERSION,
      scanScopes: [],
      skipped: [],
      ...overrides.meta,
    },
  };
}

describe('resolveSecurityGraph — a healthy artifact', () => {
  it('is AVAILABLE and hands back the graph unchanged', () => {
    const artifact = artifactWith();
    const result = resolveSecurityGraph(artifact, opts());
    expect(result.available).toBe(true);
    if (result.available) expect(result.graph).toBe(artifact.graph);
  });
});

describe('resolveSecurityGraph — every refusal is reachable and names its cause', () => {
  it('REFUSES a missing artifact', () => {
    const result = resolveSecurityGraph(null, opts());
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('NOT EVALUATED');
    expect(result.reason).toContain('build time');
  });

  it('REFUSES a graph produced by a different extractor version', () => {
    const result = resolveSecurityGraph(
      artifactWith({ meta: { generatorVersion: GENERATOR_VERSION + 1 } as never }),
      opts(),
    );
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain(`version ${GENERATOR_VERSION + 1}`);
  });

  it("REFUSES a 'modelled' graph — a fixture is not a measurement", () => {
    const graph: SecurityGraph = { ...graphWith(ONE_NODE), source: 'modelled' };
    const result = resolveSecurityGraph(artifactWith({ graph }), opts());
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain("source 'modelled'");
  });

  it('REFUSES a ZERO-NODE graph rather than sweeping it', () => {
    // THE CENTRAL CASE. A sweep over an empty graph reports zero security
    // findings, and zero is indistinguishable from clean to any consumer that
    // counts risks. It must never reach a detector.
    const result = resolveSecurityGraph(
      artifactWith({ graph: graphWith([]), join: { painted: [], unjoined: [] } }),
      opts(),
    );
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('ZERO nodes');
    expect(result.reason).toContain('indistinguishable from a clean estate');
  });

  it('REFUSES an artifact whose join does not account for every node', () => {
    const result = resolveSecurityGraph(artifactWith({ join: { painted: [], unjoined: [] } }), opts());
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('does not account for every node');
  });

  it('never throws on a malformed artifact — it degrades to an honest refusal', () => {
    const broken = { graph: null, join: null, meta: null } as unknown as SecurityGraphArtifact;
    expect(() => resolveSecurityGraph(broken, opts())).not.toThrow();
  });
});

describe('#4798 — the committed meta carries no clock, and none is required', () => {
  it('resolves an artifact whose meta has no generatedAt at all', () => {
    // `artifactWith()` builds the committed shape, which has no timestamp. The
    // age now comes from the IMAGE (`opts()` supplies a fresh one); a refusal
    // keyed on `meta.generatedAt` being absent would make this unavailable,
    // which is the input that breaks this assertion.
    const artifact = artifactWith();
    // Fixture control, not coverage: proves the input really lacks a clock.
    expect(Object.keys(artifact.meta).sort()).toEqual(['generatorVersion', 'scanScopes', 'skipped']);
    expect(resolveSecurityGraph(artifact, opts()).available).toBe(true);
  });
});

describe('#4798 — the age refusal, keyed on the date baked into the IMAGE', () => {
  function reasonOf(built: ImageBuildDate): string {
    const r = resolveSecurityGraph(artifactWith(), opts(built));
    if (r.available) throw new Error(`expected a refusal, got available (${r.ageNote ?? 'no note'})`);
    return r.reason;
  }
  function noteOf(built: ImageBuildDate): string {
    const r = resolveSecurityGraph(artifactWith(), opts(built));
    if (!r.available) throw new Error(`expected available, got refusal: ${r.reason}`);
    if (r.ageNote === undefined) throw new Error('available without an ageNote');
    return r.ageNote;
  }
  function checkedOf(built: ImageBuildDate): boolean | undefined {
    const r = resolveSecurityGraph(artifactWith(), opts(built));
    if (!r.available) throw new Error(`expected available, got refusal: ${r.reason}`);
    return r.ageChecked;
  }

  it('the ceiling is 90 days (the value the old committed-date refusal used)', () => {
    // Pins the constant the boundary tests below are written against.
    expect(MAX_ARTIFACT_AGE_DAYS).toBe(90);
  });

  it('FRESH: an image built 28 days ago is available, says how old it is, and claims no more', () => {
    // Breaks if a fresh image is refused, or the note stops naming the date.
    // The wording is pinned whole because it must not claim the graph was
    // extracted from this image's source: nothing at runtime establishes that
    // (#4807), and the round-2 wording did claim it.
    expect(noteOf(FRESH)).toBe(
      `Image built ${daysAgo(28)} (28 of 90 days); this is the graph committed in that image. ` +
        "This server does not check that the graph matches the image's source: CI's `--check` " +
        'does, and it does not gate the roll (#4807).',
    );
    expect(checkedOf(FRESH)).toBe(true);
  });

  it('STALE: an image built 91 days ago is REFUSED as stale, naming its age and date', () => {
    const reason = reasonOf({ state: 'present', value: daysAgo(91) });
    expect(reason).toContain('NOT EVALUATED');
    expect(reason).toContain(`built 91 days ago (${daysAgo(91)}, ceiling 90 days)`);
    expect(reason).toContain('STALE');
    // The one-directional claim, not the round-2 "describes the source tree as
    // it was at build time".
    expect(reason).toContain('The security graph committed in it is at least that old');
  });

  it('the boundary is strict: exactly 90 days is available, 90 days and one hour is not', () => {
    // Breaks `>` mutated to `>=` (exactly-90 then refused) and a ceiling
    // mutated upward (90d+1h then available).
    expect(noteOf({ state: 'present', value: daysAgo(90) })).toContain('(90 of 90 days)');
    expect(reasonOf({ state: 'present', value: daysAgo(90 + 1 / 24) })).toContain('STALE');
  });

  it('ABSENT: a local run with no image date is AVAILABLE, unchecked, and says so', () => {
    // A local `next dev` never ran the Dockerfile. Refusing it would teach every
    // developer to ignore the refusal; saying nothing would hide that the check
    // did not run. Breaks if absent is refused, if the note goes silent, or if
    // `ageChecked` is not false (the panel's warning keys on it).
    const note = noteOf({ state: 'absent' });
    expect(note).toContain(`\`${IMAGE_BUILD_DATE_FILE}\``);
    expect(note).toContain("the graph's age was NOT checked");
    expect(checkedOf({ state: 'absent' })).toBe(false);
  });

  it('MISSING: a built image with no date is REFUSED, naming what marked it as an image', () => {
    // The round-3 blocker. Breaks if `missing` is treated like `absent` (the
    // refusal would then be off in any image whose date went unfound).
    const reason = reasonOf({ state: 'missing', markers: ['server.js', 'public/build-marker.txt'] });
    expect(reason).toContain('NOT EVALUATED');
    expect(reason).toContain('found server.js, public/build-marker.txt');
    expect(reason).toContain("the graph's age cannot be established");
  });

  it('ABSENT does not bypass the other refusals', () => {
    // Breaks if the age check were moved ahead of the zero-node refusal and
    // returned available early for an absent date.
    const r = resolveSecurityGraph(
      artifactWith({ graph: graphWith([]), join: { painted: [], unjoined: [] } }),
      opts({ state: 'absent' }),
    );
    expect(r.available).toBe(false);
  });

  it('UNPARSEABLE: a present but non-date value is REFUSED, quoting it', () => {
    const reason = reasonOf({ state: 'present', value: 'not-a-date' });
    expect(reason).toContain("unparseable ('not-a-date'");
    // An EMPTY file is present-and-unparseable, not absent: the Dockerfile ran
    // and failed to write a date, which is a defect, not a dev build.
    expect(reasonOf({ state: 'present', value: '' })).toContain("unparseable (''");
  });

  it('UNPARSEABLE, not a plausible age: values Date.parse would accept in the wrong shape', () => {
    // `Date.parse('1')` is the year 2001, which read as STALE would misname the
    // fault; a date with no T or Z is read in LOCAL time, which moves it by the
    // host's offset. Breaks if the exact-shape check is removed.
    expect(Number.isNaN(Date.parse('1'))).toBe(false); // fixture control: the leniency is real
    expect(reasonOf({ state: 'present', value: '1' })).toContain("unparseable ('1'");
    expect(reasonOf({ state: 'present', value: '2026-09-29 12:00:00' })).toContain('unparseable');
    expect(reasonOf({ state: 'present', value: '2026-09-29T12:00:00.000Z' })).toContain('unparseable');
    // Positive control: the Dockerfile's own shape is accepted.
    expect(noteOf({ state: 'present', value: '2026-09-28T12:00:00Z' })).toContain('(1 of 90 days)');
  });

  it('UNREADABLE: a file that exists and cannot be read is REFUSED, naming the error', () => {
    expect(reasonOf({ state: 'unreadable', detail: 'EACCES' })).toContain(
      'exists but could not be read (EACCES)',
    );
  });

  it('FUTURE: a date more than a day ahead is REFUSED, stating the exact offset; skew under a day is not', () => {
    // Breaks if the future guard is deleted (a date 5 days ahead would then be
    // "fresh" forever) or tightened to zero (skew of 12h would then refuse).
    // 1.2 days ahead must read 1.2, not the round-2 `Math.ceil` "2 days".
    expect(reasonOf({ state: 'present', value: daysAgo(-5) })).toContain('5.0 days in the future');
    expect(reasonOf({ state: 'present', value: daysAgo(-1.2) })).toContain('1.2 days in the future');
    expect(noteOf({ state: 'present', value: daysAgo(-0.5) })).toContain('(0 of 90 days)');
  });
});
