/**
 * Self-tests for lib/admin/estate-fleet.ts — the cross-cloud half of the deploy
 * status surface (#3730).
 *
 * WHAT IS BEING PINNED
 * ====================
 * The defect this module exists for was not a wrong number, it was a MISSING
 * ROW: each console could only ever report itself, so Azure Government sat 251
 * commits and seven days behind main while every Commercial signal read green.
 * Three properties therefore have to hold, and each is asserted here:
 *
 *   1. BOTH clouds are in the registry, and the Gov entry's roll window cannot
 *      absorb the drift it was written to catch.
 *   2. The parser reads BOTH marker shapes — Commercial's 40-hex sha and Gov's
 *      8-hex one — and FAILS LOUDLY on anything it cannot read, rather than
 *      returning a null sha that a caller would turn into "0 commits behind".
 *   3. An estate that could not be reached is UNKNOWN: never "current" (a false
 *      green over an estate nobody read) and never "behind" (a drift claim
 *      nobody measured). deploy-integrity.md R7 exists because on 2026-08-05 a
 *      roll reported "the tag does not exist" when the truth was "I could not
 *      reach the registry".
 *
 * THE PARSER IS ASSERTED AGAINST THE SAME FIXTURE FILE AS THE CI IMPLEMENTATION
 * (scripts/ci/__fixtures__/build-markers.json, also consumed by
 * scripts/ci/__tests__/cross-cloud-drift.test.mjs). Two implementations in two
 * languages will drift apart on format handling unless something forces them not
 * to; one shared corpus is that something. If a future edit teaches one parser a
 * new marker shape and not the other, one of the two suites goes red.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GIT_OBJECT_ID,
  LOOM_ESTATES,
  estateIdForCloud,
  parseBuildMarkerText,
  probeEstateEndpoint,
  summarizeFleet,
  type FleetEstate,
} from '../estate-fleet';
import { classifyEstateDrift } from '../deploy-status';

/**
 * The shared corpus. Resolved from the repo root rather than copied here on
 * purpose — a local copy would let the two parsers diverge silently, which is
 * the exact thing this file is meant to prevent.
 */
const FIXTURES = JSON.parse(
  readFileSync(
    // __dirname is apps/fiab-console/lib/admin/__tests__ — five levels below the
    // repo root (__tests__ → admin → lib → fiab-console → apps → root).
    join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'ci', '__fixtures__', 'build-markers.json'),
    'utf-8',
  ),
) as {
  real: { id: string; estate: string; text: string; expect: { sha: string; stamp: string | null } }[];
  unparseable: { id: string; note: string; text: string }[];
};

describe('parseBuildMarkerText — both clouds, and every way a marker can be bad', () => {
  it('reads every REAL marker in the shared corpus', () => {
    // Population guard: an empty corpus would make the loop vacuous and green.
    expect(FIXTURES.real.length).toBeGreaterThanOrEqual(5);
    for (const c of FIXTURES.real) {
      const got = parseBuildMarkerText(c.text);
      expect(got.error, `${c.id}: expected a clean parse`).toBeNull();
      expect(got.sha, `${c.id}: sha`).toBe(c.expect.sha);
      expect(got.stamp, `${c.id}: stamp`).toBe(c.expect.stamp);
    }
  });

  it('reads the two live marker SHAPES — 40-hex Commercial and 8-hex Gov', () => {
    // The specific regression. A parser assuming 40 hex reports the entire
    // sovereign boundary as malformed; one assuming 8 truncates Commercial.
    const commercial = parseBuildMarkerText(
      'loom-build-marker sha=09ac2517e8139f4fb6dff87ff2dac6c029b7f8d0 stamp=20260818T152007Z token=LOOM_LIVE_BUILD\n',
    );
    const gov = parseBuildMarkerText(
      'loom-build-marker sha=28de89fb stamp=2026-08-11T09:23:46Z token=LOOM_LIVE_BUILD\n',
    );
    expect(commercial.sha).toHaveLength(40);
    expect(gov.sha).toHaveLength(8);
    expect(commercial.stamp).toBe('20260818T152007Z');
    expect(gov.stamp).toBe('2026-08-11T09:23:46Z');
  });

  it('FAILS LOUDLY on every unreadable marker — never a null sha with a null error', () => {
    expect(FIXTURES.unparseable.length).toBeGreaterThanOrEqual(8);
    for (const c of FIXTURES.unparseable) {
      const got = parseBuildMarkerText(c.text);
      // THE INVARIANT. A null sha AND a null error is the shape that would let
      // a caller skip the compare and render "no drift" for an estate it never
      // read — a broken estate shown as a healthy one.
      expect(got.sha, `${c.id}: must not produce a sha`).toBeNull();
      expect(typeof got.error, `${c.id}: must carry a reason`).toBe('string');
      expect(got.error!.length, `${c.id}: the reason must say something`).toBeGreaterThan(20);
    }
  });

  it('names an HTML ingress page as such, not as a missing field', () => {
    // The realistic failure: Front Door answers 200 with an interstitial.
    // "no sha= field" alone sends someone to the Dockerfile; naming the HTML
    // sends them to the ingress, which is where the problem actually is.
    const html = FIXTURES.unparseable.find((c) => c.id === 'front-door-error-page')!;
    expect(parseBuildMarkerText(html.text).error).toMatch(/HTML|ingress|WAF/i);
  });

  it('rejects sha=unknown and points at the missing build-arg', () => {
    const got = parseBuildMarkerText('loom-build-marker sha=unknown stamp=unknown token=LOOM_LIVE_BUILD\n');
    expect(got.sha).toBeNull();
    expect(got.error).toMatch(/LOOM_BUILD_SHA/);
  });

  it('never lets a non-hex value through — it would choose the compare endpoint', () => {
    // The sha is interpolated into an api.github.com compare path, and for a
    // PEER estate the value is another cloud's HTTP response. Containment is
    // that `sha` stays null.
    const evil = FIXTURES.unparseable.find((c) => c.id === 'sha-path-traversal')!;
    expect(parseBuildMarkerText(evil.text).sha).toBeNull();
    expect(GIT_OBJECT_ID.test('../../../../user/repos?x=')).toBe(false);
    // …and the reason must not echo the bytes back out of the process.
    expect(parseBuildMarkerText(evil.text).error).not.toContain('user/repos');
  });

  it('a stamp is optional and never invalidates a marker', () => {
    const got = parseBuildMarkerText('loom-build-marker sha=28de89fb stamp=unknown token=LOOM_LIVE_BUILD\n');
    expect(got.sha).toBe('28de89fb');
    expect(got.stamp).toBeNull();
    expect(got.error).toBeNull();
  });
});

describe('LOOM_ESTATES — the registry that was missing a row', () => {
  it('carries BOTH clouds over https', () => {
    const ids = LOOM_ESTATES.map((e) => e.id);
    expect(ids).toContain('commercial');
    // The regression test for the whole issue: a one-entry registry is what
    // made the sovereign estate invisible.
    expect(ids).toContain('gov');
    for (const e of LOOM_ESTATES) {
      expect(e.markerUrl, `${e.id}`).toMatch(/^https:\/\/.+\/build-marker\.txt$/);
      expect(e.versionUrl, `${e.id}`).toMatch(/^https:\/\/.+\/api\/version$/);
      expect(e.graceMinutes).toBeGreaterThan(0);
      expect(e.graceMinutes).toBeLessThanOrEqual(240);
    }
  });

  it('the Gov window cannot absorb the 7 days of drift it exists to catch', () => {
    // A band that tolerated its own founding condition is not a signal — the
    // same mistake the first cut of the Commercial entry made with
    // maxCommitsBehind:20 while the estate was 13 behind.
    const gov = LOOM_ESTATES.find((e) => e.id === 'gov')!;
    expect(gov.graceMinutes).toBeLessThan((7 * 24 * 60) / 10);
  });

  it('maps every sovereign boundary to the Gov console', () => {
    expect(estateIdForCloud('Commercial')).toBe('commercial');
    // GCC-High, DoD and GCC all serve from the sovereign console; IL5 folds to
    // GCC-High upstream in detectLoomCloud().
    expect(estateIdForCloud('GCC-High')).toBe('gov');
    expect(estateIdForCloud('DoD')).toBe('gov');
    expect(estateIdForCloud('GCC')).toBe('gov');
    expect(estateIdForCloud(null)).toBeNull();
  });
});

describe('probeEstateEndpoint — an unreachable peer is UNKNOWN, not a verdict', () => {
  const estate = LOOM_ESTATES.find((e) => e.id === 'gov')!;

  it('says "could not reach" on a transport failure and asserts nothing else', async () => {
    const boom = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
    const r = await probeEstateEndpoint(estate, 100, boom);
    expect(r.marker.sha).toBeNull();
    expect(r.marker.error).toMatch(/could not reach/);
    // The two claims a network failure must never make.
    expect(r.marker.error).not.toMatch(/behind|up to date|current/i);
  });

  it('reports a non-200 with its status', async () => {
    const notOk = (async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    const r = await probeEstateEndpoint(estate, 100, notOk);
    expect(r.marker.error).toMatch(/HTTP 502/);
  });

  it('a failed VERSION probe leaves the marker verdict untouched', async () => {
    // A version is a label; the sha is the fact. If /api/version could redden a
    // healthy estate, this signal would get muted — which is how the original
    // one was lost.
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/api/version')) throw new Error('ECONNREFUSED');
      return { ok: true, text: async () => 'loom-build-marker sha=28de89fb stamp=x token=LOOM_LIVE_BUILD\n' };
    }) as unknown as typeof fetch;
    const r = await probeEstateEndpoint(estate, 100, fetchImpl);
    expect(r.marker.sha).toBe('28de89fb');
    expect(r.marker.error).toBeNull();
    expect(r.version).toBeNull();
    expect(r.versionError).toBeTruthy();
  });

  it('an unreachable peer classifies as UNKNOWN — never current, never behind', async () => {
    const boom = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const { marker } = await probeEstateEndpoint(estate, 100, boom);
    const drift = classifyEstateDrift({
      buildSha: marker.sha,
      buildStamp: marker.stamp,
      branch: 'main',
      repo: 'fgarofalo56/csa-inabox',
      compare: null,
      error: marker.error,
    });
    expect(drift.state).toBe('unknown');
    expect(drift.severity).not.toBe('ok');
    expect(drift.commitsBehind).toBeNull();
    expect(drift.state).not.toBe('current');
    expect(drift.state).not.toBe('behind');
  });
});

describe('summarizeFleet — the worst fact, never an average', () => {
  const row = (over: Partial<FleetEstate> & { drift: FleetEstate['drift'] }): FleetEstate => ({
    id: 'gov', name: 'Azure Government', isSelf: false, source: 'remote-marker',
    markerUrl: 'https://x/build-marker.txt', reachable: true, unreachableReason: null,
    version: null, versionError: null,
    ...over,
  });
  const drift = (over: Partial<FleetEstate['drift']>): FleetEstate['drift'] => ({
    buildSha: 'abc1234', buildStamp: null, branch: 'main', state: 'current',
    commitsBehind: 0, behindSince: null, behindForMinutes: null,
    severity: 'ok', headline: '', detail: '', compareUrl: null,
    ...over,
  });

  it('is ok only when every estate is measured and current', () => {
    const r = summarizeFleet([
      row({ id: 'commercial', name: 'Commercial', isSelf: true, source: 'this-image', drift: drift({}) }),
      row({ drift: drift({}) }),
    ]);
    expect(r.severity).toBe('ok');
    expect(r.headline).toMatch(/All 2 estates are running main/);
  });

  it('names the WORST estate, not this one — a healthy self must not hide a stale peer', () => {
    // The founding defect in one assertion: Commercial green, Gov 251 behind.
    const r = summarizeFleet([
      row({ id: 'commercial', name: 'Commercial', isSelf: true, source: 'this-image', drift: drift({}) }),
      row({ drift: drift({ state: 'behind', commitsBehind: 251, severity: 'error' }) }),
    ]);
    expect(r.severity).toBe('error');
    expect(r.headline).toBe('Azure Government is 251 commits behind main');
  });

  it('reports an unmeasured peer as unmeasured — a warning, in its own words', () => {
    const r = summarizeFleet([
      row({ id: 'commercial', name: 'Commercial', isSelf: true, source: 'this-image', drift: drift({}) }),
      row({ reachable: false, unreachableReason: 'could not reach', drift: drift({ state: 'unknown', commitsBehind: null, severity: 'warning' }) }),
    ]);
    expect(r.severity).toBe('warning');
    expect(r.headline).toMatch(/could not be measured/);
    // It must NOT claim the peer is fine, and must NOT claim it is behind.
    expect(r.headline).not.toMatch(/running main/);
    expect(r.headline).not.toMatch(/behind/);
  });

  it('drift outranks unknown — the actionable fact leads', () => {
    const r = summarizeFleet([
      row({ id: 'commercial', name: 'Commercial', drift: drift({ state: 'unknown', commitsBehind: null, severity: 'warning' }) }),
      row({ drift: drift({ state: 'behind', commitsBehind: 251, severity: 'error' }) }),
    ]);
    expect(r.severity).toBe('error');
    expect(r.headline).toMatch(/251 commits behind/);
  });
});
