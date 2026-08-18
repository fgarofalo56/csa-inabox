/**
 * CSA Loom — THE ESTATE FLEET: what is EVERY cloud running, not just this one?
 *
 * WHY THIS EXISTS (#3730)
 * =======================
 * `deploy-status.ts` answers "is THIS estate running main?" by reading this
 * image's own build marker. That is the right question and it is only half of
 * one, because each console can only ever see itself: the Commercial console
 * reported Commercial, the Gov console reported Gov, and no surface anywhere put
 * the two facts side by side.
 *
 * So on 2026-08-18 the Commercial console read a healthy 0-commits-behind while
 * the Government console served an image built seven days and 251 commits
 * earlier, at version 0.90.2 against Commercial's 0.98.11. Every security fix
 * merged that week was inert in the sovereign boundary. The operator found it by
 * hand-curling two URLs, because the product had no page that would show both.
 *
 * `deploy-integrity.md` R3 requires drift to be surfaced "where the operator
 * looks (/admin/readiness)". `cloud-parity.md` requires that a capability which
 * works in Commercial and not in Gov be treated as INCOMPLETE. A drift banner
 * that structurally cannot see the other cloud satisfies neither — it is a
 * Commercial drift banner, and the sovereign estate's silence reads identically
 * to sovereign health.
 *
 * WHAT MAKES THIS POSSIBLE WITH NO CREDENTIALS
 * --------------------------------------------
 * Each console publishes its own build fingerprint at `/build-marker.txt`
 * (written by apps/fiab-console/Dockerfile:152 from the LOOM_BUILD_SHA
 * build-arg) and its version at `/api/version`. Both are deliberately
 * unauthenticated — loom-roll-and-validate already probes the marker — so one
 * console can read another's without any Azure identity, any `az`, or any
 * cross-cloud trust relationship. Verified 2026-08-18 against both live
 * endpoints from a host with no Gov access at all.
 *
 * THE HONEST-DEGRADE CONTRACT, WHICH IS THE WHOLE POINT
 * ----------------------------------------------------
 * A console will frequently NOT be able to read its peer. Azure Government has
 * no general egress to the public internet (it already cannot reach
 * api.github.com, which is why this file's sibling degrades the compare), so the
 * Gov console will usually report the Commercial estate as UNMEASURED.
 *
 * That is a correct and useful answer, and it must never be rendered as
 * anything else. Every failure here produces `reachable: false` plus the exact
 * reason, and the drift verdict for that estate is `unknown` — a distinct state
 * with its own colour, never `current` and never `behind`. Per
 * `deploy-integrity.md` R7 an error must not assert what it did not establish:
 * "I could not reach the Gov console" and "the Gov console is stale" are
 * different claims, and the 2026-08-05 incident (a roll reporting "the tag does
 * not exist" when the truth was "I could not reach the registry") is what that
 * rule was written from.
 *
 * PURE + IO SPLIT. Everything here is pure except `probeEstateEndpoint`, which
 * takes an injectable fetch. The parser is asserted against the SAME fixture
 * corpus as the CI implementation (scripts/ci/__fixtures__/build-markers.json)
 * so the two cannot drift apart on format handling — see
 * lib/admin/__tests__/estate-fleet.test.ts.
 */
import type { LoomCloud } from '@/lib/azure/cloud-boundary';
import type { EstateDrift } from './deploy-status';

/** One live console this product knows how to read. */
export interface EstateEndpoint {
  id: 'commercial' | 'gov';
  /** Operator-facing name. */
  name: string;
  /** The sovereign boundaries this endpoint IS, for self-identification. */
  clouds: LoomCloud[];
  /** Unauthenticated build fingerprint — the FACT this surface turns on. */
  markerUrl: string;
  /** Unauthenticated version endpoint — display metadata only. */
  versionUrl: string;
  /**
   * How long merged code may sit unapplied to THIS estate before `behind`
   * becomes an error rather than a roll in flight.
   *
   * Commercial's 90 minutes is measured (build 7-38min + roll 8-18min ⇒ ~56min
   * observed worst case). Gov's 240 is wider because its chain
   * (gov-build-images → gov-console-roll) is dispatch-only and therefore
   * includes a human deciding to start it.
   *
   * NEITHER IS A TOLERANCE FOR BEING BEHIND, and Gov's must not be widened into
   * one: at the measured 2026-08-18 state Gov exceeded this by a factor of
   * forty. Matched deliberately to scripts/ci/_estate-registry.mjs so CI and the
   * console cannot disagree about what "behind" means (one number, two
   * surfaces).
   */
  graceMinutes: number;
}

/**
 * THE FLEET.
 *
 * Env-overridable per estate so a private-preview or relocated estate can be
 * pointed at without a redeploy — and so the values are inspectable rather than
 * wired in. The defaults are the live 2026-08-18 endpoints.
 */
export const LOOM_ESTATES: EstateEndpoint[] = [
  {
    id: 'commercial',
    name: 'Commercial',
    clouds: ['Commercial'],
    markerUrl: process.env.LOOM_ESTATE_URL_COMMERCIAL
      || 'https://csa-loom.limitlessdata.ai/build-marker.txt',
    versionUrl: process.env.LOOM_ESTATE_VERSION_URL_COMMERCIAL
      || 'https://csa-loom.limitlessdata.ai/api/version',
    graceMinutes: 90,
  },
  {
    id: 'gov',
    name: 'Azure Government',
    // GCC-High, DoD and GCC all resolve to the sovereign console. An IL5 estate
    // folds to GCC-High upstream in detectLoomCloud(), so it lands here too.
    clouds: ['GCC-High', 'DoD', 'GCC'],
    markerUrl: process.env.LOOM_ESTATE_URL_GOV
      || 'https://loom-console-dcmt6cqoezlgs-agg6h9e5cjamh5h2.z01.azurefd.us/build-marker.txt',
    versionUrl: process.env.LOOM_ESTATE_VERSION_URL_GOV
      || 'https://loom-console-dcmt6cqoezlgs-agg6h9e5cjamh5h2.z01.azurefd.us/api/version',
    graceMinutes: 240,
  },
];

/** Which fleet entry is the console serving this request? */
export function estateIdForCloud(cloud: LoomCloud | null | undefined): EstateEndpoint['id'] | null {
  if (!cloud) return null;
  return LOOM_ESTATES.find((e) => e.clouds.includes(cloud))?.id ?? null;
}

/** A git object id and nothing else: 7-40 hex. See deploy-status/route.ts. */
export const GIT_OBJECT_ID = /^[0-9a-f]{7,40}$/i;

export interface ParsedMarker {
  sha: string | null;
  stamp: string | null;
  error: string | null;
}

/**
 * Parse a `/build-marker.txt` body. PURE.
 *
 * THE TWO CLOUDS SERVE DIFFERENT SHAPES, and a parser that handles one is a
 * parser that has never read the other:
 *
 *   Commercial  sha=09ac2517…0 (40 hex)  stamp=20260818T152007Z    (basic ISO)
 *   Government  sha=28de89fb   (8 hex)   stamp=2026-08-11T09:23:46Z (extended)
 *
 * The difference is structural — build-fiab-images-acr-tasks.yml passes
 * `${{ github.sha }}`, gov-build-images.yml passes
 * `git rev-parse --short=8 HEAD`. Both are legitimate builds.
 *
 * NO SUCCESS-SHAPED FAILURE. Every rejection returns `sha: null` WITH a non-null
 * `error` naming what was actually served. A null sha and a null error would let
 * the caller skip the compare and render "no drift" for an estate it never read
 * — a broken estate shown as a healthy one, which is the defect class this repo
 * has shipped three times.
 *
 * Deliberately mirrors scripts/ci/_estate-registry.mjs, and the two are pinned
 * to the same fixture corpus so they cannot diverge silently.
 */
export function parseBuildMarkerText(text: string | null | undefined): ParsedMarker {
  if (typeof text !== 'string' || text.trim() === '') {
    return { sha: null, stamp: null, error: 'the marker response was empty — the endpoint answered with no body' };
  }

  // Capture any non-whitespace run, THEN validate — so "no sha= field at all"
  // and "a sha= field naming no commit" stay distinguishable. They have
  // different causes (check the ingress vs check the build-arg) and therefore
  // need different messages.
  const raw = text.match(/(?:^|\s)sha=([^\s]*)/)?.[1];

  if (raw === undefined) {
    const head = text.trimStart().slice(0, 24).toLowerCase();
    const shape = head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')
      ? `an HTML page (${text.length} bytes) — an ingress, WAF or error page is answering in the console's place`
      : `${text.length} bytes that are not a build marker`;
    return { sha: null, stamp: null, error: `the response carried no sha= field — served ${shape}` };
  }
  if (raw === '') {
    return { sha: null, stamp: null, error: 'the marker\'s sha= field is empty — that image was built with `--build-arg LOOM_BUILD_SHA=` (no value)' };
  }
  if (raw === 'unknown') {
    // The Dockerfile ARG default. It names no commit, so it is an unidentified
    // build rather than a sha — readBuildMarker() drops the same value locally.
    return {
      sha: null,
      stamp: null,
      error: 'the marker reports sha=unknown — that image was built without a LOOM_BUILD_SHA build-arg, '
        + 'so it does not name the commit it was built from',
    };
  }
  if (!GIT_OBJECT_ID.test(raw)) {
    // Deliberately does NOT echo the value. This string is remote input and the
    // sha is interpolated into an api.github.com compare path by the caller; the
    // containment that matters is that `sha` stays null. Naming the expected
    // shape is enough to act on.
    return {
      sha: null,
      stamp: null,
      error: 'the marker\'s sha= field is not a git object id (expected 7-40 hex from the LOOM_BUILD_SHA build-arg), so it names no commit to compare',
    };
  }

  const stampRaw = text.match(/(?:^|\s)stamp=([^\s]*)/)?.[1];
  return { sha: raw, stamp: stampRaw && stampRaw !== 'unknown' ? stampRaw : null, error: null };
}

/** One estate's row on the readiness surface. */
export interface FleetEstate {
  id: EstateEndpoint['id'];
  name: string;
  /** True for the console serving this request — read from the image, not the network. */
  isSelf: boolean;
  /** Where the facts came from, so the surface never implies more than it has. */
  source: 'this-image' | 'remote-marker';
  markerUrl: string;
  /** Whether the marker could be READ at all. False ⇒ every fact below is null. */
  reachable: boolean;
  /** Exactly why it could not be read. Null when it could. */
  unreachableReason: string | null;
  /** The running semver, when /api/version answered. Display metadata only. */
  version: string | null;
  /** Why the version is absent. NEVER affects the drift verdict. */
  versionError: string | null;
  /** The drift verdict — `unknown` whenever the estate could not be measured. */
  drift: EstateDrift;
}

/**
 * Probe one remote estate's marker + version. The ONLY IO in this module.
 *
 * `fetchImpl` is injectable so every branch is unit-tested without a network.
 * Both probes are bounded: a page that hangs waiting on an unreachable
 * sovereign endpoint is a page nobody reads, so a stalled fetch becomes an
 * honest "could not reach" instead of a spinner.
 */
export async function probeEstateEndpoint(
  estate: EstateEndpoint,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ marker: ParsedMarker; version: string | null; versionError: string | null }> {
  const marker = await readMarker(estate, timeoutMs, fetchImpl);
  const version = await readVersion(estate, timeoutMs, fetchImpl);
  return { marker, version: version.version, versionError: version.error };
}

async function readMarker(
  estate: EstateEndpoint,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ParsedMarker> {
  try {
    const res = await fetchImpl(estate.markerUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!res.ok) {
      return { sha: null, stamp: null, error: `could not read ${estate.name}'s build marker — HTTP ${res.status}` };
    }
    return parseBuildMarkerText(await res.text());
  } catch (e: any) {
    const why = e?.name === 'TimeoutError'
      ? `no response within ${timeoutMs}ms`
      : String(e?.message || e).slice(0, 160);
    // "Could not reach", said as exactly that. A boundary with no egress to the
    // other cloud lands here on every load, and that is a true statement about
    // this console's network — never a statement about the other estate's
    // freshness.
    return { sha: null, stamp: null, error: `could not reach ${estate.name} — ${why}` };
  }
}

async function readVersion(
  estate: EstateEndpoint,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ version: string | null; error: string | null }> {
  try {
    const res = await fetchImpl(estate.versionUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!res.ok) return { version: null, error: `HTTP ${res.status}` };
    const body: any = await res.json();
    return typeof body?.current === 'string'
      ? { version: body.current, error: null }
      : { version: null, error: 'no `current` field in /api/version' };
  } catch (e: any) {
    return { version: null, error: String(e?.message || e).slice(0, 120) };
  }
}

/**
 * The one-line fleet verdict. PURE.
 *
 * NAMES THE WORST FACT rather than averaging, because a banner that averages is
 * a banner that gets ignored — and being ignored is the failure mode this whole
 * surface exists to prevent. A drifted estate outranks an unmeasured one:
 * "Gov is 251 commits behind" is actionable, "we could not read Gov" is a
 * prerequisite to finding out.
 */
export function summarizeFleet(estates: FleetEstate[]): {
  severity: 'ok' | 'warning' | 'error';
  headline: string;
} {
  const drifted = estates.filter((e) => e.drift.severity === 'error');
  const unknown = estates.filter((e) => e.drift.state === 'unknown');

  if (drifted.length) {
    const worst = drifted
      .slice()
      .sort((a, b) => (b.drift.commitsBehind ?? 0) - (a.drift.commitsBehind ?? 0))[0];
    const n = worst.drift.commitsBehind;
    return {
      severity: 'error',
      headline: n
        ? `${worst.name} is ${n} commit${n === 1 ? '' : 's'} behind main`
        : `${worst.name} is not running main`,
    };
  }
  if (unknown.length) {
    return {
      severity: 'warning',
      // "Could not measure" — never "is up to date", never "is behind".
      headline: unknown.length === estates.length
        ? 'No estate could be measured from this console'
        : `${unknown.map((e) => e.name).join(', ')} could not be measured from this console`,
    };
  }
  return {
    severity: 'ok',
    headline: estates.length > 1
      ? `All ${estates.length} estates are running main`
      : 'This estate is running main',
  };
}
