/**
 * In-product update path BFF — the no-clone updater.
 *
 *   GET  /api/admin/updates/apply  → pre-flight ONLY (resolve target, verify
 *        public images exist, verify ARM perms). Returns the plan or an honest
 *        gate. Does NOT mutate anything — safe to call on page load.
 *   POST /api/admin/updates/apply  → run pre-flight again, then roll every Loom
 *        Container App to the target release's PUBLIC ghcr images via real ARM
 *        PATCH. Returns the structured per-app result.
 *
 * Admin-gated (tenant admin or domain admin — same gate as the Scale pane,
 * which also rolls Container Apps). NEVER reports success unless the ARM update
 * actually returned. If a prerequisite is missing (public images not published
 * for the target tag yet, or UAMI/ARM not configured) it returns an HONEST gate
 * naming exactly what's missing — it does not fake an update (no-vaporware.md).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  updateContainerAppImage,
  getContainerApp,
  AcaArmError,
} from '@/lib/azure/container-apps-arm-client';
import {
  preflight,
  applyRoll,
  DEFAULT_GHCR_OWNER,
  GHCR_REGISTRY,
  type GhRelease,
  type UpdateDeps,
  type PreflightOk,
} from '@/lib/updates/update-apply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UPSTREAM_OWNER = process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';
const UPSTREAM_REPO = process.env.LOOM_FEEDBACK_REPO_NAME || 'csa-inabox';
const CURRENT_VERSION =
  process.env.LOOM_VERSION || process.env.NEXT_PUBLIC_LOOM_VERSION || 'dev';

/** Real GitHub releases fetch (public API; optional token for rate limit). */
async function listReleases(): Promise<GhRelease[]> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.LOOM_FEEDBACK_GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.LOOM_FEEDBACK_GITHUB_TOKEN}`;
  }
  const r = await fetch(
    `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases?per_page=20`,
    { headers, cache: 'no-store' },
  );
  if (!r.ok) throw new Error(`GitHub releases fetch failed (${r.status})`);
  return (await r.json()) as GhRelease[];
}

/**
 * HEAD a ghcr manifest to verify a public image+tag exists. ghcr requires a
 * bearer token even for PUBLIC pulls: the registry replies 401 with a
 * WWW-Authenticate challenge; we fetch an anonymous pull token from the realm
 * and retry. A 200 means the manifest exists. Returns the final HTTP status.
 */
async function headImage(ref: string): Promise<number> {
  // ref = ghcr.io/<owner>/<image>:<tag>
  const withoutHost = ref.replace(`${GHCR_REGISTRY}/`, '');
  const lastColon = withoutHost.lastIndexOf(':');
  const repo = withoutHost.slice(0, lastColon);
  const tag = withoutHost.slice(lastColon + 1);
  const manifestUrl = `https://${GHCR_REGISTRY}/v2/${repo}/manifests/${tag}`;
  const accept =
    'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, ' +
    'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

  // Anonymous pull token for the public package.
  let token = '';
  try {
    const tr = await fetch(
      `https://${GHCR_REGISTRY}/token?scope=repository:${repo}:pull`,
      { cache: 'no-store' },
    );
    if (tr.ok) {
      const tj: any = await tr.json().catch(() => ({}));
      token = tj?.token || tj?.access_token || '';
    }
  } catch {
    /* fall through — try unauthenticated HEAD */
  }

  const doHead = (bearer?: string) =>
    fetch(manifestUrl, {
      method: 'HEAD',
      headers: { Accept: accept, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      cache: 'no-store',
    });

  let res = await doHead(token || undefined);
  // Some HEAD edge-cases on ghcr need a GET to materialize the manifest status.
  if (res.status === 405) {
    res = await fetch(manifestUrl, {
      method: 'GET',
      headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      cache: 'no-store',
    });
  }
  return res.status;
}

function armConfig(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.LOOM_SUBSCRIPTION_ID) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!(process.env.LOOM_ACA_RG || process.env.LOOM_ADMIN_RG)) missing.push('LOOM_ACA_RG (or LOOM_ADMIN_RG)');
  return { configured: missing.length === 0, missing };
}

function deps(): UpdateDeps {
  return {
    listReleases,
    headImage,
    armConfig,
    currentVersion: CURRENT_VERSION,
    // Compat manifest inputs (rel-T41): compare the release's newly-required env
    // against what bicep actually deployed. LOOM_INFRA_VERSION is stamped by the
    // platform bicep and is NOT changed by an image roll, so it reflects the last
    // real `az deployment` (the running LOOM_VERSION can be ahead of it after a
    // roll — that mismatch is exactly what the compat gate catches).
    envPresent: (name: string) => {
      const v = process.env[name];
      return v !== undefined && v !== '';
    },
    infraVersion: process.env.LOOM_INFRA_VERSION || '',
  };
}

async function audit(tenantId: string, who: string, kind: string, fields: Record<string, unknown>) {
  try {
    const c = await auditLogContainer();
    await c.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: 'loom-update',
      tenantId,
      who,
      at: new Date().toISOString(),
      kind,
      ...fields,
    }).catch(() => {});
  } catch { /* best-effort */ }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  try {
    const pre = await preflight(deps(), DEFAULT_GHCR_OWNER);
    // A gate is a legitimate 200 response with ok:false + reason — the UI renders
    // it as a MessageBar. arm-not-configured is the one true infra gate → 503.
    if (!pre.ok && pre.reason === 'arm-not-configured') {
      return NextResponse.json({ ok: false, preflight: pre }, { status: 503 });
    }
    return NextResponse.json({ ok: pre.ok, preflight: pre });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;

  // Optional: the client echoes the target tag it confirmed in the UI so we can
  // refuse if the resolved target drifted between pre-flight and confirm.
  const body = await req.json().catch(() => ({})) as { confirmTag?: string };

  let pre;
  try {
    pre = await preflight(deps(), DEFAULT_GHCR_OWNER);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  if (!pre.ok) {
    // Honest gate — do not roll anything.
    const status = pre.reason === 'arm-not-configured' ? 503 : 409;
    await audit(tenantId, who, 'loom-update.gated', { reason: pre.reason });
    return NextResponse.json({ ok: false, preflight: pre }, { status });
  }

  const ok = pre as PreflightOk;
  if (body.confirmTag && body.confirmTag !== ok.target.tag_name) {
    return NextResponse.json({
      ok: false,
      error: `Target drifted: you confirmed ${body.confirmTag} but the latest release is now ${ok.target.tag_name}. Re-check and confirm again.`,
    }, { status: 409 });
  }

  await audit(tenantId, who, 'loom-update.start', {
    from: ok.current, to: ok.target.tag_name, apps: ok.plan.map((p) => p.acaName),
  });

  const { results, allSucceeded } = await applyRoll(
    ok.plan,
    async (acaName, image) => {
      const r = await updateContainerAppImage(acaName, image);
      return { fromImage: r.fromImage, toImage: r.toImage, provisioningState: r.provisioningState };
    },
    {
      // Skip apps not deployed on this boundary (404 from ARM GET → skip, not fail).
      appExists: async (acaName) => {
        try { await getContainerApp(acaName); return true; }
        catch (e) { if (e instanceof AcaArmError && e.status === 404) return false; throw e; }
      },
    },
  );

  await audit(tenantId, who, allSucceeded ? 'loom-update.succeeded' : 'loom-update.partial', {
    to: ok.target.tag_name,
    results: results.map((r) => ({ app: r.app, status: r.status })),
  });

  return NextResponse.json({
    ok: allSucceeded,
    target: ok.target,
    imageVersion: ok.imageVersion,
    results,
  }, { status: allSucceeded ? 200 : 207 });
}
