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

function compareSemver(a: string, b: string): number {
  const na = a.replace(/^v/, '').split('.').map(Number);
  const nb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i += 1) {
    const x = na[i] ?? 0; const y = nb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
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
