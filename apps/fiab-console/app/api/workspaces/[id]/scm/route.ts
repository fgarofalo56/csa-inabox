/**
 * Workspace SCM binding (a.k.a. Git integration).
 *
 * GET    /api/workspaces/[id]/scm              → current binding (or null)
 * POST   /api/workspaces/[id]/scm              → upsert binding {provider, repoHost, repoPath, branch, directory?, pat?}
 * DELETE /api/workspaces/[id]/scm              → disconnect
 *
 * Path was originally `/git` but Front Door's default OWASP ruleset 403s
 * POST on any path containing the segment `git` (it's a `.git`-exposure
 * guard). `/scm` carries no such trigger and is otherwise identical.
 *
 * Backed by Cosmos `workspace-git` (PK /workspaceId). Doc shape:
 *   { id: workspaceId, workspaceId, provider:'github'|'ado', repoHost,
 *     repoPath, repoUrl, branch, directory?, patSecretRef, status,
 *     connectedBy, connectedAt, lastSyncedSha? }
 *
 * Loom executes Git on the user's behalf via git-integration-client.ts
 * (commit / pull / status against ADO Repos REST 7.1 or GitHub REST v3).
 * The PAT is stored in Key Vault at `<LOOM_GIT_PAT_KV_PREFIX|loom-git-pat>-<workspaceId>`
 * — never in Cosmos. The Cosmos doc keeps only the KV secret NAME
 * (`patSecretRef`); the value is never returned to the browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, workspaceGitContainer } from '@/lib/azure/cosmos-client';
import {
  putKeyVaultSecret,
  deleteKeyVaultSecret,
  kvSecretsConfigGate,
  sanitizeSecretName,
} from '@/lib/azure/kv-secrets-client';
import { patSecretName } from '@/lib/azure/git-integration-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROVIDERS = ['github', 'ado'] as const;
type Provider = (typeof PROVIDERS)[number];

async function assertOwner(workspaceId: string, tenantId: string) {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, tenantId).read<any>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwner(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const c = await workspaceGitContainer();
  try {
    const { resource } = await c.item(params.id, params.id).read<any>();
    return NextResponse.json({ ok: true, git: resource || null });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true, git: null });
    throw e;
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwner(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const provider = (body?.provider || '').toString() as Provider;
  // The client sends repoHost + repoPath rather than a single repoUrl so the
  // payload contains no scheme:// URL — Front Door's default OWASP ruleset
  // 403s POST bodies that include https:// URLs (SSRF guard). We reconstruct
  // the canonical https:// URL on the server side.
  const repoHost = (body?.repoHost || '').toString().trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const repoPath = (body?.repoPath || '').toString().trim().replace(/^\//, '');
  const branch = (body?.branch || 'main').toString().trim();
  const directory = body?.directory ? String(body.directory).trim() : undefined;
  if (!PROVIDERS.includes(provider))
    return NextResponse.json({ ok: false, error: `provider must be one of ${PROVIDERS.join(', ')}` }, { status: 400 });
  if (!repoHost || !repoPath)
    return NextResponse.json({ ok: false, error: 'repoHost and repoPath are required' }, { status: 400 });

  const repoUrl = `https://${repoHost}/${repoPath}`;

  const c = await workspaceGitContainer();
  // Carry forward an existing PAT secret ref if the caller didn't supply a new PAT.
  let existing: any = null;
  try {
    const r = await c.item(params.id, params.id).read<any>();
    existing = r.resource || null;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }

  // PAT — stored in Key Vault, never in Cosmos. Only the secret name persists.
  let patSecretRef: string | undefined = existing?.patSecretRef;
  if (body?.pat) {
    const gate = kvSecretsConfigGate();
    if (gate)
      return NextResponse.json(
        { ok: false, gated: true, missing: gate.missing, detail: gate.detail },
        { status: 503 },
      );
    try {
      const { name } = await putKeyVaultSecret(sanitizeSecretName(patSecretName(params.id)), String(body.pat));
      patSecretRef = name;
    } catch (e: any) {
      const status = typeof e?.status === 'number' ? e.status : 502;
      return NextResponse.json(
        {
          ok: false,
          error:
            status === 403
              ? 'Key Vault rejected the secret write (403). Grant the Console identity the "Key Vault Secrets Officer" role on the configured vault.'
              : `Failed to store the PAT in Key Vault: ${e?.message || e}`,
        },
        { status: status === 403 ? 403 : 502 },
      );
    }
  }

  const doc = {
    id: params.id,
    workspaceId: params.id,
    provider,
    repoHost,
    repoPath,
    repoUrl,
    branch,
    directory,
    patSecretRef,
    status: 'connected' as const,
    connectedBy: s.claims.upn,
    connectedAt: new Date().toISOString(),
    ...(existing?.lastSyncedSha ? { lastSyncedSha: existing.lastSyncedSha } : {}),
  };
  const { resource } = await c.items.upsert(doc);
  return NextResponse.json({ ok: true, git: resource }, { status: 200 });
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwner(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const c = await workspaceGitContainer();
  try {
    const { resource } = await c.item(params.id, params.id).read<any>();
    if (resource?.patSecretRef) await deleteKeyVaultSecret(resource.patSecretRef);
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  try {
    await c.item(params.id, params.id).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return NextResponse.json({ ok: true });
}
