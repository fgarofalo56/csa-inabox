/**
 * /api/version — returns the running build's version, the latest
 * release from the upstream csa-inabox repo, and a delta summary.
 *
 * Used by /admin/updates page so deployed tenants can see when a
 * new Loom version is available.
 *
 * Privacy: tenant identity is NOT sent upstream. The GitHub API call
 * uses optional LOOM_FEEDBACK_GITHUB_TOKEN for higher rate limit but
 * otherwise hits the public endpoint.
 */

import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 300;

const UPSTREAM_OWNER = process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';
const UPSTREAM_REPO  = process.env.LOOM_FEEDBACK_REPO_NAME  || 'csa-inabox';

interface Release { tag_name: string; name: string; published_at: string; html_url: string; body: string; prerelease: boolean; }

/**
 * Resolve the REAL running version, in priority order, so "Currently running"
 * reflects the deployed build rather than a stale hand-set env:
 *
 *  1. LOOM_VERSION — set from the release tag by deploy-parity (bicep defaults
 *     it to the release's bare semver, e.g. '0.43.1'). When the in-product
 *     updater rolls the apps to ghcr.io/<owner>/loom-*:<X.Y.Z>, this env
 *     follows the image, so it is the authoritative running version.
 *  2. The Docker build marker at public/build-marker.txt — stamped by the
 *     Dockerfile with the build SHA (`sha=<git-sha>`). Used as a build
 *     fingerprint when LOOM_VERSION is unset (proves which image is serving
 *     even before LOOM_VERSION is wired). Surfaced as `build` in the response.
 *  3. NEXT_PUBLIC_LOOM_VERSION, then 'dev'.
 */
function readBuildMarker(): { sha?: string; stamp?: string } {
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

const BUILD = readBuildMarker();
const LOCAL_VERSION =
  process.env.LOOM_VERSION ||
  process.env.NEXT_PUBLIC_LOOM_VERSION ||
  (BUILD.sha ? `build-${BUILD.sha.slice(0, 12)}` : 'dev');

/**
 * Parse the major.minor.patch core out of a version/tag string into a numeric
 * triple. Strips a leading `v`, any pre-release/build-metadata suffix
 * (`-rc.1`, `+meta`), and tolerates partial versions. Returns null when no
 * numeric core can be found (e.g. a `build-<sha>` fingerprint), so callers can
 * distinguish "older" from "not a comparable version".
 */
function parseSemverCore(s: string): [number, number, number] | null {
  const m = s.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

/**
 * Semver compare on the major.minor.patch core. Returns -1 if a<b, 1 if a>b,
 * 0 if equal. When the LOCAL version has no parseable semver core (a dev /
 * build-SHA build) but the upstream tag does, treat local as OLDER (-1) so an
 * update is offered rather than a false "Up to date". The previous string→
 * Number split produced NaN for such builds and silently returned 0.
 */
function compareSemver(a: string, b: string): number {
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

export async function GET() {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.LOOM_FEEDBACK_GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.LOOM_FEEDBACK_GITHUB_TOKEN}`;
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases?per_page=10`, { headers, next: { revalidate: 300 } });
    if (!r.ok) {
      return NextResponse.json({ current: LOCAL_VERSION, build: BUILD, upstream: null, hasUpdate: false, error: `upstream-${r.status}` });
    }
    const releases = (await r.json()) as Release[];
    const stable = releases.filter((rel) => !rel.prerelease);
    const latest = stable[0] ?? releases[0] ?? null;
    const hasUpdate = latest ? compareSemver(LOCAL_VERSION, latest.tag_name) < 0 : false;
    return NextResponse.json({
      current: LOCAL_VERSION,
      build: BUILD,
      upstream: latest && {
        tag: latest.tag_name,
        name: latest.name,
        publishedAt: latest.published_at,
        url: latest.html_url,
        notes: latest.body?.slice(0, 4000) ?? '',
      },
      recent: releases.slice(0, 5).map((rel) => ({
        tag: rel.tag_name, name: rel.name, publishedAt: rel.published_at, url: rel.html_url, prerelease: rel.prerelease,
      })),
      hasUpdate,
      repo: `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`,
    });
  } catch (e) {
    return NextResponse.json({ current: LOCAL_VERSION, build: BUILD, upstream: null, hasUpdate: false, error: (e as Error).message }, { status: 200 });
  }
}
