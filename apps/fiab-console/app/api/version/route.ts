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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 300;

const UPSTREAM_OWNER = process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';
const UPSTREAM_REPO  = process.env.LOOM_FEEDBACK_REPO_NAME  || 'csa-inabox';

interface Release { tag_name: string; name: string; published_at: string; html_url: string; body: string; prerelease: boolean; }

const LOCAL_VERSION = process.env.LOOM_VERSION || process.env.NEXT_PUBLIC_LOOM_VERSION || 'dev';

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
      return NextResponse.json({ current: LOCAL_VERSION, upstream: null, hasUpdate: false, error: `upstream-${r.status}` });
    }
    const releases = (await r.json()) as Release[];
    const stable = releases.filter((rel) => !rel.prerelease);
    const latest = stable[0] ?? releases[0] ?? null;
    const hasUpdate = latest ? compareSemver(LOCAL_VERSION, latest.tag_name) < 0 : false;
    return NextResponse.json({
      current: LOCAL_VERSION,
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
    return NextResponse.json({ current: LOCAL_VERSION, upstream: null, hasUpdate: false, error: (e as Error).message }, { status: 200 });
  }
}
