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
import {
  readBuildMarker,
  resolveCurrentVersion,
  compareSemver,
} from '@/lib/updates/current-version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 300;

const UPSTREAM_OWNER = process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';
const UPSTREAM_REPO  = process.env.LOOM_FEEDBACK_REPO_NAME  || 'csa-inabox';

interface Release { tag_name: string; name: string; published_at: string; html_url: string; body: string; prerelease: boolean; }

/**
 * Version + build resolution and semver comparison live in
 * lib/updates/current-version.ts — SHARED with the apply route's pre-flight so
 * the "Update available" badge and the apply's already-up-to-date refusal can
 * never disagree (they previously resolved "current" from different sources:
 * package.json here vs the LOOM_VERSION env there). Resolution order + the
 * full rationale (#1468) are documented in that module.
 */
const BUILD = readBuildMarker();
const LOCAL_VERSION = resolveCurrentVersion(BUILD);

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
