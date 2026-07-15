/**
 * SHARED running-version resolution — the single source of truth for "what
 * version is this console actually running?".
 *
 * Both /api/version (the Updates page's "current vs upstream" check) and
 * /api/admin/updates/apply (the pre-flight's already-up-to-date refusal) MUST
 * resolve the running version identically. They previously did not: /api/version
 * read package.json first (authoritative — baked into the image at build time),
 * while the apply route read only the LOOM_VERSION env (a bicep param that can
 * go stale OR be hand-pinned ahead). Whenever the two disagreed the page could
 * say "Update available" while the apply pre-flight refused with
 * "already up to date" — an un-actionable contradiction. One resolver, imported
 * by both, closes that class of bug.
 *
 * Resolution order (same rationale as /api/version, #1468):
 *   1. package.json `version` — travels WITH the image; release-please keeps it
 *      in lockstep with the released semver.
 *   2. LOOM_VERSION env — honored only when package.json has no parseable semver.
 *   3. build-marker SHA fingerprint (`build-<sha>`), then NEXT_PUBLIC_LOOM_VERSION,
 *      then 'dev'.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildMarker {
  sha?: string;
  stamp?: string;
}

/** package.json version when it carries a real semver core, else undefined. */
export function readPackageVersion(): string | undefined {
  // In the Next standalone runtime cwd is the standalone root, which holds a
  // copied package.json; from a source checkout cwd is the app dir. Both work.
  for (const p of [
    join(process.cwd(), 'package.json'),
    join(process.cwd(), 'apps', 'fiab-console', 'package.json'),
  ]) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf-8'))?.version;
      // Only accept a real semver core; ignore '0.1.0-scaffold'-style or absent.
      if (typeof v === 'string' && /^\d+\.\d+(\.\d+)?/.test(v.trim())) return v.trim();
    } catch { /* try next path */ }
  }
  return undefined;
}

/** The Docker build marker (sha + stamp) proving which image is serving. */
export function readBuildMarker(): BuildMarker {
  for (const p of [
    join(process.cwd(), 'public', 'build-marker.txt'),
    join(process.cwd(), 'build-marker.txt'),
  ]) {
    try {
      const txt = readFileSync(p, 'utf-8');
      const sha = txt.match(/sha=([^\s]+)/)?.[1];
      const stamp = txt.match(/stamp=([^\s]+)/)?.[1];
      if (sha && sha !== 'unknown') return { sha, stamp };
    } catch { /* try next path */ }
  }
  // Env-stamped fallback (Dockerfile sets ENV LOOM_BUILD_SHA too).
  const sha = process.env.LOOM_BUILD_SHA;
  if (sha && sha !== 'unknown') return { sha, stamp: process.env.LOOM_BUILD_TIMESTAMP };
  return {};
}

/** Resolve the running version once (package.json → env → build fingerprint). */
export function resolveCurrentVersion(build: BuildMarker = readBuildMarker()): string {
  return (
    readPackageVersion() ||
    process.env.LOOM_VERSION ||
    process.env.NEXT_PUBLIC_LOOM_VERSION ||
    (build.sha ? `build-${build.sha.slice(0, 12)}` : 'dev')
  );
}

/**
 * Parse the major.minor.patch core out of a version/tag string into a numeric
 * triple. Tolerates ANY prefix before the version core, including a repo-scoped
 * release tag such as `csa-inabox-v0.44.0` or a bare `v0.43.1`. Returns null
 * only when no numeric core exists at all (e.g. a `build-<sha>` fingerprint),
 * so callers can distinguish "older" from "not a comparable version".
 */
export function parseSemverCore(s: string): [number, number, number] | null {
  // Find the first version-looking token: <major>.<minor>[.<patch>], optionally
  // preceded by a `v`/`V`. The leading boundary (start-or-non-digit) prevents
  // matching a digit that is part of a longer number.
  const m = s.trim().match(/(?:^|[^0-9])v?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return null;
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

/**
 * Semver compare on the major.minor.patch core. Returns -1 if a<b, 1 if a>b,
 * 0 if equal. When the LOCAL version has no parseable semver core (a dev /
 * build-SHA build) but the upstream tag does, treat local as OLDER (-1) so an
 * update is offered rather than a false "Up to date".
 */
export function compareSemver(a: string, b: string): number {
  const na = parseSemverCore(a);
  const nb = parseSemverCore(b);
  if (!na && !nb) return 0;
  if (!na) return -1; // local not comparable, upstream is a real release → older
  if (!nb) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (na[i] !== nb[i]) return na[i] < nb[i] ? -1 : 1;
  }
  return 0;
}
